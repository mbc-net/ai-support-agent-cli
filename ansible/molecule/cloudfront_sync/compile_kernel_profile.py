#!/usr/bin/python3
"""Reproduce the fixed public golden grammar; never run on a target host.

Only reviewed source/fixture hashes are accepted. Runtime helpers do not invoke
this tool or read its test fixtures. Output must be new and explicitly named.
"""
import argparse
import collections
import hashlib
import json
from pathlib import Path
import sys
import types

SOURCE_SHA256 = {
    'ufw_kernel': '4efaf71f7372621c3a6631d904b86dab308d8a4db78c191073fffe80c0ac8f60',
    'ufw_kernel_mapping': '376bd9bc0783df2484d2fb1e18dd646daa106f301aaeaf457b0a6cddf0b179a9',
    'ufw_integrity': '81e455a22b53e849840b163caebf9a147ff2e7828aeb47a61d0aa489bd85171c',
}
MANIFEST_SHA256 = {'22.04': '3df2d87d3084e24710d2645b4051c1fa7ff4e22260cccea19c07f40d1bff776e', '24.04': 'a3e146838471ea434661fda622530f1631e8b5f2c58b99b3a78f6e89b11e0954', '26.04': '731f3a47d36bc0af355f16a9edefc5b7438fbfb44020f6e7052831131bebcea8'}
STOCK_SHA256 = {'22.04': {'after.rules': 'c1be61c17e850ea16dc5a02be22e0ec79b631904c2383353da360bce2dfc6b64', 'after6.rules': 'ee5f2e14d2ae6c33ffac9614dfc6035f33a1faae94542751738f26b2859e3e13', 'before.rules': 'd63bc8bb2df0d20909267b7b40cb5cc187baba6e0baf95bbf71ac14f92df8e6c', 'before6.rules': 'e31099b46c2ae40afa92e90dbe5d575c438327e1a4374355872f5eb37db3307b'}, '24.04': {'after.rules': 'c1be61c17e850ea16dc5a02be22e0ec79b631904c2383353da360bce2dfc6b64', 'after6.rules': 'ee5f2e14d2ae6c33ffac9614dfc6035f33a1faae94542751738f26b2859e3e13', 'before.rules': 'd63bc8bb2df0d20909267b7b40cb5cc187baba6e0baf95bbf71ac14f92df8e6c', 'before6.rules': 'e31099b46c2ae40afa92e90dbe5d575c438327e1a4374355872f5eb37db3307b'}, '26.04': {'after.rules': 'c1be61c17e850ea16dc5a02be22e0ec79b631904c2383353da360bce2dfc6b64', 'after6.rules': 'ee5f2e14d2ae6c33ffac9614dfc6035f33a1faae94542751738f26b2859e3e13', 'before.rules': 'd63bc8bb2df0d20909267b7b40cb5cc187baba6e0baf95bbf71ac14f92df8e6c', 'before6.rules': 'e31099b46c2ae40afa92e90dbe5d575c438327e1a4374355872f5eb37db3307b'}}


def checked(path, expected):
    raw = path.read_bytes()
    if hashlib.sha256(raw).hexdigest() != expected:
        raise ValueError('reviewed source/fixture hash differs: ' + path.name)
    return raw


def load_modules(sources, base):
    missing = object()
    names = tuple(sources)
    previous = {name: sys.modules.get(name, missing) for name in names}
    modules = {}
    try:
        for name, raw in sources.items():
            module = types.ModuleType(name)
            module.__file__ = str(base / (name + '.py'))
            sys.modules[name] = module
            exec(compile(raw, module.__file__, 'exec'), module.__dict__)
            modules[name] = module
        return modules
    finally:
        for name, original in previous.items():
            if original is missing:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = original


def generate(base, fixture, identifier):
    manifest_pin = MANIFEST_SHA256[identifier]
    stock_pins = STOCK_SHA256[identifier]
    sources = {name: checked(base / (name + '.py'), expected) for name, expected in SOURCE_SHA256.items()}
    manifest_raw = checked(fixture / 'manifest.json', manifest_pin)
    manifest = json.loads(manifest_raw)
    cached = {}
    for state in manifest['states']:
        for row in [*state['files'].values(), *state['kernel_views'].values()]:
            cached[row['file']] = checked(fixture / row['file'], row['sha256'])
    if set(p.name for p in (fixture / 'stock').iterdir()) != set(stock_pins):
        raise ValueError('stock raw inventory differs')
    for leaf, expected in stock_pins.items():
        checked(fixture / 'stock' / leaf, expected)
    modules = load_modules(sources, base)
    kernel, mapping, adapter = (modules[name] for name in ('ufw_kernel', 'ufw_kernel_mapping', 'ufw_integrity'))
    selected = tuple(kernel.KernelSave.parse(cached['before.' + tool]) for tool in ('iptables-save', 'ip6tables-save'))
    native = kernel.NativeRuleset.parse(cached['before.native.json'], profile=mapping.BACKEND_PROFILES[identifier]['native'])
    legacy = tuple(cached['before.' + tool] for tool in ('iptables-legacy-save', 'ip6tables-legacy-save'))
    structure = mapping.validate_structure(mapping.validate_envelope(selected=selected, native=native, legacy=legacy,
                                                                    versions=manifest['kernel_tool_versions']))
    profile = {'version': 1, 'os': identifier, 'source_manifest_sha256': manifest_pin,
               'stock_raw_sha256': dict(stock_pins), 'families': {}}
    for family, view in zip(('ip', 'ip6'), selected):
        number = 4 if family == 'ip' else 6
        leaf = 'user.rules' if number == 4 else 'user6.rules'
        document = adapter.UserRulesDocument.parse(cached['before.' + leaf], adapter.UserFileProfile(number))
        bychain, canonical = collections.defaultdict(list), collections.defaultdict(list)
        for block in document.blocks:
            for line in block.render(document.profile).splitlines():
                if line.startswith(b'-A '):
                    bychain[line.split()[1].decode()].append(line.decode())
        table = view.tables[0]
        for line in table.rules:
            canonical[line.split()[1].decode()].append(line.decode())
        rawmap, body_rules = {}, []
        for chain, rows in bychain.items():
            if len(rows) != len(canonical[chain]):
                raise ValueError('raw/kernel golden rule count differs')
            for rawline, kernelline in zip(rows, canonical[chain]):
                if rawline in rawmap and rawmap[rawline] != kernelline:
                    raise ValueError('ambiguous raw/kernel golden rule')
                rawmap[rawline] = kernelline
                body_rules.append(kernelline)
        base_rules = [line.decode() for line in table.rules]
        for line in body_rules:
            base_rules.remove(line)
        expected = {}
        for pair in structure.pairs:
            if pair.family != family:
                continue
            row = json.loads(pair.native)
            for key in ('family', 'table', 'chain'):
                row.pop(key)
            key = pair.compatibility.decode()
            if key in expected and expected[key] != row:
                raise ValueError('ambiguous compatibility/native golden rule')
            expected[key] = row
        profile['families'][family] = {'chains': table.chains, 'base_rules': base_rules,
                                      'raw_rule_map': rawmap, 'native_rule_map': expected}
    for name, raw in sources.items():
        if (base / (name + '.py')).read_bytes() != raw:
            raise ValueError('source changed during generation')
    return (json.dumps(profile, sort_keys=True, indent=2) + '\n').encode()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--fixtures', type=Path)
    parser.add_argument('--os', choices=tuple(MANIFEST_SHA256), default='26.04')
    args = parser.parse_args()
    if args.output.exists() or args.output.is_symlink():
        raise ValueError('refuse to overwrite existing output')
    root = Path(__file__).resolve().parents[3]
    base = root / 'ansible/roles/cloudfront_sync/files'
    fixture = args.fixtures or base / 'tests/fixtures/kernel' / args.os
    encoded = generate(base, fixture, args.os)
    with args.output.open('xb') as handle:
        handle.write(encoded)
    print(json.dumps({'sha256': hashlib.sha256(encoded).hexdigest(), 'bytes': len(encoded)}))


if __name__ == '__main__':
    main()
