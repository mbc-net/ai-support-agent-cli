"""Real PostgreSQL/MySQL tests. Use disposable databases only.

ZABBIX_TEST_ENGINE=postgresql|mysql ZABBIX_TEST_PORT=15432|13306
ZABBIX_TEST_PASSWORD=test-password python -m unittest discover -s ansible/tests -v

TimescaleDB (design doc section 4.1) uses disposable timescale/timescaledb PG16
containers and the postgres superuser to create each test DB from template0:

ZABBIX_TEST_TIMESCALEDB=1 ZABBIX_TEST_TIMESCALEDB_PORT=25432
ZABBIX_TEST_TIMESCALEDB_ADMIN_PASSWORD=pw
ZABBIX_TEST_TIMESCALEDB_APACHE_PORT=25433  # same image, -c timescaledb.license=apache
ZABBIX_TEST_SCHEMA_ROOT=.../usr/share/zabbix-sql-scripts ZABBIX_TEST_SCHEMA_VERSION=6.0|7.0
"""
import gzip
import importlib.util
import os
from pathlib import Path
import re
import tempfile
import unittest
from unittest import mock

HELPER = Path(__file__).resolve().parents[1] / 'roles/zabbix_server/files/database.py'
spec = importlib.util.spec_from_file_location('zabbix_database', HELPER)
db = importlib.util.module_from_spec(spec)
spec.loader.exec_module(db)


@unittest.skipUnless(os.environ.get('ZABBIX_TEST_ENGINE'), 'Requires an isolated test DB')
class DatabaseBootstrapTests(unittest.TestCase):
    def setUp(self):
        self.config = dict(engine=os.environ['ZABBIX_TEST_ENGINE'], host='127.0.0.1',
                           port=int(os.environ['ZABBIX_TEST_PORT']), database='zabbix_test',
                           user='zabbix_test', password=os.environ['ZABBIX_TEST_PASSWORD'], version='7.0')
        self.connection = db.connect(self.config)
        self.connection.autocommit = True
        self.directory = tempfile.TemporaryDirectory()
        self.schema = Path(self.directory.name) / 'server.sql.gz'
        sql = '''CREATE TABLE dbversion (mandatory integer, optional integer);
CREATE TABLE users (userid integer);
CREATE TABLE config (configid integer, db_extension varchar(32) DEFAULT '' NOT NULL);
CREATE TABLE hosts (hostid integer);
CREATE TABLE items (itemid integer);
INSERT INTO dbversion VALUES (7000000,7000000);
INSERT INTO users VALUES (1);
INSERT INTO config (configid) VALUES (1);
'''
        with gzip.open(self.schema, 'wt') as f:
            f.write(sql)
        self.clean()

    def clean(self):
        with self.connection.cursor() as cursor:
            if self.config['engine'] == 'mysql':
                cursor.execute('SET FOREIGN_KEY_CHECKS=0')
            for table in db.table_names(self.connection, self.config['engine']):
                # Tests control every identifier in this disposable database.
                cursor.execute('DROP TABLE ' + table + (' CASCADE' if self.config['engine'] == 'postgresql' else ''))

    def tearDown(self):
        self.clean()
        self.connection.close()
        self.directory.cleanup()

    def test_initial_import_then_idempotent_rerun_preserves_data(self):
        self.assertTrue(db.bootstrap(self.config, self.schema)['changed'])
        with self.connection.cursor() as cursor:
            cursor.execute('INSERT INTO hosts VALUES (99)')
        self.assertFalse(db.bootstrap(self.config, self.schema)['changed'])
        with self.connection.cursor() as cursor:
            cursor.execute('SELECT hostid FROM hosts')
            self.assertEqual(list(cursor.fetchall()), [(99,)])

    @unittest.skipUnless(os.environ.get('ZABBIX_TEST_SCHEMA_ROOT'), 'Requires official SQL package')
    def test_packaged_schema_import_and_rerun(self):
        schema = Path(os.environ['ZABBIX_TEST_SCHEMA_ROOT']) / self.config['engine'] / 'server.sql.gz'
        self.assertTrue(db.bootstrap(self.config, schema)['changed'])
        self.assertFalse(db.bootstrap(self.config, schema)['changed'])
        self.assertGreater(len(db.table_names(self.connection, self.config['engine'])), 100)

    def test_partial_schema_is_rejected_without_modifying_it(self):
        with self.connection.cursor() as cursor:
            cursor.execute('CREATE TABLE hosts (hostid integer)')
        with self.assertRaises(db.DatabaseSetupError):
            db.bootstrap(self.config, self.schema)
        self.assertEqual(db.table_names(self.connection, self.config['engine']), {'hosts'})

    def test_concurrent_bootstrap_is_rejected_without_initializing(self):
        with self.connection.cursor() as cursor:
            if self.config['engine'] == 'postgresql':
                cursor.execute('SELECT pg_advisory_lock(hashtext(%s))', (db.lock_name(self.config['database']),))
            else:
                cursor.execute('SELECT GET_LOCK(%s, 0)', (db.lock_name(self.config['database']),))
        with self.assertRaises(db.DatabaseSetupError):
            db.bootstrap(self.config, self.schema)
        self.assertEqual(db.table_names(self.connection, self.config['engine']), set())

    def test_maximum_database_name_fits_mysql_lock_limit(self):
        self.assertLessEqual(len(db.lock_name('z' * 63)), 64)
        self.assertNotEqual(db.lock_name('z' * 63), db.lock_name('y' * 63))

    def test_version_row_alone_is_not_completion(self):
        with self.connection.cursor() as cursor:
            cursor.execute('CREATE TABLE dbversion (mandatory integer, optional integer)')
            cursor.execute('INSERT INTO dbversion VALUES (7000000,7000000)')
        with self.assertRaises(db.DatabaseSetupError):
            db.bootstrap(self.config, self.schema)

    def test_wrong_version_and_missing_seed_data_are_rejected(self):
        db.bootstrap(self.config, self.schema)
        with self.connection.cursor() as cursor:
            cursor.execute('UPDATE dbversion SET mandatory=6000000, optional=6000000')
        with self.assertRaises(db.DatabaseSetupError):
            db.bootstrap(self.config, self.schema)
        with self.connection.cursor() as cursor:
            cursor.execute('UPDATE dbversion SET mandatory=7000000, optional=7000000')
            cursor.execute('DELETE FROM users')
        with self.assertRaises(db.DatabaseSetupError):
            db.bootstrap(self.config, self.schema)

    def test_failed_import_is_detected_and_postgres_rolls_back(self):
        with gzip.open(self.schema, 'at') as f:
            f.write('THIS IS NOT VALID SQL;\n')
        with self.assertRaises(db.DatabaseSetupError):
            db.bootstrap(self.config, self.schema)
        if self.config['engine'] == 'postgresql':
            self.assertEqual(db.table_names(self.connection, 'postgresql'), set())
        else:
            # Even a final error after dbversion exists must prevent the next run
            # from treating the incomplete import as successful.
            with self.assertRaises(db.DatabaseSetupError):
                db.bootstrap(self.config, self.schema)

    def test_password_is_never_present_in_error_output(self):
        wrong = dict(self.config, password='wrong-secret-do-not-print')
        with self.assertRaises(db.DatabaseSetupError) as failure:
            db.bootstrap(wrong, self.schema)
        self.assertNotIn(wrong['password'], str(failure.exception))



# Hypertable sets fixed from the official packages (zabbix-sql-scripts 6.0.48 / 7.0.31).
PACKAGED_HYPERTABLES = {
    '6.0': {'history', 'history_uint', 'history_log', 'history_text', 'history_str', 'trends', 'trends_uint'},
    '7.0': {'history', 'history_uint', 'history_log', 'history_text', 'history_str', 'history_bin',
            'auditlog', 'trends', 'trends_uint'},
}

FAKE_TS_SERVER_SQL = """CREATE TABLE dbversion (mandatory integer, optional integer);
CREATE TABLE users (userid integer);
CREATE TABLE config (configid integer, db_extension varchar(32) DEFAULT '' NOT NULL,
  hk_history_global integer DEFAULT 0 NOT NULL, hk_trends_global integer DEFAULT 0 NOT NULL,
  compression_status integer DEFAULT 0 NOT NULL, compress_older varchar(32) DEFAULT '7d' NOT NULL);
CREATE TABLE hosts (hostid integer);
CREATE TABLE items (itemid integer);
CREATE TABLE history (itemid bigint, clock integer NOT NULL, value double precision);
CREATE TABLE history_uint (itemid bigint, clock integer NOT NULL, value bigint);
CREATE TABLE history_str (itemid bigint, clock integer NOT NULL, value varchar(255));
CREATE TABLE history_log (itemid bigint, clock integer NOT NULL, value text);
CREATE TABLE history_text (itemid bigint, clock integer NOT NULL, value text);
CREATE TABLE trends (itemid bigint, clock integer NOT NULL, num integer);
CREATE TABLE trends_uint (itemid bigint, clock integer NOT NULL, num integer);
START TRANSACTION;
INSERT INTO dbversion VALUES (6000000,6000000);
INSERT INTO users VALUES (1);
INSERT INTO config (configid) VALUES (1);
COMMIT;
"""

FAKE_TS_SCRIPT = """DO $$
BEGIN
	PERFORM create_hypertable('history', 'clock', chunk_time_interval => 86400, migrate_data => true);
	PERFORM create_hypertable('history_uint', 'clock', chunk_time_interval => 86400, migrate_data => true);
	PERFORM create_hypertable('history_log', 'clock', chunk_time_interval => 86400, migrate_data => true);
	PERFORM create_hypertable('history_text', 'clock', chunk_time_interval => 86400, migrate_data => true);
	PERFORM create_hypertable('history_str', 'clock', chunk_time_interval => 86400, migrate_data => true);
	PERFORM create_hypertable('trends', 'clock', chunk_time_interval => 2592000, migrate_data => true);
	PERFORM create_hypertable('trends_uint', 'clock', chunk_time_interval => 2592000, migrate_data => true);
	UPDATE config SET db_extension='timescaledb',hk_history_global=1,hk_trends_global=1;
	UPDATE config SET compression_status=1,compress_older='7d';
END $$;
"""


class TimescaleHelperUnitTests(unittest.TestCase):
    """No database needed."""

    def test_hypertables_are_parsed_from_create_hypertable_calls(self):
        self.assertEqual(db.expected_hypertables(FAKE_TS_SCRIPT), PACKAGED_HYPERTABLES['6.0'])
        self.assertEqual(db.expected_hypertables("PERFORM create_hypertable( 'auditlog', 'auditid')"), {'auditlog'})

    def test_packaged_script_paths_per_lts(self):
        self.assertEqual(db.TIMESCALE_SCRIPTS, {'6.0': 'timescaledb.sql', '7.0': 'timescaledb/schema.sql'})

    def test_timescaledb_with_mysql_is_rejected_before_connecting(self):
        config = dict(engine='mysql', host='127.0.0.1', port=1, database='z', user='z', password='p',
                      version='7.0', timescaledb=True)
        with mock.patch.object(db, 'connect') as connect:
            with self.assertRaises(db.DatabaseSetupError) as failure:
                db.bootstrap(config, '/nonexistent/server.sql.gz')
        connect.assert_not_called()
        self.assertIn('PostgreSQL', str(failure.exception))

    def test_script_without_the_base_hypertables_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            schema = Path(directory) / 'server.sql.gz'
            with gzip.open(schema, 'wt') as f:
                f.write(FAKE_TS_SERVER_SQL)
            (Path(directory) / 'timescaledb.sql').write_text("PERFORM create_hypertable('history', 'clock');")
            config = dict(engine='postgresql', host='127.0.0.1', port=1, database='z', user='z', password='p',
                          version='6.0', timescaledb=True)
            with mock.patch.object(db, 'connect') as connect:
                with self.assertRaises(db.DatabaseSetupError):
                    db.bootstrap(config, schema)
            connect.assert_not_called()

    @unittest.skipUnless(os.environ.get('ZABBIX_TEST_SCHEMA_ROOT'), 'Requires official SQL package')
    def test_packaged_script_hypertable_set_is_fixed(self):
        version = os.environ.get('ZABBIX_TEST_SCHEMA_VERSION', '7.0')
        engine_dir = Path(os.environ['ZABBIX_TEST_SCHEMA_ROOT']) / 'postgresql'
        script = db.read_sql(engine_dir / db.TIMESCALE_SCRIPTS[version])
        self.assertEqual(db.expected_hypertables(script), PACKAGED_HYPERTABLES[version])
        # The packaged scripts must not carry transaction statements of their own:
        # the TimescaleDB step relies on psql --single-transaction for atomicity.
        self.assertIsNone(re.search(r'^\s*(BEGIN|COMMIT|START TRANSACTION|ROLLBACK)\s*;', script, re.I | re.M))
        # server.sql does end with its own COMMIT, which is why the import uses two steps.
        server = db.read_sql(engine_dir / 'server.sql.gz')
        self.assertIsNotNone(re.search(r'^COMMIT;\s*\Z', server, re.M))


@unittest.skipUnless(os.environ.get('ZABBIX_TEST_TIMESCALEDB'), 'Requires a disposable timescale/timescaledb PG16 container')
class TimescaleBootstrapTests(unittest.TestCase):
    DB = 'zabbix_ts'
    USER = 'zabbix_ts'
    PASSWORD = 'ts-pa:ss\\'

    @classmethod
    def admin(cls, port, database='postgres'):
        import psycopg2
        connection = psycopg2.connect(host='127.0.0.1', port=port, dbname=database, user='postgres',
                                      password=os.environ['ZABBIX_TEST_TIMESCALEDB_ADMIN_PASSWORD'], connect_timeout=10)
        connection.autocommit = True
        return connection

    def recreate(self, port, extension=True):
        connection = self.admin(port)
        with connection.cursor() as cursor:
            cursor.execute('DROP DATABASE IF EXISTS ' + self.DB + ' WITH (FORCE)')
            cursor.execute('DROP ROLE IF EXISTS ' + self.USER)
            cursor.execute('CREATE ROLE ' + self.USER + ' LOGIN PASSWORD %s', (self.PASSWORD,))
            # template0: the image installs timescaledb into template1.
            cursor.execute('CREATE DATABASE ' + self.DB + ' OWNER ' + self.USER + ' TEMPLATE template0')
        connection.close()
        if extension:
            connection = self.admin(port, self.DB)
            with connection.cursor() as cursor:
                cursor.execute('CREATE EXTENSION IF NOT EXISTS timescaledb CASCADE')
            connection.close()
        return dict(engine='postgresql', host='127.0.0.1', port=port, database=self.DB, user=self.USER,
                    password=self.PASSWORD, version=self.version, timescaledb=True)

    def setUp(self):
        self.port = int(os.environ['ZABBIX_TEST_TIMESCALEDB_PORT'])
        self.version = '6.0'
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        self.schema = self.root / 'server.sql.gz'
        with gzip.open(self.schema, 'wt') as f:
            f.write(FAKE_TS_SERVER_SQL)
        self.script = self.root / 'timescaledb.sql'
        self.script.write_text(FAKE_TS_SCRIPT)
        self.config = self.recreate(self.port)
        self.connections = []

    def tearDown(self):
        for connection in self.connections:
            connection.close()
        self.directory.cleanup()

    def app(self, config=None):
        connection = db.connect(config or self.config)
        self.connections.append(connection)
        return connection

    def snapshot(self, config=None):
        connection = self.app(config)
        info = db.timescale_info(connection)
        tables = db.table_names(connection, 'postgresql')
        extension = None
        if 'config' in tables:
            extension = db.db_extension(connection)
        return {'tables': tables, 'hypertables': info['hypertables'], 'extension': info['extension'],
                'db_extension': extension}

    def test_empty_db_with_extension_is_initialized_then_idempotent(self):
        plan = db.bootstrap(self.config, self.schema, plan=True)
        self.assertEqual(plan['state'], 'empty')
        self.assertFalse(plan['changed'])
        result = db.bootstrap(self.config, self.schema)
        self.assertTrue(result['changed'])
        self.assertEqual(result['license'], 'timescale')
        self.assertTrue(result['extversion'])
        state = self.snapshot()
        self.assertEqual(state['hypertables'], PACKAGED_HYPERTABLES['6.0'])
        self.assertEqual(state['db_extension'], 'timescaledb')
        self.assertNotIn(db.TIMESCALE_MARKER, state['tables'])
        self.assertFalse(db.bootstrap(self.config, self.schema)['changed'])
        self.assertEqual(db.bootstrap(self.config, self.schema, plan=True)['state'], 'ready')
        self.assertFalse(db.bootstrap(self.config, self.schema, verify_only=True)['changed'])

    def test_missing_extension_fails_without_modifying_the_db(self):
        config = self.recreate(self.port, extension=False)
        self.assertEqual(db.bootstrap(config, self.schema, plan=True)['state'], 'empty')
        with self.assertRaises(db.DatabaseSetupError) as failure:
            db.bootstrap(config, self.schema)
        self.assertIn('CREATE EXTENSION timescaledb', str(failure.exception))
        self.assertEqual(self.snapshot(config)['tables'], set())

    def test_regular_db_with_true_fails_in_plan_without_modifying_it(self):
        db.bootstrap(dict(self.config, timescaledb=False), self.schema)
        before = self.snapshot()
        self.assertEqual(before['hypertables'], set())
        for plan in (True, False):
            with self.assertRaises(db.DatabaseSetupError) as failure:
                db.bootstrap(self.config, self.schema, plan=plan)
            self.assertIn('not automated', str(failure.exception))
        self.assertEqual(self.snapshot(), before)
        # false keeps working for the regular DB.
        self.assertFalse(db.bootstrap(dict(self.config, timescaledb=False), self.schema)['changed'])

    def test_timescaledb_db_with_false_fails(self):
        db.bootstrap(self.config, self.schema)
        before = self.snapshot()
        for plan in (True, False):
            with self.assertRaises(db.DatabaseSetupError) as failure:
                db.bootstrap(dict(self.config, timescaledb=False), self.schema, plan=plan)
            self.assertIn('zabbix_server_db_timescaledb: true', str(failure.exception))
        self.assertEqual(self.snapshot(), before)

    def test_partial_hypertables_fail_for_both_values(self):
        db.bootstrap(dict(self.config, timescaledb=False), self.schema)
        connection = self.app()
        with connection.cursor() as cursor:
            cursor.execute("SELECT create_hypertable('history', 'clock', chunk_time_interval => 86400)")
        for db_extension in ('', 'timescaledb'):
            with connection.cursor() as cursor:
                cursor.execute('UPDATE config SET db_extension=%s', (db_extension,))
            for want in (True, False):
                for plan in (True, False):
                    with self.assertRaises(db.DatabaseSetupError) as failure:
                        db.bootstrap(dict(self.config, timescaledb=want), self.schema, plan=plan)
                    self.assertIn('nconsistent', str(failure.exception))
        self.assertEqual(self.snapshot()['hypertables'], {'history'})

    def test_db_extension_without_the_extension_fails(self):
        config = self.recreate(self.port, extension=False)
        db.bootstrap(dict(config, timescaledb=False), self.schema)
        connection = self.app(config)
        with connection.cursor() as cursor:
            cursor.execute("UPDATE config SET db_extension='timescaledb'")
        for want in (True, False):
            with self.assertRaises(db.DatabaseSetupError) as failure:
                db.bootstrap(dict(config, timescaledb=want), self.schema, plan=True)
            self.assertIn('extension is missing', str(failure.exception))

    def test_server_sql_failure_leaves_an_empty_db(self):
        # Before server.sql's own COMMIT, like any real failure inside the packaged script.
        with gzip.open(self.schema, 'wt') as f:
            f.write(FAKE_TS_SERVER_SQL.replace('START TRANSACTION;', 'THIS IS NOT VALID SQL;\nSTART TRANSACTION;'))
        with self.assertRaises(db.DatabaseSetupError):
            db.bootstrap(self.config, self.schema)
        self.assertEqual(self.snapshot()['tables'], set())

    def test_timescaledb_script_failure_rolls_back_to_the_marker_and_is_retried(self):
        self.script.write_text(FAKE_TS_SCRIPT.replace('END $$;', "\tPERFORM no_such_function();\nEND $$;"))
        with self.assertRaises(db.DatabaseSetupError):
            db.bootstrap(self.config, self.schema)
        state = self.snapshot()
        # The TimescaleDB step rolled back completely: no hypertable, config untouched,
        # and the marker (committed with server.sql) records the interrupted step.
        self.assertEqual(state['hypertables'], set())
        self.assertEqual(state['db_extension'], '')
        self.assertIn(db.TIMESCALE_MARKER, state['tables'])
        self.assertEqual(db.bootstrap(self.config, self.schema, plan=True)['state'], 'timescaledb_pending')
        with self.assertRaises(db.DatabaseSetupError):
            db.bootstrap(self.config, self.schema, verify_only=True)
        with self.assertRaises(db.DatabaseSetupError):
            db.bootstrap(dict(self.config, timescaledb=False), self.schema, plan=True)
        self.script.write_text(FAKE_TS_SCRIPT)
        self.assertTrue(db.bootstrap(self.config, self.schema)['changed'])
        state = self.snapshot()
        self.assertEqual(state['hypertables'], PACKAGED_HYPERTABLES['6.0'])
        self.assertNotIn(db.TIMESCALE_MARKER, state['tables'])
        self.assertFalse(db.bootstrap(self.config, self.schema)['changed'])

    def test_extension_does_not_create_tables_in_public(self):
        self.assertEqual(self.snapshot()['tables'], set())
        self.assertEqual(db.bootstrap(self.config, self.schema, plan=True)['state'], 'empty')

    @unittest.skipUnless(os.environ.get('ZABBIX_TEST_TIMESCALEDB_APACHE_PORT'), 'Requires a license=apache container')
    def test_apache_license_fails_without_modifying_the_db(self):
        config = self.recreate(int(os.environ['ZABBIX_TEST_TIMESCALEDB_APACHE_PORT']))
        for plan in (True, False):
            with self.assertRaises(db.DatabaseSetupError) as failure:
                db.bootstrap(config, self.schema, plan=plan)
            self.assertIn('Community', str(failure.exception))
        self.assertEqual(self.snapshot(config)['tables'], set())

    @unittest.skipUnless(os.environ.get('ZABBIX_TEST_SCHEMA_ROOT'), 'Requires official SQL package')
    def test_packaged_schema_and_timescaledb_script(self):
        self.version = os.environ.get('ZABBIX_TEST_SCHEMA_VERSION', '7.0')
        config = self.recreate(self.port)
        schema = Path(os.environ['ZABBIX_TEST_SCHEMA_ROOT']) / 'postgresql' / 'server.sql.gz'
        self.assertTrue(db.bootstrap(config, schema)['changed'])
        state = self.snapshot(config)
        self.assertEqual(state['hypertables'], PACKAGED_HYPERTABLES[self.version])
        self.assertEqual(state['db_extension'], 'timescaledb')
        self.assertNotIn(db.TIMESCALE_MARKER, state['tables'])
        self.assertGreater(len(state['tables']), 100)
        self.assertFalse(db.bootstrap(config, schema)['changed'])
        with self.assertRaises(db.DatabaseSetupError):
            db.bootstrap(dict(config, timescaledb=False), schema, plan=True)


if __name__ == '__main__':
    unittest.main()
