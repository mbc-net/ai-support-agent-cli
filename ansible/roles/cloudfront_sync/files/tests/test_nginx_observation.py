"""Pure nginx observation parts: lexer, dump framing, shared files, dump-wide policy.

No process, file or network access. Every input is an in-memory fixture.
The Collector and admit_policy are tested in test_nginx_collector.py.
"""
import ast
import copy
import dataclasses
import gc
import importlib.util
import ipaddress
from pathlib import Path
import pickle
import secrets
import sys
import unittest
import weakref

FILES = Path(__file__).parents[1]
# nginx_observation imports ufw_observation (and it its siblings) by name.
# Private copies are bound only while the module executes; sys.modules is
# restored afterwards, so no other test's modules are replaced or reused.
DEPENDENCIES = ('ufw_integrity', 'ufw_kernel', 'ufw_kernel_mapping', 'ufw_observation')
_saved = {name: sys.modules.get(name) for name in DEPENDENCIES}
try:
    for _name in DEPENDENCIES:
        _spec = importlib.util.spec_from_file_location(_name, FILES / (_name + '.py'))
        _module = importlib.util.module_from_spec(_spec)
        sys.modules[_name] = _module
        _spec.loader.exec_module(_module)
    SPEC = importlib.util.spec_from_file_location('fixture_nginx_observation', FILES / 'nginx_observation.py')
    m = importlib.util.module_from_spec(SPEC)
    sys.modules[SPEC.name] = m
    SPEC.loader.exec_module(m)
finally:
    for _name, _module in _saved.items():
        if _module is None:
            sys.modules.pop(_name, None)
        else:
            sys.modules[_name] = _module

SECRET = 'cf-s1-origin-secret-' + secrets.token_hex(16)
SHARED = '/etc/nginx/cloudfront'
GEO_INCLUDE = SHARED + '/cloudfront-geo.conf'
REAL_INCLUDE = SHARED + '/cloudfront-realip.conf'
GEO = ('# CloudFront origin bundle\n'
       'geo $realip_remote_addr $cloudfront_origin {\n'
       '    include ' + GEO_INCLUDE + ';\n'
       '    default 0;\n'
       '}\n'
       'map $http_x_origin_verify $origin_ok {\n'
       '    default 0;\n'
       '    "' + SECRET + '" 1;\n'
       '}\n').encode()
REALIP = ('server {\n'
          '    listen 443 ssl;\n'
          '    include ' + REAL_INCLUDE + ';\n'
          '    real_ip_header X-Forwarded-For;\n'
          '    real_ip_recursive off;\n'
          '    if ($origin_ok = "0") { return 403; }\n'
          '}\n').encode()
GEO_SHARED = b'13.32.0.0/15 1;\n52.46.0.0/18 1;\n2600:9000::/28 1;\n'
REAL_SHARED = b'set_real_ip_from 13.32.0.0/15;\nset_real_ip_from 52.46.0.0/18;\nset_real_ip_from 2600:9000::/28;\n'
RANGES = ('13.32.0.0/15', '52.46.0.0/18', '2600:9000::/28')
MAIN_PATH = '/etc/nginx/nginx.conf'
GEO_PATH = '/etc/nginx/conf.d/cloudfront-origin.conf'
REALIP_PATH = '/etc/nginx/sites-enabled/origin.conf'
MAIN = ('http {\n'
        '    include /etc/nginx/conf.d/*.conf;\n'
        '    include /etc/nginx/sites-enabled/*;\n'
        '}\n').encode()
# A file included twice (two servers and a glob); see test_a_file_included_twice_is_dumped_once_by_nginx.
TWICE_MAIN = (b'pid /tmp/nginx-twice.pid;\nerror_log /dev/null;\nevents {}\nhttp {\n    access_log off;\n'
              b'    server {\n        listen 8080;\n        include /cfg/twice/s.conf;\n    }\n'
              b'    server {\n        listen 8081;\n        include /cfg/twice/s.conf;\n    }\n'
              b'    server {\n        listen 8082;\n        include /cfg/twice/s*.conf;\n    }\n}\n')
TWICE_S = b'location /x {\n    return 200 "x";\n}\n'
# Bracket expressions of glob(3) that each match the 'c' of 'cloudfront'.
BRACKETS = ('[^x]', '[[:alpha:]]', '[[=c=]]', '[[.c.]]', '[!x]')
# Directive names whose block body ngx_lua reads with its own (Lua) lexer.
LUA_BLOCKS = ('content', 'access', 'rewrite', 'header_filter', 'body_filter', 'log', 'balancer', 'ssl_certificate',
              'ssl_session_fetch', 'ssl_session_store', 'ssl_client_hello', 'init', 'init_worker', 'exit_worker',
              'server_rewrite', 'preread', 'proxy_ssl_verify')


def words(raw):
    return [(token.kind, token.value) for token in m.tokenize(raw)]


def header(path):
    return b'# configuration file ' + path.encode() + b':\n'


def dump(*sections):
    return b''.join(header(path) + body + b'\n' for path, body in sections)


class Assertions(unittest.TestCase):
    def fails(self, code, function, *args, **kwargs):
        with self.assertRaises(m.NginxObservationError) as caught:
            function(*args, **kwargs)
        error = caught.exception
        self.assertEqual(error.args, (code,))
        self.assertIn(code, m.CODES)
        self.assertIsNone(error.__cause__)
        self.assertIsNone(error.__context__)
        for text in (str(error), repr(error)):
            self.assertNotIn(SECRET, text)
            self.assertNotIn('origin-secret', text)
        return error


class TokenizeTests(Assertions):
    def test_words_and_punctuation(self):
        self.assertEqual(words(b'a b;\nc {\n d e; }\n'),
                         [('word', 'a'), ('word', 'b'), (';', ';'), ('word', 'c'), ('{', '{'),
                          ('word', 'd'), ('word', 'e'), (';', ';'), ('}', '}')])

    def test_quotes_and_escapes_follow_nginx(self):
        self.assertEqual(words(b'x "a\\"b" \'c\\\'d\' "e\\\\f" "t\\tn\\nr\\r" "\\q";'),
                         [('word', 'x'), ('word', 'a"b'), ('word', "c'd"), ('word', 'e\\f'),
                          ('word', 't\tn\nr\r'), ('word', '\\q'), (';', ';')])
        self.assertEqual(words(b'a\\;b c;'), [('word', 'a\\;b'), ('word', 'c'), (';', ';')])
        self.assertEqual(words(b'a\\ b;'), [('word', 'a\\ b'), (';', ';')])
        # Quoted punctuation is a word, never structure.
        self.assertEqual(words(b'x "{" "}" ";";'), [('word', 'x'), ('word', '{'), ('word', '}'), ('word', ';'), (';', ';')])
        self.assertEqual([t.quoted for t in m.tokenize(b'x "y" z;')], [False, True, False, False])
        self.assertEqual(words(b'x "multi\nline";'), [('word', 'x'), ('word', 'multi\nline'), (';', ';')])

    def test_only_a_token_initial_hash_starts_a_comment(self):
        self.assertEqual(words(b'a#b c#;\n'), [('word', 'a#b'), ('word', 'c#'), (';', ';')])
        self.assertEqual(words(b'a;#c d;\nb;'), [('word', 'a'), (';', ';'), ('word', 'b'), (';', ';')])
        self.assertEqual(words(b'a {# c;\n}#x'), [('word', 'a'), ('{', '{'), ('}', '}')])
        self.assertEqual(words(b'x "#y" #z;\n;'), [('word', 'x'), ('word', '#y'), (';', ';')])
        self.assertEqual(words(b'# only a comment'), [])
        self.assertEqual(words(b''), [])

    def test_variables_keep_braces_inside_the_word(self):
        self.assertEqual(words(b'set $a ${b}c;'), [('word', 'set'), ('word', '$a'), ('word', '${b}c'), (';', ';')])
        self.assertEqual(words(b'x ${{y;'), [('word', 'x'), ('word', '${{y'), (';', ';')])
        # Without a preceding $, a brace ends the word and opens a block.
        self.assertEqual(words(b'geo $a{}'), [('word', 'geo'), ('word', '$a'), ('{', '{'), ('}', '}')])
        self.assertEqual(words(b'a}b;'), [('word', 'a}b'), (';', ';')])

    def test_closing_quote_may_be_followed_by_parenthesis(self):
        self.assertEqual(words(b'if ($a = "b") { }'),
                         [('word', 'if'), ('word', '($a'), ('word', '='), ('word', 'b'), ('word', ')'), ('{', '{'), ('}', '}')])
        self.assertEqual(words(b'x "a";y;'), [('word', 'x'), ('word', 'a'), (';', ';'), ('word', 'y'), (';', ';')])
        self.assertEqual(words(b'x "a"{}'), [('word', 'x'), ('word', 'a'), ('{', '{'), ('}', '}')])

    def test_parenthesis_after_a_closing_quote_starts_the_next_word_like_nginx(self):
        # nginx 1.28.3 logs `log_format f "[" "x")$host "]" "y")) "z")` as "[x)localhost]y))z)":
        # the ')' is not dropped; it begins the next word. `set $x "a");` is three
        # arguments to nginx ("invalid number of arguments"), and so it is here.
        self.assertEqual(words(b'log_format f "[" "x")$host "]" "y")) "z")\n;'),
                         [('word', 'log_format'), ('word', 'f'), ('word', '['), ('word', 'x'), ('word', ')$host'),
                          ('word', ']'), ('word', 'y'), ('word', '))'), ('word', 'z'), ('word', ')'), (';', ';')])
        self.assertEqual(words(b'set $x "a");'), [('word', 'set'), ('word', '$x'), ('word', 'a'), ('word', ')'), (';', ';')])
        self.assertEqual(words(b"x 'a')b;"), [('word', 'x'), ('word', 'a'), ('word', ')b'), (';', ';')])

    def test_lua_block_bodies_are_not_nginx_syntax_and_fail_closed(self):
        for name in LUA_BLOCKS:
            with self.subTest(name=name):
                self.fails('nginx_lexer_unsupported', m.tokenize,
                           ('location / { ' + name + '_by_lua_block { ngx.say("hi") } }\n').encode())
        self.fails('nginx_lexer_unsupported', m.tokenize, b'set_by_lua_block $x { return 1 }\n')
        # A valid body is still refused as unsupported, never as a syntax error.
        self.fails('nginx_lexer_unsupported', m.tokenize, b'content_by_lua_block { ngx.say("hi") }')
        self.fails('nginx_lexer_unsupported', m.tokenize, b'"content_by_lua_block" { }')
        self.fails('nginx_lexer_unsupported', m.tokenize, b'future_by_lua_block{ }')
        # The string forms are ordinary nginx words.
        self.assertEqual(words(b"content_by_lua 'ngx.say(1)';"), [('word', 'content_by_lua'), ('word', 'ngx.say(1)'), (';', ';')])

    def test_invalid_or_ambiguous_syntax_fails_closed(self):
        for raw in (b'x "a', b"x 'a", b'x "a"b;', b'x "a""b";', b'x "a"#c;', b'x "a"};', b';', b'{ }', b'a { b }',
                    b'a {', b'}', b'a { } }', b'a', b'a b', b'x \\', b'x "\\', b'a "b"'):
            with self.subTest(raw=raw):
                self.fails('nginx_syntax_invalid', m.tokenize, raw)

    def test_invalid_text_fails_closed(self):
        # A managed file is bytes without NUL, lexed one character per byte like any other file.
        for raw in (b'x \x00;', b'# \x00\nx;', 'x;', bytearray(b'x;'), None):
            with self.subTest(raw=raw):
                self.fails('nginx_text_invalid', m.tokenize, raw)
        self.assertEqual(words(b'x \xff;'), [('word', 'x'), ('word', '\xff'), (';', ';')])
        self.assertEqual(words('# \u6ce8\u91c8\nx "\u79d8\u5bc6";'.encode()),
                         [('word', 'x'), ('word', '\u79d8\u5bc6'.encode().decode('latin-1')), (';', ';')])

    def test_token_repr_and_failures_hide_values(self):
        tokens = m.tokenize(('set $s "' + SECRET + '";').encode())
        self.assertIn(SECRET, [token.value for token in tokens])
        self.assertNotIn(SECRET, repr(tokens))
        self.fails('nginx_syntax_invalid', m.tokenize, ('set $s "' + SECRET).encode())
        self.fails('nginx_text_invalid', m.tokenize, (SECRET + ';').encode() + b'\x00')


class ParseDumpTests(Assertions):
    MAIN = b'http {\n    include /etc/nginx/conf.d/*.conf;\n}\n'

    def test_managed_sections_match_exact_bytes(self):
        raw = dump(('/etc/nginx/nginx.conf', self.MAIN), ('/etc/nginx/conf.d/geo.conf', GEO),
                   (GEO_INCLUDE, GEO_SHARED), ('/etc/nginx/conf.d/other.conf', b'x;'))
        sections = m.parse_dump(raw, {'/etc/nginx/conf.d/geo.conf': GEO, GEO_INCLUDE: GEO_SHARED}).sections
        self.assertEqual([(s.path, s.managed) for s in sections],
                         [('/etc/nginx/nginx.conf', False), ('/etc/nginx/conf.d/geo.conf', True),
                          (GEO_INCLUDE, True), ('/etc/nginx/conf.d/other.conf', False)])
        self.assertEqual(sections[1].body, GEO)
        self.assertEqual(sections[3].body, b'x;')
        self.assertNotIn(SECRET, repr(sections))

    def test_trailing_newline_of_the_file_is_preserved(self):
        for body in (b'a 1;', b'a 1;\n', b'a 1;\n\n', b''):
            with self.subTest(body=body):
                for raw in (dump(('/m', body)), dump(('/m', body), ('/n', b'y;')), dump(('/n', b'y;'), ('/m', body))):
                    sections = m.parse_dump(raw, {'/m': body}).sections
                    self.assertEqual([s.body for s in sections if s.path == '/m'], [body])

    def test_missing_final_linefeed_or_wrong_terminator_fails(self):
        self.fails('nginx_dump_invalid', m.parse_dump, header('/m') + b'a;', {'/m': b'a;'})
        self.fails('nginx_dump_invalid', m.parse_dump, dump(('/n', b'x;'))[:-1], {'/n': b'x;'})
        self.fails('nginx_dump_mismatch', m.parse_dump, header('/m') + b'a;x\n', {'/m': b'a;'})
        self.fails('nginx_dump_mismatch', m.parse_dump, header('/m') + b'a;\n\n', {'/m': b'a;'})
        # The byte after the managed bytes is the separating linefeed, also before a heading or at the end.
        self.fails('nginx_dump_mismatch', m.parse_dump, header('/m') + b'a;X' + header('/n') + b'y;\n', {'/m': b'a;'})
        self.fails('nginx_dump_mismatch', m.parse_dump, header('/m') + b'a;X', {'/m': b'a;'})

    def test_differing_or_extended_bytes_fail(self):
        self.fails('nginx_dump_mismatch', m.parse_dump, dump(('/m', b'a 2;\n')), {'/m': b'a 1;\n'})
        self.fails('nginx_dump_mismatch', m.parse_dump, dump(('/m', b'a 1;\nb 1;\n')), {'/m': b'a 1;\n'})
        # The file bytes then end the dump without nginx's separating linefeed.
        self.fails('nginx_dump_invalid', m.parse_dump, dump(('/m', b'a 1;')), {'/m': b'a 1;\n'})
        self.fails('nginx_dump_mismatch', m.parse_dump, dump(('/m', b'a 1;\n')), {'/m': b'a 1;'})
        error = self.fails('nginx_dump_mismatch', m.parse_dump, dump(('/m', SECRET.encode())), {'/m': b'other'})
        self.assertNotIn(SECRET, str(error.args))

    def test_missing_managed_path_fails(self):
        self.fails('nginx_dump_missing', m.parse_dump, dump(('/n', b'x;')), {'/n': b'x;', '/m': b'a;'})
        # Path comparison is exact (no normalization, no prefix match).
        self.fails('nginx_dump_missing', m.parse_dump, dump(('/m/', b'a;')), {'/m': b'a;'})
        self.fails('nginx_dump_missing', m.parse_dump, dump(('/mm', b'a;')), {'/m': b'a;'})

    def test_header_forgery_in_comments_or_text_never_counts(self):
        # The legacy check accepted the header text anywhere (comment substring).
        for body in (b'# # configuration file /m:\n', b'x; # configuration file /m:\n',
                     b' # configuration file /m:\n', b'x "# configuration file /m:";\n'):
            with self.subTest(body=body):
                self.fails('nginx_dump_missing', m.parse_dump, dump(('/n', body)), {'/m': b'a;\n'})
        # A line-initial forged header with other bytes is a mismatch.
        self.fails('nginx_dump_mismatch', m.parse_dump, dump(('/n', b'x;\n# configuration file /m:\nb;\n')), {'/m': b'a;\n'})
        # A forged header inside an open quote of the preceding file cannot pass.
        # Each forgery below is well framed; the preceding file is then incomplete.
        forged = b'\n# configuration file /m:\na;\n\n# configuration file /z:\n'
        self.fails('nginx_syntax_invalid', m.parse_dump, dump(('/n', b'return 200 "' + forged + b'";\n')), {'/m': b'a;\n'})
        # Nor inside an escaped line end or an open block of the preceding file.
        self.fails('nginx_syntax_invalid', m.parse_dump, dump(('/n', b'x y\\' + forged + b';\n')), {'/m': b'a;\n'})
        self.fails('nginx_syntax_invalid', m.parse_dump, dump(('/n', b'lua {' + forged + b'}\n')), {'/m': b'a;\n'})
        # The same framing with a complete preceding file is accepted.
        self.assertEqual([s.path for s in m.parse_dump(dump(('/n', b'x;' + forged + b'y;\n')), {'/m': b'a;\n'}).sections], ['/n', '/m', '/z'])

    def test_every_unmanaged_file_must_be_lexically_complete(self):
        # A header can start inside an open quote of any earlier file, not only the
        # one directly before a managed section: here /n opens the quote and the
        # empty /f sits between it and the forged managed /s/geo.
        forged = (b'\n# configuration file /f:\n\n# configuration file /s/geo:\n' + GEO
                  + b'\n# configuration file /g:\n')
        raw = dump(('/n', b'return 200 "' + forged + b'";\n'))
        self.fails('nginx_syntax_invalid', m.parse_dump, raw, {'/s/geo': GEO})
        # Files after the last managed one, and files with no managed one at all.
        self.fails('nginx_syntax_invalid', m.parse_dump, dump(('/m', b'a;\n'), ('/n', b'x "y;\n')), {'/m': b'a;\n'})
        self.fails('nginx_syntax_invalid', m.parse_dump, dump(('/m', b'a;\n'), ('/n', b'}\n')), {'/m': b'a;\n'})
        self.fails('nginx_syntax_invalid', m.parse_dump, dump(('/n', b'x {\n'), ('/o', b'y;\n'), ('/m', b'a;\n')), {'/m': b'a;\n'})
        # Managed bytes are lexed as well.
        self.fails('nginx_syntax_invalid', m.parse_dump, dump(('/m', b'a {\n')), {'/m': b'a {\n'})

    def test_lua_block_hiding_a_header_fails_closed(self):
        forged = b'\n# configuration file /s/geo:\n' + GEO + b'\n# configuration file /g:\n'
        body = b'location / {\n    content_by_lua_block { ngx.say([[' + forged + b']]) }\n}\n'
        self.fails('nginx_lexer_unsupported', m.parse_dump, dump(('/n', body)), {'/s/geo': GEO})
        self.fails('nginx_lexer_unsupported', m.parse_dump, dump(('/n', b'content_by_lua_block { ngx.say("hi") }\n'), ('/m', b'a;\n')),
                   {'/m': b'a;\n'})

    def test_unmanaged_files_are_lexed_as_bytes(self):
        # nginx reads bytes: cp932 notes, other 8-bit bytes and NUL are accepted by
        # nginx 1.28.3 in comments and words of a loaded file.
        note = '# \u8868\u793a\u306e\u6ce8\u91c8\n'.encode('cp932')
        for body in (note + b'x;\n', b'x "\x82\xa0";\n', b'x \xff;\n', b'# \x00\nx;\n', b'x a\x00b;\n'):
            with self.subTest(body=body):
                sections = m.parse_dump(dump(('/n', body), ('/m', b'a;\n')), {'/m': b'a;\n'}).sections
                self.assertEqual([(s.path, s.body, s.managed) for s in sections], [('/n', body, False), ('/m', b'a;\n', True)])
        # cp932 '\u8868' ends in byte 0x5c, a backslash to nginx: it escapes the closing quote.
        self.fails('nginx_syntax_invalid', m.parse_dump, dump(('/n', b'x "' + '\u8868'.encode('cp932') + b'";\n'), ('/m', b'a;\n')),
                   {'/m': b'a;\n'})
        # Managed files are lexed the same way, NUL refused: UTF-8 notes and 8-bit values are text.
        for body in ('# \u65e5\u672c\u8a9e\u306e\u6ce8\u91c8\na \u00e9;\n'.encode(), b'a \xff;\n'):
            with self.subTest(body=body):
                self.assertEqual([(s.path, s.body) for s in m.parse_dump(dump(('/m', body)), {'/m': body}).sections], [('/m', body)])
        for body in (b'a \x00;\n', '# \u6ce8\u91c8\x00\na;\n'.encode()):
            with self.subTest(body=body):
                self.fails('nginx_text_invalid', m.parse_dump, dump(('/m', body)), {'/m': body})

    def test_a_line_with_the_heading_prefix_is_a_heading_or_the_dump_is_refused(self):
        # Every line that starts with the exact heading prefix is either a valid
        # heading or makes the whole dump invalid: it is never file text.
        invalid = (b'# configuration file /\xff:', b'# configuration file /a\tb:', b'# configuration file /\x7f:',
                   b'# configuration file relative:', b'# configuration file /x', b'# configuration file :',
                   b'# configuration file /x:\r', b'# configuration file /x: ', b'# configuration file ')
        for line in invalid:
            with self.subTest(line=line):
                # Inside an unmanaged file, as its first line, and after a managed file.
                self.fails('nginx_dump_invalid', m.parse_dump, dump(('/n', b'x;\n' + line + b'\ny;\n'), ('/m', b'a;\n')), {'/m': b'a;\n'})
                self.fails('nginx_dump_invalid', m.parse_dump, dump(('/n', line + b'\ny;\n'), ('/m', b'a;\n')), {'/m': b'a;\n'})
                self.fails('nginx_dump_invalid', m.parse_dump, dump(('/m', b'a;\n')) + line + b'\n', {'/m': b'a;\n'})
        # nginx 1.28.3 `-T` for `include "/cfg/lfa\nz";` (a file name with a linefeed):
        # the heading itself spans two lines.
        real = (b'# configuration file /cfg/lf2.conf:\nhttp {\n    include "/cfg/lfa\\nz";\n}\n\n'
                b'# configuration file /cfg/lfa\nz:\naccess_log off;\n\n')
        self.fails('nginx_dump_invalid', m.parse_dump, real + dump(('/m', b'a;\n')), {'/m': b'a;\n'})
        # A valid heading as the first line of a file body cannot be nginx's own
        # (nginx ends every file with a linefeed): refused too.
        self.fails('nginx_dump_invalid', m.parse_dump, dump(('/n', b'# configuration file /z:\ny;\n'), ('/m', b'a;\n')), {'/m': b'a;\n'})

    def test_comments_that_only_resemble_the_heading_stay_in_the_body(self):
        for line in (b'#configuration file /x:', b'#  configuration file /x:', b' # configuration file /x:',
                     b'\t# configuration file /x:', b'# Configuration file /x:', b'# configuration  file /x:',
                     b'## configuration file /x:', b'# configuration files /x:'):
            body = b'x;\n' + line + b'\ny;\n'
            with self.subTest(line=line):
                sections = m.parse_dump(dump(('/n', body), ('/m', b'a;\n')), {'/m': b'a;\n'}).sections
                self.assertEqual([(s.path, s.body) for s in sections], [('/n', body), ('/m', b'a;\n')])
        # After a managed file a non-heading line is extra bytes of that file.
        self.fails('nginx_dump_mismatch', m.parse_dump, dump(('/m', b'a;\n')) + b'#configuration file /x:\n', {'/m': b'a;\n'})

    def test_header_text_inside_a_managed_file_is_consumed_by_length(self):
        body = b'# configuration file /x:\na;\n'
        sections = m.parse_dump(dump(('/m', body), ('/n', b'y;')), {'/m': body}).sections
        self.assertEqual([(s.path, s.body) for s in sections], [('/m', body), ('/n', b'y;')])

    def test_a_heading_path_appears_once(self):
        # nginx -T prints each file once however often it is included, so a second
        # heading of one path, managed or not, matching or not, is not nginx's.
        for raw in (dump(('/m', b'a;'), ('/n', b'x;'), ('/m', b'a;')), dump(('/m', b'a;'), ('/m', b'a;')),
                    dump(('/m', b'a;'), ('/n', b'x;'), ('/m', b'b;')), dump(('/n', b'x;'), ('/m', b'a;'), ('/n', b'x;')),
                    dump(('/n', b'x;'), ('/n', b'y;'), ('/m', b'a;')), dump(('/m', b'a;'), ('/n', b''), ('/n', b''))):
            with self.subTest(raw=raw):
                self.fails('nginx_dump_invalid', m.parse_dump, raw, {'/m': b'a;'})
        # The first occurrence is still checked first.
        self.fails('nginx_dump_mismatch', m.parse_dump, dump(('/m', b'b;'), ('/m', b'a;')), {'/m': b'a;'})

    def test_a_file_included_twice_is_dumped_once_by_nginx(self):
        # nginx 1.28.3 `nginx -T -q -c /cfg/twice/nginx.conf` (s.conf included in two
        # servers and again by a glob): one heading for s.conf.
        real = (b'# configuration file /cfg/twice/nginx.conf:\n' + TWICE_MAIN + b'\n'
                b'# configuration file /cfg/twice/s.conf:\n' + TWICE_S + b'\n')
        sections = m.parse_dump(real, {'/cfg/twice/s.conf': TWICE_S}).sections
        self.assertEqual([(s.path, s.managed) for s in sections], [('/cfg/twice/nginx.conf', False), ('/cfg/twice/s.conf', True)])

    def test_a_managed_heading_forged_inside_an_unmanaged_file_is_refused(self):
        # An unmanaged file that carries a heading of a managed path and that file's
        # exact bytes, before or after nginx's own section of it.
        tail = header('/etc/nginx/conf.d/tail.conf') + b'y;\n'
        managed = {GEO_INCLUDE: GEO_SHARED, REAL_INCLUDE: REAL_SHARED}
        forged = b'x;\n' + header(REAL_INCLUDE) + REAL_SHARED + b'\n' + tail
        for raw in (dump((MAIN_PATH, MAIN), (GEO_INCLUDE, GEO_SHARED), (REAL_INCLUDE, REAL_SHARED), ('/etc/nginx/conf.d/z.conf', forged)),
                    dump((MAIN_PATH, MAIN + header(REAL_INCLUDE) + REAL_SHARED + b'\n' + tail), (GEO_INCLUDE, GEO_SHARED),
                         (REAL_INCLUDE, REAL_SHARED))):
            with self.subTest(raw=raw):
                self.fails('nginx_dump_invalid', m.parse_dump, raw, managed)

    def test_dump_framing(self):
        for raw in (b'', b'x\n' + dump(('/m', b'a;')), b'nginx: ok\n' + dump(('/m', b'a;')),
                    b'# configuration file /m\na;\n', b'# configuration file :\na;\n',
                    b'# configuration file m:\na;\n', b'# configuration file /m:', b'# configuration file /\xff:\na;\n',
                    b'# configuration file /m\x00:\na;\n'):
            with self.subTest(raw=raw):
                self.fails('nginx_dump_invalid', m.parse_dump, raw, {'/m': b'a;'})
        for raw in ('text', bytearray(dump(('/m', b'a;'))), None):
            with self.subTest(raw=raw):
                self.fails('nginx_dump_invalid', m.parse_dump, raw, {'/m': b'a;'})

    def test_managed_argument_is_validated(self):
        raw = dump(('/m', b'a;'))
        for managed in ({}, None, [('/m', b'a;')], {'m': b'a;'}, {b'/m': b'a;'}, {'/m': 'a;'},
                        {'/m': bytearray(b'a;')}, {'/m\n': b'a;'}, {'/m\x00': b'a;'}):
            with self.subTest(managed=managed):
                self.fails('nginx_managed_invalid', m.parse_dump, raw, managed)


class ParseSharedTests(Assertions):
    def test_rendered_pair_is_accepted(self):
        self.assertEqual(m.parse_shared(GEO_SHARED, REAL_SHARED), RANGES)

    def test_empty_or_single_family_is_rejected(self):
        self.fails('nginx_shared_invalid', m.parse_shared, b'', b'')
        self.fails('nginx_shared_invalid', m.parse_shared, b'13.32.0.0/15 1;\n', b'set_real_ip_from 13.32.0.0/15;\n')
        self.fails('nginx_shared_invalid', m.parse_shared, b'2600:9000::/28 1;\n', b'set_real_ip_from 2600:9000::/28;\n')

    def test_noncanonical_cidr_is_rejected(self):
        def shared(ranges):
            return (''.join(cidr + ' 1;\n' for cidr in ranges).encode(),
                    ''.join('set_real_ip_from ' + cidr + ';\n' for cidr in ranges).encode())
        # Each case sits where its value sorts, so only the spelling or value is wrong.
        self.assertEqual(m.parse_shared(*shared(('13.32.0.0/15', '54.192.0.0/16', '2600:9000::/28', '2a05:d000::/25'))),
                         ('13.32.0.0/15', '54.192.0.0/16', '2600:9000::/28', '2a05:d000::/25'))
        for first, v4, v6 in (('', '54.192.0.1/16', ''), ('', '54.192.0.0', ''), ('', '054.192.0.0/16', ''),
                              ('', '54.192.0.0/016', ''), ('', '54.192.0.0/33', ''), ('', '', '2a05:d000:0::/25'),
                              ('', '', '2a05:d000:0:0:0:0:0:0/25'), ('', '', '2a05:d000::/025'), ('', '', '2a05:d000::1/25'),
                              ('', '', '2a05:d000::/129'), ('', '', 'fe80::%eth0/64'), ('', '54.192.0.0/16 ', ''),
                              ('', '54.192.0.0/16\x00', ''), ('', '\u0665\u0664.192.0.0/16', ''),
                              ('0.0.0.0/0', '', ''), ('', '', '::/0'),
                              # IPv4-mapped in either spelling (dotted since Python 3.13).
                              ('', '::ffff:54.192.0.0/112', ''), ('', '::ffff:36c0:0/112', '')):
            ranges = tuple(item for item in (first, '13.32.0.0/15', v4, '2600:9000::/28', v6) if item)
            with self.subTest(ranges=ranges):
                if first == '0.0.0.0/0' or v6 == '::/0':
                    ranges = (('0.0.0.0/0', '13.32.0.0/15', '2600:9000::/28') if first else ('13.32.0.0/15', '::/0', '2600:9000::/28'))
                self.fails('nginx_shared_invalid', m.parse_shared, *shared(ranges))
        # Upper-case IPv6 is not the canonical spelling; the lower-case one is.
        self.assertEqual(m.parse_shared(GEO_SHARED + b'2a05:d000::/25 1;\n', REAL_SHARED + b'set_real_ip_from 2a05:d000::/25;\n'),
                         RANGES + ('2a05:d000::/25',))
        self.fails('nginx_shared_invalid', m.parse_shared, GEO_SHARED + b'2A05:D000::/25 1;\n',
                   REAL_SHARED + b'set_real_ip_from 2A05:D000::/25;\n')

    def test_layout_is_exactly_the_rendered_form(self):
        for geo in (b'# comment\n' + GEO_SHARED, b'\n' + GEO_SHARED, GEO_SHARED + b'\n', GEO_SHARED[:-1],
                    GEO_SHARED.replace(b' 1;', b'  1;'), GEO_SHARED.replace(b' 1;', b'\t1;'),
                    GEO_SHARED.replace(b' 1;', b' 2;'), GEO_SHARED.replace(b' 1;', b' 1 ;'),
                    GEO_SHARED.replace(b'\n', b'\r\n'), b' ' + GEO_SHARED,
                    GEO_SHARED + b'13.32.0.0/15 1;\n', b'13.32.0.0/15 1;\n' + GEO_SHARED, b'default 0;\n' + GEO_SHARED, b'\xff', 'text', None):
            with self.subTest(geo=geo):
                self.fails('nginx_shared_invalid', m.parse_shared, geo, REAL_SHARED)
        for real in (REAL_SHARED.replace(b'set_real_ip_from ', b'set_real_ip_from  '),
                     REAL_SHARED.replace(b';', b' ;'), REAL_SHARED.replace(b'set_real_ip_from', b'allow'),
                     b'real_ip_header X-Forwarded-For;\n' + REAL_SHARED, REAL_SHARED[:-1], b''):
            with self.subTest(real=real):
                self.fails('nginx_shared_invalid', m.parse_shared, GEO_SHARED, real)

    def test_range_order_is_free_and_the_result_is_canonical(self):
        def migrate_render(values):
            # The common-sv migration candidate renders ranges_checked(values):
            # str(ip_network(x, strict=True)) for each value, then sorted() as strings.
            ranges = sorted(str(ipaddress.ip_network(x, strict=True)) for x in values)
            return (''.join(x + ' 1;\n' for x in ranges).encode(),
                    ''.join('set_real_ip_from ' + x + ';\n' for x in ranges).encode())
        values = ['2600:9000::/28', '52.46.0.0/18', '13.32.0.0/15', '2a05:d000::/25', '3.172.0.0/18', '130.176.0.0/17']
        geo, realip = migrate_render(values)
        # String order, not address order.
        self.assertEqual(geo.split(b' 1;\n')[:-1], [b'13.32.0.0/15', b'130.176.0.0/17', b'2600:9000::/28', b'2a05:d000::/25',
                                                  b'3.172.0.0/18', b'52.46.0.0/18'])
        self.assertEqual(m.parse_shared(geo, realip),
                         ('3.172.0.0/18', '13.32.0.0/15', '52.46.0.0/18', '130.176.0.0/17', '2600:9000::/28', '2a05:d000::/25'))
        # Each file in its own order.
        self.assertEqual(m.parse_shared(b'2600:9000::/28 1;\n52.46.0.0/18 1;\n13.32.0.0/15 1;\n', REAL_SHARED), RANGES)
        self.assertEqual(m.parse_shared(GEO_SHARED, b'set_real_ip_from 52.46.0.0/18;\nset_real_ip_from 2600:9000::/28;\n'
                                                    b'set_real_ip_from 13.32.0.0/15;\n'), RANGES)
        # Duplicates stay refused in any order.
        self.fails('nginx_shared_invalid', m.parse_shared, b'52.46.0.0/18 1;\n' + GEO_SHARED, REAL_SHARED)

    def test_geo_and_realip_ranges_must_be_equal(self):
        self.fails('nginx_shared_ranges_differ', m.parse_shared, GEO_SHARED,
                   b'set_real_ip_from 13.32.0.0/15;\nset_real_ip_from 2600:9000::/28;\n')


def reachable_directives(value):
    """Every Directive reachable from value through attributes and containers (identity, first-seen order)."""
    found, seen, pending = [], set(), [value]
    while pending:
        item = pending.pop()
        if id(item) in seen or isinstance(item, (str, bytes, int, float, bool, type(None))):
            continue
        seen.add(id(item))
        if type(item) is m.Directive:
            found.append(item)
        if isinstance(item, dict):
            pending.extend(item.values())
        elif isinstance(item, (tuple, list, set, frozenset)):
            pending.extend(item)
        if hasattr(item, '__dict__'):
            pending.extend(vars(item).values())
        if dataclasses.is_dataclass(item):
            pending.extend(getattr(item, field.name) for field in dataclasses.fields(item))
    return found


def policy_sections(geo=GEO, realip=REALIP, main=MAIN, extra=(), same=False):
    """Sections as parse_dump returns them for one bundle (geo and realip files)."""
    files = [(MAIN_PATH, main), (GEO_PATH, geo), (GEO_INCLUDE, GEO_SHARED)]
    if not same:
        files.append((REALIP_PATH, realip))
    files += [(REAL_INCLUDE, REAL_SHARED), *extra]
    managed = {GEO_PATH: geo, GEO_INCLUDE: GEO_SHARED, REAL_INCLUDE: REAL_SHARED}
    if not same:
        managed[REALIP_PATH] = realip
    return m.parse_dump(dump(*files), managed)


class PolicyTests(Assertions):
    def check(self, geo=GEO, realip=REALIP, shared=SHARED, main=MAIN, extra=(), same=False):
        sections = policy_sections(geo, realip, main, extra, same)
        bundles = ((GEO_PATH, GEO_PATH if same else REALIP_PATH),)
        return m.check_policy(sections, bundles, shared)

    def test_required_policy_is_accepted(self):
        self.assertIsNone(self.check())
        # Quoting is the same word to nginx.
        self.assertIsNone(self.check(geo=GEO.replace(b'include ' + GEO_INCLUDE.encode(), b'"include" "' + GEO_INCLUDE.encode() + b'"')))
        # default before include, and both files in one bundle file.
        self.assertIsNone(self.check(geo=GEO.replace(b'    include ' + GEO_INCLUDE.encode() + b';\n    default 0;\n',
                                                     b'    default 0;\n    include ' + GEO_INCLUDE.encode() + b';\n')))
        combined = GEO + REALIP
        self.assertIsNone(self.check(geo=combined, realip=combined, same=True))
        # A trailing comment after a directive is a comment.
        self.assertIsNone(self.check(realip=REALIP.replace(b'off;', b'off;#note')))

    def test_geo_default_rules(self):
        for old, new in ((b'    default 0;\n', b''), (b'    default 0;\n', b'    default 0;\n    default 0;\n'),
                         (b'    default 0;\n', b'    default 1;\n'), (b'    default 0;\n', b'    default 0 0;\n'),
                         (b'    default 0;\n', b'    default#x 0;\n'), (b'    default 0;\n', b'    # default 0;\n'),
                         (b'    default 0;\n', b'    default 0 { }\n')):
            with self.subTest(new=new):
                self.fails('nginx_geo_unmanaged_policy', self.check, GEO.replace(old, new, 1))

    def test_geo_body_contains_only_include_and_default(self):
        include = ('    include ' + GEO_INCLUDE + ';\n').encode()
        for extra in (b'    10.0.0.0/8 1;\n', b'    ranges;\n', b'    proxy 10.0.0.1;\n', b'    delete 13.32.0.0/15;\n',
                      include, ('    include ' + SHARED + '/other.conf;\n').encode(), b'    nested { }\n',
                      ('    "' + SECRET + '" 1;\n').encode()):
            with self.subTest(extra=extra):
                self.fails('nginx_geo_unmanaged_policy', self.check, GEO.replace(b'    default 0;\n', b'    default 0;\n' + extra, 1))

    def test_geo_must_be_bound_to_the_original_peer_once(self):
        block = ('geo $realip_remote_addr $other {\n    include ' + GEO_INCLUDE + ';\n    default 0;\n}\n').encode()
        for geo in (GEO.replace(b'$realip_remote_addr', b'$remote_addr', 1),
                    GEO.replace(b'$realip_remote_addr', b'$http_x_forwarded_for', 1),
                    GEO.replace(b'geo $realip_remote_addr $cloudfront_origin', b'geo $cloudfront_origin', 1),
                    # One argument names the variable; the source is then the implicit $remote_addr.
                    GEO.replace(b'geo $realip_remote_addr $cloudfront_origin', b'geo $realip_remote_addr', 1),
                    GEO.replace(b'$cloudfront_origin {', b'$cloudfront_origin extra {', 1),
                    GEO.replace(b'geo $realip_remote_addr', b'geo "$realip_remote_addr " ', 1),
                    GEO.replace(b'geo ', b'map ', 1), GEO + block,
                    GEO.replace(('    include ' + GEO_INCLUDE + ';\n').encode(), b'    # include ' + GEO_INCLUDE.encode() + b';\n'),
                    GEO.replace(('include ' + GEO_INCLUDE).encode(), ('include ' + GEO_INCLUDE + '.bak').encode()),
                    b'map $a $b { default 0; }\n'):
            with self.subTest(geo=geo):
                self.fails('nginx_geo_not_bound', self.check, geo)

    def test_realip_include_exactly_once(self):
        include = ('    include ' + REAL_INCLUDE + ';\n').encode()
        for realip in (REALIP.replace(include, b''), REALIP.replace(include, include + include),
                       REALIP.replace(include, b'    #' + include[4:]), REALIP.replace(include, include.replace(b'realip', b'geo'))):
            with self.subTest(realip=realip):
                self.fails('nginx_realip_include_invalid', self.check, GEO, realip)

    def test_realip_header_and_recursion_required(self):
        for old, new in ((b'    real_ip_header X-Forwarded-For;\n', b''), (b'    real_ip_recursive off;\n', b''),
                         (b'    real_ip_recursive off;\n', b'    # real_ip_recursive off;\n')):
            with self.subTest(new=new):
                self.fails('nginx_realip_policy_missing', self.check, GEO, REALIP.replace(old, new))

    def test_other_realip_values_or_trust_are_rejected(self):
        for old, new in ((b'X-Forwarded-For;', b'X-Real-IP;'), (b'X-Forwarded-For;', b'x-forwarded-for;'),
                         (b'X-Forwarded-For;', b'X-Forwarded-For X-Real-IP;'), (b'off;', b'on;'),
                         (b'    real_ip_recursive off;\n', b'    real_ip_recursive off;\n    real_ip_recursive on;\n'),
                         (b'    real_ip_header X-Forwarded-For;\n', b'    real_ip_header X-Forwarded-For;\n    real_ip_header proxy_protocol;\n'),
                         (b'    listen 443 ssl;\n', b'    listen 443 ssl;\n    set_real_ip_from 0.0.0.0/0;\n'),
                         (b'    listen 443 ssl;\n', b'    listen 443 ssl;\n    location / { set_real_ip_from 10.0.0.0/8; }\n'),
                         (b'    listen 443 ssl;\n', b'    listen 443 ssl;\n    real_ip_other x;\n'),
                         (b'    listen 443 ssl;\n', b'    listen 443 ssl;\n    "set_real_ip_from" 10.0.0.0/8;\n'),
                         (b'    listen 443 ssl;\n', b'    listen 443 ssl;\n    real_ip_recursive off { }\n')):
            with self.subTest(new=new):
                if new.endswith(b'X-Real-IP;') or new.endswith(b'x-forwarded-for;') or new == b'on;':
                    # The required value is then absent as well; either refusal is fail-closed.
                    with self.assertRaises(m.NginxObservationError):
                        self.check(GEO, REALIP.replace(old, new))
                else:
                    self.fails('nginx_realip_unmanaged_trust', self.check, GEO, REALIP.replace(old, new))
        # Trust added in the geo file counts too.
        self.fails('nginx_realip_unmanaged_trust', self.check, GEO + b'set_real_ip_from 10.0.0.0/8;\n', REALIP)
        self.fails('nginx_realip_unmanaged_trust', self.check, GEO + b'real_ip_recursive on;\n', REALIP)

    def test_realip_value_differences_are_precise(self):
        self.fails('nginx_realip_policy_missing', self.check, GEO, REALIP.replace(b'X-Forwarded-For;', b'X-Real-IP;'))
        self.fails('nginx_realip_policy_missing', self.check, GEO, REALIP.replace(b'off;', b'on;'))
        self.fails('nginx_realip_unmanaged_trust', self.check, GEO,
                   REALIP.replace(b'    real_ip_recursive off;\n', b'    real_ip_recursive off;\n    real_ip_recursive on;\n'))

    def test_shared_directory_is_exact(self):
        for shared in ('etc/nginx/cloudfront', SHARED + '/', SHARED + '/.', '/etc/nginx/../nginx/cloudfront',
                       '//etc/nginx/cloudfront', '/', '', None, b'/etc/nginx/cloudfront', '/etc/nginx/cloud\nfront',
                       '/etc/nginx/cloud\x00front'):
            with self.subTest(shared=shared):
                self.fails('nginx_shared_dir_invalid', self.check, GEO, REALIP, shared)
        # The dump's managed files then differ from the policy's: an inconsistent call.
        self.fails('nginx_managed_invalid', self.check, GEO, REALIP, '/etc/nginx/other')

    def test_syntax_errors_and_secret_bearing_inputs_never_leak(self):
        self.fails('nginx_syntax_invalid', self.check, GEO + ('set $x "' + SECRET).encode(), REALIP)
        self.fails('nginx_syntax_invalid', self.check, GEO, REALIP + b'}')
        self.fails('nginx_text_invalid', self.check, GEO + b'\x00', REALIP)
        self.fails('nginx_geo_unmanaged_policy', self.check,
                   GEO.replace(b'    default 0;\n', ('    default 0;\n    "' + SECRET + '" 1;\n').encode(), 1))
        self.fails('nginx_realip_unmanaged_trust', self.check, GEO, REALIP + ('set_real_ip_from "' + SECRET + '";\n').encode())


    def test_geo_variable_is_defined_only_by_the_managed_geo(self):
        geo_redefinitions = (b'geo $remote_addr $cloudfront_origin {\n    default 1;\n}\n',
                             b'geo $cloudfront_origin {\n    default 1;\n}\n',
                             b'map $host $cloudfront_origin {\n    default 1;\n}\n')
        for extra in geo_redefinitions:
            with self.subTest(extra=extra):
                # Later in the same bundle file, and in another (unmanaged) file.
                self.fails('nginx_geo_variable_redefined', self.check, GEO + extra)
                self.fails('nginx_geo_variable_redefined', self.check, extra=(('/etc/nginx/conf.d/z.conf', extra),))
        # (perl_set, js_set, js_var and set_by_lua are refused as dynamic modules.)
        server_redefinitions = (b'set $cloudfront_origin 1;', b'set $CloudFront_Origin 1;', b'set ${cloudfront_origin} 1;',
                                b'auth_request_set $cloudfront_origin $upstream_status;', b'set_md5 $cloudfront_origin x;',
                                b'keyval $arg_k $cloudfront_origin zone=z;')
        for line in server_redefinitions:
            with self.subTest(line=line):
                # In the realip file (inside its server) and in another file.
                self.fails('nginx_geo_variable_redefined', self.check, GEO,
                           REALIP.replace(b'    real_ip_recursive off;\n', b'    real_ip_recursive off;\n    ' + line + b'\n'))
                self.fails('nginx_geo_variable_redefined', self.check,
                           extra=(('/etc/nginx/conf.d/z.conf', b'server {\n    location / { ' + line + b' }\n}\n'),))
        self.fails('nginx_geo_variable_redefined', self.check,
                   extra=(('/etc/nginx/conf.d/z.conf', b'split_clients "$x" $CLOUDFRONT_ORIGIN {\n    * 1;\n}\n'),))
        # Reading the variable is not a definition.
        self.assertIsNone(self.check(geo=GEO + b'map $cloudfront_origin $from_cloudfront {\n    default 0;\n    1 1;\n}\n',
                                     realip=REALIP.replace(b'    listen 443 ssl;\n',
                                                           b'    listen 443 ssl;\n    if ($cloudfront_origin = 0) { return 403; }\n'
                                                           b'    set $copy $cloudfront_origin;\n')))

    def test_realip_include_only_in_http_server_location_or_file_level(self):
        include = ('    include ' + REAL_INCLUDE + ';\n').encode()
        for wrapped in (b'    map $host $z {\n' + include + b'        default 0;\n    }\n',
                        b'    types {\n' + include + b'    }\n', b'    geo $z {\n' + include + b'    }\n',
                        b'    split_clients "$x" $z {\n' + include + b'    }\n',
                        b'    location / {\n        if ($x) {\n' + include + b'        }\n    }\n',
                        b'    location / {\n        limit_except GET {\n' + include + b'        }\n    }\n'):
            with self.subTest(wrapped=wrapped):
                self.fails('nginx_realip_include_invalid', self.check, GEO, REALIP.replace(include, wrapped))
        for placed in (b'    location / {\n' + include + b'    }\n', b'    location / {\n    location /a {\n' + include + b'    }\n    }\n'):
            with self.subTest(placed=placed):
                self.assertIsNone(self.check(GEO, REALIP.replace(include, placed)))
        # http level and file level, with real_ip_header/real_ip_recursive beside the include.
        policy = b'real_ip_header X-Forwarded-For;\nreal_ip_recursive off;\n'
        bare = REALIP.replace(include, b'').replace(b'    real_ip_header X-Forwarded-For;\n', b'').replace(b'    real_ip_recursive off;\n', b'')
        self.assertIsNone(self.check(GEO, b'http {\n' + bare + include + policy + b'}\n'))
        self.assertIsNone(self.check(GEO, include + policy + bare))

    def test_trust_outside_the_bundle_is_rejected(self):
        trusted = MAIN.replace(b'http {\n', b'http {\n    set_real_ip_from 0.0.0.0/0;\n    real_ip_recursive on;\n')
        self.fails('nginx_realip_unmanaged_trust', self.check, main=trusted)
        for line in (b'set_real_ip_from 10.0.0.0/8;', b'real_ip_header X-Forwarded-For;', b'real_ip_recursive off;',
                     b'real_ip_header proxy_protocol;', b'"set_real_ip_from" unix:;',
                     # The shared realip file included outside the bundle trusts its ranges there.
                     ('include ' + REAL_INCLUDE + ';').encode()):
            with self.subTest(line=line):
                self.fails('nginx_realip_unmanaged_trust', self.check,
                           extra=(('/etc/nginx/conf.d/z.conf', b'server {\n    ' + line + b'\n}\n'),))
                self.fails('nginx_realip_unmanaged_trust', self.check,
                           main=MAIN.replace(b'http {\n', b'http {\n    ' + line + b'\n'))
        # Also from the geo file of the bundle (not a realip file).
        self.fails('nginx_realip_unmanaged_trust', self.check, GEO + ('include ' + REAL_INCLUDE + ';\n').encode())
        # A directive whose name only resembles the prefix is not real_ip_*.
        self.assertIsNone(self.check(main=MAIN.replace(b'http {\n', b'http {\n    realip_note x;\n')))

    # --- review round 3, item 2: include arguments that can resolve to a shared file
    REALIP_FORMS = (SHARED + '/*.conf', 'cloudfront/cloudfront-realip.conf', SHARED + '/../cloudfront/cloudfront-realip.conf',
                    SHARED + '//cloudfront-realip.conf', SHARED + '/cloudfront-real?p.conf', SHARED + '/./cloudfront-realip.conf',
                    SHARED + '/cloudfront-realip.con[f]', './cloudfront/cloudfront-realip.conf', '/etc/nginx/cloud*/cloudfront-*',
                    '/etc//nginx/cloudfront/cloudfront-realip.conf', 'conf.d/../cloudfront/cloudfront-realip.conf',
                    '//etc/nginx/cloudfront/cloudfront-realip.conf',
                    # glob(3) reads '\f' as 'f'; a backslash in a pattern is refused whole.
                    SHARED + '/cloudfront-realip.con\\f*', '/etc/nginx/x/$y/../../cloudfront/cloudfront-realip.conf',
                    # A bracket expression counts as matching any name: glob(3) reads '[^x]', classes,
                    # equivalence classes and collating symbols, which fnmatch does not.
                    *(SHARED + '/' + b + 'loudfront-realip.conf' for b in BRACKETS),
                    *('/etc/nginx/' + b + 'loudfront/cloudfront-realip.conf' for b in BRACKETS),
                    *(SHARED + '/cloudfront-realip.con' + b for b in BRACKETS))
    GEO_FORMS = ('cloudfront/cloudfront-geo.conf', SHARED + '/cloudfront-geo.con?', SHARED + '/./cloudfront-geo.conf',
                 SHARED + '/../cloudfront/cloudfront-geo.conf', GEO_INCLUDE,
                 *('/etc/nginx/' + b + 'loudfront/cloudfront-geo.conf' for b in BRACKETS))

    def test_include_forms_resolving_to_the_shared_realip_file_are_refused_outside_the_bundle(self):
        for arg in self.REALIP_FORMS:
            line = ('include "' + arg + '";').encode()
            with self.subTest(arg=arg):
                self.fails('nginx_realip_unmanaged_trust', self.check, extra=(('/etc/nginx/conf.d/z.conf', b'server {\n    ' + line + b'\n}\n'),))
                self.fails('nginx_realip_unmanaged_trust', self.check, main=MAIN.replace(b'http {\n', b'http {\n    ' + line + b'\n'))
                # In the bundle geo file (not a realip file).
                self.fails('nginx_realip_unmanaged_trust', self.check, GEO + line + b'\n')

    def test_relative_includes_resolve_against_conf_prefix_and_main_directory(self):
        # nginx joins a relative name to its conf prefix: the main file's directory
        # under -c, /etc/nginx on the supported hosts. Both are tried.
        def sections(main_path, line):
            files = [(main_path, b'http {\n    ' + line + b'\n}\n'), (GEO_PATH, GEO), (GEO_INCLUDE, GEO_SHARED),
                     (REALIP_PATH, REALIP), (REAL_INCLUDE, REAL_SHARED)]
            return m.parse_dump(dump(*files), {GEO_PATH: GEO, GEO_INCLUDE: GEO_SHARED, REALIP_PATH: REALIP, REAL_INCLUDE: REAL_SHARED})
        bundles = ((GEO_PATH, REALIP_PATH),)
        for main_path, line in (('/etc/nginx/sub/nginx.conf', b'include ../cloudfront/cloudfront-realip.conf;'),
                                ('/etc/nginx/sub/nginx.conf', b'include cloudfront/cloudfront-realip.conf;'),
                                ('/nginx.conf', b'include etc/nginx/cloudfront/cloudfront-realip.conf;')):
            with self.subTest(main_path=main_path, line=line):
                self.fails('nginx_realip_unmanaged_trust', m.check_policy, sections(main_path, line), bundles, SHARED)
        self.assertIsNone(m.check_policy(sections('/etc/nginx/sub/nginx.conf', b'include cloudfront/other.conf;'), bundles, SHARED))

    def test_include_forms_in_the_bundle_realip_file_count_and_must_be_exact(self):
        include = ('    include ' + REAL_INCLUDE + ';\n').encode()
        for arg in self.REALIP_FORMS:
            line = ('    include "' + arg + '";\n').encode()
            with self.subTest(arg=arg):
                # Instead of the exact include, and beside it (a second one).
                self.fails('nginx_realip_include_invalid', self.check, GEO, REALIP.replace(include, line))
                self.fails('nginx_realip_include_invalid', self.check, GEO, REALIP.replace(include, include + line))

    def test_include_forms_resolving_to_the_shared_geo_file_are_refused_outside_the_bound_geo(self):
        for arg in self.GEO_FORMS:
            line = ('include "' + arg + '";').encode()
            with self.subTest(arg=arg):
                self.fails('nginx_geo_include_invalid', self.check,
                           extra=(('/etc/nginx/conf.d/z.conf', b'geo $realip_remote_addr $z {\n    ' + line + b'\n}\n'),))
                self.fails('nginx_geo_include_invalid', self.check,
                           extra=(('/etc/nginx/conf.d/z.conf', b'map $host $z {\n    ' + line + b'\n}\n'),))
                # In the bundle files, outside the bound geo block.
                self.fails('nginx_geo_include_invalid', self.check, GEO + b'map $host $z {\n    ' + line + b'\n}\n')
                self.fails('nginx_geo_include_invalid', self.check, GEO,
                           REALIP.replace(b'    listen 443 ssl;\n', b'    listen 443 ssl;\n    ' + line + b'\n'))
        # A bracket in the file name matches any name in the shared directory, the
        # shared realip file included: that refusal comes first.
        for arg in (SHARED + '/' + b + 'loudfront-geo.conf' for b in BRACKETS):
            line = ('include "' + arg + '";').encode()
            with self.subTest(arg=arg):
                self.fails('nginx_realip_unmanaged_trust', self.check,
                           extra=(('/etc/nginx/conf.d/z.conf', b'geo $realip_remote_addr $z {\n    ' + line + b'\n}\n'),))
                self.fails('nginx_realip_unmanaged_trust', self.check, GEO + b'map $host $z {\n    ' + line + b'\n}\n')

    def test_unrelated_includes_and_globs_are_unaffected(self):
        for line in (b'include /etc/nginx/conf.d/*.conf;', b'include /etc/nginx/sites-enabled/*;', b'include mime.types;',
                     b'include /etc/nginx/cloudfront-extra/*.conf;', b'include /etc/nginx/*.conf;', b'include snippets/*.conf;',
                     b'include /etc/nginx/cloudfront/other.conf;', b'include /etc/nginx/other/cloudfront-realip.conf.bak;',
                     b'include /etc/nginx/cloudfront/x/cloudfront-realip.conf;', b'include /etc/nginx/cloudfront?/*;',
                     # Brackets in a directory or name that cannot be the shared one.
                     b'include /etc/nginx/conf.d/[^x]*.conf;', b'include /etc/nginx/[s]ites-enabled/x.conf;',
                     b'include /srv/[[:alpha:]]*/*.conf;', b'include conf.d/[!.]*.conf;', b'include /etc/nginx/cloudfront-x/[[.a.]]*;'):
            with self.subTest(line=line):
                self.assertIsNone(self.check(main=MAIN.replace(b'http {\n', b'http {\n    ' + line + b'\n')))

    def test_include_argument_with_a_control_character_is_refused(self):
        # nginx prints such a file name into its heading line, which then no longer
        # frames the dump reliably (a '<path>:\n#' name forges a valid heading).
        for arg in ('/etc/nginx/a:\\n#', '/etc/nginx/a\\tb', '/etc/nginx/a\\rb'):
            with self.subTest(arg=arg):
                self.fails('nginx_dump_invalid', self.check,
                           main=MAIN.replace(b'http {\n', ('http {\n    include "' + arg + '";\n').encode()))

    # --- item 3: real_ip_header / real_ip_recursive on the include's own path
    def test_realip_policy_must_be_on_the_include_block_or_its_ancestors(self):
        include = ('    include ' + REAL_INCLUDE + ';\n').encode()
        header, recursive = b'    real_ip_header X-Forwarded-For;\n', b'    real_ip_recursive off;\n'
        bare = REALIP.replace(header, b'').replace(recursive, b'')
        for realip in (bare + b'map $x $unused {\n' + header + recursive + b'}\n',
                       bare.replace(b'    listen 443 ssl;\n', b'    listen 443 ssl;\n    location /x {\n' + header + recursive + b'    }\n'),
                       bare + b'server {\n' + header + recursive + b'}\n',
                       bare.replace(b'    listen 443 ssl;\n', b'    listen 443 ssl;\n    types {\n' + header + recursive + b'    }\n'),
                       bare.replace(b'    listen 443 ssl;\n', b'    listen 443 ssl;\n    geo $q {\n' + header + recursive + b'    }\n'),
                       bare.replace(b'    listen 443 ssl;\n', b'    listen 443 ssl;\n    split_clients "$x" $q {\n' + header + recursive + b'    }\n'),
                       # Below the include's block (a child location) is not where the include applies.
                       bare.replace(include, include + b'    location / {\n' + header + recursive + b'    }\n'),
                       # Only one of the two on the path.
                       REALIP.replace(recursive, b'') + b'map $x $u {\n' + recursive + b'}\n'):
            with self.subTest(realip=realip):
                self.fails('nginx_realip_policy_missing', self.check, GEO, realip)
        # In the geo file only (another file: its include context is unknown).
        self.fails('nginx_realip_policy_missing', self.check, GEO + header + recursive, bare)
        # The include at http level with the policy only in a child server.
        self.fails('nginx_realip_policy_missing', self.check, GEO, b'http {\n' + include + REALIP.replace(include, b'') + b'}\n')
        # Same block, a direct ancestor block, or file level above the include.
        for realip in (REALIP, header + recursive + bare,
                       b'http {\n' + header + bare.replace(b'    listen 443 ssl;\n', b'    listen 443 ssl;\n' + recursive) + b'}\n',
                       bare.replace(include, b'    location / {\n' + include + b'    }\n').replace(b'    listen 443 ssl;\n', b'    listen 443 ssl;\n' + header + recursive)):
            with self.subTest(accepted=realip):
                self.assertIsNone(self.check(GEO, realip))

    # --- item 4: runtime variable writers and named captures
    def test_dynamic_modules_that_can_write_variables_are_refused(self):
        for line in (b'access_by_lua "ngx.var.cloudfront_origin = 1";', b'content_by_lua_file /x.lua;', b'set_by_lua $z "return 1";',
                     b'set_by_lua_file $z /x.lua;', b'rewrite_by_lua_file /x.lua;', b'init_by_lua "x = 1";', b'log_by_lua \'x\';',
                     b'"access_by_lua" "x";', b'js_content main.f;', b'js_access main.f;', b'js_set $z main.f;', b'js_var $z;',
                     b'js_header_filter main.f;', b'js_body_filter main.f;', b'js_periodic main.f;', b'js_preread main.f;',
                     b'js_filter main.f;', b'perl Main::handler;', b'perl_set $z \'sub { 1 }\';', b'perl_modules /p;',
                     b'perl_require x.pm;'):
            with self.subTest(line=line):
                self.fails('nginx_dynamic_module_unsupported', self.check,
                           extra=(('/etc/nginx/conf.d/z.conf', b'server {\n    location / { ' + line + b' }\n}\n'),))
                self.fails('nginx_dynamic_module_unsupported', self.check, GEO,
                           REALIP.replace(b'    listen 443 ssl;\n', b'    listen 443 ssl;\n    ' + line + b'\n'))
        # Configuration-only njs directives and look-alike names are not handlers.
        for line in (b'js_import main.js;', b'js_path /etc/nginx/njs;', b'perlish x;', b'lua_shared_dict d 1m;'):
            with self.subTest(accepted=line):
                self.assertIsNone(self.check(main=MAIN.replace(b'http {\n', b'http {\n    ' + line + b'\n')))

    def test_named_captures_with_the_geo_variable_name_are_redefinitions(self):
        for line in (b'server { server_name ~^(?<cloudfront_origin>.+)$; }', b'server { location ~ (?P<CloudFront_Origin>x) { } }',
                     b'server { location ~* "(?\'cloudfront_origin\'a)" { } }',
                     b'server { if ($uri ~ "^(?<cloudfront_origin>.*)$") { return 403; } }',
                     b'server { if ($uri !~* "(?<cloudfront_origin>a)") { return 403; } }',
                     b'map $uri $q { ~^(?<cloudfront_origin>.*)$ 1; }',
                     b'server { rewrite ^(?<cloudfront_origin>.*)$ /x; }'):
            with self.subTest(line=line):
                self.fails('nginx_geo_variable_redefined', self.check, extra=(('/etc/nginx/conf.d/z.conf', line + b'\n'),))
        # Other capture names, lookbehind and plain groups are not definitions of it.
        for line in (b'server { server_name ~^(?<host_part>.+)$; }', b'server { location ~ (?<=a)(?:b)(c) { } }',
                     b'map $uri $q { ~(?<cloudfront_origin_x>a) 1; }'):
            with self.subTest(accepted=line):
                self.assertIsNone(self.check(extra=(('/etc/nginx/conf.d/z.conf', line + b'\n'),)))

    def test_geoip2_block_variables_are_definitions(self):
        self.fails('nginx_geo_variable_redefined', self.check,
                   extra=(('/etc/nginx/conf.d/z.conf', b'geoip2 /x.mmdb {\n    $cloudfront_origin country iso_code;\n}\n'),))
        self.fails('nginx_geo_variable_redefined', self.check,
                   extra=(('/etc/nginx/conf.d/z.conf', b'geoip2 /x.mmdb {\n    $CLOUDFRONT_ORIGIN default=1 country iso_code;\n}\n'),))
        self.assertIsNone(self.check(extra=(('/etc/nginx/conf.d/z.conf', b'geoip2 /x.mmdb {\n    $country country iso_code;\n}\n'),)))

    # --- item 6: the include's whole block path
    def test_realip_include_under_stream_or_mail_is_refused(self):
        body = REALIP.replace(b'server {\n', b'server {\n', 1)
        for outer in (b'stream {\n', b'mail {\n', b'http {\n    stream {\n'):
            realip = outer + body + b'}\n' * outer.count(b'{')
            with self.subTest(outer=outer):
                self.fails('nginx_realip_include_invalid', self.check, GEO, realip)
        self.fails('nginx_realip_include_invalid', self.check, GEO,
                   b'stream {\n    include ' + REAL_INCLUDE.encode() + b';\n    real_ip_header X-Forwarded-For;\n    real_ip_recursive off;\n}\n')

    # --- item 7: check_policy works on parse_dump's syntax trees
    def test_check_policy_does_not_lex_again(self):
        parsed = policy_sections()
        original = m._lex
        m._lex = None
        try:
            self.assertIsNone(m.check_policy(parsed, ((GEO_PATH, REALIP_PATH),), SHARED))
        finally:
            m._lex = original
        sections = parsed.sections
        # The trees stay in the module: a section shows and compares by path, bytes and flag only.
        self.assertNotIn('tree', repr(sections))
        self.assertNotIn('Directive', repr(sections))
        self.assertEqual(tuple(m.DumpSection(s.path, s.body, s.managed) for s in sections), sections)

    def test_policy_arguments_and_dump_consistency(self):
        sections = policy_sections()
        for bundles in ((), None, [(GEO_PATH, REALIP_PATH)], ((GEO_PATH,),), ((GEO_PATH, 'relative'),),
                        ((GEO_PATH, REALIP_PATH), (GEO_PATH, REALIP_PATH)), ((GEO_PATH, b'/x'),),
                        ((GEO_INCLUDE, REALIP_PATH),)):
            with self.subTest(bundles=bundles):
                self.fails('nginx_managed_invalid', m.check_policy, sections, bundles, SHARED)
        for value in (list(sections.sections), sections.sections, (), None, ('x',), [sections]):
            with self.subTest(value=value):
                self.fails('nginx_dump_invalid', m.check_policy, value, ((GEO_PATH, REALIP_PATH),), SHARED)
        # A bundle file the dump does not hold, a verified file the policy does not name, or one held unverified.
        files = [(MAIN_PATH, MAIN), (GEO_PATH, GEO), (GEO_INCLUDE, GEO_SHARED), (REAL_INCLUDE, REAL_SHARED)]
        managed = {GEO_PATH: GEO, GEO_INCLUDE: GEO_SHARED, REAL_INCLUDE: REAL_SHARED}
        self.fails('nginx_dump_missing', m.check_policy, m.parse_dump(dump(*files), managed), ((GEO_PATH, REALIP_PATH),), SHARED)
        self.fails('nginx_managed_invalid', m.check_policy, sections, ((GEO_PATH, '/etc/nginx/other.conf'),), SHARED)
        unverified = m.parse_dump(dump(*files, (REALIP_PATH, REALIP)), managed)
        self.fails('nginx_managed_invalid', m.check_policy, unverified, ((GEO_PATH, REALIP_PATH),), SHARED)

    # --- review round 4, item 6: only what parse_dump returned is checked
    def test_check_policy_accepts_only_what_parse_dump_returned(self):
        bundles = ((GEO_PATH, REALIP_PATH),)
        parsed = policy_sections()
        self.assertIsNone(m.check_policy(parsed, bundles, SHARED))
        sections = parsed.sections
        at = [s.path for s in sections].index(REALIP_PATH)
        trusting = REALIP.replace(b'    real_ip_recursive off;\n', b'    real_ip_recursive off;\n    set_real_ip_from 0.0.0.0/0;\n')
        def swapped(section):
            return m.Dump(sections[:at] + (section,) + sections[at + 1:])
        made = {'hand-made Dump': m.Dump(sections),
                'replaced Dump': dataclasses.replace(parsed),
                'hand-made sections': m.Dump(tuple(m.DumpSection(s.path, s.body, s.managed) for s in sections)),
                'replaced body': swapped(dataclasses.replace(sections[at], body=trusting)),
                'replaced section': swapped(dataclasses.replace(sections[at])),
                'hand-made section': swapped(m.DumpSection(REALIP_PATH, REALIP, True))}
        for label, value in made.items():
            with self.subTest(label=label):
                self.fails('nginx_dump_invalid', m.check_policy, value, bundles, SHARED)
        # The objects parse_dump returned, changed in place behind the frozen dataclass.
        for attribute, value in (('body', trusting), ('managed', False), ('path', '/etc/nginx/conf.d/z.conf')):
            with self.subTest(attribute=attribute):
                parsed = policy_sections()
                object.__setattr__(parsed.sections[at], attribute, value)
                self.fails('nginx_dump_invalid', m.check_policy, parsed, bundles, SHARED)
        parsed = policy_sections()
        object.__setattr__(parsed, 'sections', parsed.sections[:-1])
        self.fails('nginx_dump_invalid', m.check_policy, parsed, bundles, SHARED)
        # The tree of an untouched result keeps being accepted, also after other results are made.
        first = policy_sections()
        policy_sections(realip=trusting)
        self.assertIsNone(m.check_policy(first, bundles, SHARED))
        self.assertNotIn(SECRET, repr(first))

    # --- review round 5, item 1: the trees check_policy walks are not handed out
    def test_changing_what_parse_dump_returned_does_not_change_the_verdict(self):
        bundles = ((GEO_PATH, REALIP_PATH),)
        trusting_main = MAIN.replace(b'http {\n', b'http {\n    set_real_ip_from 0.0.0.0/0;\n')
        extra_range = GEO.replace(b'    default 0;\n', b'    default 0;\n    10.0.0.0/8 1;\n')
        cases = (('nginx_realip_unmanaged_trust', {'main': trusting_main}, 'set_real_ip_from'),
                 ('nginx_geo_unmanaged_policy', {'geo': extra_range}, '10.0.0.0/8'))
        for code, files, dropped in cases:
            with self.subTest(code=code):
                self.fails(code, m.check_policy, policy_sections(**files), bundles, SHARED)
                parsed = policy_sections(**files)
                # Every statement reachable from the result, edited behind the frozen dataclass.
                for directive in reachable_directives(parsed):
                    if directive.block is not None:
                        object.__setattr__(directive, 'block', tuple(inner for inner in directive.block if inner.args[0] != dropped))
                self.fails(code, m.check_policy, parsed, bundles, SHARED)
        parsed = policy_sections()
        self.assertEqual(reachable_directives(parsed), [])
        self.assertEqual([item.name for item in dataclasses.fields(m.DumpSection)], ['path', 'body', 'managed'])
        self.assertIsNone(m.check_policy(parsed, bundles, SHARED))

    # --- review round 5, item 3: copies and dropped results
    def test_copied_dump_is_refused(self):
        bundles = ((GEO_PATH, REALIP_PATH),)
        parsed = policy_sections()
        for label, value in (('copy', copy.copy(parsed)), ('deepcopy', copy.deepcopy(parsed)),
                             ('pickle', pickle.loads(pickle.dumps(parsed)))):
            with self.subTest(label=label):
                self.assertIsNot(value, parsed)
                self.fails('nginx_dump_invalid', m.check_policy, value, bundles, SHARED)
        self.assertIsNone(m.check_policy(parsed, bundles, SHARED))

    def test_registry_releases_a_dropped_dump(self):
        gc.collect()
        before = len(m._ISSUED)
        parsed = policy_sections()
        held = weakref.ref(parsed)
        self.assertEqual(len(m._ISSUED), before + 1)
        del parsed
        gc.collect()
        self.assertIsNone(held())
        self.assertEqual(len(m._ISSUED), before)

    # --- review round 4, item 3: the bound geo block sits under http only
    def test_bound_geo_block_is_under_http_or_file_level_only(self):
        block, rest = GEO.split(b'map ', 1)
        rest = b'map ' + rest
        for outer in (b'stream {\n', b'mail {\n', b'http {\n    stream {\n', b'stream {\n    http {\n', b'http {\n    server {\n',
                      b'http {\n    mail {\n'):
            with self.subTest(outer=outer):
                self.fails('nginx_geo_not_bound', self.check, outer + block + b'}\n' * outer.count(b'{') + rest)
        self.assertIsNone(self.check(b'http {\n' + block + b'}\n' + rest))
        self.assertIsNone(self.check(block + rest))

    # --- review round 4, item 4: the bound geo names plain variables
    def test_bound_geo_variable_and_source_are_plain_names(self):
        for variable in (b'${cloudfront_origin}', b'$1', b'$12', b'${}', b'$9abc', b'$cloud-front', b'$cloud.front',
                         b'$cloudfront_origin}', b'${cloudfront_origin', b'$$x', b'$', b'"$cloudfront_origin "', b'$\xe9'):
            with self.subTest(variable=variable):
                self.fails('nginx_geo_not_bound', self.check, GEO.replace(b'$cloudfront_origin {', variable + b' {', 1))
        for source in (b'${realip_remote_addr}', b'$REALIP_REMOTE_ADDR', b'$realip_remote_addr_x', b'$realip_remote_addr}'):
            with self.subTest(source=source):
                self.fails('nginx_geo_not_bound', self.check, GEO.replace(b'$realip_remote_addr', source, 1))
        for variable in (b'$CloudFront_Origin', b'$_x9', b'$A', b'"$cloudfront_origin"'):
            with self.subTest(accepted=variable):
                self.assertIsNone(self.check(GEO.replace(b'$cloudfront_origin {', variable + b' {', 1)))

    # --- review round 4, item 5: bundle files are bytes without NUL; shared files stay strict
    def test_bundle_files_may_hold_utf8_text_but_no_nul(self):
        note = '# CloudFront \u7d4c\u7531\u306e\u307f\u8a31\u53ef\uff08\u6ce8\u91c8\uff09\n'.encode()
        geo = note + GEO + ('map $http_x_k $k_ok {\n    default 0;\n    "\u79d8\u5bc6-' + SECRET + '" 1;\n}\n').encode()
        self.assertIsNone(self.check(geo, note + REALIP))
        self.assertIsNone(self.check(note + GEO + REALIP, note + GEO + REALIP, same=True))
        self.assertIsNone(self.check(GEO, REALIP + b'# \xff\xfe cp1252 \x80\n'))
        for geo, realip in ((GEO + b'# \x00\n', REALIP), (GEO, note + REALIP + b'\x00'), (GEO.replace(b'default 0', b'default\x000'), REALIP)):
            with self.subTest(geo=geo[-8:], realip=realip[-8:]):
                self.fails('nginx_text_invalid', self.check, geo, realip)

    def test_shared_files_in_the_dump_are_exactly_the_rendered_form(self):
        note = '# \u6ce8\u91c8\n'.encode()
        for geo_shared, real_shared in ((note + GEO_SHARED, REAL_SHARED), (GEO_SHARED, REAL_SHARED + note),
                                        (GEO_SHARED + b'# \xff\n', REAL_SHARED), (b'# ascii note\n' + GEO_SHARED, REAL_SHARED),
                                        (GEO_SHARED, REAL_SHARED.replace(b'set_real_ip_from 52.46.0.0/18;\n', b''))):
            files = [(MAIN_PATH, MAIN), (GEO_PATH, GEO), (GEO_INCLUDE, geo_shared), (REALIP_PATH, REALIP), (REAL_INCLUDE, real_shared)]
            managed = {GEO_PATH: GEO, GEO_INCLUDE: geo_shared, REALIP_PATH: REALIP, REAL_INCLUDE: real_shared}
            with self.subTest(geo_shared=geo_shared, real_shared=real_shared):
                with self.assertRaises(m.NginxObservationError) as caught:
                    m.parse_shared(geo_shared, real_shared)
                self.fails(caught.exception.args[0], m.check_policy, m.parse_dump(dump(*files), managed), ((GEO_PATH, REALIP_PATH),), SHARED)


def bundle_files(count, variables):
    """count bundles; bundle i binds variables[i] in /etc/nginx/b<i>/geo.conf and has /etc/nginx/b<i>/realip.conf."""
    files, bundles = [], []
    for index in range(count):
        geo_path, realip_path = '/etc/nginx/b%d/geo.conf' % index, '/etc/nginx/b%d/realip.conf' % index
        variable = variables[index].encode()
        files.append((geo_path, GEO.replace(b'$cloudfront_origin', variable)))
        files.append((realip_path, REALIP.replace(b'listen 443', b'listen %d' % (8000 + index))
                      .replace(b'    real_ip_recursive off;\n', b'    real_ip_recursive off;\n    if (' + variable + b' = 0) { return 403; }\n')))
        bundles.append((geo_path, realip_path))
    return files, tuple(bundles)


class MultiBundleTests(Assertions):
    MAIN = b'http {\n    include /etc/nginx/b*/geo.conf;\n    include /etc/nginx/b*/realip.conf;\n}\n'

    def check(self, files, bundles, extra=()):
        everything = [(MAIN_PATH, self.MAIN), *files, (GEO_INCLUDE, GEO_SHARED), (REAL_INCLUDE, REAL_SHARED), *extra]
        managed = {path: body for path, body in files}
        managed.update({GEO_INCLUDE: GEO_SHARED, REAL_INCLUDE: REAL_SHARED})
        return m.check_policy(m.parse_dump(dump(*everything), managed), bundles, SHARED)

    def test_bundles_may_share_or_differ_in_the_geo_variable(self):
        # nginx 1.28.3 accepts two geo blocks of one variable (the last one wins at runtime).
        for count in (2, 10):
            for variables in (['$cloudfront_origin'] * count, ['$cf_%d' % i for i in range(count)],
                              ['$cloudfront_origin', '$CloudFront_Origin'] + ['$cf_%d' % (i % 3) for i in range(count - 2)]):
                with self.subTest(count=count, variables=variables):
                    self.assertIsNone(self.check(*bundle_files(count, variables)))

    def test_one_altered_bundle_is_refused(self):
        for count in (2, 10):
            for variables in (['$cloudfront_origin'] * count, ['$cf_%d' % i for i in range(count)]):
                files, bundles = bundle_files(count, variables)
                last = len(files) - 2
                with self.subTest(count=count, variables=variables[:2]):
                    altered = list(files)
                    altered[last] = (files[last][0], files[last][1].replace(b'    default 0;\n', b'    default 1;\n'))
                    self.fails('nginx_geo_unmanaged_policy', self.check, altered, bundles)
                    altered = list(files)
                    altered[last + 1] = (files[last + 1][0], files[last + 1][1].replace(b'    real_ip_recursive off;\n', b''))
                    self.fails('nginx_realip_policy_missing', self.check, altered, bundles)
                    altered = list(files)
                    altered[last] = (files[last][0], files[last][1].replace(b'$realip_remote_addr', b'$remote_addr'))
                    self.fails('nginx_geo_not_bound', self.check, altered, bundles)

    def test_a_non_bundle_definition_of_a_shared_name_is_refused(self):
        for variables in (['$cloudfront_origin'] * 2, ['$cloudfront_origin', '$cf_1']):
            files, bundles = bundle_files(2, variables)
            for extra in (b'geo $realip_remote_addr $cloudfront_origin {\n    default 1;\n}\n',
                          b'map $host $cloudfront_origin {\n    default 1;\n}\n'):
                with self.subTest(variables=variables, extra=extra):
                    self.fails('nginx_geo_variable_redefined', self.check, files, bundles, (('/etc/nginx/conf.d/z.conf', extra),))
            # A compliant-looking geo block in an unmanaged file is not a bundle's.
            unmanaged = (('/etc/nginx/conf.d/z.conf', files[0][1].split(b'map ')[0]),)
            with self.subTest(variables=variables, unmanaged=True):
                self.fails('nginx_geo_variable_redefined', self.check, files, bundles, unmanaged)
        # Within the bundle files too.
        files, bundles = bundle_files(2, ['$cloudfront_origin'] * 2)
        files[2] = (files[2][0], files[2][1] + b'map $host $cloudfront_origin {\n    default 1;\n}\n')
        self.fails('nginx_geo_variable_redefined', self.check, files, bundles)


class ModuleShapeTests(unittest.TestCase):
    TREE = ast.parse((FILES / 'nginx_observation.py').read_bytes())

    def test_imports_no_process_network_or_file_writer(self):
        imported = set()
        for node in ast.walk(self.TREE):
            if isinstance(node, ast.Import):
                imported.update(alias.name for alias in node.names)
                self.assertTrue(all(alias.asname is None for alias in node.names))
            elif isinstance(node, ast.ImportFrom):
                imported.add('from ' + (node.module or ''))
        # Processes only through ufw_observation._stream; no subprocess, network, shell or writer module.
        self.assertEqual(imported, {'from dataclasses', 'fnmatch', 'ipaddress', 'math', 'os', 'posixpath', 're',
                                    'signal', 'stat', 'sys', 'time', 'weakref', 'ufw_observation'})
        names = {node.id for node in ast.walk(self.TREE) if isinstance(node, ast.Name)}
        self.assertFalse(names & {'open', 'exec', 'eval', '__import__', 'compile', 'subprocess'})
        constants = {node.value for node in ast.walk(self.TREE) if isinstance(node, ast.Constant)}
        self.assertNotIn('subprocess', constants)

    def test_io_is_read_only_and_confined_to_the_collector(self):
        """os: open (read-only flags), read, stat, fstat, close, geteuid; ufw_observation: _stream,
        CommandResult, _identity. Every such reference sits in a Collector method."""
        collector = next(node for node in self.TREE.body if isinstance(node, ast.ClassDef) and node.name == 'Collector')
        inside = {id(node) for node in ast.walk(collector)}
        used = {'os': set(), 'ufw_observation': set()}
        for node in ast.walk(self.TREE):
            if isinstance(node, ast.Attribute) and isinstance(node.value, ast.Name) and node.value.id in used:
                used[node.value.id].add(node.attr)
                self.assertIn(id(node), inside, node.attr)
            if (isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == 'getattr'
                    and node.args and isinstance(node.args[0], ast.Name) and node.args[0].id == 'os'):
                self.assertEqual(ast.unparse(node), "getattr(os, 'O_NOATIME', 0)")
        self.assertEqual(used['os'], {'open', 'read', 'stat', 'fstat', 'close', 'geteuid',
                                      'O_RDONLY', 'O_DIRECTORY', 'O_NOFOLLOW', 'O_NONBLOCK'})
        self.assertEqual(used['ufw_observation'], {'_stream', 'CommandResult', '_identity'})
        for node in ast.walk(self.TREE):
            if isinstance(node, ast.Call) and ast.unparse(node.func) == 'os.open':
                flags = ast.unparse(node.args[1])
                self.assertNotRegex(flags, 'O_(WRONLY|RDWR|CREAT|TRUNC|APPEND)')
                self.assertIn('os.O_RDONLY', flags)

    def test_every_raised_code_is_declared(self):
        fail = [node for node in self.TREE.body if isinstance(node, ast.FunctionDef) and node.name == '_fail']
        self.assertEqual(len(fail), 1)
        self.assertEqual(ast.unparse(fail[0].body), 'raise NginxObservationError(code)')
        constructed = [node for node in ast.walk(self.TREE) if isinstance(node, ast.Call)
                       and isinstance(node.func, ast.Name) and node.func.id == 'NginxObservationError']
        self.assertEqual(len(constructed), 1)
        self.assertEqual([node for node in ast.walk(self.TREE) if isinstance(node, ast.Raise)], fail[0].body)
        raised = set()
        for node in ast.walk(self.TREE):
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == '_fail':
                self.assertEqual(len(node.args), 1)
                self.assertIsInstance(node.args[0], ast.Constant)
                raised.add(node.args[0].value)
        self.assertEqual(raised, set(m.CODES))
        self.assertTrue(all(code.startswith('nginx_') for code in m.CODES))

    def test_no_raise_inside_an_except_handler(self):
        """A raise inside a handler would chain the original error (with input text) as __context__."""
        for node in ast.walk(self.TREE):
            if isinstance(node, ast.ExceptHandler):
                for inner in ast.walk(node):
                    self.assertFalse(isinstance(inner, ast.Raise) or (isinstance(inner, ast.Call) and isinstance(inner.func, ast.Name)
                                                                       and inner.func.id == '_fail'), ast.dump(node))

    def test_bytes_and_values_are_hidden_from_dataclass_repr(self):
        token = m.Token('word', SECRET, True)
        section = m.DumpSection('/m', SECRET.encode(), True)
        for value in (token, section):
            self.assertNotIn(SECRET, repr(value))
        # Paths are configuration too: a section's repr names no path.
        self.assertNotIn('origin-secret', repr(m.DumpSection('/etc/nginx/origin-secret.conf', b'x;', False)))
        with self.assertRaises(Exception):
            token.value = 'changed'


if __name__ == '__main__':
    unittest.main()
