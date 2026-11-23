"""Pure generation/stamp/manifest data checks for one fixed bundled asset set.

No files, imports of bundled code, service calls or policy operations occur.
Production entry/bootstrap wiring is a separate integration boundary. Recovery
labels classify supplied metadata only; they never authorize mutable recovery.
"""
import ast
from dataclasses import dataclass
import hashlib
import json
import re
from types import MappingProxyType


ENTRY_NAMES = ('cloudfront-sync.py', 'cloudfront-integrity-guard.py', 'install_cloudfront_sync.py')
HELPER_NAMES = ('ufw_integrity', 'ufw_kernel', 'ufw_kernel_mapping', 'ufw_docker_kernel', 'ufw_docker_transition', 'ufw_observation', 'nginx_observation', 'cloudfront_snapshot')
BOOTSTRAP_NAMES = ('bundle_manifest.py', 'bundled_source.py')
PROFILE_NAMES = ('ufw_kernel_profile_22.json', 'ufw_kernel_profile_24.json', 'ufw_kernel_profile_26.json')
ASSET_NAMES = tuple(sorted((*ENTRY_NAMES, *BOOTSTRAP_NAMES, *(name + '.py' for name in HELPER_NAMES), *PROFILE_NAMES)))
STAMP = 'BUNDLE_GENERATION_ID'
ZERO = '0' * 64
MAX_ASSET_BYTES = 2 * 1024 * 1024
MAX_BUNDLE_BYTES = 8 * 1024 * 1024
MAX_MANIFEST_BYTES = 64 * 1024


class ManifestError(ValueError):
    """Only fixed, non-sensitive codes leave pure validation."""


def _fail(code):
    raise ManifestError(code)


def _sha(raw):
    return hashlib.sha256(raw).hexdigest()


def _hex(value, length=64):
    return type(value) is str and re.fullmatch('[0-9a-f]{' + str(length) + '}', value) is not None


def _canonical(value):
    try:
        return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False,
                          allow_nan=False).encode('utf-8')
    except (ValueError, TypeError, UnicodeError, RecursionError):
        _fail('invalid_canonical_bundle_data')


def _json(raw, limit):
    if type(raw) is not bytes or not raw or len(raw) > limit:
        _fail('bundle_json_budget_exceeded')

    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                _fail('duplicate_bundle_json_key')
            result[key] = value
        return result

    def noninteger(unused):
        _fail('noninteger_bundle_json_number')

    def integer(text):
        if len(text) > 20:
            _fail('bundle_integer_budget_exceeded')
        return int(text)

    try:
        value = json.loads(raw.decode('utf-8'), object_pairs_hook=pairs, parse_float=noninteger,
                           parse_constant=noninteger, parse_int=integer)
    except (ValueError, TypeError, UnicodeError, RecursionError):
        _fail('invalid_bundle_json')
    pending, count = [(value, 0)], 0
    while pending:
        item, depth = pending.pop()
        count += 1
        if depth > 64 or count > 100000:
            _fail('bundle_json_structure_budget_exceeded')
        if isinstance(item, dict): pending.extend((part, depth + 1) for part in item.values())
        elif isinstance(item, list): pending.extend((part, depth + 1) for part in item)
    return value


def _mode(name):
    return 0o755 if name in ENTRY_NAMES else 0o644


def _kind(name):
    return 'entry' if name in ENTRY_NAMES else 'json' if name in PROFILE_NAMES else 'source'


def _entry(raw, generation=ZERO):
    try:
        text = raw.decode('utf-8')
        tree = ast.parse(text)
    except (ValueError, UnicodeError, SyntaxError, RecursionError):
        _fail('invalid_entry_source')
    body = list(tree.body)
    if body and isinstance(body[0], ast.Expr) and isinstance(body[0].value, ast.Constant) and type(body[0].value.value) is str:
        body.pop(0)
    while body and isinstance(body[0], ast.ImportFrom) and body[0].module == '__future__':
        body.pop(0)
    if not body or not isinstance(body[0], ast.Assign):
        _fail('missing_entry_stamp')
    node = body[0]
    if (len(node.targets) != 1 or not isinstance(node.targets[0], ast.Name)
            or node.targets[0].id != STAMP or not isinstance(node.value, ast.Constant)
            or not _hex(node.value.value) or node.col_offset != 0 or node.lineno != node.end_lineno):
        _fail('invalid_entry_stamp')
    stores = [part for part in ast.walk(tree) if isinstance(part, ast.Name) and part.id == STAMP and isinstance(part.ctx, (ast.Store, ast.Del))]
    if stores != [node.targets[0]]:
        _fail('duplicate_entry_stamp_binding')
    for part in ast.walk(tree):
        if ((isinstance(part, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.arg))
             and getattr(part, 'name', getattr(part, 'arg', None)) == STAMP)
                or (isinstance(part, ast.alias) and (part.asname or part.name.split('.')[0]) == STAMP)
                or (isinstance(part, ast.ExceptHandler) and part.name == STAMP)
                or (isinstance(part, (ast.MatchAs, ast.MatchStar)) and part.name == STAMP)
                or (isinstance(part, ast.MatchMapping) and part.rest == STAMP)):
            _fail('duplicate_entry_stamp_binding')
    lines = text.splitlines(keepends=True)
    expected = STAMP + ' = "' + node.value.value + '"\n'
    if lines[node.lineno - 1] != expected:
        _fail('noncanonical_entry_stamp_line')
    lines[node.lineno - 1] = STAMP + ' = "' + generation + '"\n'
    return ''.join(lines).encode('utf-8'), node.value.value


def _capture_assets(assets):
    if type(assets) not in (dict, MappingProxyType):
        _fail('wrong_fixed_bundle_asset_set')
    assets = dict(assets)
    if any(type(name) is not str for name in assets) or set(assets) != set(ASSET_NAMES):
        _fail('wrong_fixed_bundle_asset_set')
    if any(type(raw) is not bytes or not 0 < len(raw) <= MAX_ASSET_BYTES for raw in assets.values()):
        _fail('invalid_bundle_asset_or_size')
    if sum(len(raw) for raw in assets.values()) > MAX_BUNDLE_BYTES:
        _fail('bundle_aggregate_size_exceeded')
    return assets


def _source_inputs(assets):
    assets = _capture_assets(assets)
    result = {}
    for name in ASSET_NAMES:
        raw = assets[name]
        if name.endswith('.py'):
            try: compile(raw.decode('utf-8'), name, 'exec', dont_inherit=True)
            except (ValueError, UnicodeError, SyntaxError, RecursionError): _fail('invalid_bundle_python_source')
        else:
            _json(raw, MAX_ASSET_BYTES)
        normalized = _entry(raw)[0] if name in ENTRY_NAMES else raw
        result[name] = {'kind': _kind(name), 'mode': _mode(name), 'size': len(raw),
                        'source_sha256': _sha(normalized)}
    return {'version': 1, 'assets': result}


def _manifest(raw, running_generation):
    if not _hex(running_generation): _fail('invalid_running_generation')
    value = _json(raw, MAX_MANIFEST_BYTES)
    if (type(value) is not dict or set(value) != {'version', 'generation_id', 'inputs', 'assets'}
            or type(value['version']) is not int or value['version'] != 1
            or not _hex(value['generation_id']) or value['generation_id'] != running_generation
            or _canonical(value) + b'\n' != raw):
        _fail('invalid_or_wrong_generation_manifest')
    inputs = value['inputs']
    if (type(inputs) is not dict or set(inputs) != {'version', 'assets'}
            or type(inputs['version']) is not int or inputs['version'] != 1
            or type(inputs['assets']) is not dict or set(inputs['assets']) != set(ASSET_NAMES)
            or type(value['assets']) is not dict or set(value['assets']) != set(ASSET_NAMES)):
        _fail('invalid_manifest_input_schema')
    total = 0
    for name in ASSET_NAMES:
        row, actual = inputs['assets'][name], value['assets'][name]
        if (type(row) is not dict or set(row) != {'kind', 'mode', 'size', 'source_sha256'}
                or row['kind'] != _kind(name) or type(row['mode']) is not int or row['mode'] != _mode(name)
                or type(row['size']) is not int or not 0 < row['size'] <= MAX_ASSET_BYTES
                or not _hex(row['source_sha256']) or type(actual) is not dict
                or set(actual) != {'mode', 'size', 'sha256'} or type(actual['mode']) is not int
                or actual['mode'] != row['mode'] or type(actual['size']) is not int
                or actual['size'] != row['size'] or not _hex(actual['sha256'])):
            _fail('invalid_manifest_asset_row')
        if name not in ENTRY_NAMES and actual['sha256'] != row['source_sha256']:
            _fail('bootstrap_or_data_hash_not_inputs_bound')
        total += row['size']
    if total > MAX_BUNDLE_BYTES: _fail('bundle_aggregate_size_exceeded')
    if _sha(_canonical(inputs)) != running_generation:
        _fail('manifest_inputs_digest_differs')
    return value


@dataclass(frozen=True)
class BuiltBundle:
    generation: str
    assets: object
    manifest: bytes


@dataclass(frozen=True)
class VerifiedBundle:
    generation: str
    assets: tuple
    manifest: bytes


def build_bundle(code_sources):
    code_sources = _capture_assets(code_sources)
    inputs = _source_inputs(code_sources)
    generation = _sha(_canonical(inputs))
    assets = {name: _entry(raw, generation)[0] if name in ENTRY_NAMES else raw
              for name, raw in code_sources.items()}
    manifest = {'version': 1, 'generation_id': generation, 'inputs': inputs,
                'assets': {name: {'mode': _mode(name), 'size': len(assets[name]), 'sha256': _sha(assets[name])}
                           for name in ASSET_NAMES}}
    raw = _canonical(manifest) + b'\n'
    _manifest(raw, generation)
    return BuiltBundle(generation, MappingProxyType(assets), raw)


def validate_bundle(manifest_bytes, code_sources, *, running_generation):
    code_sources = _capture_assets(code_sources)
    value = _manifest(manifest_bytes, running_generation)
    if _source_inputs(code_sources) != value['inputs']:
        _fail('bundle_source_inputs_differ')
    for name in ASSET_NAMES:
        if _sha(code_sources[name]) != value['assets'][name]['sha256']:
            _fail('bundle_asset_bytes_differ')
        if name in ENTRY_NAMES and _entry(code_sources[name])[1] != running_generation:
            _fail('entry_literal_generation_differs')
    return VerifiedBundle(running_generation, tuple((name, code_sources[name]) for name in ASSET_NAMES), manifest_bytes)


def bootstrap_expectations(manifest_bytes, *, running_generation):
    """Return only inputs-digest-bound hashes, before executing bootstrap bytes.

    A future entry's stdlib-only stub must do these initial data checks before
    loading this module. Calling an unverified copy of this function is not a
    self-authentication mechanism.
    """
    value = _manifest(manifest_bytes, running_generation)
    return MappingProxyType({name: value['inputs']['assets'][name]['source_sha256'] for name in BOOTSTRAP_NAMES})


def helper_expectations(verified):
    if not isinstance(verified, VerifiedBundle) or type(verified.assets) is not tuple or len(verified.assets) != len(ASSET_NAMES):
        _fail('missing_verified_bundle')
    try:
        assets = dict(verified.assets)
    except (TypeError, ValueError):
        _fail('invalid_verified_bundle_assets')
    # A dataclass is not authority: revalidate immutable captured bytes.
    validate_bundle(verified.manifest, assets, running_generation=verified.generation)
    return MappingProxyType({name: _sha(assets[name + '.py']) for name in HELPER_NAMES})


def classify_recovery(*, journal_kind, candidate_phase, candidate_generation, before, observed, old_cohort_verified):
    """Classify supplied observations only; no result authorizes a mutation."""
    fields = {'generation_id', 'state_sha256', 'protected_sha256', 'enrollment_id', 'intent_sha256', 'state_version'}
    if (journal_kind not in ('none', 'legacy23_pending', 'true_kernel_v2_pending', 'unknown')
            or candidate_phase not in ('not_applying', 'proven_uncommitted', 'applying', 'committed')
            or not _hex(candidate_generation) or type(old_cohort_verified) is not bool):
        _fail('invalid_recovery_classification')
    for record in (before, observed):
        if (type(record) is not dict or set(record) != fields
                or type(record['state_version']) is not int or record['state_version'] not in (1, 2)
                or not _hex(record['enrollment_id'], 32)
                or any(not _hex(record[key]) for key in fields - {'state_version', 'enrollment_id'})):
            _fail('invalid_recovery_observation')
    if journal_kind == 'legacy23_pending': return 'manual_legacy_pending'
    if journal_kind == 'true_kernel_v2_pending': return 'requires_independent_recovery_proof'
    if journal_kind == 'unknown': return 'manual_divergence'
    if candidate_phase in ('applying', 'committed'): return 'preserve_candidate'
    if (not old_cohort_verified or observed['generation_id'] not in (before['generation_id'], candidate_generation)
            or any(before[key] != observed[key] for key in fields - {'generation_id'})):
        return 'manual_divergence'
    return 'rollback_candidate_only'
