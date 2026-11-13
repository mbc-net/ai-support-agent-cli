#!/usr/bin/python3
"""Sync the MBC SSO role assignments (PULL API) into the SAML JIT users of the local Zabbix frontend.

Usage is documented in ansible/ZABBIX.md (SAML, "MBC SSO の割り当ての同期（PULL）"). The zabbix_web role runs it
from a systemd timer:

    ai-support-zabbix-mbc-pull.py <settings JSON> <credentials JSON>

settings (root-only, 0600): port, scim_port, server_name, version, url, application_id
credentials (root-only, 0600): pull_key (<keyId>.<secret>), zabbix_api_token (the service user's API token)
state (mbc-pull.state next to the settings file, root-only, 0600, written by the script): salted hashes of the
changes applied in the last 24 hours, to detect changes that something else (a SAML login) keeps undoing

One run:
  1. GET <url>/pull/v1/applications/<application_id>/assignments. Anything but a well-formed 200 for this
     application (HTTP errors, timeouts, TLS errors, redirects, non-JSON, wrong applicationId, duplicate subjects,
     malformed entries) stops the run before Zabbix is contacted: nothing is changed. There is no retry; the next
     timer run tries again.
  2. Read the SAML setup and the SAML JIT users through the JSON-RPC API (read-only) and the SCIM groups.
  3. Plan. Only users of the SAML user directory are managed (users created by the MBC login through JIT). Admin,
     the API-only service user, Super admin users and users in a disabled user group other than the deprovisioned
     group are never touched. A user is "present" when the response lists their username with at least one role
     that is a saml_group of the JIT mapping; everybody else is "absent".
  4. Safety cap: if the run would deprovision every enabled managed user (also 1 of 1 and users: []), or more than
     half of them and more than one, nothing is changed.
  5. Apply through Zabbix's own SCIM endpoint (/api_scim.php on a dedicated loopback-only listener, scim_port, that
     a reverse proxy in front of the frontend port never forwards to). The JSON-RPC API refuses to
     change the role or the user groups of provisioned users, so the SCIM endpoint (the supported way for an IdP to
     change JIT users) is used; Zabbix then computes the user groups and the role from the JIT mapping exactly as on
     login:
       * absent and enabled -> PATCH /Users active=false (moved to the deprovisioned group, role removed; the user
         record, media and SCIM memberships stay)
       * present -> the SCIM group memberships of the mapped saml_group names are set to the user's roles
         (additions first, then removals, so that a role change never passes through "no role" = deprovisioned;
         between the two steps the user holds the old and the new roles), which re-provisions the user from the
         mapping
       * present and deprovisioned with unchanged memberships -> PATCH /Users active=true (Zabbix re-maps the
         stored memberships)
  6. Verify by reading the users again, and count the changes that repeat one applied in the last 24 hours
     ("reapplied"): a SAML login recomputes the user's groups from the assertion, so repeats mean that the IdP sends
     other roles than the PULL API or lets unassigned users in (see ZABBIX.md).

Exit codes: 0 done (also "nothing to do"), 2 invalid input or a Zabbix error, 5 the PULL API did not return a
usable response (nothing was changed), 6 the safety cap refused the run (nothing was changed).

Nothing written to stdout / stderr contains the PULL key, the Zabbix API token, an Authorization header or a user
identifier (username, subject or user ID): only counts, the applicationId and the keyId.

Standard library only: the target host runs the distribution python3. The Zabbix JSON-RPC client is the one of
the zabbix_web API helper (ai-support-zabbix-api.py), loaded from the same directory.
"""
import hashlib
import http.client
import importlib.util
import json
import os
import re
import secrets
import ssl
import sys
import time


def _load_helper():
    """The zabbix_web API helper (installed as ai-support-zabbix-api.py, zabbix_api.py in the repository)."""
    here = os.path.dirname(os.path.abspath(__file__))
    for name in ('ai-support-zabbix-api.py', 'zabbix_api.py'):
        path = os.path.join(here, name)
        if os.path.isfile(path):
            spec = importlib.util.spec_from_file_location('ai_support_zabbix_api', path)
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            return module
    print('The Zabbix API helper (ai-support-zabbix-api.py) was not found next to this script.', file=sys.stderr)
    sys.exit(2)


helper = _load_helper()
HelperError = helper.HelperError

# The PULL API. Literals on purpose: recipe variables can only pick an origin from this list.
PULL_HOSTS = ('sso.mbc-net.com',)
PULL_URL_PATTERN = re.compile(r'^https://([a-z0-9.-]+)/?\Z')
PULL_PATH = '/pull/v1/applications/%s/assignments'
# The server answers within its 55 s Lambda deadline (503 when it runs out); a little more than that.
PULL_TIMEOUT = 65
PULL_MAX_BYTES = 4 * 1024 * 1024
PULL_MAX_USERS = 10000
USER_AGENT = 'ai-support-zabbix-mbc-pull/1'
# Same rules as the server (packages/sso-contract APPLICATION_ID_PATTERN / ROLE_PATTERN, app-pull-keys).
APPLICATION_ID_PATTERN = re.compile(r'^(?=.{1,40}\Z)[a-z][a-z0-9]*(?:-[a-z0-9]+)*\Z')
PULL_KEY_PATTERN = re.compile(r'^(k[0-9a-f]{24})\.[A-Za-z0-9_-]{43}\Z')
ROLE_PATTERN = re.compile(r'^(?=.{1,40}\Z)[a-z][a-z0-9]*(?:[_-][a-z0-9]+)*\Z')
# SAML usernames of the MBC IdP: <local>+mbcawssso@<domain> or <local>+mbclocal@<domain>, lower case, max 100 bytes.
SUBJECT_PATTERN = re.compile(r'^[\x21-\x3f\x41-\x7e]+\+mbc(?:awssso|local)@[\x21-\x3f\x41-\x7e]+\Z')
SUBJECT_MAX_LENGTH = 100
SERVER_NAME_PATTERN = re.compile(r'^[A-Za-z0-9][A-Za-z0-9.-]*\Z')
VERSIONS = ('7.0', '8.0')

# Zabbix SCIM (ui/include/classes/scim). Same Host header and loopback port as the JSON-RPC helper.
SCIM_PATH = '/api_scim.php'
SCIM_USER_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:User'
SCIM_GROUP_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:Group'
SCIM_PATCH_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:PatchOp'
SCIM_LIST_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:ListResponse'
STATE_FILE = 'mbc-pull.state'
STATE_WINDOW = 24 * 3600
ID_PATTERN = re.compile(r'^[0-9]{1,20}\Z')

USER_TYPE_SUPER_ADMIN = helper.USER_TYPE_SUPER_ADMIN
PROTECTED_USERNAMES = (helper.USERNAME.lower(), helper.SERVICE_USERNAME.lower())

EXIT_OK = 0
EXIT_ERROR = helper.EXIT_ERROR
EXIT_PULL = 5
EXIT_SAFETY = 6


class UserVanished(Exception):
    """SCIM PATCH /Users answered 404: the user was deleted (or left the SAML directory) after the read."""


class PullUnavailable(HelperError):
    """The PULL API did not return a usable response; nothing may be changed."""

    def __init__(self, message):
        super().__init__(message, EXIT_PULL)


# --- input ---------------------------------------------------------------------------------------

def validate_input(settings, credentials):
    """Return the validated settings and secrets. Only field names are reported, never values."""
    if not isinstance(settings, dict) or not isinstance(credentials, dict):
        raise HelperError('Invalid input: the settings and credentials must be JSON objects.')
    if set(settings) != {'port', 'scim_port', 'server_name', 'version', 'url', 'application_id'}:
        raise HelperError('Invalid input: settings need exactly port, scim_port, server_name, version, url and '
                          'application_id.')
    if set(credentials) != {'pull_key', 'zabbix_api_token'}:
        raise HelperError('Invalid input: credentials need exactly pull_key and zabbix_api_token.')
    port, scim_port = settings['port'], settings['scim_port']
    for value in (port, scim_port):
        if isinstance(value, bool) or not isinstance(value, int) or not 0 < value < 65536:
            raise HelperError('Invalid input: port and scim_port must be TCP ports.')
    if port == scim_port:
        raise HelperError('Invalid input: scim_port must differ from port.')
    server_name = settings['server_name']
    if not isinstance(server_name, str) or not SERVER_NAME_PATTERN.match(server_name):
        raise HelperError('Invalid input: server_name must be a host name.')
    if settings['version'] not in VERSIONS:
        raise HelperError('Invalid input: version must be 7.0 or 8.0.')
    url = settings['url']
    match = PULL_URL_PATTERN.match(url) if isinstance(url, str) else None
    if not match or match.group(1) not in PULL_HOSTS:
        raise HelperError('Invalid input: url must be https://%s (no path, query or port).'
                          % ' or https://'.join(PULL_HOSTS))
    application_id = settings['application_id']
    if not isinstance(application_id, str) or not APPLICATION_ID_PATTERN.match(application_id):
        raise HelperError('Invalid input: application_id must be 1-40 characters of a-z, 0-9 and single hyphens, '
                          'starting with a letter.')
    pull_key = credentials['pull_key']
    key_match = PULL_KEY_PATTERN.match(pull_key) if isinstance(pull_key, str) else None
    if not key_match:
        raise HelperError('Invalid input: pull_key must be <keyId>.<secret> (k + 24 hex characters, a dot and 43 '
                          'base64url characters).')
    token = credentials['zabbix_api_token']
    if not isinstance(token, str) or not helper.API_TOKEN_PATTERN.match(token):
        raise HelperError('Invalid input: zabbix_api_token must be a Zabbix API token (64 hex characters).')
    return {'port': port, 'scim_port': scim_port, 'server_name': server_name, 'version': settings['version'],
            'host': match.group(1), 'application_id': application_id, 'pull_key': pull_key,
            'key_id': key_match.group(1), 'token': token}


# --- PULL API ------------------------------------------------------------------------------------

def https_connection(host):
    return http.client.HTTPSConnection(host, 443, timeout=PULL_TIMEOUT, context=ssl.create_default_context())


def fetch_assignments(config, connect=https_connection):
    """{subject: [roles]} from the PULL API, or PullUnavailable. Exactly one request, no retry, no redirect."""
    path = PULL_PATH % config['application_id']
    headers = {'Authorization': 'Bearer ' + config['pull_key'], 'Accept': 'application/json',
               'User-Agent': USER_AGENT}
    connection = connect(config['host'])
    try:
        connection.request('GET', path, headers=headers)
        response = connection.getresponse()
        status = response.status
        content_type = response.getheader('Content-Type') or ''
        raw = response.read(PULL_MAX_BYTES + 1)
    except (OSError, http.client.HTTPException, ValueError) as error:
        # ssl.SSLError and socket.timeout are OSErrors. Only the class name: messages may quote the request.
        raise PullUnavailable('The PULL request failed (%s).' % type(error).__name__) from None
    finally:
        connection.close()
    if status != 200:
        raise PullUnavailable('The PULL API returned HTTP %d.' % status)
    if len(raw) > PULL_MAX_BYTES:
        raise PullUnavailable('The PULL response is larger than %d bytes.' % PULL_MAX_BYTES)
    if content_type.split(';')[0].strip().lower() != 'application/json':
        raise PullUnavailable('The PULL response is not JSON (Content-Type).')
    try:
        payload = json.loads(raw.decode('utf-8'))
    except (UnicodeDecodeError, ValueError):
        raise PullUnavailable('The PULL response is not JSON.') from None
    return parse_assignments(payload, config['application_id'])


def parse_assignments(payload, application_id):
    """Validate the 200 body strictly; any malformed part rejects the whole response."""
    if not isinstance(payload, dict):
        raise PullUnavailable('The PULL response is not an object.')
    if payload.get('applicationId') != application_id:
        raise PullUnavailable('The PULL response is for another applicationId.')
    if not isinstance(payload.get('generatedAt'), str) or not payload['generatedAt']:
        raise PullUnavailable('The PULL response has no generatedAt.')
    users = payload.get('users')
    if not isinstance(users, list) or len(users) > PULL_MAX_USERS:
        raise PullUnavailable('The PULL response has no valid users list.')
    assignments = {}
    for entry in users:
        if not isinstance(entry, dict) or not {'subject', 'roles'} <= set(entry):
            raise PullUnavailable('The PULL response has a malformed users entry.')
        subject, roles = entry['subject'], entry['roles']
        if not isinstance(subject, str) or len(subject) > SUBJECT_MAX_LENGTH or subject != subject.lower() \
                or not SUBJECT_PATTERN.match(subject):
            raise PullUnavailable('The PULL response has a malformed subject.')
        if not isinstance(roles, list) or not roles or len(set(map(str, roles))) != len(roles) \
                or not all(isinstance(r, str) and ROLE_PATTERN.match(r) for r in roles):
            raise PullUnavailable('The PULL response has malformed roles.')
        if subject in assignments:
            raise PullUnavailable('The PULL response lists a subject more than once.')
        assignments[subject] = list(roles)
    return assignments


# --- Zabbix (JSON-RPC, read-only) ------------------------------------------------------------------

def read_zabbix(client, token):
    """The SAML setup, the user groups, the roles and the users of the SAML user directory."""
    auth = client.require('authentication.get', {'output': ['saml_auth_enabled', 'saml_jit_status',
                                                            'saml_case_sensitive', 'disabled_usrgrpid']}, token)
    if not isinstance(auth, dict):
        raise HelperError('Zabbix API authentication.get returned an unexpected result.')
    if str(auth.get('saml_auth_enabled')) != '1' or str(auth.get('saml_jit_status')) != '1':
        raise HelperError('SAML authentication and JIT provisioning must be enabled. Nothing was changed.')
    disabled_usrgrpid = str(auth.get('disabled_usrgrpid', ''))
    if not ID_PATTERN.match(disabled_usrgrpid) or disabled_usrgrpid == '0':
        raise HelperError('No deprovisioned user group is configured. Nothing was changed.')
    directories = [row for row in client.require_list('userdirectory.get', {
        'output': ['userdirectoryid', 'idp_type', 'provision_status', 'scim_status'],
        'selectProvisionGroups': 'extend', 'filter': {'idp_type': helper.IDP_TYPE_SAML}}, token)
        if str(row.get('idp_type')) == str(helper.IDP_TYPE_SAML)]
    if len(directories) != 1:
        raise HelperError('Expected exactly one SAML user directory, found %d. Nothing was changed.' % len(directories))
    directory = directories[0]
    if str(directory.get('provision_status')) != '1' or str(directory.get('scim_status')) != '1':
        raise HelperError('The SAML user directory must have JIT provisioning and SCIM enabled (the zabbix_web role '
                          'enables SCIM with zabbix_web_mbc_pull). Nothing was changed.')
    mapping = {}
    for row in directory.get('provision_groups') or []:
        name = row.get('name') if isinstance(row, dict) else None
        if not isinstance(name, str) or not name or '*' in name or name in mapping:
            raise HelperError('The SAML user directory has an unsupported group mapping (empty, duplicate or wildcard '
                              'names). Nothing was changed.')
        usrgrpids = [str(g.get('usrgrpid')) for g in row.get('user_groups') or [] if isinstance(g, dict)]
        if not ID_PATTERN.match(str(row.get('roleid'))) or not usrgrpids or not all(map(ID_PATTERN.match, usrgrpids)):
            raise HelperError('The SAML user directory has a malformed group mapping. Nothing was changed.')
        mapping[name] = (str(row['roleid']), frozenset(usrgrpids))
    if not mapping:
        raise HelperError('The SAML user directory has no group mapping. Nothing was changed.')
    roles = {}
    for row in client.require_list('role.get', {'output': ['roleid', 'name', 'type']}, token):
        roles[str(row.get('roleid'))] = {'name': str(row.get('name')), 'type': str(row.get('type'))}
    groups = {}
    for row in client.require_list('usergroup.get', {'output': ['usrgrpid', 'users_status']}, token):
        groups[str(row.get('usrgrpid'))] = str(row.get('users_status'))
    userdirectoryid = str(directory.get('userdirectoryid'))
    users = []
    for row in client.require_list('user.get', {'output': ['userid', 'username', 'roleid', 'userdirectoryid'],
                                                'selectUsrgrps': ['usrgrpid'],
                                                'filter': {'userdirectoryid': userdirectoryid}}, token):
        if str(row.get('userdirectoryid')) != userdirectoryid:
            continue
        if not isinstance(row.get('username'), str) or not ID_PATTERN.match(str(row.get('userid'))):
            raise HelperError('Zabbix API user.get returned an unexpected result.')
        users.append({'userid': str(row['userid']), 'username': row['username'], 'roleid': str(row.get('roleid')),
                      'usrgrps': frozenset(str(g.get('usrgrpid')) for g in row.get('usrgrps') or []
                                           if isinstance(g, dict))})
    return {'case_sensitive': str(auth.get('saml_case_sensitive')) == '1', 'disabled_usrgrpid': disabled_usrgrpid,
            'mapping': mapping, 'roles': roles, 'groups': groups, 'users': users}


def _int(value):
    return int(value) if value.isdigit() else 0


def expected_access(role_names, mapping, roles):
    """(roleid, user groups) Zabbix derives from the matched saml_group names (CProvisioning::getUserGroupsAndRole).

    Every matching mapping adds its user groups; the role is the one with the highest user type, then the first
    name (case-insensitive). Used to report drift only: the writes let Zabbix compute this itself.
    """
    matched = [mapping[name] for name in mapping if name in role_names]
    if not matched:
        return None
    usrgrps = frozenset().union(*(entry[1] for entry in matched))
    candidates = sorted({entry[0] for entry in matched if entry[0] in roles},
                        key=lambda roleid: (-_int(roles[roleid]['type']), roles[roleid]['name'].lower()))
    return (candidates[0] if candidates else '0'), usrgrps


# --- Zabbix (SCIM) ---------------------------------------------------------------------------------

class Scim:
    """Minimal client of the Zabbix SCIM endpoint on the loopback vhost (Bearer: the service user's API token)."""

    def __init__(self, port, server_name, token, connect=None):
        self.port = port
        self.server_name = server_name
        self.token = token
        self.connect = connect or (lambda: http.client.HTTPConnection('127.0.0.1', port, timeout=helper.TIMEOUT))
        self.writes = 0

    def call(self, method, resource, ident=None, body=None):
        path = SCIM_PATH + '/' + resource + ('/' + ident if ident is not None else '')
        headers = {'Host': self.server_name, 'Authorization': 'Bearer ' + self.token, 'Accept': 'application/json'}
        data = None
        if body is not None:
            headers['Content-Type'] = 'application/json'
            data = json.dumps(body).encode()
        connection = self.connect()
        try:
            connection.request(method, path, body=data, headers=headers)
            response = connection.getresponse()
            status = response.status
            raw = response.read()
        except (OSError, http.client.HTTPException) as error:
            raise HelperError('Zabbix SCIM %s %s request failed (%s). Check that the frontend answers on '
                              '127.0.0.1:%d.' % (method, resource, type(error).__name__, self.port)) from None
        finally:
            connection.close()
        # The error "detail" may quote user names; only the status is reported.
        if status == 404 and method == 'PATCH' and resource == 'Users':
            raise UserVanished()
        if status != 200:
            raise HelperError('Zabbix SCIM %s %s returned HTTP %d.' % (method, resource, status))
        if method != 'GET':
            self.writes += 1
        try:
            payload = json.loads(raw.decode('utf-8'))
        except (UnicodeDecodeError, ValueError):
            raise HelperError('Zabbix SCIM %s %s returned a response that is not JSON.' % (method, resource)) from None
        if not isinstance(payload, dict):
            raise HelperError('Zabbix SCIM %s %s returned an unexpected response.' % (method, resource))
        return payload

    def groups(self):
        """{displayName: (scim group id, {member user IDs})} of every SCIM group."""
        payload = self.call('GET', 'Groups')
        resources = payload.get('Resources')
        if SCIM_LIST_SCHEMA not in (payload.get('schemas') or []) or not isinstance(resources, list):
            raise HelperError('Zabbix SCIM GET Groups returned an unexpected response.')
        groups = {}
        for row in resources:
            if not isinstance(row, dict) or not isinstance(row.get('displayName'), str) \
                    or not ID_PATTERN.match(str(row.get('id'))) or not isinstance(row.get('members', []), list):
                raise HelperError('Zabbix SCIM GET Groups returned an unexpected group.')
            members = set()
            for member in row.get('members', []):
                if not isinstance(member, dict) or not ID_PATTERN.match(str(member.get('value'))):
                    raise HelperError('Zabbix SCIM GET Groups returned an unexpected member.')
                members.add(str(member['value']))
            if row['displayName'] in groups:
                raise HelperError('More than one SCIM group has the same name. Nothing was changed.')
            groups[row['displayName']] = (str(row['id']), members)
        return groups

    def set_active(self, userid, active):
        """False when the user no longer exists (404); other errors raise."""
        try:
            self.call('PATCH', 'Users', userid, {'schemas': [SCIM_PATCH_SCHEMA],
                                                 'Operations': [{'op': 'replace', 'path': 'active', 'value': active}]})
        except UserVanished:
            return False
        return True

    def change_members(self, groupid, op, userids):
        self.call('PATCH', 'Groups', groupid, {'schemas': [SCIM_PATCH_SCHEMA], 'Operations': [
            {'op': op, 'path': 'members', 'value': [{'value': userid} for userid in sorted(userids)]}]})

    def create_group(self, name, members):
        """members: [(userid, username)]. Only for a name GET Groups did not list: POST on an existing name would
        replace all its members, so the caller re-reads the groups right before."""
        self.call('POST', 'Groups', None, {'schemas': [SCIM_GROUP_SCHEMA], 'displayName': name,
                                           'members': [{'value': u, 'display': n} for u, n in sorted(members)]})


# --- plan ------------------------------------------------------------------------------------------

def plan_changes(assignments, state, scim_groups):
    """What to change, without changing anything. Raises when a username is ambiguous."""
    mapping, roles, groups = state['mapping'], state['roles'], state['groups']
    disabled = state['disabled_usrgrpid']
    case_sensitive = state['case_sensitive']
    lookup = assignments if case_sensitive else {s.lower(): r for s, r in assignments.items()}
    members = {name: scim_groups[name][1] if name in scim_groups else set() for name in mapping}
    plan = {'deprovision': [], 'restore': [], 'remove': {}, 'add': {}, 'usernames': {}, 'present': {},
            'counts': {'managed': 0, 'enabled': 0, 'protected': 0, 'skipped_disabled': 0, 'present': 0,
                       'absent': 0, 'already_deprovisioned': 0, 'unmapped_roles_only': 0, 'drift': 0}}
    counts = plan['counts']
    seen = set()
    known = {user['username'] if case_sensitive else user['username'].lower() for user in state['users']}
    for user in state['users']:
        role = roles.get(user['roleid'])
        if user['username'].lower() in PROTECTED_USERNAMES or (role and role['type'] == USER_TYPE_SUPER_ADMIN):
            counts['protected'] += 1
            continue
        if any(groups.get(g) == helper.GROUP_STATUS_DISABLED and g != disabled for g in user['usrgrps']):
            # Disabled by an administrator (another disabled group); the SAML login does not update them either.
            counts['skipped_disabled'] += 1
            continue
        key = user['username'] if case_sensitive else user['username'].lower()
        if key in seen:
            raise HelperError('Two SAML users have the same username ignoring case while SAML is case-insensitive. '
                              'Nothing was changed.')
        seen.add(key)
        counts['managed'] += 1
        deprovisioned = disabled in user['usrgrps']
        if not deprovisioned:
            counts['enabled'] += 1
        pulled = lookup.get(key)
        wanted = {name for name in (pulled or []) if name in mapping}
        if pulled and not wanted:
            counts['unmapped_roles_only'] += 1
        userid = user['userid']
        if not wanted:
            counts['absent'] += 1
            if deprovisioned:
                counts['already_deprovisioned'] += 1
            else:
                plan['deprovision'].append(userid)
            continue
        counts['present'] += 1
        plan['usernames'][userid] = user['username']
        plan['present'][userid] = wanted
        changed = False
        for name in mapping:
            if name in wanted and userid not in members[name]:
                plan['add'].setdefault(name, set()).add(userid)
                changed = True
            elif name not in wanted and userid in members[name]:
                plan['remove'].setdefault(name, set()).add(userid)
                changed = True
        if deprovisioned and not changed:
            plan['restore'].append(userid)
        elif not deprovisioned and not changed:
            expected = expected_access(wanted, mapping, roles)
            if expected != (user['roleid'], user['usrgrps']):
                counts['drift'] += 1
    counts['not_provisioned'] = len(set(lookup) - known)
    return plan


def safety_cap_exceeded(enabled, to_disable):
    """True when the run would disable all enabled managed users, or more than half of them and more than one."""
    if enabled == 0 or to_disable == 0:
        return False
    return to_disable >= enabled or (to_disable > 1 and to_disable * 2 > enabled)


def apply_plan(scim, plan, scim_groups, applied):
    """Deprovision first (removes access), then membership additions, removals and restores.

    Additions come before removals: a role change A -> B then passes through A+B (both roles, for the moment between
    two requests, or until the next run if the removal fails) instead of through "no role", which Zabbix turns into
    a deprovisioned user with ended sessions. At the end of a successful run every user holds exactly the PULL roles.
    Every applied change is appended to ``applied`` (as an internal key with user IDs; never printed). Returns the
    number of users that no longer exist (SCIM 404 on PATCH /Users), which are skipped.
    """
    vanished = 0
    for userid in plan['deprovision']:
        if scim.set_active(userid, False):
            applied.append('deprovision:%s' % userid)
        else:
            vanished += 1
    for name in sorted(plan['add']):
        if name not in scim_groups:
            scim_groups.update(scim.groups())
        if name in scim_groups:
            scim.change_members(scim_groups[name][0], 'add', plan['add'][name])
        else:
            scim.create_group(name, [(u, plan['usernames'][u]) for u in plan['add'][name]])
        applied.extend('add:%s:%s' % (name, u) for u in plan['add'][name])
    for name in sorted(plan['remove']):
        scim.change_members(scim_groups[name][0], 'remove', plan['remove'][name])
        applied.extend('remove:%s:%s' % (name, u) for u in plan['remove'][name])
    for userid in plan['restore']:
        if scim.set_active(userid, True):
            applied.append('restore:%s' % userid)
        else:
            vanished += 1
    return vanished


def load_state(path):
    """{'salt': str, 'applied': {hash: epoch}} from the state file; a fresh state when missing or unreadable."""
    try:
        with open(path, encoding='utf-8') as handle:
            state = json.load(handle)
        if isinstance(state, dict) and isinstance(state.get('salt'), str) and len(state['salt']) == 32 \
                and isinstance(state.get('applied'), dict) \
                and all(isinstance(v, int) and not isinstance(v, bool) for v in state['applied'].values()):
            return state
    except (OSError, ValueError):
        pass
    return {'salt': secrets.token_hex(16), 'applied': {}}


def record_changes(path, state, applied, now):
    """Count the changes that repeat one of the last 24 hours, then store this run's changes (hashes only)."""
    recent = {h: t for h, t in state['applied'].items() if now - t < STATE_WINDOW}
    hashes = {hashlib.sha256((state['salt'] + change).encode()).hexdigest() for change in applied}
    reapplied = len(hashes & set(recent))
    recent.update({h: now for h in hashes})
    data = json.dumps({'salt': state['salt'], 'applied': recent}, sort_keys=True)
    temporary = path + '.tmp'
    try:
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(descriptor, 'w', encoding='utf-8') as handle:
            handle.write(data)
        os.replace(temporary, path)
        saved = True
    except OSError:
        saved = False
    return reapplied, saved


def verify(client, token, plan):
    """Re-read the users. Returns (absent users still enabled, present users still deprovisioned, drift)."""
    state = read_zabbix(client, token)
    by_id = {user['userid']: user for user in state['users']}
    disabled = state['disabled_usrgrpid']
    still_enabled = sum(1 for u in plan['deprovision'] if u in by_id and disabled not in by_id[u]['usrgrps'])
    still_disabled = 0
    drift = 0
    for userid, wanted in plan['present'].items():
        user = by_id.get(userid)
        if user is None:
            continue
        if disabled in user['usrgrps']:
            still_disabled += 1
        elif expected_access(wanted, state['mapping'], state['roles']) != (user['roleid'], user['usrgrps']):
            drift += 1
    return still_enabled, still_disabled, drift


# --- run -------------------------------------------------------------------------------------------

def run(settings, credentials, redact, connect_pull=None, connect_scim=None, state_path=None, now=None):
    """Returns (exit code, summary). The summary holds counts, applicationId and keyId only."""
    config = validate_input(settings, credentials)
    redact.add(config['pull_key'])
    redact.add(config['pull_key'].split('.', 1)[1])
    redact.add(config['token'])
    summary = {'applicationId': config['application_id'], 'keyId': config['key_id'], 'changed': False}
    try:
        assignments = fetch_assignments(config, connect_pull or https_connection)
    except PullUnavailable as error:
        summary['error'] = '%s Nothing was changed.' % error
        return EXIT_PULL, summary
    summary['pull_users'] = len(assignments)
    client = helper.Client(config['port'], config['server_name'], redact)
    helper.check_version(client, config['version'])
    helper.check_saml_version(client, config['version'])
    token = config['token']
    result, error = client.call('usergroup.get', {'output': ['usrgrpid'], 'limit': 1}, token)
    if error is not None or not isinstance(result, list):
        raise HelperError('The Zabbix API token was rejected (expired, disabled or deleted): %s'
                          % client.describe(error))
    state = read_zabbix(client, token)
    scim = Scim(config['scim_port'], config['server_name'], token, connect_scim)
    scim_groups = scim.groups()
    plan = plan_changes(assignments, state, scim_groups)
    counts = plan['counts']
    summary.update(counts)
    summary.update({'deprovision': len(plan['deprovision']), 'restore': len(plan['restore']),
                    'role_changes': len({u for ids in list(plan['add'].values()) + list(plan['remove'].values())
                                         for u in ids})})
    if safety_cap_exceeded(counts['enabled'], len(plan['deprovision'])):
        summary['error'] = ('The run would deprovision %d of %d enabled MBC users (safety cap: all of them, or more '
                            'than half and more than one). Nothing was changed. Check the MBC application, its roles '
                            'and the JIT mapping.' % (len(plan['deprovision']), counts['enabled']))
        return EXIT_SAFETY, summary
    applied = []
    history = load_state(state_path) if state_path else None
    try:
        summary['vanished'] = apply_plan(scim, plan, scim_groups, applied)
    except HelperError as failure:
        if history is not None:
            record_changes(state_path, history, applied, int(now or time.time()))
        raise HelperError('%s (%d SCIM change(s) were applied before the failure; the next run continues).'
                          % (failure, scim.writes)) from None
    summary['scim_writes'] = scim.writes
    summary['changed'] = scim.writes > 0
    if history is not None:
        summary['reapplied'], saved = record_changes(state_path, history, applied, int(now or time.time()))
        if not saved:
            summary['warning'] = 'Could not write the state file; repeated changes are not detected.'
    still_enabled, still_disabled, drift = verify(client, token, plan)
    summary['drift'] = drift
    if still_enabled or still_disabled:
        summary['error'] = ('After the changes, %d absent user(s) are still enabled and %d present user(s) are still '
                            'deprovisioned.' % (still_enabled, still_disabled))
        return EXIT_ERROR, summary
    return EXIT_OK, summary


def read_json(path, what):
    try:
        with open(path, encoding='utf-8') as handle:
            return json.load(handle)
    except (OSError, ValueError):
        raise HelperError('Could not read the %s file.' % what) from None


def main(argv):
    redact = helper.Redactor()
    try:
        if len(argv) != 3:
            raise HelperError('Usage: ai-support-zabbix-mbc-pull.py <settings JSON> <credentials JSON>')
        code, summary = run(read_json(argv[1], 'settings'), read_json(argv[2], 'credentials'), redact,
                            state_path=os.path.join(os.path.dirname(os.path.abspath(argv[1])), STATE_FILE))
    except HelperError as error:
        print(redact(str(error)), file=sys.stderr)
        return error.code
    except Exception as error:  # pragma: no cover - defensive; never print the repr
        print('MBC PULL sync failed unexpectedly (%s).' % type(error).__name__, file=sys.stderr)
        return EXIT_ERROR
    if 'error' in summary:
        print(redact(summary['error']), file=sys.stderr)
    if summary.get('warning'):
        print(summary['warning'], file=sys.stderr)
    if summary.get('reapplied'):
        print('%d change(s) repeat a change applied in the last 24 hours: something else undoes them, usually a SAML '
              'login whose groups differ from the PULL roles or of a user the PULL API does not list. Check that the '
              'IdP sends the PULL roles and refuses unassigned users (ZABBIX.md).' % summary['reapplied'],
              file=sys.stderr)
    if summary.get('vanished'):
        print('%d user(s) were deleted while the run was in progress and were skipped.' % summary['vanished'],
              file=sys.stderr)
    if summary.get('drift'):
        print('%d present user(s) do not have the role and user groups of their JIT mapping (for example after the '
              'mapping was changed); Zabbix corrects them at their next login.' % summary['drift'], file=sys.stderr)
    print(redact(json.dumps(summary, sort_keys=True)))
    return code


if __name__ == '__main__':
    sys.exit(main(sys.argv))
