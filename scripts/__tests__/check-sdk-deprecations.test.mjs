import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  checkSdkDeprecations,
  findEmittedCodes,
  guideSection,
  parseRegistry,
} from '../check-sdk-deprecations.mjs';

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), '../check-sdk-deprecations.mjs');
const REPO_ROOT = resolve(dirname(SCRIPT), '..');

const ENTRY = {
  code: 'ILN_SDK_DEP001',
  surface: '@iln/sdk/legacy',
  replacement: "import from '@iln/sdk'",
  removedIn: '1.0.0',
};

function write(root, rel, content) {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
}

function registry(entries) {
  const body = entries
    .map(
      (e) =>
        `  {\n${Object.entries(e)
          .map(([k, v]) => `    ${k}: ${JSON.stringify(v)},`)
          .join('\n')}\n  },`
    )
    .join('\n');
  return `export const DEPRECATED_SURFACES: readonly DeprecatedSurface[] = Object.freeze([\n${body}\n]);\n`;
}

function manifest(overrides = {}) {
  return {
    name: '@iln/sdk',
    version: '0.1.0',
    exports: {
      '.': { types: './dist/index.d.ts', import: './dist/index.mjs', require: './dist/index.cjs' },
      './legacy': {
        types: './dist/legacy-imports.d.ts',
        import: './dist/legacy-imports.mjs',
        require: './dist/legacy-imports.cjs',
      },
    },
    sideEffects: ['./dist/legacy-imports.mjs', './dist/legacy-imports.cjs'],
    ...overrides,
  };
}

const GUIDE = [
  '# SDK Migration Guide',
  '',
  '## Deprecated SDK surface',
  '',
  '| Code | Deprecated surface | Use instead | Removed in |',
  '|---|---|---|---|',
  '| `ILN_SDK_DEP001` | `@iln/sdk/legacy` | `@iln/sdk` | `1.0.0` |',
  '',
  '## Overview of Breaking Changes',
  '',
].join('\n');

function scaffold(root) {
  write(root, 'sdk/package.json', manifest());
  write(root, 'sdk/src/deprecations.ts', registry([ENTRY]));
  write(
    root,
    'sdk/src/legacy-imports.ts',
    "import { emitDeprecationWarning } from './deprecations';\nemitDeprecationWarning('ILN_SDK_DEP001');\nexport * from './index';\n"
  );
  write(root, 'sdk/src/index.ts', "export const SDK_VERSION = '0.1.0';\n");
  write(root, 'docs/sdk-migration-guide.md', GUIDE);
}

function rules(root) {
  return checkSdkDeprecations(root).findings.map((f) => f.rule);
}

function run(root, ...args) {
  return spawnSync(process.execPath, [SCRIPT, `--root=${root}`, ...args], { encoding: 'utf8' });
}

let root;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sdk-deprecations-'));
  scaffold(root);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('success', () => {
  it('passes a wired, documented, side-effect-declared deprecation', () => {
    const report = checkSdkDeprecations(root);
    assert.deepEqual(report.findings, []);
    assert.deepEqual(report.summary.deprecations, [
      {
        code: 'ILN_SDK_DEP001',
        surface: '@iln/sdk/legacy',
        removedIn: '1.0.0',
        emittedBy: ['sdk/src/legacy-imports.ts'],
      },
    ]);
  });

  it('exits 0 from the CLI and writes a JSON report', () => {
    const out = join(root, 'report.json');
    const res = run(root, `--json=${out}`);
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.match(res.stdout, /\[sdk-deprecations\] OK — 1 deprecated surface/);
    assert.equal(JSON.parse(readFileSync(out, 'utf8')).summary.ok, true);
  });

  it('the repository itself is clean (regression guard for #1222)', () => {
    const report = checkSdkDeprecations(REPO_ROOT);
    assert.deepEqual(
      report.findings.map((f) => `${f.rule} ${f.file}: ${f.message}`),
      []
    );
    assert.ok(report.summary.deprecations.some((d) => d.surface === '@iln/sdk/legacy'));
  });
});

describe('failure', () => {
  it('flags a deprecated entry point that no longer warns', () => {
    write(root, 'sdk/src/legacy-imports.ts', "export * from './index';\n");
    const [f] = checkSdkDeprecations(root).findings;
    assert.equal(f.rule, 'unwired');
    assert.equal(f.file, 'sdk/src/legacy-imports.ts');
  });

  it('flags a warning emitted only from some other module', () => {
    write(root, 'sdk/src/legacy-imports.ts', "export * from './index';\n");
    write(root, 'sdk/src/other.ts', "emitDeprecationWarning('ILN_SDK_DEP001');\n");
    assert.deepEqual(rules(root), ['unwired']);
  });

  it('flags an emitted code that is not registered', () => {
    write(root, 'sdk/src/client.ts', "emitDeprecationWarning('ILN_SDK_DEP404');\n");
    const [f] = checkSdkDeprecations(root).findings;
    assert.equal(f.rule, 'unknown-code');
    assert.equal(f.file, 'sdk/src/client.ts');
  });

  it('flags sideEffects: false (bundlers may drop the import-time warning)', () => {
    write(root, 'sdk/package.json', manifest({ sideEffects: false }));
    assert.deepEqual(rules(root), ['side-effects']);
  });

  it('flags a sideEffects list missing one of the deprecated dist files', () => {
    write(root, 'sdk/package.json', manifest({ sideEffects: ['./dist/legacy-imports.mjs'] }));
    const [f] = checkSdkDeprecations(root).findings;
    assert.equal(f.rule, 'side-effects');
    assert.match(f.message, /legacy-imports\.cjs/);
  });

  it('flags a missing or incomplete migration-guide section', () => {
    write(root, 'docs/sdk-migration-guide.md', '# SDK Migration Guide\n');
    assert.deepEqual(rules(root), ['undocumented']);
    write(root, 'docs/sdk-migration-guide.md', GUIDE.replace('`1.0.0`', '`2.0.0`'));
    const [f] = checkSdkDeprecations(root).findings;
    assert.equal(f.rule, 'undocumented');
    assert.match(f.message, /"1\.0\.0"/);
  });

  it('flags malformed and duplicate registry entries', () => {
    write(
      root,
      'sdk/src/deprecations.ts',
      registry([ENTRY, ENTRY, { ...ENTRY, code: 'DEP2' }, { code: 'ILN_SDK_DEP003', surface: 'x' }])
    );
    const messages = checkSdkDeprecations(root)
      .findings.filter((f) => f.rule === 'registry-shape')
      .map((f) => f.message);
    assert.ok(messages.some((m) => /duplicate code "ILN_SDK_DEP001"/.test(m)));
    assert.ok(messages.some((m) => /"DEP2" must match/.test(m)));
    assert.ok(messages.some((m) => /missing replacement, removedIn/.test(m)));
  });

  it('exits 1 from the CLI with annotations and still writes the report', () => {
    write(root, 'sdk/src/legacy-imports.ts', "export * from './index';\n");
    const out = join(root, 'report.json');
    const res = run(root, `--json=${out}`);
    assert.equal(res.status, 1);
    assert.match(res.stdout, /::error file=sdk\/src\/legacy-imports\.ts::\[unwired\]/);
    assert.equal(JSON.parse(readFileSync(out, 'utf8')).summary.byRule.unwired, 1);
  });
});

describe('unavailable dependency (fails closed)', () => {
  it('reports a missing registry', () => {
    rmSync(join(root, 'sdk/src/deprecations.ts'));
    assert.ok(rules(root).includes('registry-shape'));
  });

  it('reports a registry it cannot parse', () => {
    write(root, 'sdk/src/deprecations.ts', 'export const DEPRECATED_SURFACES = buildList();\n');
    const [f] = checkSdkDeprecations(root).findings;
    assert.equal(f.rule, 'registry-shape');
    assert.match(f.message, /Object\.freeze/);
  });

  it('reports a missing SDK manifest and migration guide', () => {
    rmSync(join(root, 'sdk/package.json'));
    rmSync(join(root, 'docs/sdk-migration-guide.md'));
    assert.deepEqual(rules(root).sort(), ['registry-shape', 'undocumented']);
  });
});

describe('replay / restart', () => {
  it('produces an identical report on repeated runs', () => {
    write(root, 'sdk/src/legacy-imports.ts', "export * from './index';\n");
    assert.deepEqual(checkSdkDeprecations(root), checkSdkDeprecations(root));
  });

  it('goes green after remediation, then red again on regression', () => {
    write(root, 'sdk/package.json', manifest({ sideEffects: false }));
    assert.equal(checkSdkDeprecations(root).summary.ok, false);
    write(root, 'sdk/package.json', manifest());
    assert.equal(checkSdkDeprecations(root).summary.ok, true);
    write(root, 'sdk/src/legacy-imports.ts', "export * from './index';\n");
    assert.equal(checkSdkDeprecations(root).summary.ok, false);
  });
});

describe('boundary conditions', () => {
  it('flags an entry still shipped at its removal version, not one version before', () => {
    write(root, 'sdk/package.json', manifest({ version: '0.9.9' }));
    assert.deepEqual(rules(root), []);
    write(root, 'sdk/package.json', manifest({ version: '1.0.0' }));
    assert.deepEqual(rules(root), ['overdue']);
  });

  it('asks for the registry entry to be dropped once the subpath is removed', () => {
    const m = manifest();
    delete m.exports['./legacy'];
    write(root, 'sdk/package.json', m);
    assert.deepEqual(rules(root), ['stale-entry']);
  });

  it('requires a non-subpath (API) deprecation to be emitted somewhere in sdk/src', () => {
    const api = { ...ENTRY, code: 'ILN_SDK_DEP002', surface: 'ILNSdk#getVersion()' };
    write(root, 'sdk/src/deprecations.ts', registry([ENTRY, api]));
    write(
      root,
      'docs/sdk-migration-guide.md',
      GUIDE.replace(
        '\n\n## Overview',
        '\n| `ILN_SDK_DEP002` | `ILNSdk#getVersion()` | x | `1.0.0` |\n\n## Overview'
      )
    );
    assert.deepEqual(rules(root), ['unwired']);
    write(root, 'sdk/src/client.ts', "emitDeprecationWarning('ILN_SDK_DEP002');\n");
    assert.deepEqual(rules(root), []);
  });

  it('ignores warnings emitted only from test files', () => {
    write(root, 'sdk/src/legacy-imports.ts', "export * from './index';\n");
    write(root, 'sdk/src/legacy-imports.test.ts', "emitDeprecationWarning('ILN_SDK_DEP001');\n");
    assert.deepEqual(rules(root), ['unwired']);
  });

  it('parses registry strings with escaped quotes and every quote style', () => {
    const src = `export const DEPRECATED_SURFACES = Object.freeze([
      { code: 'ILN_SDK_DEP001', surface: "@iln/sdk/legacy", replacement: 'import from \\'@iln/sdk\\'', removedIn: \`1.0.0\` },
    ]);`;
    assert.deepEqual(parseRegistry(src), [
      {
        code: 'ILN_SDK_DEP001',
        surface: '@iln/sdk/legacy',
        replacement: "import from '@iln/sdk'",
        removedIn: '1.0.0',
      },
    ]);
    assert.equal(parseRegistry('export const X = 1;'), null);
  });

  it('extracts emitted codes and bounds the guide section at the next heading', () => {
    assert.deepEqual(
      findEmittedCodes('emitDeprecationWarning( \'A\' );\nemitDeprecationWarning("B")'),
      ['A', 'B']
    );
    const section = guideSection(`${GUIDE}\nILN_SDK_DEP009 mentioned later\n`);
    assert.ok(section.includes('ILN_SDK_DEP001'));
    assert.ok(!section.includes('ILN_SDK_DEP009'));
  });
});
