#!/usr/bin/python3
"""Bootstrap an empty Zabbix DB, preserving existing and incomplete databases.

The caller supplies a root-only JSON credentials file, never argv credentials.
Errors deliberately omit driver/CLI output, which can contain credentials/SQL.

Modes (argv[2:]):
  (none)         initialize an empty DB, then verify completion
  --plan         read-only state check (no lock, no writes). Run before any
                 PostgreSQL setting change or restart so that a wrong
                 zabbix_server_db_timescaledb for an existing DB fails first
  --verify-only  verify completion without initializing

TimescaleDB (PostgreSQL only, design doc section 4.1): the packaged server.sql
ends with its own COMMIT, so server.sql and the TimescaleDB script cannot share
one psql --single-transaction. They are imported in two atomic steps instead,
with the marker table TIMESCALE_MARKER created in the first step and dropped in
the second. A failure in the second step leaves the marker, and the next run
retries only the TimescaleDB step.
"""
import gzip
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile


class DatabaseSetupError(Exception):
    pass


TIMESCALE_MARKER = '_ai_support_zabbix_timescaledb_pending'
# Relative to the engine directory (/usr/share/zabbix-sql-scripts/postgresql).
TIMESCALE_SCRIPTS = {'6.0': 'timescaledb.sql', '7.0': 'timescaledb/schema.sql'}
# Hypertables both LTS scripts create. 7.0 also creates history_bin and auditlog;
# the full expected set is always read from the packaged script.
BASE_HYPERTABLES = {'history', 'history_uint', 'history_str', 'history_log', 'history_text', 'trends', 'trends_uint'}
MANUAL_MIGRATION = ('Converting an existing Zabbix DB to TimescaleDB is not automated: stop Zabbix server and frontend, '
                    'back up the DB, run CREATE EXTENSION timescaledb CASCADE as postgres and the packaged TimescaleDB '
                    'script as the Zabbix DB user, then start Zabbix (see ZABBIX.md).')


def lock_name(database):
    # MySQL advisory lock names have a 64-character limit.
    return 'ai-support-zabbix:' + hashlib.sha256(database.encode()).hexdigest()[:40]


def connect(config):
    try:
        if config['engine'] == 'postgresql':
            import psycopg2
            connection = psycopg2.connect(host=config['host'], port=config['port'],
                                         dbname=config['database'], user=config['user'],
                                         password=config['password'], connect_timeout=10,
                                         options='-csearch_path=public')
        else:
            import pymysql
            connection = pymysql.connect(host=config['host'], port=config['port'],
                                         database=config['database'], user=config['user'],
                                         password=config['password'], charset='utf8mb4',
                                         connect_timeout=10, read_timeout=30, write_timeout=30)
        if config['engine'] == 'postgresql':
            connection.autocommit = True
        else:
            connection.autocommit(True)
        return connection
    except Exception:
        raise DatabaseSetupError('DB connection failed. Check credentials, driver, host, port and DB grants.') from None


def table_names(connection, engine):
    with connection.cursor() as cursor:
        if engine == 'postgresql':
            cursor.execute("SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname='public'")
        else:
            cursor.execute("SELECT table_name FROM information_schema.tables WHERE table_schema=DATABASE() AND table_type='BASE TABLE'")
        return {row[0] for row in cursor.fetchall()}


def expected_tables(schema):
    return set(re.findall(r'CREATE\s+TABLE\s+["`]?([a-z_][a-z_0-9]*)', schema, re.IGNORECASE))


def expected_hypertables(script):
    return set(re.findall(r"create_hypertable\(\s*'(\w+)'", script))


def read_sql(path):
    opener = gzip.open if str(path).endswith('.gz') else open
    with opener(path, 'rt', encoding='utf-8') as source:
        return source.read()


def inspect(connection, config, tables, importing=False):
    actual = table_names(connection, config['engine'])
    if not actual:
        return 'empty'
    if (not importing and '_ai_support_zabbix_import' in actual) or not tables.issubset(actual):
        raise DatabaseSetupError('Incomplete DB schema. Inspect and restore the DB; MySQL failed imports require recreating the dedicated DB before retrying.')
    with connection.cursor() as cursor:
        cursor.execute('SELECT mandatory, optional FROM dbversion')
        versions = cursor.fetchall()
        lower = {'6.0': 6000000, '7.0': 7000000}[config['version']]
        if len(versions) != 1 or not (lower <= versions[0][0] <= versions[0][1] < lower + 100000):
            raise DatabaseSetupError('DB version does not match the selected LTS. In-place LTS upgrades/downgrades require a separate backed-up upgrade procedure.')
        for table in ('users', 'config'):
            cursor.execute('SELECT COUNT(*) FROM ' + table)
            if cursor.fetchone()[0] < 1:
                raise DatabaseSetupError('Initial DB seed data is missing. Inspect and restore the DB before retrying.')
    return 'timescaledb_pending' if config['engine'] == 'postgresql' and TIMESCALE_MARKER in actual else 'ready'


def timescale_info(connection):
    """Read the TimescaleDB extension, license and hypertables. Read-only."""
    with connection.cursor() as cursor:
        cursor.execute("SELECT extversion FROM pg_catalog.pg_extension WHERE extname='timescaledb'")
        row = cursor.fetchone()
        if row is None:
            return {'extension': False, 'extversion': None, 'license': None, 'hypertables': set()}
        # NULL instead of an error when the library is not loaded.
        cursor.execute("SELECT current_setting('timescaledb.license', true)")
        license_name = cursor.fetchone()[0]
        cursor.execute("SELECT hypertable_name FROM timescaledb_information.hypertables WHERE hypertable_schema='public'")
        return {'extension': True, 'extversion': row[0], 'license': license_name,
                'hypertables': {r[0] for r in cursor.fetchall()}}


def db_extension(connection):
    with connection.cursor() as cursor:
        cursor.execute('SELECT db_extension FROM config')
        values = {row[0] or '' for row in cursor.fetchall()}
    if len(values) != 1:
        raise DatabaseSetupError('Unexpected Zabbix config rows. Inspect and restore the DB before retrying.')
    return values.pop()


def require_community(info):
    if not info['extension']:
        raise DatabaseSetupError('zabbix_server_db_timescaledb is true but the timescaledb extension does not exist in the Zabbix DB. '
                                 'For an external DB, ask the DBA to run CREATE EXTENSION timescaledb (Community edition) in it first.')
    if info['license'] != 'timescale':
        raise DatabaseSetupError('The TimescaleDB extension is not the Community edition (timescaledb.license is not timescale). '
                                 'The Apache edition has no compression and is not supported by this role.')


def classify_timescale(connection, state, info, expected):
    """Return 'plain' or 'timescaledb' for an initialized PostgreSQL DB, or raise."""
    extension_name = db_extension(connection)
    hypertables = info['hypertables']
    if state == 'timescaledb_pending':
        if extension_name or hypertables:
            raise DatabaseSetupError('An interrupted TimescaleDB initialization left an inconsistent DB. Inspect and restore the DB before retrying.')
        return 'pending'
    if not extension_name and not hypertables:
        return 'plain'
    if extension_name == 'timescaledb' and not info['extension']:
        raise DatabaseSetupError('config.db_extension is timescaledb but the timescaledb extension is missing. Restore the extension or the DB before retrying.')
    if extension_name == 'timescaledb' and expected().issubset(hypertables):
        return 'timescaledb'
    raise DatabaseSetupError('Incomplete or inconsistent TimescaleDB setup (config.db_extension and hypertables do not match). '
                             'Inspect and restore the DB manually before retrying.')


def check_policy(kind, info, want):
    """Apply the design's decision table to an initialized DB."""
    if kind == 'plain' and want:
        raise DatabaseSetupError('zabbix_server_db_timescaledb is true but the DB already holds a regular (non-TimescaleDB) Zabbix schema. '
                                 + MANUAL_MIGRATION)
    if kind in ('timescaledb', 'pending') and not want:
        raise DatabaseSetupError('The DB is a TimescaleDB Zabbix DB (or an interrupted TimescaleDB initialization). '
                                 'Set zabbix_server_db_timescaledb: true; disabling TimescaleDB is not supported by this role.')
    if want:
        require_community(info)


def import_sql(config, sql_text):
    # CLI clients perform SQL parsing. Do not split scripts on semicolons:
    # MySQL triggers and routines contain delimiters of their own.
    with tempfile.TemporaryDirectory(prefix='ai-support-zabbix-db-') as directory:
        credentials = Path(directory) / 'credentials'
        sql = Path(directory) / 'import.sql'
        sql.write_text(sql_text, encoding='utf-8')
        sql.chmod(0o600)
        env = os.environ.copy()
        if config['engine'] == 'postgresql':
            def pg_escape(value):
                return str(value).replace('\\', '\\\\').replace(':', '\\:')
            credentials.write_text(':'.join(pg_escape(config[k]) for k in ('host', 'port', 'database', 'user', 'password')) + '\n')
            env['PGPASSFILE'] = str(credentials)
            env['PGOPTIONS'] = '-csearch_path=public'
            env.pop('PGPASSWORD', None)
            command = ['psql', '-X', '--no-password', '--set=ON_ERROR_STOP=1', '--single-transaction',
                       '--host', config['host'], '--port', str(config['port']), '--username', config['user'],
                       '--dbname', config['database'], '--file', str(sql)]
        else:
            def mysql_escape(value):
                return str(value).replace('\\', '\\\\').replace('"', '\\"')
            credentials.write_text('[client]\n' + '\n'.join(k + '="' + mysql_escape(config[source]) + '"'
                                  for k, source in [('host', 'host'), ('port', 'port'), ('user', 'user'), ('password', 'password')]) + '\n')
            env.pop('MYSQL_PWD', None)
            command = ['mysql', '--defaults-file=' + str(credentials), '--protocol=TCP',
                       '--default-character-set=utf8mb4', '--binary-mode', config['database']]
        credentials.chmod(0o600)
        with sql.open('rb') as source:
            result = subprocess.run(command, stdin=source, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                    env=env, timeout=600, check=False)
        if result.returncode:
            raise DatabaseSetupError('SQL import failed. Check DB privileges and SQL compatibility; MySQL also requires log_bin_trust_function_creators=1 when binary logging is enabled. Inspect/restore the DB before retrying.')


def import_schema(config, schema):
    import_sql(config, schema)


def bootstrap(config, schema_path, verify_only=False, plan=False):
    connection = None
    want = bool(config.get('timescaledb', False))
    script_cache = {}

    def timescale_script():
        if 'text' not in script_cache:
            path = Path(schema_path).parent / TIMESCALE_SCRIPTS[config['version']]
            try:
                script_cache['text'] = read_sql(path)
            except OSError:
                raise DatabaseSetupError('The packaged TimescaleDB SQL script is missing.') from None
            if not BASE_HYPERTABLES.issubset(expected_hypertables(script_cache['text'])):
                raise DatabaseSetupError('The packaged TimescaleDB SQL script does not create the expected hypertables.')
        return script_cache['text']

    def expected():
        return expected_hypertables(timescale_script())

    try:
        if want and config['engine'] != 'postgresql':
            raise DatabaseSetupError('zabbix_server_db_timescaledb requires PostgreSQL.')
        schema = read_sql(schema_path)
        tables = expected_tables(schema)
        if not {'dbversion', 'users', 'config', 'hosts', 'items'}.issubset(tables):
            raise DatabaseSetupError('The packaged SQL script is not a complete Zabbix server schema.')
        if want:
            timescale_script()
        connection = connect(config)
        if not plan:
            with connection.cursor() as cursor:
                if config['engine'] == 'postgresql':
                    cursor.execute('SELECT pg_try_advisory_lock(hashtext(%s))', (lock_name(config['database']),))
                else:
                    cursor.execute('SELECT GET_LOCK(%s, 0)', (lock_name(config['database']),))
                if not cursor.fetchone()[0]:
                    raise DatabaseSetupError('Another Zabbix DB setup is running. Retry after it completes.')
        state = inspect(connection, config, tables)
        info = timescale_info(connection) if config['engine'] == 'postgresql' else None
        result = {'changed': False, 'state': state, 'timescaledb': want}
        if info is not None:
            result.update(extversion=info['extversion'], license=info['license'])

        if state != 'empty' and info is not None:
            check_policy(classify_timescale(connection, state, info, expected), info, want)
        elif state == 'empty' and want and info['extension']:
            # In local mode the extension is created after --plan; check it early when it already exists.
            require_community(info)

        if plan or state == 'ready':
            return result
        if verify_only:
            raise DatabaseSetupError('The DB is empty; it has not been initialized.' if state == 'empty'
                                     else 'The TimescaleDB initialization has not completed.')
        if want:
            require_community(info)
        if state == 'empty':
            if config['engine'] == 'mysql':
                # DDL cannot roll back. A marker also catches failures AFTER the
                # dbversion/seed rows have been written, including final SQL errors.
                with connection.cursor() as cursor:
                    cursor.execute('CREATE TABLE _ai_support_zabbix_import (id integer)')
            # PostgreSQL: one transaction, so a failure leaves an empty DB. With
            # TimescaleDB the marker is committed together with the schema.
            import_schema(config, ('CREATE TABLE ' + TIMESCALE_MARKER + ' (id integer);\n' if want else '') + schema)
            inspect(connection, config, tables, importing=True)
            if config['engine'] == 'mysql':
                with connection.cursor() as cursor:
                    cursor.execute('DROP TABLE _ai_support_zabbix_import')
        if want:
            # The TimescaleDB script has no transaction statements of its own,
            # so it and the marker removal commit (or roll back) together.
            import_sql(config, timescale_script() + '\n;\nDROP TABLE ' + TIMESCALE_MARKER + ';\n')
            if inspect(connection, config, tables) != 'ready':
                raise DatabaseSetupError('The TimescaleDB initialization did not complete. Inspect the DB before retrying.')
            info = timescale_info(connection)
            if classify_timescale(connection, 'ready', info, expected) != 'timescaledb':
                raise DatabaseSetupError('The TimescaleDB initialization did not create the expected hypertables. Inspect the DB before retrying.')
            result.update(extversion=info['extversion'], license=info['license'])
        result.update(changed=True, state='ready')
        return result
    except DatabaseSetupError:
        raise
    except Exception:
        raise DatabaseSetupError('DB setup failed. Check drivers, packaged SQL, client binaries, connectivity and grants. No existing data was automatically removed.') from None
    finally:
        if connection is not None:
            try:
                if config['engine'] == 'mysql' and not plan:
                    with connection.cursor() as cursor:
                        cursor.execute('SELECT RELEASE_LOCK(%s)', (lock_name(config['database']),))
            except Exception:
                # A lost connection already releases session locks. Preserve
                # the sanitized setup failure rather than exposing a driver error.
                pass
            finally:
                connection.close()


if __name__ == '__main__':
    try:
        config = json.loads(Path(sys.argv[1]).read_text())
        schema_path = '/usr/share/zabbix-sql-scripts/' + ('postgresql' if config['engine'] == 'postgresql' else 'mysql') + '/server.sql.gz'
        print(json.dumps(bootstrap(config, schema_path, '--verify-only' in sys.argv[2:], '--plan' in sys.argv[2:])))
    except Exception as error:
        message = str(error) if isinstance(error, DatabaseSetupError) else 'DB setup failed; check the root-only credentials file and packaged SQL script.'
        print(message, file=sys.stderr)
        sys.exit(1)
