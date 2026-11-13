#!/usr/bin/python3
"""Converge the Zabbix Admin password, housekeeping and SAML through the frontend API.

Usage is documented in ansible/ZABBIX.md (admin password, housekeeping, SAML and API token).

The caller supplies a root-only JSON file (never argv / environment) with:
  port, server_name, version, password, previous_password, housekeeping
and optionally (all default to "off"):
  api_token, token_output_path, admin_lockdown, saml

Authentication:
  * api_token empty: log in as Admin with the password state machine (unchanged behaviour).
    When saml.enabled is true this is the one-time bootstrap: create the API-only service
    user and its API token, write the token to token_output_path and stop.
  * api_token set: use it as the API token of the service user. The Admin password is not
    converged and user.login is never called.

Exit codes:
  0  success; stdout is {"changed", "password_changed", "housekeeping_changed", ...}
  2  invalid input, transport/protocol error, version mismatch, API error, refused change
  3  no candidate password could log in as Admin
  4  the password was changed but logging in with the new password failed

Nothing written to stdout / stderr may contain a password, an API token or a session token
(also not Base64-encoded). Request bodies and exception reprs are never printed, and API
error texts are redacted before they are shown. User names are not printed either (only
counts), except the literal names of the objects this helper owns.

Standard library only: the target host runs the distribution python3.
"""
import hashlib
import http.client
import json
import os
import re
import secrets
import sys
import unicodedata

# Literals on purpose: recipe variables must not be able to redirect these.
USERNAME = 'Admin'
INITIAL_PASSWORD = 'zabbix'
TIMEOUT = 10
API_PATH = '/api_jsonrpc.php'

# Service user (bootstrap_service_user). Literals: the role and the docs rely on these names.
SERVICE_USERNAME = 'ai-support-automation'
SERVICE_GROUP = 'AI support automation (API only)'
SERVICE_TOKEN_NAME = 'ai-support-automation role helper'
SUPER_ADMIN_ROLE = 'Super admin role'
SERVICE_MARKER = '{$AI_SUPPORT_SERVICE_USER_DONE}'
LOCAL_USERS_MARKER = '{$AI_SUPPORT_SAML_LOCAL_USERS_DONE}'

# Zabbix constants.
GROUP_GUI_ACCESS_DISABLED = '3'
GROUP_STATUS_ENABLED = '0'
GROUP_STATUS_DISABLED = '1'
USER_TYPE_SUPER_ADMIN = '3'
IDP_TYPE_SAML = 2

# Minimum frontend version for SAML (CVE-2024-36466 is fixed after 7.0.0; the role validated
# 7.0.32 and 8.0.0). Compared against the full apiinfo.version.
SAML_MIN_VERSION = {'7.0': (7, 0, 32), '8.0': (8, 0, 0)}

EXIT_ERROR = 2
EXIT_LOGIN = 3
EXIT_RELOGIN = 4

# Writable housekeeping keys (identical in 6.0 and 7.0). The role assert has
# the same literal allowlist; neither is configurable from recipes.
MODE_KEYS = (
    'hk_events_mode', 'hk_services_mode', 'hk_audit_mode', 'hk_sessions_mode',
    'hk_history_mode', 'hk_trends_mode', 'hk_history_global', 'hk_trends_global',
    'compression_status',
)
DAY = 86400
MAX_PERIOD = 25 * 365 * DAY  # Zabbix "25y" (788400000 seconds)
# key -> (minimum seconds, whether 0 is accepted)
PERIOD_KEYS = {
    'hk_events_trigger': (DAY, False),
    'hk_events_service': (DAY, False),
    'hk_events_internal': (DAY, False),
    'hk_events_discovery': (DAY, False),
    'hk_events_autoreg': (DAY, False),
    'hk_services': (DAY, False),
    'hk_audit': (DAY, False),
    'hk_sessions': (DAY, False),
    'hk_history': (3600, True),
    'hk_trends': (DAY, True),
    'compress_older': (7 * DAY, False),
}
HOUSEKEEPING_KEYS = frozenset(MODE_KEYS) | frozenset(PERIOD_KEYS)
UNITS = {'s': 1, 'm': 60, 'h': 3600, 'd': DAY, 'w': 7 * DAY}
PERIOD_PATTERN = re.compile(r'^[0-9]{1,10}[smhdw]?\Z')

# SAML input rules. tasks/main.yml (Validate assert) has the same anchored patterns.
API_TOKEN_PATTERN = re.compile(r'^[0-9a-f]{64}\Z')
HTTPS_URL_PATTERN = re.compile(r'^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?(/[\x21-\x7e]*)?\Z')
URN_PATTERN = re.compile(r'^urn:[A-Za-z0-9][A-Za-z0-9-]{0,31}:[\x21-\x7e]+\Z')
SP_ENTITYID_PATTERN = re.compile(r'^[\x21-\x7e]{1,1024}\Z')
NAMEID_FORMATS = ('urn:oasis:names:tc:SAML:2.0:nameid-format:persistent',
                  'urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified')
ATTRIBUTE_PATTERN = re.compile(r'^[A-Za-z][A-Za-z0-9_.:-]{0,127}\Z')
OPTIONAL_ATTRIBUTE_PATTERN = re.compile(r'^([A-Za-z][A-Za-z0-9_.:-]{0,127})?\Z')
# Printable ASCII without "*" (Zabbix treats "*" in a SAML group name as a wildcard).
SAML_GROUP_PATTERN = re.compile(r'^[\x21-\x29\x2b-\x7e]([\x20-\x29\x2b-\x7e]{0,253}[\x21-\x29\x2b-\x7e])?\Z')
OBJECT_NAME_PATTERN = re.compile(r'^[\x21-\x7e]([\x20-\x7e]{0,62}[\x21-\x7e])?\Z')
AUTOLOGOUT_PATTERN = re.compile(r'^([0-9]{1,5})([smhd]?)\Z')
TARGET_PATTERN = re.compile(r'^[\x21-\x7e]{1,100}\Z')
SHA256_PATTERN = re.compile(r'^[0-9a-f]{64}\Z')
SIGN_KEYS = ('messages', 'assertions', 'authn_requests', 'logout_requests', 'logout_responses')
SIGN_DEFAULTS = {'messages': True, 'assertions': True, 'authn_requests': False,
                 'logout_requests': False, 'logout_responses': False}
JIT_DEFAULTS = {'enabled': False, 'group_name_attribute': 'groups', 'user_name_attribute': 'name',
                'user_lastname_attribute': '', 'deprovisioned_group': '', 'groups': [], 'media': []}
LOCAL_USER_MODES = ('', 'delete', 'scramble')
# Managed user groups (saml.user_groups). Host group permissions only; template group rights are never sent.
USER_GROUP_PERMISSIONS = {'read': 2, 'read-write': 3}
PERMISSION_NAMES = {'0': 'deny', '2': 'read', '3': 'read-write'}
PERMISSION_DENY = '0'
USER_GROUP_KEYS = {'name', 'permission', 'hostgroups'}
USER_GROUP_OPTIONAL_KEYS = {'exclude_hostgroups', 'replace_denied'}
ALL_HOSTGROUPS = 'all'
# Built-in groups (Super admins, guests, disabled users, frontend access and debug switches); never managed
# by this helper (compared case-insensitively).
BUILTIN_GROUPS = ('Zabbix administrators', 'Guests', 'Disabled', 'No access to the frontend', 'Internal',
                  'Enabled debug mode')
# Host group names may use any Unicode letters (e.g. Japanese): 1-255 characters, no leading/trailing whitespace
# and no control, format, surrogate or private-use characters (Unicode categories Cc, Cf, Cs, Co, from Unicode
# 15.1) and no line/paragraph separators. tasks/main.yml has the same literal pattern; unassigned code points
# (Cn) are refused here only (see hostgroup_name), as the role assert has no Unicode database.
HOSTGROUP_FORBIDDEN = (r'\x00-\x1f\x7f-\x9f\xad\u0600-\u0605\u061c\u06dd\u070f\u0890-\u0891\u08e2\u180e\u200b-\u200f'
                       r'\u2028-\u202e\u2060-\u2064\u2066-\u206f\ud800-\uf8ff\ufeff\ufff9-\ufffb\U000110bd\U000110cd'
                       r'\U00013430-\U0001343f\U0001bca0-\U0001bca3\U0001d173-\U0001d17a\U000e0001\U000e0020-\U000e007f'
                       r'\U000f0000-\U000ffffd\U00100000-\U0010fffd')
HOSTGROUP_NAME_PATTERN = re.compile(r'^[^\s%s]([^%s]{0,253}[^\s%s])?\Z'
                                    % (HOSTGROUP_FORBIDDEN, HOSTGROUP_FORBIDDEN, HOSTGROUP_FORBIDDEN))
MAX_TARGETS = 200
EMAIL_LIKE = re.compile(r"[^\s\"'@]+@[^\s\"']+")


class HelperError(Exception):
    def __init__(self, message, code=EXIT_ERROR):
        super().__init__(message)
        self.code = code


class Redactor:
    """Removes every secret seen so far from text that is about to be printed."""

    def __init__(self):
        self.secrets = []

    def add(self, value):
        if isinstance(value, str) and value and value not in self.secrets:
            self.secrets.append(value)

    def __call__(self, text):
        text = str(text)
        for secret in sorted(self.secrets, key=len, reverse=True):
            text = text.replace(secret, '***')
        return text


def period_seconds(value):
    """Seconds for a housekeeping period, or None when the format is not accepted."""
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value if value >= 0 else None
    if isinstance(value, str) and PERIOD_PATTERN.match(value):
        if value[-1] in UNITS:
            return int(value[:-1]) * UNITS[value[-1]]
        return int(value)
    return None


def mode_value(value):
    if isinstance(value, bool):
        return None
    if isinstance(value, int) and value in (0, 1):
        return value
    if isinstance(value, str) and value in ('0', '1'):
        return int(value)
    return None


def autologout_seconds(value):
    """Seconds for an autologout value (s/m/h/d suffix or plain seconds), or None."""
    if not isinstance(value, str):
        return None
    match = AUTOLOGOUT_PATTERN.match(value)
    if not match:
        return None
    return int(match.group(1)) * UNITS[match.group(2) or 's']


def targets_sha256(targets):
    """The documented hash: names sorted by their bytes, joined with "\\n", no trailing newline."""
    joined = '\n'.join(sorted(targets, key=lambda name: name.encode('utf-8')))
    return hashlib.sha256(joined.encode('utf-8')).hexdigest()


def validate_housekeeping(housekeeping):
    """Return {key: (normalized value, value to send)} or raise. Only key names are reported.

    Modes are compared and sent as integers. Periods are compared in seconds but sent as
    written (``"90d"`` stays ``"90d"`` in the frontend; an integer is sent as its decimal string).
    """
    if not isinstance(housekeeping, dict):
        raise HelperError('housekeeping must be a mapping.')
    normalized = {}
    for key in sorted(housekeeping):
        value = housekeeping[key]
        if key not in HOUSEKEEPING_KEYS:
            raise HelperError('housekeeping key %s is unknown or read-only.' % json.dumps(str(key)))
        if key in MODE_KEYS:
            mode = mode_value(value)
            if mode is None:
                raise HelperError('housekeeping %s must be 0 or 1 (integer or string, not boolean).' % key)
            normalized[key] = (mode, mode)
            continue
        seconds = period_seconds(value)
        minimum, zero_ok = PERIOD_KEYS[key]
        if seconds is None:
            raise HelperError('housekeeping %s must be seconds or a number with an s/m/h/d/w suffix '
                              '(no macros, y/M units or spaces).' % key)
        if not ((zero_ok and seconds == 0) or minimum <= seconds <= MAX_PERIOD):
            raise HelperError('housekeeping %s is out of range.' % key)
        normalized[key] = (seconds, str(value))
    return normalized


def _string(value, pattern, message, max_length=None):
    if not isinstance(value, str) or not pattern.match(value) or (max_length and len(value) > max_length):
        raise HelperError(message)
    return value


def hostgroup_name(value, message):
    """A host group name (HOSTGROUP_NAME_PATTERN, and no unassigned code point either)."""
    _string(value, HOSTGROUP_NAME_PATTERN, message)
    if any(unicodedata.category(char) == 'Cn' for char in value):
        raise HelperError(message)
    return value


def _boolean(value, message):
    if not isinstance(value, bool):
        raise HelperError(message)
    return value


def validate_jit(jit):
    if not isinstance(jit, dict) or set(jit) - set(JIT_DEFAULTS):
        raise HelperError('saml jit must be a mapping with the keys enabled, group_name_attribute, '
                          'user_name_attribute, user_lastname_attribute, deprovisioned_group, groups, media.')
    jit = dict(JIT_DEFAULTS, **jit)
    _boolean(jit['enabled'], 'saml jit enabled must be a boolean.')
    if not jit['enabled']:
        return jit
    _string(jit['group_name_attribute'], ATTRIBUTE_PATTERN, 'saml jit group_name_attribute is invalid.')
    _string(jit['user_name_attribute'], OPTIONAL_ATTRIBUTE_PATTERN, 'saml jit user_name_attribute is invalid.')
    _string(jit['user_lastname_attribute'], OPTIONAL_ATTRIBUTE_PATTERN,
            'saml jit user_lastname_attribute is invalid.')
    _string(jit['deprovisioned_group'], OBJECT_NAME_PATTERN,
            'saml jit deprovisioned_group must name a user group (required with JIT).')
    if jit['deprovisioned_group'] == SERVICE_GROUP:
        raise HelperError('saml jit deprovisioned_group must not be the API-only service group.')
    groups = jit['groups']
    if not isinstance(groups, list) or not groups:
        raise HelperError('saml jit groups must be a non-empty list.')
    seen = set()
    for entry in groups:
        if not isinstance(entry, dict) or set(entry) != {'saml_group', 'role', 'user_groups'}:
            raise HelperError('Each saml jit groups entry needs exactly saml_group, role and user_groups.')
        _string(entry['saml_group'], SAML_GROUP_PATTERN,
                'saml jit saml_group must be a full group name without "*".')
        if entry['saml_group'] in seen:
            raise HelperError('saml jit saml_group values must be unique.')
        seen.add(entry['saml_group'])
        _string(entry['role'], OBJECT_NAME_PATTERN, 'saml jit role must name a user role.')
        if entry['role'] == SUPER_ADMIN_ROLE:
            raise HelperError('Super admin role is never granted through SAML.')
        user_groups = entry['user_groups']
        if not isinstance(user_groups, list) or not user_groups or len(set(map(str, user_groups))) != len(user_groups):
            raise HelperError('saml jit user_groups must be a non-empty list of unique user group names.')
        for name in user_groups:
            _string(name, OBJECT_NAME_PATTERN, 'saml jit user_groups must name user groups.')
            if name in (SERVICE_GROUP, jit['deprovisioned_group']):
                raise HelperError('saml jit user_groups must not contain the API-only or deprovisioned group.')
    media = jit['media']
    if not isinstance(media, list):
        raise HelperError('saml jit media must be a list.')
    for entry in media:
        if not isinstance(entry, dict) or set(entry) != {'name', 'mediatype', 'attribute'}:
            raise HelperError('Each saml jit media entry needs exactly name, mediatype and attribute.')
        _string(entry['name'], OBJECT_NAME_PATTERN, 'saml jit media name is invalid.')
        _string(entry['mediatype'], OBJECT_NAME_PATTERN, 'saml jit media mediatype must name a media type.')
        _string(entry['attribute'], ATTRIBUTE_PATTERN, 'saml jit media attribute is invalid.')
    return jit


def validate_local_users(local_users):
    if not isinstance(local_users, dict) or \
            set(local_users) - {'mode', 'targets', 'expected_sha256', 'transfer_maps_dashboards'}:
        raise HelperError('saml local_users must be a mapping with mode, targets, expected_sha256 and '
                          'transfer_maps_dashboards.')
    local_users = dict({'mode': '', 'targets': [], 'expected_sha256': '', 'transfer_maps_dashboards': False},
                       **local_users)
    if local_users['mode'] not in LOCAL_USER_MODES:
        raise HelperError('saml local_users mode must be "", delete or scramble.')
    _boolean(local_users['transfer_maps_dashboards'], 'saml local_users transfer_maps_dashboards must be a boolean.')
    if local_users['mode'] == '':
        return local_users
    targets = local_users['targets']
    if not isinstance(targets, list) or not 1 <= len(targets) <= MAX_TARGETS:
        raise HelperError('saml local_users targets must list 1-%d user names.' % MAX_TARGETS)
    for name in targets:
        _string(name, TARGET_PATTERN, 'saml local_users targets must be 1-100 printable ASCII characters '
                                      'without spaces.')
        # MySQL collations may ignore case, so "admin" could still select Admin.
        if name.lower() in (USERNAME.lower(), SERVICE_USERNAME):
            raise HelperError('saml local_users targets must not contain Admin or the service user.')
    if len(set(targets)) != len(targets):
        raise HelperError('saml local_users targets contain duplicates.')
    _string(local_users['expected_sha256'], SHA256_PATTERN,
            'saml local_users expected_sha256 must be 64 lowercase hex characters.')
    if targets_sha256(targets) != local_users['expected_sha256']:
        raise HelperError('saml local_users expected_sha256 does not match targets. Nothing was changed.')
    return local_users


def validate_user_groups(user_groups, jit):
    """The user groups whose host group permissions this helper converges. Raises on invalid input.

    Each entry is {name, permission: read|read-write, hostgroups: 'all' | [host group names]} with the optional
    exclude_hostgroups (names left out of "all"; only with "all") and replace_denied (boolean; allows replacing
    existing deny rights). The API-only service group, the deprovisioned group and the built-in groups are
    refused (case-insensitively, as a MySQL collation may match them), and so are duplicate names.
    """
    if not isinstance(user_groups, list):
        raise HelperError('saml user_groups must be a list.')
    protected = {SERVICE_GROUP.lower()} | {name.lower() for name in BUILTIN_GROUPS}
    deprovisioned = jit.get('deprovisioned_group') if isinstance(jit, dict) else None
    if isinstance(deprovisioned, str) and deprovisioned:
        protected.add(deprovisioned.lower())
    seen = set()
    result = []
    for entry in user_groups:
        if not isinstance(entry, dict) or not USER_GROUP_KEYS <= set(entry) or \
                set(entry) - USER_GROUP_KEYS - USER_GROUP_OPTIONAL_KEYS:
            raise HelperError('Each saml user_groups entry needs name, permission and hostgroups, and may only add '
                              'exclude_hostgroups and replace_denied.')
        name = _string(entry['name'], OBJECT_NAME_PATTERN, 'saml user_groups name must name a user group.')
        if name.lower() in protected:
            raise HelperError('saml user_groups must not contain the API-only, deprovisioned or a built-in group '
                              '(%s).' % ', '.join(BUILTIN_GROUPS))
        if name.lower() in seen:
            raise HelperError('saml user_groups names must be unique.')
        seen.add(name.lower())
        if not isinstance(entry['permission'], str) or entry['permission'] not in USER_GROUP_PERMISSIONS:
            raise HelperError('saml user_groups permission must be read or read-write.')
        hostgroups = entry['hostgroups']
        if hostgroups != ALL_HOSTGROUPS:
            if not isinstance(hostgroups, list) or not hostgroups:
                raise HelperError('saml user_groups hostgroups must be "all" or a non-empty list of host group names.')
            for hostgroup in hostgroups:
                hostgroup_name(hostgroup, 'saml user_groups hostgroups must name host groups.')
            if len(set(hostgroups)) != len(hostgroups):
                raise HelperError('saml user_groups hostgroups contain duplicates.')
        exclude = entry.get('exclude_hostgroups', [])
        if 'exclude_hostgroups' in entry:
            if hostgroups != ALL_HOSTGROUPS:
                raise HelperError('saml user_groups exclude_hostgroups is only allowed with hostgroups: all.')
            if not isinstance(exclude, list):
                raise HelperError('saml user_groups exclude_hostgroups must be a list of host group names.')
            for hostgroup in exclude:
                hostgroup_name(hostgroup, 'saml user_groups exclude_hostgroups must name host groups.')
            if len(set(exclude)) != len(exclude):
                raise HelperError('saml user_groups exclude_hostgroups contain duplicates.')
        replace_denied = _boolean(entry.get('replace_denied', False),
                                  'saml user_groups replace_denied must be a boolean.')
        result.append({'name': name, 'permission': entry['permission'], 'hostgroups': hostgroups,
                       'exclude_hostgroups': list(exclude), 'replace_denied': replace_denied})
    return result


def validate_saml(saml, version):
    if saml is None:
        return None
    if not isinstance(saml, dict):
        raise HelperError('Invalid helper input: saml must be a mapping.')
    if not _boolean(saml.get('enabled', False), 'saml enabled must be a boolean.'):
        return {'enabled': False}
    if version not in SAML_MIN_VERSION:
        raise HelperError('SAML requires zabbix_web_version 7.0 or 8.0.')
    entityid = saml.get('idp_entityid')
    if not isinstance(entityid, str) or len(entityid) > 1024 or \
            not (HTTPS_URL_PATTERN.match(entityid) or URN_PATTERN.match(entityid)):
        raise HelperError('saml idp_entityid must be an https URL or a URN of at most 1024 characters.')
    _string(saml.get('sso_url'), HTTPS_URL_PATTERN, 'saml sso_url must be an https URL.', 2048)
    slo_url = saml.get('slo_url', '')
    if slo_url != '':
        _string(slo_url, HTTPS_URL_PATTERN, 'saml slo_url must be empty or an https URL.', 2048)
    _string(saml.get('sp_entityid'), SP_ENTITYID_PATTERN,
            'saml sp_entityid must be 1-1024 printable ASCII characters without spaces.')
    if saml.get('nameid_format') not in NAMEID_FORMATS:
        raise HelperError('saml nameid_format must be the SAML 2.0 persistent or 1.1 unspecified URN.')
    _string(saml.get('username_attribute'), ATTRIBUTE_PATTERN, 'saml username_attribute is invalid.')
    _boolean(saml.get('case_sensitive'), 'saml case_sensitive must be a boolean.')
    _boolean(saml.get('allow_legacy_users', False), 'saml allow_legacy_users must be a boolean.')
    sign = saml.get('sign', {})
    if not isinstance(sign, dict) or set(sign) - set(SIGN_KEYS) or \
            not all(isinstance(v, bool) for v in sign.values()):
        raise HelperError('saml sign keys are messages, assertions, authn_requests, logout_requests, '
                          'logout_responses with boolean values.')
    sign = dict(SIGN_DEFAULTS, **sign)
    if not (sign['messages'] or sign['assertions']):
        raise HelperError('saml sign needs messages or assertions (or both) to be true; otherwise an unsigned '
                          'response would be accepted.')
    autologout = saml.get('autologout', '')
    if autologout != '':
        seconds = autologout_seconds(autologout)
        if seconds is None or not 90 <= seconds <= DAY:
            raise HelperError('saml autologout must be empty or a period between 90s and 1d.')
    jit = validate_jit(saml.get('jit', {}))
    # SCIM on the SAML user directory: only for the MBC PULL sync (zabbix_mbc_pull.py), which changes JIT users
    # through /api_scim.php because the JSON-RPC API refuses to change their role and groups.
    scim = _boolean(saml.get('scim', False), 'saml scim must be a boolean.')
    if scim and not jit['enabled']:
        raise HelperError('saml scim (zabbix_web_mbc_pull) requires JIT provisioning.')
    return dict(saml, slo_url=slo_url, sign=sign, autologout=autologout, scim=scim,
                allow_legacy_users=saml.get('allow_legacy_users', False), jit=jit,
                local_users=validate_local_users(saml.get('local_users', {})),
                user_groups=validate_user_groups(saml.get('user_groups', []), jit))


def validate_config(config):
    if not isinstance(config, dict):
        raise HelperError('Invalid helper input.')
    port = config.get('port')
    if isinstance(port, bool) or not isinstance(port, int) or not 0 < port < 65536:
        raise HelperError('Invalid listen port.')
    for field in ('server_name', 'version', 'password', 'previous_password'):
        if not isinstance(config.get(field), str):
            raise HelperError('Invalid helper input: %s must be a string.' % field)
    if config['version'] not in ('6.0', '7.0', '8.0'):
        raise HelperError('Unsupported Zabbix version.')
    api_token = config.get('api_token', '')
    if not isinstance(api_token, str) or (api_token and not API_TOKEN_PATTERN.match(api_token)):
        raise HelperError('zabbix_web_api_token must be empty or a Zabbix API token (64 hex characters).')
    password = config['password']
    # With an API token the Admin password is not used; an empty value is then accepted.
    if not (api_token and password == '') and (
            not re.match(r'^[\x20-\x7e]{8,72}\Z', password) or password != password.strip()
            or password == INITIAL_PASSWORD):
        raise HelperError('zabbix_web_admin_password must be 8-72 printable ASCII characters without '
                          'leading/trailing spaces and must not be the initial password.')
    if not re.match(r'^[\x20-\x7e]{0,72}\Z', config['previous_password']):
        raise HelperError('zabbix_web_admin_previous_password must be 0-72 printable ASCII characters.')
    lockdown = _boolean(config.get('admin_lockdown', False), 'admin_lockdown must be a boolean.')
    delete_admin_tokens = _boolean(config.get('admin_lockdown_delete_tokens', False),
                                   'admin_lockdown_delete_tokens must be a boolean.')
    if lockdown and not api_token:
        raise HelperError('zabbix_web_admin_lockdown requires zabbix_web_api_token.')
    saml = validate_saml(config.get('saml'), config['version'])
    if lockdown and not (saml and saml['enabled']):
        # Without SAML nobody could sign in to the frontend any more.
        raise HelperError('zabbix_web_admin_lockdown requires zabbix_web_saml_enabled.')
    token_output_path = config.get('token_output_path', '')
    if not isinstance(token_output_path, str) or (token_output_path and not token_output_path.startswith('/')):
        raise HelperError('Invalid helper input: token_output_path must be an absolute path.')
    if saml and saml['enabled'] and not api_token and not token_output_path:
        raise HelperError('Invalid helper input: token_output_path is required for the bootstrap.')
    return {'housekeeping': validate_housekeeping(config.get('housekeeping', {})), 'api_token': api_token,
            'admin_lockdown': lockdown, 'admin_lockdown_delete_tokens': delete_admin_tokens, 'saml': saml,
            'token_output_path': token_output_path}


class Client:
    def __init__(self, port, server_name, redact):
        self.port = port
        self.server_name = server_name
        self.redact = redact
        self.bearer = False
        self.version = (0, 0)
        self.full_version = (0, 0, 0)
        self.request_id = 0

    def call(self, method, params, token=None):
        """Return (result, error). Transport and protocol failures raise HelperError."""
        self.request_id += 1
        body = {'jsonrpc': '2.0', 'method': method, 'params': params, 'id': self.request_id}
        headers = {'Content-Type': 'application/json-rpc', 'Host': self.server_name}
        if token is not None:
            if self.bearer:
                headers['Authorization'] = 'Bearer ' + token
            else:
                body['auth'] = token
        connection = http.client.HTTPConnection('127.0.0.1', self.port, timeout=TIMEOUT)
        try:
            connection.request('POST', API_PATH, body=json.dumps(body).encode(), headers=headers)
            response = connection.getresponse()
            status = response.status
            raw = response.read()
        except (OSError, http.client.HTTPException) as error:
            # Only the class name: messages/reprs are not printed by design.
            raise HelperError('Zabbix API %s request failed (%s). Check that the frontend answers on '
                              '127.0.0.1:%d.' % (method, type(error).__name__, self.port)) from None
        finally:
            connection.close()
        if status != 200:
            raise HelperError('Zabbix API %s returned HTTP %d.' % (method, status))
        try:
            payload = json.loads(raw.decode('utf-8'))
        except (UnicodeDecodeError, ValueError):
            raise HelperError('Zabbix API %s returned a response that is not JSON.' % method) from None
        if not isinstance(payload, dict) or ('result' not in payload and 'error' not in payload):
            raise HelperError('Zabbix API %s returned an unexpected JSON-RPC response.' % method)
        if 'error' in payload:
            return None, payload['error']
        return payload['result'], None

    def describe(self, error):
        if not isinstance(error, dict):
            return 'unknown error'
        parts = [str(error.get(k)) for k in ('message', 'data') if error.get(k) not in (None, '')]
        # API errors may quote user names (e.g. 'User "x" is map "y" owner.'); hide e-mail-like names.
        return EMAIL_LIKE.sub('***', self.redact(' '.join(parts) or 'unknown error'))

    def require(self, method, params, token):
        result, error = self.call(method, params, token)
        if error is not None:
            raise HelperError('Zabbix API %s failed: %s' % (method, self.describe(error)))
        return result

    def require_list(self, method, params, token):
        result = self.require(method, params, token)
        if not isinstance(result, list) or not all(isinstance(item, dict) for item in result):
            raise HelperError('Zabbix API %s returned an unexpected result.' % method)
        return result

    def login(self, password):
        result, error = self.call('user.login', {'username': USERNAME, 'password': password})
        if error is not None:
            return None
        if not isinstance(result, str) or not result:
            raise HelperError('Zabbix API user.login returned an unexpected result.')
        self.redact.add(result)
        return result

    def logout(self, token):
        try:
            self.call('user.logout', [], token)
        except HelperError:
            pass  # best effort


def check_version(client, expected):
    result, error = client.call('apiinfo.version', [])
    if error is not None or not isinstance(result, str):
        raise HelperError('Zabbix API apiinfo.version failed.')
    match = re.match(r'^([0-9]+)\.([0-9]+)', result)
    if not match:
        raise HelperError('Zabbix API returned an unrecognized version.')
    major, minor = int(match.group(1)), int(match.group(2))
    if '%d.%d' % (major, minor) != expected:
        raise HelperError('Zabbix frontend API version %d.%d does not match zabbix_web_version %s.'
                          % (major, minor, expected))
    client.version = (major, minor)
    client.bearer = (major, minor) >= (6, 4)
    full = re.match(r'^([0-9]+)\.([0-9]+)\.([0-9]+)', result)
    client.full_version = tuple(int(part) for part in full.groups()) if full else (major, minor, -1)


def check_saml_version(client, expected):
    """SAML is refused below the validated patch (CVE-2024-36466 affects 7.0.0)."""
    floor = SAML_MIN_VERSION[expected]
    if client.full_version < floor:
        raise HelperError('SAML requires Zabbix %s or newer in the %s series. Nothing was changed.'
                          % ('.'.join(map(str, floor)), expected))


def converge_password(client, password, previous, sessions):
    """Return (token, password_changed). Every obtained token is appended to sessions."""
    token = client.login(password)
    if token is not None:
        sessions.append(token)
        return token, False
    candidates = [previous] if previous else []
    candidates.append(INITIAL_PASSWORD)
    for current in candidates:
        token = client.login(current)
        if token is None:
            continue
        sessions.append(token)
        users = client.require('user.get', {'output': ['userid'], 'filter': {'username': USERNAME}}, token)
        if not isinstance(users, list) or len(users) != 1 or not isinstance(users[0], dict) \
                or 'userid' not in users[0]:
            raise HelperError('Zabbix API user.get did not return exactly one Admin user.')
        update = {'userid': users[0]['userid'], 'passwd': password}
        # current_passwd exists from 6.2 (required there when changing one's own password).
        # 6.0 rejects it as an unexpected parameter (verified against 6.0.48).
        if client.version >= (6, 2):
            update['current_passwd'] = current
        client.require('user.update', update, token)
        new_token = client.login(password)
        if new_token is None:
            raise HelperError('The Admin password change was sent and is probably applied, but logging '
                              'in with the new password failed.', EXIT_RELOGIN)
        sessions.append(new_token)
        return new_token, True
    raise HelperError('Could not log in as Admin with the new, previous or initial password.', EXIT_LOGIN)


def converge_housekeeping(client, desired, token):
    if not desired:
        return []
    current = client.require('housekeeping.get', {'output': 'extend'}, token)
    if not isinstance(current, dict):
        raise HelperError('Zabbix API housekeeping.get returned an unexpected result.')
    wants_compression = desired.get('compression_status', (None,))[0] == 1
    if wants_compression or 'compress_older' in desired:
        if current.get('db_extension') != 'timescaledb':
            raise HelperError('compression_status: 1 / compress_older require a TimescaleDB database '
                              '(housekeeping db_extension is not timescaledb). Only compression_status: 0 '
                              'is allowed here.')
    if wants_compression and str(current.get('compression_availability')) == '0':
        raise HelperError('TimescaleDB compression is not available (compression_availability is 0; '
                          'the Apache-licensed TimescaleDB edition may be installed).')
    update = {}
    for key, (value, wire) in sorted(desired.items()):
        current_value = mode_value(current.get(key)) if key in MODE_KEYS else period_seconds(current.get(key))
        if current_value != value:
            update[key] = wire
    if not update:
        return []
    result = client.require('housekeeping.update', update, token)
    if not isinstance(result, list) or not all(isinstance(k, str) for k in result):
        raise HelperError('Zabbix API housekeeping.update returned an unexpected result.')
    return sorted(result)


# --- shared lookups ---------------------------------------------------------------------------

def random_password():
    """A throw-away password nobody receives; the suffix satisfies every password policy class."""
    return secrets.token_urlsafe(48) + 'aA1!'


def read_marker(client, token, macro):
    """Value of a global macro used as a DB marker, or None when it does not exist."""
    rows = client.require_list('usermacro.get', {'output': ['globalmacroid', 'macro', 'value'],
                                                 'globalmacro': True, 'filter': {'macro': macro}}, token)
    rows = [row for row in rows if row.get('macro') == macro]
    if len(rows) > 1:
        raise HelperError('More than one global macro %s exists.' % macro)
    return rows[0].get('value', '') if rows else None


def create_marker(client, token, macro, value):
    client.require('usermacro.createglobal', {'macro': macro, 'value': value}, token)


def usergroups_by_name(client, token, names):
    rows = client.require_list('usergroup.get', {'output': ['usrgrpid', 'name', 'gui_access', 'users_status'],
                                                 'filter': {'name': sorted(set(names))}}, token)
    # Exact (case-sensitive) names only: MySQL collations may match case-insensitively.
    found = {}
    for row in rows:
        if row.get('name') in names:
            if row['name'] in found:
                raise HelperError('User group "%s" exists more than once.' % row['name'])
            found[row['name']] = row
    return found


def ensure_service_group(client, token, create):
    """The API-only user group (frontend access disabled). Returns its usrgrpid and whether it was created."""
    group = usergroups_by_name(client, token, [SERVICE_GROUP]).get(SERVICE_GROUP)
    if group is None:
        if not create:
            raise HelperError('User group "%s" does not exist. Run the service user bootstrap first.'
                              % SERVICE_GROUP)
        result = client.require('usergroup.create', {'name': SERVICE_GROUP,
                                                     'gui_access': int(GROUP_GUI_ACCESS_DISABLED),
                                                     'users_status': int(GROUP_STATUS_ENABLED)}, token)
        return result['usrgrpids'][0], True
    if str(group.get('gui_access')) != GROUP_GUI_ACCESS_DISABLED or \
            str(group.get('users_status')) != GROUP_STATUS_ENABLED:
        raise HelperError('User group "%s" must have frontend access disabled and be enabled. Nothing was '
                          'changed.' % SERVICE_GROUP)
    return group['usrgrpid'], False


def user_by_name(client, token, username, **extra):
    params = {'output': ['userid', 'username', 'roleid', 'userdirectoryid'], 'filter': {'username': username}}
    params.update(extra)
    rows = [row for row in client.require_list('user.get', params, token) if row.get('username') == username]
    if len(rows) > 1:
        raise HelperError('More than one user is named %s.' % username)
    return rows[0] if rows else None


# --- service user bootstrap ----------------------------------------------------------

def bootstrap_service_user(client, token, output_path, redact):
    """Create the API-only service user and its token once. Returns a result fragment.

    The API token is written once to output_path (created exclusively, mode 0600) and the
    DB marker {$AI_SUPPORT_SERVICE_USER_DONE} is created last.
    """
    if read_marker(client, token, SERVICE_MARKER) is not None:
        raise HelperError('The service user bootstrap is already done (DB marker %s exists). Set '
                          'zabbix_web_api_token (bootstrap is done); the Admin password is not used for '
                          'SAML.' % SERVICE_MARKER)
    if os.path.lexists(output_path):
        raise HelperError('%s already exists. Move its token to zabbix_web_api_token and delete the file '
                          'before running again. Nothing was changed.' % output_path)
    roles = [row for row in client.require_list('role.get', {'output': ['roleid', 'name', 'type'],
                                                             'filter': {'name': SUPER_ADMIN_ROLE}}, token)
             if row.get('name') == SUPER_ADMIN_ROLE]
    if len(roles) != 1 or str(roles[0].get('type')) != USER_TYPE_SUPER_ADMIN:
        raise HelperError('Could not find the "%s" (Super admin type) user role.' % SUPER_ADMIN_ROLE)
    roleid = roles[0]['roleid']
    groupid, _ = ensure_service_group(client, token, create=True)
    user = user_by_name(client, token, SERVICE_USERNAME, selectUsrgrps=['usrgrpid'])
    if user is None:
        # No password: a user that only belongs to a frontend-disabled group can be created without
        # one, so the API user.login path does not exist for this user.
        result = client.require('user.create', {'username': SERVICE_USERNAME, 'roleid': roleid,
                                                'usrgrps': [{'usrgrpid': groupid}]}, token)
        userid = result['userids'][0]
    else:
        groups = sorted(str(g.get('usrgrpid')) for g in user.get('usrgrps', []))
        if str(user.get('roleid')) != str(roleid) or groups != [str(groupid)]:
            raise HelperError('User %s exists with another role or other groups. Fix or delete it by hand. '
                              'Nothing was changed.' % SERVICE_USERNAME)
        userid = user['userid']
    # A token from an interrupted bootstrap cannot be read back; replace it.
    old = [row['tokenid'] for row in client.require_list(
        'token.get', {'output': ['tokenid', 'name'], 'userids': [userid],
                      'filter': {'name': SERVICE_TOKEN_NAME}}, token) if row.get('name') == SERVICE_TOKEN_NAME]
    if old:
        client.require('token.delete', old, token)
    tokenid = client.require('token.create', {'name': SERVICE_TOKEN_NAME, 'userid': userid,
                                              'description': 'Managed by ai-support-agent (zabbix_web role).'},
                             token)['tokenids'][0]
    generated = client.require_list('token.generate', [tokenid], token)
    if len(generated) != 1 or not isinstance(generated[0].get('token'), str) or \
            not API_TOKEN_PATTERN.match(generated[0]['token']):
        raise HelperError('Zabbix API token.generate returned an unexpected result.')
    value = generated[0]['token']
    redact.add(value)
    created = False
    try:
        descriptor = os.open(output_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        created = True
        with os.fdopen(descriptor, 'w', encoding='ascii') as handle:
            handle.write(value + '\n')
    except OSError as error:
        if created:
            # Do not leave a partial token file behind; the next bootstrap refuses an existing file.
            try:
                os.unlink(output_path)
            except OSError:
                pass
        raise HelperError('Could not write the service user token file (%s). The token was created but not '
                          'stored; run the bootstrap again.' % type(error).__name__) from None
    create_marker(client, token, SERVICE_MARKER, SERVICE_USERNAME)
    return {'service_user_bootstrapped': True}


# --- Admin lockdown ------------------------------------------------------------------

def tokens_of(client, token, userids):
    """tokenids of the API tokens owned by the given users."""
    ids = set(map(str, userids))
    rows = client.require_list('token.get', {'output': ['tokenid', 'userid'], 'userids': sorted(ids)}, token)
    return [row['tokenid'] for row in rows if str(row.get('userid')) in ids]


def lockdown_admin(client, token, redact, delete_tokens):
    """Add Admin to the API-only group with a random password. Done once Admin is in the group.

    API tokens of Admin keep working after the lockdown, so they are refused (checked on every run)
    unless delete_tokens allows deleting them.
    """
    groupid, _ = ensure_service_group(client, token, create=False)
    admin = user_by_name(client, token, USERNAME, selectUsrgrps=['usrgrpid'])
    if admin is None:
        raise HelperError('Zabbix API user.get did not return the Admin user.')
    admin_tokens = tokens_of(client, token, [admin['userid']])
    if admin_tokens and not delete_tokens:
        raise HelperError('Admin owns %d API token(s), which keep working after the lockdown. Delete them, or set '
                          'zabbix_web_admin_lockdown_delete_tokens: true. Nothing was changed.' % len(admin_tokens))
    if admin_tokens:
        client.require('token.delete', admin_tokens, token)
    groups = [str(g.get('usrgrpid')) for g in admin.get('usrgrps', [])]
    if str(groupid) in groups:
        return bool(admin_tokens)
    password = random_password()
    redact.add(password)
    client.require('user.update', {'userid': admin['userid'], 'passwd': password,
                                   'usrgrps': [{'usrgrpid': g} for g in groups + [str(groupid)]]}, token)
    return True


# --- one-time local user procedure ---------------------------------------------------

def owned_objects(client, token, userids):
    """Counts of what blocks user.delete: maps, dashboards, reports and action recipients."""
    ids = set(map(str, userids))
    maps = [m for m in client.require_list('map.get', {'output': ['sysmapid', 'userid'], 'userids': sorted(ids)},
                                           token) if str(m.get('userid')) in ids]
    dashboards = [d for d in client.require_list('dashboard.get', {'output': ['dashboardid', 'userid'],
                                                                   'filter': {'userid': sorted(ids)}}, token)
                  if str(d.get('userid')) in ids]
    reports = 0
    for report in client.require_list('report.get', {'output': ['reportid', 'userid'], 'selectUsers': 'extend',
                                                     'selectUserGroups': 'extend'}, token):
        related = {str(report.get('userid'))}
        for row in report.get('users') or []:
            related |= {str(row.get('userid')), str(row.get('access_userid'))}
        for row in report.get('user_groups') or []:
            related.add(str(row.get('access_userid')))
        if related & ids:
            reports += 1
    actions = 0
    for action in client.require_list('action.get', {'output': ['actionid'], 'selectOperations': 'extend',
                                                     'selectRecoveryOperations': 'extend',
                                                     'selectUpdateOperations': 'extend'}, token):
        operations = (action.get('operations') or []) + (action.get('recovery_operations') or []) + \
            (action.get('update_operations') or [])
        recipients = {str(row.get('userid')) for op in operations for row in (op.get('opmessage_usr') or [])}
        if recipients & ids:
            actions += 1
    return maps, dashboards, reports, actions


def apply_local_users_once(client, token, local_users):
    """Delete or scramble an explicit list of users once. Returns a result fragment (counts only)."""
    mode = local_users['mode']
    if mode == '':
        return {}
    targets = local_users['targets']
    marker_value = '%s:%s' % (local_users['expected_sha256'], mode)
    current = read_marker(client, token, LOCAL_USERS_MARKER)
    if current is not None:
        if current == marker_value:
            return {'local_users': {'deleted': 0, 'scrambled': 0}, 'local_users_marker': marker_value}
        raise HelperError('The DB marker %s records another local user procedure. Nothing was changed; set '
                          'zabbix_web_saml_local_users.mode to "" after a completed procedure.'
                          % LOCAL_USERS_MARKER)
    found = client.require_list('user.get', {'output': ['userid', 'username'], 'filter': {'username': targets}},
                                token)
    names = [row.get('username') for row in found]
    if mode == 'delete' and not found:
        create_marker(client, token, LOCAL_USERS_MARKER, marker_value)
        return {'local_users': {'deleted': 0, 'scrambled': 0}, 'local_users_marker': marker_value,
                'local_users_changed': False}
    # Case-sensitive comparison: a case-insensitive collation could return "Alice@" for "alice@".
    if len(names) != len(set(names)) or set(names) != set(targets):
        raise HelperError('Found %d of %d target users with exactly matching names. Nothing was changed; fix '
                          'targets and expected_sha256.' % (len([n for n in names if n in targets]), len(targets)))
    if USERNAME in names or SERVICE_USERNAME in names:
        raise HelperError('Admin and the service user cannot be targets.')
    userids = [row['userid'] for row in found]
    if mode == 'scramble':
        # A new password does not end existing API tokens; delete them before scrambling.
        target_tokens = tokens_of(client, token, userids)
        if target_tokens:
            client.require('token.delete', target_tokens, token)
        done = 0
        try:
            for userid in userids:
                password = random_password()
                client.redact.add(password)
                client.require('user.update', {'userid': userid, 'passwd': password}, token)
                done += 1
        except HelperError as error:
            raise HelperError('%s (%d of %d users were scrambled; no marker was created).'
                              % (error, done, len(userids))) from None
        create_marker(client, token, LOCAL_USERS_MARKER, marker_value)
        return {'local_users': {'deleted': 0, 'scrambled': done, 'tokens_deleted': len(target_tokens)},
                'local_users_marker': marker_value,
                'local_users_changed': True}
    maps, dashboards, reports, actions = owned_objects(client, token, userids)
    if reports or actions:
        raise HelperError('The target users own %d scheduled report(s) and receive messages from %d action(s). '
                          'Delete the reports or move them to a person with equal or narrower rights, and remove '
                          'these users from the action operations (the action owner picks the replacement). '
                          'Nothing was changed.' % (reports, actions))
    moved = 0
    if maps or dashboards:
        if not local_users['transfer_maps_dashboards']:
            raise HelperError('The target users own %d map(s) and %d dashboard(s). Move them, or set '
                              'zabbix_web_saml_local_users.transfer_maps_dashboards: true to move them to the '
                              'service user. Nothing was changed.' % (len(maps), len(dashboards)))
        service = user_by_name(client, token, SERVICE_USERNAME)
        if service is None:
            raise HelperError('The service user does not exist; maps and dashboards cannot be moved.')
        for row in maps:
            client.require('map.update', {'sysmapid': row['sysmapid'], 'userid': service['userid']}, token)
            moved += 1
        for row in dashboards:
            client.require('dashboard.update', {'dashboardid': row['dashboardid'], 'userid': service['userid']},
                           token)
            moved += 1
    client.require('user.delete', userids, token)
    create_marker(client, token, LOCAL_USERS_MARKER, marker_value)
    return {'local_users': {'deleted': len(userids), 'scrambled': 0, 'moved_maps_dashboards': moved},
            'local_users_marker': marker_value, 'local_users_changed': True}


# --- SAML ----------------------------------------------------------------------------

def _flag(value):
    return 1 if value else 0


def token_capable(rules):
    """True when a role allows API access or managing API tokens (role.get selectRules output)."""
    if not isinstance(rules, dict):
        return True
    if str(rules.get('api.access', '1')) != '0':
        return True
    actions = {str(row.get('name')): str(row.get('status')) for row in rules.get('actions') or []
               if isinstance(row, dict)}
    return actions.get('manage_api_tokens', str(rules.get('actions.default_access', '1'))) != '0'


def desired_userdirectory(client, token, saml, planned_groups=frozenset()):
    """The userdirectory fields to converge (read-only lookups). Certificates are never sent (file storage).

    Returns (fields, deprovisioned group name or None, {user group name: usrgrpid}). Everything that could make
    the SAML setup fail is checked here, before the one-time local user procedure changes anything. User groups
    in planned_groups (created later by converge_user_groups) may be missing now; the user group names in
    provision_groups are replaced with their IDs by resolve_provision_groups once they exist.
    """
    sign = saml['sign']
    jit = saml['jit']
    fields = {
        'idp_entityid': saml['idp_entityid'], 'sso_url': saml['sso_url'], 'slo_url': saml['slo_url'],
        'username_attribute': saml['username_attribute'], 'sp_entityid': saml['sp_entityid'],
        'nameid_format': saml['nameid_format'],
        'sign_messages': _flag(sign['messages']), 'sign_assertions': _flag(sign['assertions']),
        'sign_authn_requests': _flag(sign['authn_requests']),
        'sign_logout_requests': _flag(sign['logout_requests']),
        'sign_logout_responses': _flag(sign['logout_responses']),
        'encrypt_nameid': 0, 'encrypt_assertions': 0,
        'provision_status': _flag(jit['enabled']),
        'scim_status': _flag(saml['scim']),
    }
    if not jit['enabled']:
        return fields, None, {}
    roles = {}
    role_names = sorted({entry['role'] for entry in jit['groups']})
    for row in client.require_list('role.get', {'output': ['roleid', 'name', 'type'],
                                                'selectRules': ['api.access', 'actions', 'actions.default_access'],
                                                'filter': {'name': role_names}}, token):
        if row.get('name') in role_names:
            if row['name'] in roles:
                raise HelperError('User role "%s" exists more than once.' % row['name'])
            roles[row['name']] = row
    missing = [name for name in role_names if name not in roles]
    if missing:
        raise HelperError('User role(s) not found: %s.' % ', '.join(json.dumps(n) for n in missing))
    for name, row in roles.items():
        if str(row.get('type')) == USER_TYPE_SUPER_ADMIN:
            raise HelperError('User role "%s" is a Super admin role; Super admin is never granted through SAML.'
                              % name)
        # API tokens of JIT users keep working after the IdP denies them, until the user is deleted.
        if token_capable(row.get('rules')):
            raise HelperError('User role "%s" allows API access or managing API tokens; roles mapped through SAML '
                              'must have both disabled (see ZABBIX.md).' % name)
    group_names = sorted({name for entry in jit['groups'] for name in entry['user_groups']})
    groups = usergroups_by_name(client, token, group_names)
    missing = [name for name in group_names if name not in groups and name not in planned_groups]
    if missing:
        raise HelperError('User group(s) not found: %s.' % ', '.join(json.dumps(n) for n in missing))
    media_names = sorted({entry['mediatype'] for entry in jit['media']})
    mediatypes = {}
    if media_names:
        for row in client.require_list('mediatype.get', {'output': ['mediatypeid', 'name'],
                                                         'filter': {'name': media_names}}, token):
            if row.get('name') in media_names:
                mediatypes[row['name']] = row
        missing = [name for name in media_names if name not in mediatypes]
        if missing:
            raise HelperError('Media type(s) not found: %s.' % ', '.join(json.dumps(n) for n in missing))
    fields.update({
        'group_name': jit['group_name_attribute'], 'user_username': jit['user_name_attribute'],
        'user_lastname': jit['user_lastname_attribute'],
        'provision_groups': [{'name': entry['saml_group'], 'roleid': roles[entry['role']]['roleid'],
                              'user_groups': list(entry['user_groups'])} for entry in jit['groups']],
        'provision_media': [{'name': entry['name'], 'mediatypeid': mediatypes[entry['mediatype']]['mediatypeid'],
                             'attribute': entry['attribute']} for entry in jit['media']],
    })
    check_deprovisioned_group(client, token, jit['deprovisioned_group'])
    return fields, jit['deprovisioned_group'], {name: row['usrgrpid'] for name, row in groups.items()}


def resolve_provision_groups(client, token, fields, usrgrpids):
    """Replace the user group names in provision_groups with their usrgrpids (after converge_user_groups).

    Only the names that did not exist during desired_userdirectory are read again.
    """
    if 'provision_groups' not in fields:
        return fields
    names = sorted({name for entry in fields['provision_groups'] for name in entry['user_groups']})
    pending = [name for name in names if name not in usrgrpids]
    if pending:
        found = usergroups_by_name(client, token, pending)
        missing = [name for name in pending if name not in found]
        if missing:
            raise HelperError('User group(s) not found: %s.' % ', '.join(json.dumps(n) for n in missing))
        usrgrpids = dict(usrgrpids, **{name: row['usrgrpid'] for name, row in found.items()})
    fields['provision_groups'] = [
        dict(entry, user_groups=[{'usrgrpid': usrgrpids[name]} for name in entry['user_groups']])
        for entry in fields['provision_groups']]
    return fields


# --- managed user groups ---------------------------------------------------------------

def plan_user_groups(client, token, user_groups):
    """Read-only: what converge_user_groups changes so that the listed groups have exactly the listed rights.

    Returns {'create': [{name, hostgroup_rights}], 'update': [{usrgrpid, name, hostgroup_rights}],
    'hostgroups': {host group name: groupid}, 'diff': {group name: rights_difference}}. "all" means every host
    group that exists at this run, minus exclude_hostgroups. Missing host groups, disabled or frontend-disabled
    groups and deny rights that would be replaced without replace_denied fail here, before anything is changed.
    No request is made for an empty list.
    """
    plan = {'create': [], 'update': [], 'hostgroups': {}, 'diff': {}}
    if not user_groups:
        return plan
    hostgroups = {}
    for row in client.require_list('hostgroup.get', {'output': ['groupid', 'name']}, token):
        if not isinstance(row.get('name'), str) or row.get('groupid') in (None, ''):
            raise HelperError('Zabbix API hostgroup.get returned an unexpected result.')
        if row['name'] in hostgroups:
            raise HelperError('Host group "%s" exists more than once.' % row['name'])
        hostgroups[row['name']] = str(row['groupid'])
    plan['hostgroups'] = hostgroups
    hostgroup_names = {groupid: name for name, groupid in hostgroups.items()}
    missing = sorted({name for entry in user_groups
                      for name in (entry['exclude_hostgroups'] if entry['hostgroups'] == ALL_HOSTGROUPS
                                   else entry['hostgroups'])
                      if name not in hostgroups})
    if missing:
        raise HelperError('Host group(s) not found: %s. Nothing was changed.'
                          % ', '.join(json.dumps(n) for n in missing))
    names = [entry['name'] for entry in user_groups]
    rows = client.require_list('usergroup.get', {'output': ['usrgrpid', 'name', 'gui_access', 'users_status'],
                                                 'selectHostGroupRights': 'extend',
                                                 'filter': {'name': sorted(names)}}, token)
    wanted = {name.lower(): name for name in names}
    current = {}
    for row in rows:
        name = row.get('name')
        if name in names:
            if name in current:
                raise HelperError('User group "%s" exists more than once.' % name)
            current[name] = row
        elif isinstance(name, str) and name.lower() in wanted:
            # A case-insensitive collation: the listed name would collide with this group.
            raise HelperError('User group "%s" exists with another letter case. Nothing was changed.'
                              % wanted[name.lower()])
    for row in current.values():
        if str(row.get('users_status')) == GROUP_STATUS_DISABLED or \
                str(row.get('gui_access')) == GROUP_GUI_ACCESS_DISABLED:
            raise HelperError('User group "%s" is disabled or has frontend access disabled; it is not managed through '
                              'saml user_groups. Nothing was changed.' % row['name'])
    for entry in user_groups:
        if entry['hostgroups'] == ALL_HOSTGROUPS:
            excluded = {hostgroups[name] for name in entry['exclude_hostgroups']}
            ids = set(hostgroups.values()) - excluded
        else:
            ids = {hostgroups[name] for name in entry['hostgroups']}
        permission = USER_GROUP_PERMISSIONS[entry['permission']]
        rights = [{'id': groupid, 'permission': permission} for groupid in sorted(ids, key=lambda i: (len(i), i))]
        desired = {groupid: str(permission) for groupid in ids}
        row = current.get(entry['name'])
        if row is None:
            plan['create'].append({'name': entry['name'], 'hostgroup_rights': rights})
            plan['diff'][entry['name']] = rights_difference({}, desired, hostgroup_names, created=True)
            continue
        existing = row.get('hostgroup_rights')
        if not isinstance(existing, list) or not all(isinstance(right, dict) for right in existing):
            raise HelperError('Zabbix API usergroup.get returned unexpected host group rights.')
        pairs = [(str(right.get('id')), str(right.get('permission'))) for right in existing]
        if sorted(pairs) == sorted(desired.items()):
            continue
        before = dict(pairs)
        denied = sorted(hostgroup_names.get(groupid, 'id ' + groupid) for groupid, value in before.items()
                        if value == PERMISSION_DENY)
        if denied and not entry['replace_denied']:
            raise HelperError('User group "%s" has deny rights on %d host group(s) (%s) that the listed rights would '
                              'remove or change. Set replace_denied: true on this entry to allow it. Nothing was '
                              'changed.' % (entry['name'], len(denied), ', '.join(json.dumps(n) for n in denied)))
        plan['update'].append({'usrgrpid': row['usrgrpid'], 'name': entry['name'], 'hostgroup_rights': rights})
        plan['diff'][entry['name']] = rights_difference(before, desired, hostgroup_names)
    return plan


def rights_difference(before, after, hostgroup_names, created=False):
    """Added, removed and changed host group rights by host group name (permission names, no secrets)."""
    def label(groupid):
        return hostgroup_names.get(groupid, 'id ' + groupid)

    def permission(value):
        return PERMISSION_NAMES.get(value, value)

    return {
        'created': created,
        'added': sorted(({'hostgroup': label(i), 'permission': permission(after[i])} for i in after if i not in before),
                        key=lambda row: row['hostgroup']),
        'removed': sorted(({'hostgroup': label(i), 'permission': permission(before[i])}
                           for i in before if i not in after), key=lambda row: row['hostgroup']),
        'changed': sorted(({'hostgroup': label(i), 'before': permission(before[i]), 'after': permission(after[i])}
                           for i in after if i in before and before[i] != after[i]),
                          key=lambda row: row['hostgroup']),
    }


def converge_user_groups(client, token, plan):
    """Create the missing groups and set the host group rights of the others exactly as listed.

    Only hostgroup_rights is sent: template group rights, members and frontend access are left alone.
    Returns the names of the changed groups.
    """
    changed = []
    total = len(plan['create']) + len(plan['update'])
    try:
        for entry in plan['create']:
            client.require('usergroup.create', {'name': entry['name'], 'hostgroup_rights': entry['hostgroup_rights']},
                           token)
            changed.append(entry['name'])
        for entry in plan['update']:
            client.require('usergroup.update', {'usrgrpid': entry['usrgrpid'],
                                                'hostgroup_rights': entry['hostgroup_rights']}, token)
            changed.append(entry['name'])
    except HelperError as error:
        raise HelperError('%s (%d of %d user groups were changed; run again to finish).'
                          % (error, len(changed), total)) from None
    return changed


def check_deprovisioned_group(client, token, name):
    """The existing disabled group for deprovisioned JIT users, or None when it must be created."""
    group = usergroups_by_name(client, token, [name]).get(name)
    if group is not None and str(group.get('users_status')) != GROUP_STATUS_DISABLED:
        raise HelperError('User group "%s" (deprovisioned_group) exists but is enabled; it must be disabled. '
                          'Nothing was changed.' % name)
    return group


def deprovisioned_group(client, token, name):
    """usrgrpid of the disabled group for deprovisioned JIT users; created (disabled) when missing."""
    group = check_deprovisioned_group(client, token, name)
    if group is None:
        result = client.require('usergroup.create', {'name': name, 'users_status': int(GROUP_STATUS_DISABLED)},
                                token)
        return result['usrgrpids'][0]
    return group['usrgrpid']


def _normalized_groups(rows):
    return sorted((str(row.get('name')), str(row.get('roleid')),
                   tuple(sorted(str(g.get('usrgrpid')) for g in (row.get('user_groups') or []))))
                  for row in rows or [])


def _normalized_media(rows):
    return sorted((str(row.get('name')), str(row.get('mediatypeid')), str(row.get('attribute')))
                  for row in rows or [])


def userdirectory_difference(current, fields):
    changed = {}
    for key, value in fields.items():
        if key == 'provision_groups':
            if _normalized_groups(current.get(key)) != _normalized_groups(value):
                changed[key] = value
        elif key == 'provision_media':
            if _normalized_media(current.get(key)) != _normalized_media(value):
                changed[key] = value
        elif str(current.get(key)) != str(value):
            changed[key] = value
    return changed


def legacy_manual_users(client, token, saml_userdirectoryid):
    """Number of non-SAML users (internal or another user directory such as LDAP) with an e-mail-like name."""
    rows = client.require_list('user.get', {'output': ['userid', 'username', 'userdirectoryid'],
                                            'search': {'username': '@'}}, token)
    return len([row for row in rows if '@' in str(row.get('username'))
                and str(row.get('userdirectoryid')) != str(saml_userdirectoryid)])


def converge_saml(client, token, saml, fields, deprovisioned):
    """Converge the SAML userdirectory, the manual user check and authentication. Returns a fragment."""
    disabled_usrgrpid = deprovisioned_group(client, token, deprovisioned) if deprovisioned is not None else None
    directories = client.require_list('userdirectory.get', {
        'output': 'extend', 'selectProvisionGroups': 'extend', 'selectProvisionMedia': 'extend',
        'filter': {'idp_type': IDP_TYPE_SAML}}, token)
    if len(directories) > 1:
        raise HelperError('More than one SAML user directory exists.')
    changed = []
    if not directories:
        result = client.require('userdirectory.create', dict(fields, idp_type=IDP_TYPE_SAML), token)
        userdirectoryid = result['userdirectoryids'][0]
        changed.append('userdirectory')
    else:
        userdirectoryid = directories[0]['userdirectoryid']
        update = userdirectory_difference(directories[0], fields)
        if update:
            client.require('userdirectory.update', dict(update, userdirectoryid=userdirectoryid), token)
            changed.append('userdirectory')
    auth = client.require('authentication.get', {'output': ['saml_auth_enabled', 'saml_case_sensitive',
                                                            'saml_jit_status', 'disabled_usrgrpid']}, token)
    if not isinstance(auth, dict):
        raise HelperError('Zabbix API authentication.get returned an unexpected result.')
    # Users with the same name as an e-mail address can sign in through SAML with their old role
    # (the frontend logs in by name regardless of the user directory), so SAML must not stay enabled.
    if not saml['allow_legacy_users']:
        count = legacy_manual_users(client, token, userdirectoryid)
        if count:
            if str(auth.get('saml_auth_enabled')) != '0':
                # Fail closed: SAML may still be on from an earlier run (e.g. the validation period).
                client.require('authentication.update', {'saml_auth_enabled': 0}, token)
                state = 'SAML login was enabled and has been disabled now'
            else:
                state = 'SAML login stays disabled'
            raise HelperError('%d non-SAML user(s) have an "@" in their name and could sign in through SAML with '
                              'their current role. Delete them with zabbix_web_saml_local_users first '
                              '(zabbix_web_saml_allow_legacy_users: true is only for the validation period). %s.'
                              % (count, state))
    desired = {'saml_auth_enabled': 1, 'saml_case_sensitive': _flag(saml['case_sensitive']),
               'saml_jit_status': _flag(saml['jit']['enabled'])}
    if disabled_usrgrpid is not None:
        desired['disabled_usrgrpid'] = disabled_usrgrpid
    update = {key: value for key, value in desired.items() if str(auth.get(key)) != str(value)}
    if update:
        client.require('authentication.update', update, token)
        changed.append('authentication')
    updated = converge_autologout(client, token, userdirectoryid, saml['autologout'])
    return {'saml_changed': changed, 'autologout_updated': updated}


def converge_autologout(client, token, userdirectoryid, autologout):
    """Set autologout of every user provisioned by the SAML directory (JIT users)."""
    if autologout == '':
        return 0
    seconds = autologout_seconds(autologout)
    rows = client.require_list('user.get', {'output': ['userid', 'autologout', 'userdirectoryid'],
                                            'filter': {'userdirectoryid': userdirectoryid}}, token)
    updated = 0
    for row in rows:
        if str(row.get('userdirectoryid')) != str(userdirectoryid):
            continue
        if autologout_seconds(str(row.get('autologout'))) != seconds:
            client.require('user.update', {'userid': row['userid'], 'autologout': autologout}, token)
            updated += 1
    return updated


def disable_saml(client, token):
    auth = client.require('authentication.get', {'output': ['saml_auth_enabled']}, token)
    if not isinstance(auth, dict):
        raise HelperError('Zabbix API authentication.get returned an unexpected result.')
    if str(auth.get('saml_auth_enabled')) == '0':
        return {'saml_changed': []}
    client.require('authentication.update', {'saml_auth_enabled': 0}, token)
    return {'saml_changed': ['authentication']}


def run(config, redact):
    plan = validate_config(config)
    redact.add(config['password'])
    redact.add(config['previous_password'])
    redact.add(plan['api_token'])
    client = Client(config['port'], config['server_name'], redact)
    check_version(client, config['version'])
    saml = plan['saml']
    saml_enabled = bool(saml and saml['enabled'])
    if saml_enabled:
        check_saml_version(client, config['version'])
    if not plan['api_token']:
        sessions = []
        try:
            token, password_changed = converge_password(client, config['password'],
                                                        config['previous_password'], sessions)
            changed_keys = converge_housekeeping(client, plan['housekeeping'], token)
            extra = bootstrap_service_user(client, token, plan['token_output_path'], redact) \
                if saml_enabled else {}
        finally:
            for session in reversed(sessions):
                client.logout(session)
        result = {'changed': password_changed or bool(changed_keys) or bool(extra),
                  'password_changed': password_changed, 'housekeeping_changed': changed_keys}
        result.update(extra)
        return result
    # API token of the service user: no user.login, no logout, no Admin password convergence.
    token = plan['api_token']
    result, error = client.call('usergroup.get', {'output': ['usrgrpid'], 'limit': 1}, token)
    if error is not None or not isinstance(result, list):
        raise HelperError('zabbix_web_api_token was rejected by the Zabbix API (expired, disabled or deleted): %s'
                          % client.describe(error))
    changed_keys = converge_housekeeping(client, plan['housekeeping'], token)
    result = {'changed': bool(changed_keys), 'password_changed': False, 'housekeeping_changed': changed_keys}
    if saml_enabled:
        # Order: read-only prerequisites (user group plan, SAML names) -> user groups (re-runnable) ->
        # one-time procedure (irreversible; delete before enable) -> provision group IDs -> manual user check ->
        # enable SAML.
        groups_plan = plan_user_groups(client, token, saml['user_groups'])
        fields, deprovisioned, usrgrpids = desired_userdirectory(
            client, token, saml, frozenset(entry['name'] for entry in groups_plan['create']))
        changed_groups = converge_user_groups(client, token, groups_plan)
        if saml['user_groups']:
            result['user_groups_changed'] = changed_groups
            result['user_groups_diff'] = {name: groups_plan['diff'][name] for name in changed_groups}
            result['changed'] |= bool(changed_groups)
        fragment = apply_local_users_once(client, token, saml['local_users'])
        result['changed'] |= fragment.pop('local_users_changed', False)
        result.update(fragment)
        resolve_provision_groups(client, token, fields, usrgrpids)
        fragment = converge_saml(client, token, saml, fields, deprovisioned)
        result['changed'] |= bool(fragment['saml_changed']) or bool(fragment['autologout_updated'])
        result.update(fragment)
    elif saml is not None:
        fragment = disable_saml(client, token)
        result['changed'] |= bool(fragment['saml_changed'])
        result.update(fragment)
    if plan['admin_lockdown']:
        locked = lockdown_admin(client, token, redact, plan['admin_lockdown_delete_tokens'])
        result['changed'] |= locked
        result['admin_locked_down'] = locked
    return result


def main(argv):
    redact = Redactor()
    try:
        if len(argv) != 2:
            raise HelperError('Usage: ai-support-zabbix-api.py <root-only JSON file>')
        try:
            with open(argv[1], encoding='utf-8') as handle:
                config = json.load(handle)
        except (OSError, ValueError):
            raise HelperError('Could not read the helper input file.') from None
        print(json.dumps(run(config, redact)))
        return 0
    except HelperError as error:
        print(redact(str(error)), file=sys.stderr)
        return error.code
    except Exception as error:  # pragma: no cover - defensive; never print the repr
        print('Zabbix API helper failed unexpectedly (%s).' % type(error).__name__, file=sys.stderr)
        return EXIT_ERROR


if __name__ == '__main__':
    sys.exit(main(sys.argv))
