"""Real PostgreSQL/MySQL tests. Use disposable databases only.

ZABBIX_TEST_ENGINE=postgresql|mysql ZABBIX_TEST_PORT=15432|13306
ZABBIX_TEST_PASSWORD=test-password python -m unittest discover -s ansible/tests -v
"""
import gzip
import importlib.util
import os
from pathlib import Path
import tempfile
import unittest

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
CREATE TABLE config (configid integer);
CREATE TABLE hosts (hostid integer);
CREATE TABLE items (itemid integer);
INSERT INTO dbversion VALUES (7000000,7000000);
INSERT INTO users VALUES (1);
INSERT INTO config VALUES (1);
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


if __name__ == '__main__':
    unittest.main()
