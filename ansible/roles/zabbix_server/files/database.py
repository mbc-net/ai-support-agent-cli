#!/usr/bin/python3
"""Bootstrap an empty Zabbix DB, preserving existing and incomplete databases.

The caller supplies a root-only JSON credentials file, never argv credentials.
Errors deliberately omit driver/CLI output, which can contain credentials/SQL.
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
    return 'ready'


def import_schema(config, schema):
    # CLI clients perform SQL parsing. Do not split scripts on semicolons:
    # MySQL triggers and routines contain delimiters of their own.
    with tempfile.TemporaryDirectory(prefix='ai-support-zabbix-db-') as directory:
        credentials = Path(directory) / 'credentials'
        sql = Path(directory) / 'server.sql'
        sql.write_text(schema, encoding='utf-8')
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


def bootstrap(config, schema_path, verify_only=False):
    connection = None
    try:
        with gzip.open(schema_path, 'rt', encoding='utf-8') as source:
            schema = source.read()
        tables = expected_tables(schema)
        if not {'dbversion', 'users', 'config', 'hosts', 'items'}.issubset(tables):
            raise DatabaseSetupError('The packaged SQL script is not a complete Zabbix server schema.')
        connection = connect(config)
        with connection.cursor() as cursor:
            if config['engine'] == 'postgresql':
                cursor.execute('SELECT pg_try_advisory_lock(hashtext(%s))', (lock_name(config['database']),))
            else:
                cursor.execute('SELECT GET_LOCK(%s, 0)', (lock_name(config['database']),))
            if not cursor.fetchone()[0]:
                raise DatabaseSetupError('Another Zabbix DB setup is running. Retry after it completes.')
        state = inspect(connection, config, tables)
        if state == 'ready':
            return {'changed': False, 'state': state}
        if verify_only:
            raise DatabaseSetupError('The DB is empty; it has not been initialized.')
        if config['engine'] == 'mysql':
            # DDL cannot roll back. A marker also catches failures AFTER the
            # dbversion/seed rows have been written, including final SQL errors.
            with connection.cursor() as cursor:
                cursor.execute('CREATE TABLE _ai_support_zabbix_import (id integer)')
        import_schema(config, schema)
        inspect(connection, config, tables, importing=True)
        if config['engine'] == 'mysql':
            with connection.cursor() as cursor:
                cursor.execute('DROP TABLE _ai_support_zabbix_import')
        return {'changed': True, 'state': 'ready'}
    except DatabaseSetupError:
        raise
    except Exception:
        raise DatabaseSetupError('DB setup failed. Check drivers, packaged SQL, client binaries, connectivity and grants. No existing data was automatically removed.') from None
    finally:
        if connection is not None:
            try:
                if config['engine'] == 'mysql':
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
        print(json.dumps(bootstrap(config, schema_path, '--verify-only' in sys.argv[2:])))
    except Exception as error:
        message = str(error) if isinstance(error, DatabaseSetupError) else 'DB setup failed; check the root-only credentials file and packaged SQL script.'
        print(message, file=sys.stderr)
        sys.exit(1)
