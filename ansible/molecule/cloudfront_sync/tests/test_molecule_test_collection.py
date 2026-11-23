"""Every test written in this directory is one unittest actually collects.

A ``test*`` function that is not a direct method of a module-level TestCase
class (nested in a function or after its return, defined at module level,
inside a nested class, or shadowed by a later definition of the same name) is
silently never run. This module checks every ``test_*.py`` file next to it:

* by AST, each ``test*`` function is a direct method of a class defined at
  module scope (directly or inside module-level ``if __name__`` /
  ``if sys.platform`` branches) and no class or method name is defined twice
  in one scope;
* the tests unittest collects from the imported module are exactly the AST
  test methods of the classes active on import (with test methods a class
  inherits from a base class of the same file), as a set and as a count.

A class defined only in the ``__name__ == '__main__'`` branch (files that run
their real tests in a fresh subprocess) is checked by AST: it derives from
unittest.TestCase and the branch ends with ``unittest.main()``.

The same file is ansible/roles/cloudfront_sync/files/tests/
test_role_test_collection.py and ansible/molecule/cloudfront_sync/tests/
test_molecule_test_collection.py (byte-identical, enforced below); each copy
checks its own directory.
"""
import ast
import importlib
from pathlib import Path
import sys
import unittest

HERE = Path(__file__).resolve().parent
ANSIBLE = next(parent for parent in HERE.parents if (parent / 'roles/cloudfront_sync').is_dir())
COPIES = (ANSIBLE / 'roles/cloudfront_sync/files/tests/test_role_test_collection.py',
          ANSIBLE / 'molecule/cloudfront_sync/tests/test_molecule_test_collection.py')
PREFIX = unittest.TestLoader.testMethodPrefix
FUNCTIONS = (ast.FunctionDef, ast.AsyncFunctionDef)


def condition(node):
    """Classify a module-scope ``if``: ('main', body runs as __main__ only),
    ('platform', body runs on this platform) or None (unsupported layout).

    Supported: ``__name__ ==/!= '__main__'`` and ``sys.platform ==/!= '<name>'``.
    """
    test = node.test
    if not (isinstance(test, ast.Compare) and len(test.ops) == 1 and isinstance(test.ops[0], (ast.Eq, ast.NotEq))
            and isinstance(test.comparators[0], ast.Constant) and type(test.comparators[0].value) is str):
        return None
    equal = isinstance(test.ops[0], ast.Eq)
    left, value = ast.unparse(test.left), test.comparators[0].value
    if left == '__name__' and value == '__main__':
        return 'main', equal
    if left == 'sys.platform':
        return 'platform', (sys.platform == value) == equal
    return None


def ends_with_unittest_main(body):
    """The branch ends with ``unittest.main()``, directly or under ``if __name__ == '__main__'``."""
    last = body[-1]
    if isinstance(last, ast.If) and condition(last) == ('main', True) and not last.orelse:
        last = last.body[-1]
    return isinstance(last, ast.Expr) and ast.unparse(last) == 'unittest.main()'


def module_classes(tree, problems):
    """[(ClassDef, runs_on_import)] at module scope, including module-level __name__ branches."""
    found = []
    def scan(body, on_import, main_only):
        names = [node.name for node in body if isinstance(node, ast.ClassDef)]
        problems.extend('class %s is defined twice in one scope' % name
                        for name in sorted({name for name in names if names.count(name) > 1}))
        for node in body:
            if isinstance(node, ast.ClassDef):
                found.append((node, on_import, main_only))
            elif isinstance(node, ast.If):
                kind = condition(node)
                if kind is None:
                    if any(isinstance(item, ast.ClassDef) for item in ast.walk(node)):
                        problems.append('line %d: classes inside an unsupported module-level if' % node.lineno)
                    continue
                if kind[0] == 'platform':
                    # Only the branch of this platform defines its classes.
                    scan(node.body, on_import and kind[1], main_only)
                    scan(node.orelse, on_import and not kind[1], main_only)
                    continue
                branch = kind[1]
                scan(node.body, on_import and not branch, main_only or branch)
                scan(node.orelse, on_import and branch, main_only or not branch)
                main_body = node.body if branch else node.orelse
                if any(isinstance(item, ast.ClassDef) for item in ast.walk(ast.Module(main_body, []))) \
                        and not ends_with_unittest_main(main_body):
                    problems.append('line %d: a __main__-only test branch must end with unittest.main()'
                                    % node.lineno)
    scan(tree.body, True, False)
    return found


def ast_findings(path):
    """(problems, {class name: (base names, test names)} of the classes active on import)."""
    tree = ast.parse(path.read_text(), str(path))
    problems = []
    classes = module_classes(tree, problems)
    direct = set()
    on_import = {}
    for node, active, main_only in classes:
        # Defined on import, or (__main__ only) when the file runs as a script.
        methods = [item.name for item in node.body if isinstance(item, FUNCTIONS)]
        problems.extend('%s.%s is defined twice' % (node.name, name)
                        for name in sorted({name for name in methods if methods.count(name) > 1}))
        tests = [item for item in node.body if isinstance(item, FUNCTIONS) and item.name.startswith(PREFIX)]
        direct.update(id(item) for item in tests)
        if main_only and tests and not any(ast.unparse(base) == 'unittest.TestCase' for base in node.bases):
            problems.append('%s (run as __main__ only) does not derive from unittest.TestCase' % node.name)
        if active:
            on_import[node.name] = ([ast.unparse(base) for base in node.bases], {item.name for item in tests})
    for node in ast.walk(tree):
        if isinstance(node, FUNCTIONS) and node.name.startswith(PREFIX) and id(node) not in direct:
            problems.append('line %d: %s is not a direct method of a module-level class (never collected)'
                            % (node.lineno, node.name))
    return problems, on_import


def expected_tests(on_import, name):
    """Test names of class ``name`` including those inherited from bases of the same file."""
    bases, tests = on_import[name]
    names = set(tests)
    for base in bases:
        if base in on_import and base != name:
            names |= expected_tests(on_import, base)
    return names


def import_test_module(path):
    """The module as unittest discovery imports it (top-level directory = this directory)."""
    module = sys.modules.get(path.stem)
    if module is None:
        sys.path.insert(0, str(path.parent))
        try:
            module = importlib.import_module(path.stem)
        finally:
            sys.path.remove(str(path.parent))
    if Path(module.__file__).resolve() != path.resolve():
        raise AssertionError('%s is imported from another file: %s' % (path.stem, module.__file__))
    return module


def flatten(suite):
    for item in suite:
        if isinstance(item, unittest.TestSuite):
            yield from flatten(item)
        else:
            yield item


def collected_tests(module):
    """[(class name, method name)] that unittest collects from ``module``."""
    return [(type(test).__name__, test._testMethodName)
            for test in flatten(unittest.defaultTestLoader.loadTestsFromModule(module))]


def check_file(path, module=None):
    """Every problem of one test file; empty when all its tests are collected."""
    problems, on_import = ast_findings(path)
    if problems:
        return problems
    module = import_test_module(path) if module is None else module
    collected = collected_tests(module)
    expected = set()
    for name, value in vars(module).items():
        if isinstance(value, type) and issubclass(value, unittest.TestCase) and value.__module__ == module.__name__:
            if name not in on_import:
                problems.append('%s is collected but not defined at module scope' % name)
                continue
            expected |= {(name, test) for test in expected_tests(on_import, name)}
    for name, (_, tests) in on_import.items():
        value = getattr(module, name, None)
        if tests and not (isinstance(value, type) and issubclass(value, unittest.TestCase)):
            problems.append('%s has test methods but is not a unittest.TestCase subclass' % name)
    if len(collected) != len(set(collected)):
        problems.append('a test is collected twice')
    if set(collected) != expected or len(collected) != len(expected):
        problems.append('collected %d tests, the AST defines %d: missing %s, unexpected %s'
                        % (len(collected), len(expected), sorted(expected - set(collected)),
                           sorted(set(collected) - expected)))
    return problems


class CollectionTests(unittest.TestCase):
    def test_every_test_function_in_this_directory_is_collected(self):
        files = sorted(HERE.glob('test_*.py'))
        self.assertIn(Path(__file__).resolve(), files)
        for path in files:
            with self.subTest(file=path.name):
                self.assertEqual(check_file(path), [])

    def test_both_directories_carry_the_same_checker(self):
        self.assertIn(Path(__file__).resolve(), COPIES)
        self.assertEqual(COPIES[0].read_bytes(), COPIES[1].read_bytes())

    def test_the_checker_detects_every_uncollected_layout(self):
        """Each layout below is a test that unittest would silently never run."""
        header = 'import sys\nimport unittest\n\n\nclass T(unittest.TestCase):\n    def test_ok(self):\n        pass\n'
        cases = {
            'after return': header + '\n\ndef helper():\n    return 1\n\n    def test_lost(self):\n        pass\n',
            'nested function': header + '\n    def helper(self):\n        def test_inner():\n            pass\n',
            'module level': header + '\n\ndef test_module_level():\n    pass\n',
            'nested class': header + '\n    class Inner(unittest.TestCase):\n        def test_inner(self):\n            pass\n',
            'shadowed method': header + '\n    def test_ok(self):\n        pass\n',
            'shadowed class': header + '\n\nclass T(unittest.TestCase):\n    def test_other(self):\n        pass\n',
            'not a TestCase': header + '\n\nclass Plain:\n    def test_plain(self):\n        pass\n',
            'unsupported if': header + '\nif True:\n    class U(unittest.TestCase):\n        def test_u(self):\n            pass\n',
            'main branch without unittest.main':
                header + "\nif __name__ == '__main__':\n    class M(unittest.TestCase):\n        def test_m(self):\n            pass\n",
            'tests hidden by load_tests':
                header + '\n\ndef load_tests(loader, tests, pattern):\n    return unittest.TestSuite()\n',
            'test method replaced by a value':
                header + '\n\nT.test_ok = None\n',
            'platform branch with a stray test':
                header + "\nif sys.platform == 'nonexistent':\n    def test_stray():\n        pass\n",
            'main branch not a TestCase':
                header + "\nif __name__ == '__main__':\n    class M:\n        def test_m(self):\n            pass\n    unittest.main()\n",
        }
        import tempfile
        import types
        with tempfile.TemporaryDirectory() as directory:
            for label, source in cases.items():
                with self.subTest(layout=label):
                    path = Path(directory) / 'test_probe.py'
                    path.write_text(source)
                    module = types.ModuleType('test_probe')
                    module.__file__ = str(path)
                    exec(compile(source, str(path), 'exec'), module.__dict__)
                    self.assertNotEqual(check_file(path, module), [])
            # The supported layouts pass: plain classes, inherited tests and a
            # subprocess-isolated __main__ branch.
            for label, source in (
                    ('plain', header),
                    ('inherited', header + '\n\nclass U(T):\n    def test_more(self):\n        pass\n'),
                    ('isolated', "import unittest\n\nif __name__ != '__main__':\n"
                                 "    class W(unittest.TestCase):\n        def test_w(self):\n            pass\n"
                                 "else:\n    class M(unittest.TestCase):\n        def test_m(self):\n"
                                 "            pass\n    if __name__ == '__main__':\n        unittest.main()\n"),
                    ('platform', header + "\nimport sys\nif sys.platform == 'nonexistent':\n"
                                 "    class P(unittest.TestCase):\n        def test_p(self):\n            pass\n"
                                 "else:\n    class Q(unittest.TestCase):\n        def test_q(self):\n"
                                 "            pass\n")):
                with self.subTest(layout=label):
                    path = Path(directory) / 'test_probe.py'
                    path.write_text(source)
                    module = types.ModuleType('test_probe')
                    module.__file__ = str(path)
                    exec(compile(source, str(path), 'exec'), module.__dict__)
                    self.assertEqual(check_file(path, module), [])


if __name__ == '__main__':
    unittest.main()
