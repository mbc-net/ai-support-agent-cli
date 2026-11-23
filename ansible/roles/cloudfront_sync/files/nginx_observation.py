"""nginx evidence: pure checks, one read-only Collector and admit_policy.

The pure parts (tokenize, parse_dump, parse_shared, check_policy) do no
process, file, network, lock or persistence. Callers supply captured bytes
(an `nginx -T` dump, managed file contents) and receive parsed values or one
fixed failure code. Configuration text, secret values and paths never enter an
exception, and values held by returned records are omitted from their repr.
The lexer follows nginx's own token rules; unsupported or ambiguous input fails.

Collector.collect() is the only I/O: it reads /usr/lib/os-release and the
managed files (the two shared include files and every bundle file) through
NOFOLLOW directory descriptors, runs the fixed read-only `systemctl show`
and `nginx -T -q` inside the fixed systemd-run sandbox (SANDBOX_DUMP; what it
prevents and what it does not is described there) through
ufw_observation._stream, twice, and requires both passes to be identical
(the raw evidence is compared first; only identical passes are parsed, once).
On a non-Linux platform, when not root, with a non-default SIGCHLD handler,
when systemd-run, nginx or systemctl is not a safe executable at its host
path, or when a TemporaryFileSystem= target of the sandbox
(SANDBOX_TMPFS_DIRECTORIES) is not a directory (any failure of these checks)
it fails nginx_sandbox_unavailable before any command; nginx is never run
outside the sandbox. It writes nothing and
keeps nothing but the record of the observations it returned (see
collected), and admits nothing: admit_policy(observation) decides.
nginx_policy_verified judges the default configuration on disk
(/etc/nginx/nginx.conf, as nginx -T read it) and the packaged ExecStart; it
does not prove that the running master uses that configuration (changes not
reloaded yet, or a master started otherwise, are not detected).
Collection codes are nginx_observed (a returned NginxObservation),
nginx_sandbox_unavailable and nginx_observation_failed (any other failure:
nginx -T exiting non-zero for whatever reason, nginx's configuration, the
sandbox or systemd alike, an unexpected stderr, timeout, budget, unstable
passes, unsafe file, dump not bound to the managed bytes or not parsable).
nginx's failures are deliberately not classified further (no "configuration
invalid" code that a sandbox- or systemd-caused failure could be mistaken
for); the cause is read from nginx's and systemd's own logs. Admission
codes are nginx_policy_verified and nginx_policy_unsupported.

Order of use: parse_dump(dump, managed) -> a Dump (its sections: path,
bytes, managed flag); parse_shared(geo, realip) -> ranges; check_policy(dump,
bundles, shared_dir) over the whole dump. check_policy accepts only a Dump
that parse_dump returned, unchanged, and walks the syntax trees parse_dump
built for it, which the module keeps to itself: no tree is reachable from the
Dump, so editing what the caller holds cannot change a verdict.

Threat model of that provenance check (and of the same check on
NginxObservation, see collected): it catches accidental misuse in the
calling code (a stale or hand-made Dump, section or observation,
dataclasses.replace, a copy, a pickle round trip, a field changed in place).
Deliberate tampering inside the same process (calling or replacing this
module's private names such as _issue, _ISSUED or _OBSERVED, editing its
globals) is out of scope: Python cannot
prevent it, and code that can do it can also replace check_policy itself.

nginx module semantics are not reproduced. A configuration this module cannot
analyse is refused (fail-closed), never approximated. In particular:
- Directives of known modules that can write variables at run time are
  refused wherever they appear (nginx_dynamic_module_unsupported): every
  '*_by_lua*' directive (ngx_lua; '*_by_lua_block' bodies are refused by the
  lexer), the njs handler and variable directives in JS_HANDLERS, and 'perl'
  and every 'perl_*' directive. The list covers these known modules only; a
  third-party module outside it that writes variables is not detected.
- Variable definitions are recognised in known forms only: geo, map and
  split_clients blocks, set, '*_set', 'set_*', keyval (third argument),
  '$name' entries of geoip2 blocks, and PCRE named captures ('(?<name>',
  '(?P<name>', "(?'name'") in any argument.
- Include arguments are resolved lexically (conf prefix /etc/nginx and the
  main file's directory for relative names, '//', '.' and '..' collapsed,
  glob(3) patterns matched per path component; a component with a bracket
  expression matches any name, and a pattern with a backslash counts as
  matching). Symbolic links are not seen: a file reached under
  another name is dumped under that name, and its bytes then sit in an
  unmanaged section, where the trust rules apply to them.
Remaining risks the dump cannot settle: a managed file's bytes duplicated in
an unmanaged file under a heading that is not a managed path; and the context
that includes a bundle file. A shared realip include at the top level of the
bundle realip file, and a bound geo block at the top level of the bundle geo
file, are accepted although that file itself could be included from a stream
or mail block; a block path inside the file is fully checked.
File names that contain a linefeed and are reached only through a glob are
not visible as include arguments either.
"""
from dataclasses import dataclass, field
import fnmatch
import ipaddress
import math
import os
import posixpath
import re
import signal
import stat
import sys
import time
import weakref
import ufw_observation


class NginxObservationError(ValueError):
    """Fixed non-sensitive failure codes only."""


CODES = ('nginx_text_invalid', 'nginx_syntax_invalid', 'nginx_lexer_unsupported', 'nginx_dump_invalid',
         'nginx_dump_mismatch', 'nginx_dump_missing', 'nginx_managed_invalid', 'nginx_shared_invalid',
         'nginx_shared_ranges_differ', 'nginx_shared_dir_invalid', 'nginx_geo_not_bound',
         'nginx_geo_unmanaged_policy', 'nginx_geo_variable_redefined', 'nginx_geo_include_invalid',
         'nginx_realip_include_invalid', 'nginx_realip_policy_missing', 'nginx_realip_unmanaged_trust',
         'nginx_dynamic_module_unsupported', 'nginx_collector_invalid', 'nginx_sandbox_unavailable',
         'nginx_observation_failed', 'nginx_policy_unsupported')
GEO_NAME = 'cloudfront-geo.conf'
REALIP_NAME = 'cloudfront-realip.conf'
GEO_SOURCE = '$realip_remote_addr'
REALIP_HEADER = ('real_ip_header', 'X-Forwarded-For')
REALIP_RECURSIVE = ('real_ip_recursive', 'off')
HEADER = b'# configuration file '
# ngx_lua reads the body of every '*_by_lua_block' directive with its own Lua
# lexer (content, access, rewrite, header_filter, body_filter, log, balancer,
# ssl_certificate, ssl_session_fetch, ssl_session_store, ssl_client_hello,
# init, init_worker, exit_worker, set, server_rewrite, preread, ...). nginx
# rules do not describe that text, so any such block is refused.
LUA_BLOCK_SUFFIX = '_by_lua_block'
# Blocks that may enclose a realip include (every block on its path in the file).
REALIP_CONTEXTS = frozenset(('http', 'server', 'location'))
# Blocks that may enclose the bound geo block (every block on its path in the file).
GEO_CONTEXTS = frozenset(('http',))
# nginx's conf prefix on the supported hosts; relative include names resolve here.
CONF_PREFIX = '/etc/nginx'
# njs directives that run a handler or define a variable (njs can assign
# r.variables.<name>, and geo variables are changeable).
JS_HANDLERS = frozenset(('js_access', 'js_body_filter', 'js_content', 'js_filter', 'js_header_filter', 'js_periodic',
                         'js_preread', 'js_set', 'js_var'))
_SPACE = ' \t\r\n'
_ESCAPES = {'"': '"', "'": "'", '\\': '\\', 't': '\t', 'r': '\r', 'n': '\n'}
_CIDR = re.compile(r'[0-9a-f.:]+/[0-9]{1,3}', re.ASCII)
_ASCII_LOWER = {code: code + 32 for code in range(ord('A'), ord('Z') + 1)}
# PCRE named groups: (?<name>...), (?P<name>...) and (?'name'...).
_CAPTURE = re.compile(r"\(\?(?:P?<([A-Za-z_][A-Za-z0-9_]*)>|'([A-Za-z_][A-Za-z0-9_]*)')", re.ASCII)
# The variable a bound geo block sets: '$' and a plain name ('${...}', '$1' and the like are refused).
_PLAIN_VARIABLE = re.compile(r'\$[A-Za-z_][A-Za-z0-9_]*', re.ASCII)


def _fail(code):
    raise NginxObservationError(code)


@dataclass(frozen=True)
class Token:
    kind: str
    value: str = field(repr=False)
    quoted: bool = False


@dataclass(frozen=True)
class Directive:
    args: tuple = field(repr=False)
    block: object = field(repr=False)


@dataclass(frozen=True)
class DumpSection:
    """One file of the dump. Its statement tree is held by the module only (see _ISSUED)."""
    path: str = field(repr=False)
    body: bytes = field(repr=False)
    managed: bool


@dataclass(frozen=True, eq=False)
class Dump:
    """parse_dump's result: the sections in dump order, one per path. Only an
    instance parse_dump returned, with its sections unchanged, passes check_policy
    (a copy, deep copy or unpickled clone is another instance and is refused)."""
    sections: tuple


# Each Dump parse_dump returned (weakly held, compared by identity) -> its
# sections tuple, every section's fields as they were returned, and the
# statement trees parse_dump built (one per section). The trees live here
# only; nothing returned to a caller refers to them.
_ISSUED = weakref.WeakKeyDictionary()


def _issue(sections, trees):
    dump = Dump(sections)
    _ISSUED[dump] = (sections, tuple((section.path, section.body, section.managed) for section in sections), trees)
    return dump


def _issued(dump):
    """(sections, trees) of a Dump that parse_dump returned and nothing changed since, else nginx_dump_invalid."""
    record = _ISSUED.get(dump) if type(dump) is Dump else None
    if (record is None or dump.sections is not record[0]
            or any(section.path is not path or section.body is not body or section.managed is not managed
                   for section, (path, body, managed) in zip(record[0], record[1]))):
        _fail('nginx_dump_invalid')
    return record[0], record[2]


def _managed_text(raw):
    """A managed file as nginx reads it: bytes without NUL, one character per
    byte (latin-1), else None. UTF-8 notes and 8-bit values are text."""
    if type(raw) is not bytes or b'\x00' in raw:
        return None
    return raw.decode('latin-1')


def _text(raw):
    """Shared include text: ASCII without NUL, else None; the decode error (it quotes input) is dropped."""
    if type(raw) is not bytes:
        return None
    try:
        text = raw.decode('ascii')
    except UnicodeDecodeError:
        text = None
    return None if text is None or '\x00' in text else text


def _unescape(word):
    """nginx copies a word, translating only \\" \\' \\\\ \\t \\r \\n."""
    result, index = [], 0
    while index < len(word):
        if word[index] == '\\' and index + 1 < len(word) and word[index + 1] in _ESCAPES:
            result.append(_ESCAPES[word[index + 1]])
            index += 2
        else:
            result.append(word[index])
            index += 1
    return ''.join(result)


def _lex(text):
    """nginx ngx_conf_read_token rules over one file's text (one char per byte).

    Only a token-initial '#' starts a comment (to the line end). Single or
    double quotes delimit a word only at its start and must be followed by
    whitespace, ';', '{' or ')'; such a ')' begins the next word, as in nginx.
    A backslash escapes the next character. A bare word ends at whitespace,
    ';' or '{'; '{' directly after '$' stays in the word (${name}), and '}'
    inside a word is a word character. ';' and '{' need a preceding word in
    the statement, '}' needs none, and braces balance. A block opened by a
    '*_by_lua_block' directive is another lexer's text: nginx_lexer_unsupported.
    """
    tokens, first, words, depth, index, size = [], None, 0, 0, 0, len(text)
    while index < size:
        char = text[index]
        if char in _SPACE:
            index += 1
        elif char == '#':
            end = text.find('\n', index)
            index = size if end < 0 else end + 1
        elif char in ';{':
            if not words:
                _fail('nginx_syntax_invalid')
            if char == '{' and first.endswith(LUA_BLOCK_SUFFIX):
                _fail('nginx_lexer_unsupported')
            tokens.append(Token(char, char))
            first, words, depth, index = None, 0, depth + (char == '{'), index + 1
        elif char == '}':
            if words or not depth:
                _fail('nginx_syntax_invalid')
            tokens.append(Token(char, char))
            depth, index = depth - 1, index + 1
        else:
            if char in '"\'':
                end = index + 1
                while end < size and text[end] != char:
                    end += 2 if text[end] == '\\' else 1
                if end >= size:
                    _fail('nginx_syntax_invalid')
                if end + 1 < size and text[end + 1] not in _SPACE + ';{)':
                    _fail('nginx_syntax_invalid')
                token = Token('word', _unescape(text[index + 1:end]), True)
                end += 1
            else:
                end, variable = index, False
                while end < size:
                    part = text[end]
                    if part == '{' and variable:
                        end += 1
                        continue
                    variable = part == '$'
                    if part == '\\':
                        if end + 1 >= size:
                            _fail('nginx_syntax_invalid')
                        end += 2
                    elif part in _SPACE or part in ';{':
                        break
                    else:
                        end += 1
                token = Token('word', _unescape(text[index:end]))
            tokens.append(token)
            first = token.value if first is None else first
            words, index = words + 1, end
    if words or depth:
        _fail('nginx_syntax_invalid')
    return tuple(tokens)


def tokenize(raw):
    """Tokens of one managed file (bytes without NUL), or a fixed failure code."""
    text = _managed_text(raw)
    if text is None:
        _fail('nginx_text_invalid')
    return _lex(text)


def _section_tokens(body, managed):
    """Every file is lexed byte for byte as nginx reads it (latin-1 maps each
    byte to one character); a managed file may not hold NUL."""
    return tokenize(body) if managed else _lex(body.decode('latin-1'))


def _directives(tokens):
    """Statement tree from balanced tokens (iterative: no recursion limit)."""
    stack, args = [[]], []
    for token in tokens:
        if token.kind == 'word':
            args.append(token.value)
        elif token.kind == ';':
            stack[-1].append(Directive(tuple(args), None))
            args = []
        elif token.kind == '{':
            stack[-1].append(tuple(args))
            stack.append([])
            args = []
        else:
            body = tuple(stack.pop())
            stack[-1][-1] = Directive(stack[-1][-1], body)
    return tuple(stack[0])


def _walk(directives):
    """(directive, enclosing block directives from the file level inward), in order."""
    pending, result = [(directive, ()) for directive in reversed(directives)], []
    while pending:
        directive, chain = pending.pop()
        result.append((directive, chain))
        if directive.block is not None:
            inner_chain = chain + (directive,)
            pending.extend((inner, inner_chain) for inner in reversed(directive.block))
    return result


def _path(value):
    return (type(value) is str and value.startswith('/')
            and not any(ord(char) < 32 or ord(char) == 127 for char in value))


def _heading(raw, position):
    """The one heading predicate: the path and the offset after the line, or None.

    A heading is a whole line '# configuration file <path>:' whose path is
    UTF-8, absolute and free of control characters. parse_dump refuses any
    other line that starts with the heading prefix; a line that only resembles
    it (other spacing or case) is file text.
    """
    end = raw.find(b'\n', position)
    if end < 0:
        return None
    line = raw[position:end]
    if not line.startswith(HEADER) or not line.endswith(b':'):
        return None
    try:
        path = line[len(HEADER):-1].decode('utf-8')
    except UnicodeDecodeError:
        path = None
    return (path, end + 1) if _path(path) else None


def _next_heading(raw, start):
    """Offset of the first LF at or after start that precedes a line with the
    heading prefix, or -1; that line must be a heading (else nginx_dump_invalid)."""
    found = raw.find(b'\n' + HEADER, start)
    if found >= 0 and _heading(raw, found + 1) is None:
        _fail('nginx_dump_invalid')
    return found


def parse_dump(raw, managed):
    """Split `nginx -T` stdout into sections, binding each managed path to its bytes.

    nginx writes '# configuration file <path>:\\n', the file bytes and one '\\n'
    per file, and each file once however often it is included: a second
    heading of one path (managed or not) is nginx_dump_invalid. A managed
    section consumes exactly its expected bytes, which must be followed by
    '\\n' and the next heading or the end. Every managed path must appear.
    An unmanaged section ends at the next line-initial heading. Outside
    managed bytes, every line that
    starts with the heading prefix must be a heading (a file name with a
    linefeed or control character makes nginx print one that is not), and a
    file body cannot start with that prefix. Every section must be lexically complete
    with nginx rules: each section then starts where nginx's lexer is at a
    fresh statement, so a heading inside an open quote, escape or block of any
    file never splits it, and a heading-shaped comment at a statement boundary
    splits text that nginx lexes exactly as the sections are lexed here.
    Returns a Dump, the only input check_policy accepts.
    """
    if (type(managed) is not dict or not managed
            or any(not _path(path) or type(body) is not bytes for path, body in managed.items())):
        _fail('nginx_managed_invalid')
    if type(raw) is not bytes:
        _fail('nginx_dump_invalid')
    sections, trees, seen, position = [], [], set(), 0
    while position < len(raw):
        heading = _heading(raw, position)
        if heading is None:
            _fail('nginx_dump_invalid')
        path, position = heading
        if path in seen:
            _fail('nginx_dump_invalid')
        seen.add(path)
        if path in managed:
            body = managed[path]
            end = position + len(body)
            if raw[position:end] != body:
                _fail('nginx_dump_mismatch')
            if end >= len(raw):
                _fail('nginx_dump_invalid')
            if raw[end:end + 1] != b'\n':
                _fail('nginx_dump_mismatch')
            if end + 1 < len(raw) and _heading(raw, end + 1) is None:
                if raw.startswith(HEADER, end + 1):
                    _fail('nginx_dump_invalid')
                _fail('nginx_dump_mismatch')
        else:
            if raw.startswith(HEADER, position):
                _fail('nginx_dump_invalid')
            end = _next_heading(raw, position)
            if end < 0:
                end = len(raw) - 1
                if not raw.endswith(b'\n') or end < position:
                    _fail('nginx_dump_invalid')
        body = raw[position:end]
        trees.append(_directives(_section_tokens(body, path in managed)))
        sections.append(DumpSection(path, body, path in managed))
        position = end + 1
    if not sections:
        _fail('nginx_dump_invalid')
    if set(managed) - seen:
        _fail('nginx_dump_missing')
    return _issue(tuple(sections), tuple(trees))


def _cidr(value):
    if _CIDR.fullmatch(value) is None:
        _fail('nginx_shared_invalid')
    try:
        network = ipaddress.ip_network(value, strict=True)
    except ValueError:
        network = None
    # IPv4-mapped IPv6 is spelled differently across Python versions (dotted
    # since 3.13), so it has no stable canonical form here and is refused.
    if (network is None or network.prefixlen == 0 or str(network) != value
            or (network.version == 6 and ('.' in value or network.network_address.ipv4_mapped is not None))):
        _fail('nginx_shared_invalid')
    return network


def parse_shared(geo, realip):
    """The two shared include files: one '<cidr> 1;\\n' or 'set_real_ip_from
    <cidr>;\\n' line per range in any order, canonical CIDRs without
    duplicates, both families present, and the same set in both files.
    Returns the ranges in (family, address, prefix) order.
    """
    found = []
    for raw, prefix, suffix in ((geo, '', ' 1;'), (realip, 'set_real_ip_from ', ';')):
        text = _text(raw)
        if text is None or not text.endswith('\n'):
            _fail('nginx_shared_invalid')
        networks = []
        for line in text[:-1].split('\n'):
            if not line.startswith(prefix) or not line.endswith(suffix) or len(line) <= len(prefix) + len(suffix):
                _fail('nginx_shared_invalid')
            networks.append(_cidr(line[len(prefix):len(line) - len(suffix)]))
        if len(set(networks)) != len(networks) or {item.version for item in networks} != {4, 6}:
            _fail('nginx_shared_invalid')
        found.append(set(networks))
    if found[0] != found[1]:
        _fail('nginx_shared_ranges_differ')
    ordered = sorted(found[0], key=lambda item: (item.version, int(item.network_address), item.prefixlen))
    return tuple(str(item) for item in ordered)


def _shared_dir(value):
    if (not _path(value) or value == '/' or value.endswith('/') or '//' in value
            or any(part in ('.', '..') for part in value.split('/'))):
        _fail('nginx_shared_dir_invalid')
    return value


def _variable(value):
    """nginx variable names compare ASCII-case-insensitively; '${name}' is '$name'."""
    if not value.startswith('$') or len(value) < 2:
        return None
    name = value[1:]
    if name.startswith('{') and name.endswith('}'):
        name = name[1:-1]
    return name.translate(_ASCII_LOWER)


def _defined_variable(directive, chain):
    """The variable a directive defines (known forms), or None: geo/map/
    split_clients name it last before their block; set, '*_set'
    (auth_request_set, ...) and 'set_*' (set-misc) name it first; keyval
    names it second; a geoip2 block entry is the variable itself."""
    args, name = directive.args, directive.args[0]
    if name in ('geo', 'map', 'split_clients') and directive.block is not None and len(args) >= 2:
        return _variable(args[-1])
    if name == 'keyval' and len(args) >= 3:
        return _variable(args[2])
    if chain and chain[-1].args[0].startswith('geoip'):
        return _variable(name)
    if ((name == 'set' or name.endswith('_set') or name.startswith('set_'))
            and name != 'set_real_ip_from' and len(args) >= 2):
        return _variable(args[1])
    return None


def _captures(args):
    """Lower-cased names of PCRE named groups in any argument (a superset of
    the regex positions: server_name, location, if, map keys, rewrite, ...)."""
    names = set()
    for arg in args:
        if '(?' in arg:
            names.update((match.group(1) or match.group(2)).translate(_ASCII_LOWER) for match in _CAPTURE.finditer(arg))
    return names


def _dynamic(name):
    """A directive of a known module that can write variables at run time."""
    return '_by_lua' in name or name in JS_HANDLERS or name == 'perl' or name.startswith('perl_')


def _resolves_to(arg, target, prefixes):
    """Whether an include argument can name target (an exact absolute path).

    A relative name is joined to each conf prefix. Repeated '/' and the '.'
    and '..' components are collapsed lexically. A name without '*', '?' or
    '[' must then equal target; a glob(3) pattern must match it component by
    component (fnmatch per component, so '*' never crosses '/'). A component
    with '[' matches any name: glob(3) bracket expressions ('[^x]', classes,
    equivalence classes, collating symbols) are not what fnmatch reads. A
    pattern with a backslash (glob(3) escapes, which fnmatch does not read)
    counts as matching.
    """
    for candidate in ((arg,) if arg.startswith('/') else tuple(prefix + '/' + arg for prefix in prefixes)):
        path = posixpath.normpath(re.sub('/+', '/', candidate))
        if not any(char in path for char in '*?['):
            if path == target:
                return True
        elif '\\' in path:
            return True
        else:
            parts, wanted = path.split('/'), target.split('/')
            if len(parts) == len(wanted) and all('[' in part or fnmatch.fnmatchcase(name, part) for name, part in zip(wanted, parts)):
                return True
    return False


def _bundles(bundles, shared_paths):
    if (type(bundles) is not tuple or not bundles
            or any(type(bundle) is not tuple or len(bundle) != 2 or not all(_path(path) for path in bundle)
                   or set(bundle) & shared_paths for bundle in bundles)
            or len(set(bundles)) != len(bundles)):
        _fail('nginx_managed_invalid')
    return bundles


def check_policy(dump, bundles, shared_dir):
    """Address policy over the whole dump (the Dump parse_dump returned).

    Any other value, or a Dump whose sections were made or changed elsewhere,
    is nginx_dump_invalid. bundles is a tuple of (geo file, realip file) path
    pairs; with the two shared include files they are exactly the managed
    sections. The two shared files in the dump must pass parse_shared (its
    code on failure). The checks walk the syntax trees parse_dump built and
    the module kept (never the caller's objects); nothing is decoded or lexed
    again.

    Anywhere: a directive of a known variable-writing module (see the module
    docstring) is nginx_dynamic_module_unsupported; an include argument with a
    control character is nginx_dump_invalid.
    Per bundle: exactly one geo block in its geo file includes the shared geo
    file; it is 'geo $realip_remote_addr $<name>' (exactly those words, the
    name plain: letters, digits and '_', not starting with a digit), every
    block on its path is http (the file level is accepted, as for realip),
    and its body is exactly that include and 'default 0;', once each. In
    its realip file every include that can resolve to the shared realip
    file is counted: there is exactly
    one, it names the shared file exactly, and every block on its path is
    http, server or location (none under stream or mail). The file level is
    accepted; the context including the file is not visible. In the same file
    'real_ip_header X-Forwarded-For;' and 'real_ip_recursive off;' stand in
    the include's own block or a block enclosing it (the file level included),
    never in a sibling, child or non-http/server/location block.
    Across the whole dump: set_real_ip_from appears only in the shared realip
    file; real_ip_* appears only in bundle files with exactly the two values
    above; only a bundle realip file holds an include that can resolve to the
    shared realip file; the only include that can resolve to the shared geo
    file is the one in each bound geo block; and a bundle's geo variable is
    defined only by bound geo blocks. Bundles may share a variable name:
    nginx accepts several geo blocks of one variable (the last one wins), and
    every one of them is then a verified bundle block.
    """
    shared = _shared_dir(shared_dir)
    geo_shared, realip_shared = shared + '/' + GEO_NAME, shared + '/' + REALIP_NAME
    geo_include, realip_include = ('include', geo_shared), ('include', realip_shared)
    bundles = _bundles(bundles, {geo_shared, realip_shared})
    sections, trees = _issued(dump)
    geo_paths = {geo for geo, _ in bundles}
    realip_paths = {realip for _, realip in bundles}
    bundle_paths = geo_paths | realip_paths
    managed_paths = bundle_paths | {geo_shared, realip_shared}
    bodies, walked = {}, {}
    for section, tree in zip(sections, trees):
        if (section.path in managed_paths) is not section.managed:
            _fail('nginx_managed_invalid')
        bodies[section.path] = section.body
        walked[section.path] = _walk(tree)
    if managed_paths - set(walked):
        _fail('nginx_dump_missing')
    parse_shared(bodies[geo_shared], bodies[realip_shared])
    prefixes = (CONF_PREFIX, posixpath.dirname(sections[0].path))
    # One pass: refusals that need no bundle, and what each include can reach.
    reaches = {}
    for items in walked.values():
        for directive, _ in items:
            if _dynamic(directive.args[0]):
                _fail('nginx_dynamic_module_unsupported')
            if directive.args[0] == 'include':
                if any(not _path('/' + arg) for arg in directive.args[1:]):
                    _fail('nginx_dump_invalid')
                reaches[id(directive)] = (any(_resolves_to(arg, realip_shared, prefixes) for arg in directive.args[1:]),
                                          any(_resolves_to(arg, geo_shared, prefixes) for arg in directive.args[1:]))
    bound, bound_includes, variables = set(), set(), set()
    for geo_path, realip_path in bundles:
        selected = [(directive, chain) for directive, chain in walked[geo_path]
                    if directive.args[0] == 'geo' and directive.block is not None
                    and any(inner.args == geo_include for inner, _ in _walk(directive.block))]
        if len(selected) != 1:
            _fail('nginx_geo_not_bound')
        geo, geo_chain = selected[0]
        if (len(geo.args) != 3 or geo.args[1] != GEO_SOURCE or _PLAIN_VARIABLE.fullmatch(geo.args[2]) is None
                or any(block.args[0] not in GEO_CONTEXTS for block in geo_chain)):
            _fail('nginx_geo_not_bound')
        body = geo.block
        if (len(body) != 2 or any(item.block is not None for item in body)
                or {item.args for item in body} != {geo_include, ('default', '0')}):
            _fail('nginx_geo_unmanaged_policy')
        bound.add(id(geo))
        bound_includes.update(id(item) for item in body if item.args == geo_include)
        variables.add(_variable(geo.args[2]))
        includes = [(directive, chain) for directive, chain in walked[realip_path]
                    if directive.args[0] == 'include' and reaches[id(directive)][0]]
        if (len(includes) != 1 or includes[0][0].args != realip_include or includes[0][0].block is not None
                or any(block.args[0] not in REALIP_CONTEXTS for block in includes[0][1])):
            _fail('nginx_realip_include_invalid')
        path = includes[0][1]
        present = {directive.args for directive, chain in walked[realip_path]
                   if directive.block is None and directive.args in (REALIP_HEADER, REALIP_RECURSIVE)
                   and len(chain) <= len(path) and all(outer is inner for outer, inner in zip(chain, path))}
        if present != {REALIP_HEADER, REALIP_RECURSIVE}:
            _fail('nginx_realip_policy_missing')
    for path, items in walked.items():
        for directive, chain in items:
            name = directive.args[0]
            if name == 'set_real_ip_from':
                trusted = path == realip_shared and directive.block is None
            elif name.startswith('real_ip_'):
                trusted = path in bundle_paths and directive.args in (REALIP_HEADER, REALIP_RECURSIVE) and directive.block is None
            elif name == 'include' and reaches[id(directive)][0]:
                trusted = path in realip_paths
            else:
                trusted = True
            if not trusted:
                _fail('nginx_realip_unmanaged_trust')
            if name == 'include' and reaches[id(directive)][1] and id(directive) not in bound_includes:
                _fail('nginx_geo_include_invalid')
            defined = _defined_variable(directive, chain)
            if (defined in variables and id(directive) not in bound) or _captures(directive.args) & variables:
                _fail('nginx_geo_variable_redefined')


# ---------------------------------------------------------------------------
# Read-only observation (the only I/O in this module) and admission.

SUPPORTED_OS = ('22.04', '24.04', '26.04')
OS_RELEASE = '/usr/lib/os-release'
SYSTEMD_RUN = '/usr/bin/systemd-run'
NGINX = '/usr/sbin/nginx'
SYSTEMCTL = '/usr/bin/systemctl'
# The host executables the commands below run; the sandbox precondition checks
# each at this absolute path (never under a Collector's file-read root).
SANDBOX_EXECUTABLES = (SYSTEMD_RUN, NGINX, SYSTEMCTL)
# Their owner, and the owner of every directory above them: root. Fixed, never
# the Collector's owner (which applies to the managed files only).
EXECUTABLE_UID = 0
# systemctl show is a read of the service manager's state; it runs unsandboxed.
# ExecStart is the command line systemd starts nginx with: admission requires
# the packaged one (NGINX_COMMAND_LINES), so the daemon reads the default
# configuration that nginx -T dumps (no -c, -p or other -g). ExecReload is not
# read: a reload only signals the running master, which rereads the
# configuration file it was started with.
DAEMON_PROPERTIES = ('Id', 'LoadState', 'ActiveState', 'SubState', 'MainPID', 'ExecStart')
DAEMON_STATE = (SYSTEMCTL, 'show', '--property=' + ','.join(DAEMON_PROPERTIES), 'nginx.service')
# nginx -T -q only inside this transient unit. Its purpose is that nginx -T's
# incidental side effects (the error log, pid file and temporary directories
# it opens or creates, shared memory, IPC objects) leave the host unchanged:
# a read-only file system view; a private /tmp; empty private tmpfs over /run,
# the nginx log and state directories and /dev/shm, /dev/mqueue,
# /dev/hugepages and /dev/pts (PrivateDevices=yes alone keeps the host's
# instances of those four; whatever is written there is discarded with the
# unit, and no host pty can be opened); the host's systemd-resolved directory
# bound read-only into that /run when it exists (/etc/resolv.conf points there
# on Ubuntu, so nginx can resolve names); a private IPC namespace (no host
# System V or POSIX IPC object is visible, none created reaches the host);
# kernel tunables, /sys and cgroups readable but not writable and the
# non-process entries of /proc made inaccessible, written out as
# ReadOnlyPaths/InaccessiblePaths (see below); sockets of AF_UNIX (the
# resolved stub and nss), AF_INET/AF_INET6 (DNS) and AF_NETLINK (glibc's getaddrinfo reads the configured addresses
# through it for nginx's AI_ADDRCONFIG; without it the resolved address
# families differ from those of nginx's own reload) only; no new privileges,
# no devices, read-only kernel modules/logs/clock/hostname, no new namespaces,
# no set-uid/set-gid files, no personality or realtime changes, native system
# calls of the @system-service set only, and a capability bounding set of what
# nginx -T as root needs to read its files and drop to its worker user (no
# CAP_SYS_ADMIN, CAP_KILL or CAP_SYS_PTRACE, no ambient capabilities). systemd
# names the unit (no fixed name to collide on) and --pipe owns stdin.
#
# ProtectProc=, ProcSubset=, ProtectKernelTunables= and ProtectControlGroups=
# are deliberately not used, on every OS (one argv, no per-OS variant): each
# implies MountAPIVFS, which adds systemd's own "/run" API mount (mode RUN).
# systemd 249 (22.04) keeps only the higher-priority of two mounts of the
# same path, RUN outranks TemporaryFileSystem's TMPFS, and RUN does nothing
# when /run is already a mount point, so /run stays the host's (measured:
# nginx -T then left an empty /run/nginx.pid on the host). Their effect is
# written out instead. ReadOnlyPaths= keeps /proc/sys, /proc/sysrq-trigger,
# /sys and /sys/fs/cgroup readable but not writable, as
# ProtectKernelTunables=/ProtectControlGroups= do (reads such as OpenSSL's
# /proc/sys/crypto/fips_enabled behave as in nginx's own reload);
# /proc/sysrq-trigger is optional ('-': a kernel without CONFIG_MAGIC_SYSRQ
# lacks it), the other three are mandatory. InaccessiblePaths= approximates
# ProcSubset=pid by the non-process entries of /proc collected on the aarch64
# Ubuntu 22.04, 24.04 and 26.04 VMs and the amd64 26.04 host (common-sv),
# plus the other /proc entries of systemd 249's ProtectKernelTunables= table
# (apm, asound, timer_stats), each optional with a leading '-'. Not hidden:
# self and thread-self (the process's own), mounts and net (links into
# self), kmsg (ProtectKernelLogs= hides it), sys and sysrq-trigger
# (read-only above). No path is in both lists: systemd keeps a single mount
# per path, dropping the other entry together with its mandatory flag.
# Limits: there is no ProtectProc= equivalent (measured on the supported VMs:
# this root unit saw every /proc/<pid> with ProtectProc=invisible too, since
# the kernel exempts group 0 from hidepid); the /proc list is fixed, so an
# entry a future kernel adds (or one present only on hardware not sampled)
# is not hidden automatically: it stays visible (fail-open: readable, and
# writable only where the kernel itself makes it so; the writable entries of
# the sampled kernels, /proc/sys and /proc/sysrq-trigger, are read-only
# here); /proc itself is the host's procfs, not a subset=pid instance.
#
# TemporaryFileSystem= creates a missing target directory on the host file
# system before mounting over it (measured on 22.04, 24.04 and 26.04 with
# /var/cache/nginx absent), so its targets are only directories that must
# exist: /run, /var/log/nginx and /var/lib/nginx (SANDBOX_TMPFS_DIRECTORIES:
# each must be a directory itself, by lstat, a symbolic link refused; checked
# with the sandbox precondition, nginx_sandbox_unavailable, and again right
# before every start, nginx_observation_failed, the unit then not started)
# and the four /dev directories, which are created in PrivateDevices='s
# private /dev. /var/cache/nginx is not among them (Ubuntu's nginx keeps
# nothing there and it may be absent, as on common-sv): with
# ProtectSystem=strict it stays read-only and is never created, so a
# configuration that puts proxy_cache_path or a *_temp_path under
# /var/cache/nginx fails nginx -T here (EROFS: nginx_observation_failed;
# neither Ubuntu's default configuration nor common-sv's does).
# Residual race (not removed, accepted): a target removed between that
# re-check and the unit's start (apt purge of nginx, for example) is created
# again, empty, on the host by systemd.
#
# Not prevented (systemd 249, the oldest supported, has no PID namespace for
# units: PrivatePIDs= needs a newer systemd): signals to processes of the same
# uid (root), reading files root may read, and network connections (DNS needs
# them: PrivateNetwork= and IPAddressDeny= would break resolving upstream names
# through the 127.0.0.53 stub). The sandbox does not contain a hostile module
# or configuration: nginx loads the same modules and runs the same
# initialisation code as root, unsandboxed, on every reload of the same
# configuration, so containing them here would protect nothing. nginx -T still
# runs as root: the sandbox is what keeps its incidental writes off the host;
# it is the precondition of running nginx -T at all (there is no unsandboxed
# fallback). Every property is calibrated on the supported VMs (phase C).
# The unit's RuntimeMaxSec, and the Collector's timeout domain built on it:
# command_timeout (the sandbox's client timeout) outlasts it by
# MIN_COMMAND_TIMEOUT - SANDBOX_RUNTIME_MAX_SEC seconds (systemd-run --wait
# returns after the unit ends). Each pass runs two commands with a timeout,
# systemctl show (at most DAEMON_STATE_TIMEOUT) and the sandbox
# (command_timeout), so whole_timeout holds
# 2 * (command_timeout + DAEMON_STATE_TIMEOUT) + WHOLE_TIMEOUT_MARGIN; the
# defaults, 20 and 60, are the smallest such pair.
# RuntimeMaxSec counts only from the unit's start: when PID1 is busy and the
# client is killed before the unit started, the unit may still start and run
# up to RuntimeMaxSec unwatched by the Collector (its PrivateTmp directories
# staying on the host meanwhile). Not removed, accepted (rare; see README).
SANDBOX_RUNTIME_MAX_SEC = 15
MIN_COMMAND_TIMEOUT = SANDBOX_RUNTIME_MAX_SEC + 5
DAEMON_STATE_TIMEOUT = 5
WHOLE_TIMEOUT_MARGIN = 10
# The TemporaryFileSystem= targets outside the private /dev (see above).
SANDBOX_TMPFS_DIRECTORIES = ('/run', '/var/log/nginx', '/var/lib/nginx')
SANDBOX_DUMP = (SYSTEMD_RUN, '--quiet', '--wait', '--pipe', '--collect',
                '--service-type=exec', '--property=ProtectSystem=strict', '--property=PrivateTmp=yes',
                '--property=TemporaryFileSystem=/run /var/log/nginx /var/lib/nginx'
                ' /dev/shm /dev/mqueue /dev/hugepages /dev/pts',
                '--property=BindReadOnlyPaths=-/run/systemd/resolve',
                '--property=NoNewPrivileges=yes', '--property=PrivateDevices=yes', '--property=PrivateIPC=yes',
                '--property=ReadOnlyPaths=/proc/sys -/proc/sysrq-trigger /sys /sys/fs/cgroup',
                '--property=InaccessiblePaths=-/proc/acpi -/proc/apm -/proc/asound -/proc/bootconfig'
                ' -/proc/buddyinfo -/proc/bus -/proc/cgroups -/proc/cmdline -/proc/consoles -/proc/cpuinfo'
                ' -/proc/crypto -/proc/devices -/proc/diskstats -/proc/dma -/proc/driver -/proc/dynamic_debug'
                ' -/proc/execdomains -/proc/fb -/proc/filesystems -/proc/fs -/proc/interrupts -/proc/iomem'
                ' -/proc/ioports -/proc/irq -/proc/kallsyms -/proc/kcore -/proc/key-users -/proc/keys'
                ' -/proc/kpagecgroup -/proc/kpagecount -/proc/kpageflags -/proc/latency_stats -/proc/loadavg'
                ' -/proc/locks -/proc/mdstat -/proc/meminfo -/proc/misc -/proc/modules -/proc/mtrr'
                ' -/proc/pagetypeinfo -/proc/partitions -/proc/pressure -/proc/schedstat -/proc/scsi'
                ' -/proc/slabinfo -/proc/softirqs -/proc/stat -/proc/swaps'
                ' -/proc/sysvipc -/proc/timer_list -/proc/timer_stats -/proc/tty -/proc/uptime -/proc/version'
                ' -/proc/version_signature -/proc/vmallocinfo -/proc/vmstat -/proc/zoneinfo',
                '--property=RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK',
                '--property=ProtectKernelModules=yes', '--property=ProtectKernelLogs=yes',
                '--property=ProtectClock=yes', '--property=ProtectHostname=yes',
                '--property=RestrictNamespaces=yes', '--property=RestrictSUIDSGID=yes',
                '--property=LockPersonality=yes', '--property=RestrictRealtime=yes',
                '--property=SystemCallArchitectures=native', '--property=SystemCallFilter=@system-service',
                '--property=CapabilityBoundingSet=CAP_CHOWN CAP_DAC_OVERRIDE CAP_DAC_READ_SEARCH CAP_SETUID CAP_SETGID',
                '--property=RuntimeMaxSec=' + str(SANDBOX_RUNTIME_MAX_SEC),
                '--', NGINX, '-T', '-q')
COMMANDS = frozenset((DAEMON_STATE, SANDBOX_DUMP))
# systemctl show prints one ExecStart command as
# '{ path=P ; argv[]=A ; ignore_errors=yes|no ; start_time=[..] ; ... }', the
# argv joined by single spaces without quoting (systemd 249, 255 and 259 on
# the supported VMs). One command only: the ' ; argv[]=' and ' ; ignore_errors='
# separators must each occur once (so argv is unambiguous) and the remaining
# fields must be plain 'name=value' fields. Anything else is not parsed.
_EXEC_START = re.compile(r'\{ path=(/[^ ;{}\n]+) ; argv\[\]=([^\n]*) ; ignore_errors=(?:yes|no)'
                         r'(?: ; [a-z_]+=[^;{}\n]*)* \}', re.ASCII)
# The command lines admitted (the argv as systemctl show prints it): nginx
# with no option, or Ubuntu's packaged ExecStart (-g 'daemon on;
# master_process on;': both are nginx's own defaults and leave the address
# policy alone). Any -c, -p, other -g or other option may make the daemon run
# another configuration than the one nginx -T dumps, and is not admitted.
NGINX_COMMAND_LINES = (NGINX, NGINX + ' -g daemon on; master_process on;')
MANAGED_FILE_LIMIT = 2 * 1024 * 1024
WARNING = b'nginx: [warn] '
_OS_VALUE = re.compile(r'(?:"([A-Za-z0-9._-]{1,32})"|([A-Za-z0-9._-]{1,32}))', re.ASCII)
_PID = re.compile(r'[0-9]{1,10}', re.ASCII)
_STATE = re.compile(r'[a-z-]{1,32}', re.ASCII)


@dataclass(frozen=True, eq=False)
class NginxObservation:
    """Two identical read-only passes. Only os_id is shown in the repr; every
    other field (paths, bytes, counts) is omitted. Only an instance that
    Collector.collect() returned, with its fields unchanged, passes
    admit_policy (see _OBSERVED): a hand-made instance, dataclasses.replace,
    a copy, deep copy or unpickled clone is another instance and is refused."""
    os_id: str
    shared_dir: str = field(repr=False)
    bundles: tuple = field(repr=False)
    os_name: str = field(repr=False)
    daemon: tuple = field(repr=False)
    dump: bytes = field(repr=False)
    stderr: bytes = field(repr=False)
    warnings: int = field(repr=False)
    managed: tuple = field(repr=False)


_OBSERVATION_FIELDS = ('os_id', 'shared_dir', 'bundles', 'os_name', 'daemon', 'dump', 'stderr', 'warnings', 'managed')
# Each NginxObservation that Collector.collect() returned (weakly held,
# compared by identity) -> its field values as returned (shared_dir and
# bundles are the Collector's own). Same threat model as _ISSUED: accidental misuse by
# the calling code is detected; deliberate tampering with this module's
# private names inside the process is out of scope.
_OBSERVED = weakref.WeakKeyDictionary()


def _observation_values(observation):
    return tuple(getattr(observation, name) for name in _OBSERVATION_FIELDS)


def _issue_observation(observation):
    _OBSERVED[observation] = _observation_values(observation)
    return observation


def collected(observation):
    """Whether observation is an NginxObservation that Collector.collect()
    returned, every field still the object it returned (so its shared_dir and
    bundles are those the Collector was built with)."""
    record = _OBSERVED.get(observation) if type(observation) is NginxObservation else None
    return record is not None and all(value is kept for value, kept in zip(_observation_values(observation), record))


def _normal_path(value):
    return (_path(value) and value != '/' and posixpath.normpath(value) == value
            and not any(part in ('.', '..') for part in value.split('/')))


class Collector:
    """Fixed read-only nginx evidence; see the module docstring. No constructor I/O."""

    def __init__(self, *, shared_dir, bundles, root='/', owner=0, runner=None, clock=None,
                 command_timeout=20, whole_timeout=60, max_output=4 * 1024 * 1024, max_total=16 * 1024 * 1024):
        shared = _shared_dir(shared_dir)
        shared_paths = (shared + '/' + GEO_NAME, shared + '/' + REALIP_NAME)
        bundles = _bundles(bundles, set(shared_paths))
        managed = (*shared_paths, *sorted({path for bundle in bundles for path in bundle}))
        if (type(root) is not str or not _normal_path(root) and root != '/'
                or type(owner) is not int or not 0 <= owner < 2 ** 32 - 1
                or any(type(value) not in (int, float) or not math.isfinite(value) or not 0 < value <= 120
                       for value in (command_timeout, whole_timeout))
                or not command_timeout >= MIN_COMMAND_TIMEOUT
                or not whole_timeout >= 2 * (command_timeout + DAEMON_STATE_TIMEOUT) + WHOLE_TIMEOUT_MARGIN
                or type(max_output) is not int or not 0 < max_output <= 4 * 1024 * 1024
                or type(max_total) is not int or not 0 < max_total <= 16 * 1024 * 1024
                or (runner is not None and not callable(runner)) or (clock is not None and not callable(clock))
                or not all(_normal_path(path) for path in managed)):
            _fail('nginx_collector_invalid')
        self.shared_dir, self.bundles, self.managed_paths = shared, bundles, managed
        self.root, self.owner, self.runner, self.clock = root, owner, runner, clock
        self.command_timeout, self.whole_timeout = command_timeout, whole_timeout
        self.max_output, self.max_total = max_output, max_total

    def collect(self):
        code = None
        try:
            return _issue_observation(self._collect())
        except NginxObservationError as error:
            code = error.args[0] if type(error) is NginxObservationError and len(error.args) == 1 else None
        except Exception:
            code = None
        _collection_failure(code)

    # -- session: [bytes charged, deadline, last clock reading] --------------
    def _now(self):
        value = (self.clock or time.monotonic)()
        if type(value) not in (int, float) or not math.isfinite(value):
            _fail('nginx_observation_failed')
        return value

    def _remaining(self, session):
        now = self._now()
        if now < session[2]:
            _fail('nginx_observation_failed')
        session[2] = now
        remaining = session[1] - now
        if remaining <= 0:
            _fail('nginx_observation_failed')
        return remaining

    def _charge(self, session, count):
        self._remaining(session)
        session[0] += count
        if session[0] > self.max_total:
            _fail('nginx_observation_failed')

    def _collect(self):
        self._sandbox_ready()
        start = self._now()
        session = [0, start + self.whole_timeout, start]
        first = self._pass(session)
        second = self._pass(session)
        self._remaining(session)
        # The raw passes (os-release, daemon, dump, stderr, managed bytes) are
        # compared first; only identical passes are parsed, once.
        if first != second:
            _fail('nginx_observation_failed')
        os_name, os_id, daemon, dump, stderr, warnings, managed = first
        # Binds every managed path to the bytes read; any refusal is a failed observation.
        parse_dump(dump, dict(managed))
        return NginxObservation(os_id, self.shared_dir, self.bundles, os_name, daemon, dump, stderr, warnings, managed)

    def _sandbox_ready(self):
        """Before any command: Linux, root (a system transient unit), default
        SIGCHLD (ufw_observation._stream owns its child) and every executable
        the commands run (SANDBOX_EXECUTABLES: systemd-run, nginx, systemctl)
        at its absolute host path, never under self.root: reached through
        NOFOLLOW directories owned by root (EXECUTABLE_UID) and not
        group/world writable, a regular file owned by root (EXECUTABLE_UID,
        never self.owner, which is for the managed files only), not
        group/world writable and executable; and every
        SANDBOX_TMPFS_DIRECTORIES path a directory itself (see
        _tmpfs_directories_present). Any failure of these checks (an
        OSError, a ValueError or a check's own code) is
        nginx_sandbox_unavailable."""
        ready = False
        try:
            ready = self._sandbox_checks()
        except Exception:
            ready = False
        if ready is not True:
            _fail('nginx_sandbox_unavailable')

    def _sandbox_checks(self):
        if (sys.platform != 'linux' or os.geteuid() != 0 or not hasattr(signal, 'SIGCHLD')
                or signal.getsignal(signal.SIGCHLD) != signal.SIG_DFL):
            return False
        for executable in SANDBOX_EXECUTABLES:
            parent, leaf = executable.rsplit('/', 1)
            fd = self._directory(parent, None, host=True)
            try:
                info = os.stat(leaf, dir_fd=fd, follow_symlinks=False)
            finally:
                os.close(fd)
            if (not stat.S_ISREG(info.st_mode) or info.st_uid != EXECUTABLE_UID
                    or info.st_mode & 0o022 or not info.st_mode & 0o111):
                return False
        return self._tmpfs_directories_present()

    # -- files -----------------------------------------------------------------
    def _directory(self, logical, session, host=False):
        """A directory reached from '/' through NOFOLLOW descriptors; every
        ancestor not group/world writable (a root sticky 'tmp' excepted) and
        owned by root or self.owner when logical is under self.root (file
        reads), or by root (EXECUTABLE_UID) with host=True, logical then being
        the absolute host path itself (executables)."""
        owners = (0, EXECUTABLE_UID) if host else (0, self.owner)
        fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY | getattr(os, 'O_NOATIME', 0))
        reached = False
        try:
            parts = [part for part in (logical if host else self.root.rstrip('/') + logical).split('/') if part]
            for part in parts:
                if session is not None:
                    self._remaining(session)
                child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | getattr(os, 'O_NOATIME', 0),
                                dir_fd=fd)
                os.close(fd)
                fd = child
                info = os.fstat(fd)
                sticky = part == 'tmp' and info.st_uid == 0 and info.st_mode & stat.S_ISVTX
                if info.st_uid not in owners or (info.st_mode & 0o022 and not sticky):
                    _fail('nginx_observation_failed')
            reached = True
            return fd
        finally:
            if not reached:
                os.close(fd)

    def _read(self, logical, session):
        parent, leaf = logical.rsplit('/', 1)
        fd = self._directory(parent, session)
        try:
            self._remaining(session)
            before = os.stat(leaf, dir_fd=fd, follow_symlinks=False)
            if (not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_uid != self.owner
                    or before.st_mode & 0o022 or not 0 <= before.st_size <= MANAGED_FILE_LIMIT):
                _fail('nginx_observation_failed')
            self._charge(session, 256 + len(logical))
            if before.st_size > self.max_total - session[0]:
                _fail('nginx_observation_failed')
            source = os.open(leaf, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | getattr(os, 'O_NOATIME', 0),
                             dir_fd=fd)
            try:
                if ufw_observation._identity(os.fstat(source)) != ufw_observation._identity(before):
                    _fail('nginx_observation_failed')
                data = bytearray()
                while True:
                    self._remaining(session)
                    part = os.read(source, 65536)
                    if not part:
                        break
                    self._charge(session, len(part))
                    data.extend(part)
                    if len(data) > MANAGED_FILE_LIMIT:
                        _fail('nginx_observation_failed')
                if (ufw_observation._identity(os.fstat(source)) != ufw_observation._identity(before)
                        or ufw_observation._identity(os.stat(leaf, dir_fd=fd, follow_symlinks=False))
                        != ufw_observation._identity(before)):
                    _fail('nginx_observation_failed')
                return bytes(data)
            finally:
                os.close(source)
        finally:
            os.close(fd)

    # -- commands --------------------------------------------------------------
    def _command(self, argv, session):
        if type(argv) is not tuple or argv not in COMMANDS:
            _fail('nginx_observation_failed')
        remaining = self._remaining(session)
        # The sandbox only with the whole command_timeout left: a shorter
        # client timeout would kill systemd-run alone and leave its unit
        # running until RuntimeMaxSec. systemctl show has no unit to leave
        # and is given at most DAEMON_STATE_TIMEOUT.
        if argv == SANDBOX_DUMP and remaining < self.command_timeout:
            _fail('nginx_observation_failed')
        # Re-checked right before every start (also checked with the sandbox
        # precondition): systemd would create a missing TemporaryFileSystem=
        # target on the host.
        if argv == SANDBOX_DUMP and not self._tmpfs_directories_present():
            _fail('nginx_observation_failed')
        timeout = self.command_timeout if argv == SANDBOX_DUMP else DAEMON_STATE_TIMEOUT
        available = min(self.max_output, self.max_total - session[0])
        if available <= 0:
            _fail('nginx_observation_failed')
        runner = self.runner if self.runner is not None else ufw_observation._stream
        result = None
        try:
            result = runner(argv, timeout=min(timeout, remaining), max_output=available)
        except Exception:
            result = None
        if (type(result) is not ufw_observation.CommandResult or type(result.stdout) is not bytes
                or type(result.stderr) is not bytes or type(result.returncode) is not int):
            _fail('nginx_observation_failed')
        if len(result.stdout) + len(result.stderr) > available:
            _fail('nginx_observation_failed')
        self._charge(session, len(result.stdout) + len(result.stderr))
        return result

    @staticmethod
    def _tmpfs_directories_present():
        """Each SANDBOX_TMPFS_DIRECTORIES path is a directory itself on the
        host (lstat semantics, os.stat with follow_symlinks=False: a symbolic
        link, even to a directory, is refused, so nothing depends on what
        systemd does with one). Any error is False."""
        try:
            return all(stat.S_ISDIR(os.stat(path, follow_symlinks=False).st_mode) for path in SANDBOX_TMPFS_DIRECTORIES)
        except Exception:
            return False

    def _os_release(self, session):
        raw = self._read(OS_RELEASE, session)
        fields = {}
        text = _text(raw)
        if text is None:
            _fail('nginx_observation_failed')
        for line in text.splitlines():
            if not line or line.startswith('#'):
                continue
            key, equals, value = line.partition('=')
            if not equals or key in fields:
                _fail('nginx_observation_failed')
            fields[key] = value
        values = []
        for key in ('ID', 'VERSION_ID'):
            match = _OS_VALUE.fullmatch(fields.get(key, ''))
            if match is None:
                _fail('nginx_observation_failed')
            values.append(match[1] if match[1] is not None else match[2])
        return values[0], values[1]

    def _daemon(self, session):
        result = self._command(DAEMON_STATE, session)
        text = _text(result.stdout)
        if result.returncode != 0 or result.stderr or text is None or not text.endswith('\n'):
            _fail('nginx_observation_failed')
        properties = {}
        for line in text[:-1].split('\n'):
            key, equals, value = line.partition('=')
            if not equals or key in properties:
                _fail('nginx_observation_failed')
            properties[key] = value
        if (set(properties) != set(DAEMON_PROPERTIES) or properties['Id'] != 'nginx.service'
                or _PID.fullmatch(properties['MainPID']) is None
                or any(_STATE.fullmatch(properties[key]) is None for key in ('LoadState', 'ActiveState', 'SubState'))):
            _fail('nginx_observation_failed')
        return tuple((key, properties[key]) for key in DAEMON_PROPERTIES)

    def _dump(self, session):
        """nginx -T -q in the sandbox. Accepted only with exit 0 and a stderr
        of complete lines that all start with 'nginx: [warn] ' (their count is
        kept privately). Every other outcome, any non-zero exit whatever its
        cause, is nginx_observation_failed (no further classification)."""
        result = self._command(SANDBOX_DUMP, session)
        lines = result.stderr.split(b'\n')
        if (result.returncode != 0 or lines[-1] != b''
                or any(not line.startswith(WARNING) for line in lines[:-1])):
            _fail('nginx_observation_failed')
        return result.stdout, result.stderr, len(lines) - 1

    def _pass(self, session):
        """One pass's raw evidence (strings, bytes and tuples of them), not parsed."""
        os_name, os_id = self._os_release(session)
        daemon = self._daemon(session)
        dump, stderr, warnings = self._dump(session)
        managed = tuple((path, self._read(path, session)) for path in self.managed_paths)
        return os_name, os_id, daemon, dump, stderr, warnings, managed


def _collection_failure(code):
    """Collection codes only, raised outside any handler (no chained context)."""
    if code == 'nginx_sandbox_unavailable':
        _fail('nginx_sandbox_unavailable')
    _fail('nginx_observation_failed')


def _exec_start_command_line(value):
    """(path, argv) of one ExecStart value as systemctl show prints it, or
    None when it is not exactly one command in that format (fail-closed)."""
    if (type(value) is not str or value.count(' ; argv[]=') != 1 or value.count(' ; ignore_errors=') != 1
            or value.count('{') != 1 or value.count('}') != 1):
        return None
    match = _EXEC_START.fullmatch(value)
    return None if match is None else (match[1], match[2])


def _admitted(observation):
    if not collected(observation):
        return None
    daemon = dict(observation.daemon) if type(observation.daemon) is tuple else {}
    if (type(observation.os_name) is not str or observation.os_name != 'ubuntu'
            or type(observation.os_id) is not str or observation.os_id not in SUPPORTED_OS
            or daemon != {'Id': 'nginx.service', 'LoadState': 'loaded', 'ActiveState': 'active',
                          'SubState': 'running', 'MainPID': daemon.get('MainPID'),
                          'ExecStart': daemon.get('ExecStart')}
            or type(daemon['MainPID']) is not str or _PID.fullmatch(daemon['MainPID']) is None
            or int(daemon['MainPID']) <= 0
            or _exec_start_command_line(daemon['ExecStart']) not in ((NGINX, line) for line in NGINX_COMMAND_LINES)
            or type(observation.managed) is not tuple
            or any(type(row) is not tuple or len(row) != 2 for row in observation.managed)):
        return None
    managed = dict(observation.managed)
    shared = _shared_dir(observation.shared_dir)
    shared_paths = (shared + '/' + GEO_NAME, shared + '/' + REALIP_NAME)
    bundles = _bundles(observation.bundles, set(shared_paths))
    if (len(managed) != len(observation.managed)
            or set(managed) != {*shared_paths, *(path for bundle in bundles for path in bundle)}):
        return None
    dump = parse_dump(observation.dump, managed)
    ranges = parse_shared(managed[shared_paths[0]], managed[shared_paths[1]])
    check_policy(dump, bundles, shared)
    return ranges


def admit_policy(observation):
    """Admission of an NginxObservation that Collector.collect() returned,
    unchanged (see collected): Ubuntu 22.04/24.04/26.04, nginx.service
    loaded/active/running with a main PID and started by the packaged command
    line (ExecStart path /usr/sbin/nginx, argv in NGINX_COMMAND_LINES: no -c,
    -p or other -g; an ExecStart that is not parsable is refused), and the
    dump (parsed again from the observation's bytes) passing parse_shared and
    check_policy. Returns the shared ranges; any other value or violation is
    nginx_policy_unsupported.

    nginx_policy_verified is a verdict on the default configuration on disk
    (/etc/nginx/nginx.conf and what it includes, as nginx -T read it at
    collection). It does not prove that the running master uses that
    configuration: changes not yet reloaded, or a master whose configuration
    differs from the files (for example one started by hand), are not
    detected."""
    ranges = None
    try:
        ranges = _admitted(observation)
    except Exception:
        ranges = None
    if ranges is None:
        _fail('nginx_policy_unsupported')
    return ranges
