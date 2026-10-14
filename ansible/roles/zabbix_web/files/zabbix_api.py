#!/usr/bin/python3
"""Converge the Zabbix Admin password and housekeeping through the frontend API.

Design: admin-docs server-setup-monitoring-app-roles.md section 4.2.

The caller supplies a root-only JSON file (never argv / environment) with:
  port, server_name, version, password, previous_password, housekeeping

Exit codes:
  0  success; stdout is {"changed", "password_changed", "housekeeping_changed"}
  2  invalid input, transport/protocol error, version mismatch, API error
  3  no candidate password could log in as Admin
  4  the password was changed but logging in with the new password failed

Nothing written to stdout / stderr may contain a password or a session token
(also not Base64-encoded). Request bodies and exception reprs are never printed,
and API error texts are redacted before they are shown.

Standard library only: the target host runs the distribution python3.
"""
import http.client
import json
import re
import sys

# Literals on purpose: recipe variables must not be able to redirect these.
USERNAME = 'Admin'
INITIAL_PASSWORD = 'zabbix'
TIMEOUT = 10
API_PATH = '/api_jsonrpc.php'

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


def validate_config(config):
    if not isinstance(config, dict):
        raise HelperError('Invalid helper input.')
    port = config.get('port')
    if isinstance(port, bool) or not isinstance(port, int) or not 0 < port < 65536:
        raise HelperError('Invalid listen port.')
    for field in ('server_name', 'version', 'password', 'previous_password'):
        if not isinstance(config.get(field), str):
            raise HelperError('Invalid helper input: %s must be a string.' % field)
    if config['version'] not in ('6.0', '7.0'):
        raise HelperError('Unsupported Zabbix version.')
    password = config['password']
    if not re.match(r'^[\x20-\x7e]{8,72}\Z', password) or password != password.strip() \
            or password == INITIAL_PASSWORD:
        raise HelperError('zabbix_web_admin_password must be 8-72 printable ASCII characters without '
                          'leading/trailing spaces and must not be the initial password.')
    if not re.match(r'^[\x20-\x7e]{0,72}\Z', config['previous_password']):
        raise HelperError('zabbix_web_admin_previous_password must be 0-72 printable ASCII characters.')
    return validate_housekeeping(config.get('housekeeping', {}))


class Client:
    def __init__(self, port, server_name, redact):
        self.port = port
        self.server_name = server_name
        self.redact = redact
        self.bearer = False
        self.version = (0, 0)
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
        return self.redact(' '.join(parts) or 'unknown error')

    def require(self, method, params, token):
        result, error = self.call(method, params, token)
        if error is not None:
            raise HelperError('Zabbix API %s failed: %s' % (method, self.describe(error)))
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


def run(config, redact):
    desired = validate_config(config)
    redact.add(config['password'])
    redact.add(config['previous_password'])
    client = Client(config['port'], config['server_name'], redact)
    check_version(client, config['version'])
    sessions = []
    try:
        token, password_changed = converge_password(client, config['password'],
                                                    config['previous_password'], sessions)
        changed_keys = converge_housekeeping(client, desired, token)
    finally:
        for session in reversed(sessions):
            client.logout(session)
    return {'changed': password_changed or bool(changed_keys), 'password_changed': password_changed,
            'housekeeping_changed': changed_keys}


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
