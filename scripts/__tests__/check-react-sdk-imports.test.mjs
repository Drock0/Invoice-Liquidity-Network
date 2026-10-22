import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  checkReactSdkImports,
  collectModuleExports,
  findImports,
  packageNameOf,
  stripComments,
} from '../check-react-sdk-imports.mjs';

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), '../check-react-sdk-imports.mjs');
const REPO_ROOT = resolve(dirname(SCRIPT), '..');

function write(root, rel, content) {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
}

/** Minimal healthy layout: an SDK entry with a re-export chain, and @iln/react. */
function scaffold(root) {
  write(
    root,
    'sdk/src/index.ts',
    "export * from './types';\nexport const SDK_VERSION = '0.1.0';\n"
  );
  write(
    root,
    'sdk/src/types.ts',
    "export interface Invoice { id: bigint }\nexport type { DisputeRecord } from '@iln/shared';\n"
  );
  write(root, 'packages/react/package.json', {
    name: '@iln/react',
    peerDependencies: { '@iln/sdk': '^0.1.0', react: '^19.0.0' },
    devDependencies: { '@iln/sdk': 'workspace:*', react: '^19.0.0', recharts: '^2.15.3' },
  });
  write(
    root,
    'packages/react/src/index.ts',
    "import { useMemo } from 'react';\nimport type { Invoice, DisputeRecord } from '@iln/sdk';\nexport { useMemo };\n"
  );
}

function rules(root) {
  return checkReactSdkImports(root).findings.map((f) => f.rule);
}

function run(root, ...args) {
  return spawnSync(process.execPath, [SCRIPT, `--root=${root}`, ...args], { encoding: 'utf8' });
}

let root;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'react-sdk-imports-'));
  scaffold(root);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('success', () => {
  it('passes when every ILN import goes through the @iln/sdk root', () => {
    const report = checkReactSdkImports(root);
    assert.deepEqual(report.findings, []);
    assert.equal(report.summary.sdkImports, 1);
  });

  it('exits 0 from the CLI and writes a JSON report', () => {
    const out = join(root, 'report.json');
    const res = run(root, `--json=${out}`);
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.match(res.stdout, /\[react-sdk-imports\] OK/);
    assert.equal(JSON.parse(readFileSync(out, 'utf8')).summary.ok, true);
  });

  it('the repository itself is clean (regression guard for #1221)', () => {
    const report = checkReactSdkImports(REPO_ROOT);
    assert.deepEqual(
      report.findings.map((f) => `${f.rule} ${f.file}:${f.line ?? ''}`),
      []
    );
    assert.ok(report.summary.sdkImports > 0, 'expected @iln/react to import @iln/sdk');
  });
});

describe('failure', () => {
  it('flags the unpublished @iln/shared workspace package', () => {
    write(root, 'packages/react/src/a.ts', "import type { DisputeRecord } from '@iln/shared';\n");
    const [f] = checkReactSdkImports(root).findings;
    assert.equal(f.rule, 'non-canonical-sdk');
    assert.equal(f.file, 'packages/react/src/a.ts');
    assert.equal(f.line, 1);
  });

  it('flags sdk-next, retired names, and deep or deprecated SDK subpaths', () => {
    write(
      root,
      'packages/react/src/a.ts',
      [
        "import { X } from '@iln/sdk-next';",
        "import { Y } from '@invoice-liquidity/sdk';", // sdk-name-check: allow-legacy
        "import { Z } from '@iln/sdk/legacy';",
        "import { W } from '@iln/sdk/dist/index.mjs';",
      ].join('\n')
    );
    assert.deepEqual(rules(root), Array(4).fill('non-canonical-sdk'));
  });

  it('flags a relative import that reaches into the SDK sources', () => {
    write(
      root,
      'packages/react/src/a.ts',
      "import type { Invoice } from '../../../sdk/src/types';\n"
    );
    assert.deepEqual(rules(root), ['escapes-package']);
  });

  it('flags a name the SDK does not export', () => {
    write(root, 'packages/react/src/a.ts', "import { ILNClientt } from '@iln/sdk';\n");
    const [f] = checkReactSdkImports(root).findings;
    assert.equal(f.rule, 'missing-sdk-export');
    assert.match(f.message, /"ILNClientt"/);
  });

  it('flags a default import from the SDK (it has no default export)', () => {
    write(root, 'packages/react/src/a.ts', "import sdk from '@iln/sdk';\n");
    assert.deepEqual(rules(root), ['missing-sdk-export']);
  });

  it('flags a package declared nowhere in the manifest', () => {
    write(root, 'packages/react/src/a.ts', "import { format } from 'date-fns';\n");
    const [f] = checkReactSdkImports(root).findings;
    assert.equal(f.rule, 'undeclared-package');
    assert.match(f.message, /date-fns/);
  });

  it('exits 1 from the CLI with annotations and still writes the report', () => {
    write(root, 'packages/react/src/a.ts', "import type { DisputeRecord } from '@iln/shared';\n");
    const out = join(root, 'report.json');
    const res = run(root, `--json=${out}`);
    assert.equal(res.status, 1);
    assert.match(
      res.stdout,
      /::error file=packages\/react\/src\/a\.ts,line=1::\[non-canonical-sdk\]/
    );
    assert.equal(JSON.parse(readFileSync(out, 'utf8')).summary.byRule['non-canonical-sdk'], 1);
  });
});

describe('unavailable dependency (fails closed)', () => {
  it('reports a missing SDK entry instead of passing every import', () => {
    rmSync(join(root, 'sdk'), { recursive: true });
    assert.deepEqual(rules(root).sort(), ['missing-sdk-export', 'missing-sdk-export', 'sdk-entry']);
  });

  it('reports an `export *` from a bare package it cannot enumerate', () => {
    write(root, 'sdk/src/index.ts', "export * from '@iln/shared';\n");
    const findings = checkReactSdkImports(root).findings;
    assert.ok(findings.some((f) => f.rule === 'sdk-entry' && /@iln\/shared/.test(f.message)));
  });

  it('reports an unreadable React manifest', () => {
    write(root, 'packages/react/package.json', '{ not json');
    assert.ok(rules(root).includes('undeclared-package'));
  });
});

describe('replay / restart', () => {
  it('produces an identical report (minus timestamps) on repeated runs', () => {
    write(root, 'packages/react/src/a.ts', "import type { DisputeRecord } from '@iln/shared';\n");
    assert.deepEqual(checkReactSdkImports(root), checkReactSdkImports(root));
  });

  it('goes green after remediation, then red again on regression', () => {
    write(root, 'packages/react/src/a.ts', "import type { DisputeRecord } from '@iln/shared';\n");
    assert.equal(checkReactSdkImports(root).summary.ok, false);
    write(root, 'packages/react/src/a.ts', "import type { DisputeRecord } from '@iln/sdk';\n");
    assert.equal(checkReactSdkImports(root).summary.ok, true);
    write(root, 'sdk/src/types.ts', 'export interface Invoice { id: bigint }\n');
    assert.deepEqual(rules(root), ['missing-sdk-export', 'missing-sdk-export']);
  });
});

describe('boundary conditions', () => {
  it('parses every import form, multi-line clauses and inline type modifiers', () => {
    const text = [
      'import React, { useMemo } from "react";',
      'import type {',
      '  Invoice,',
      '  LPPortfolio as Portfolio,',
      "} from '@iln/sdk';",
      "import { type ILNClient, ILNSdk } from '@iln/sdk';",
      "import * as sdk from '@iln/sdk';",
      "import './styles.css';",
      "export { ILN_TESTNET as TESTNET } from '@iln/sdk';",
      "const lazy = await import('@iln/sdk');",
    ].join('\n');
    assert.deepEqual(
      findImports(text).map((i) => [i.line, i.specifier, i.names]),
      [
        [1, 'react', ['default', 'useMemo']],
        [2, '@iln/sdk', ['Invoice', 'LPPortfolio']],
        [6, '@iln/sdk', ['ILNClient', 'ILNSdk']],
        [7, '@iln/sdk', []],
        [8, './styles.css', []],
        [9, '@iln/sdk', ['ILN_TESTNET']],
        [10, '@iln/sdk', []],
      ]
    );
  });

  it('ignores imports inside comments but keeps line numbers', () => {
    const text =
      "// import x from '@iln/shared';\n/* import y from '@iln/shared'; */\nimport { z } from '@iln/sdk';\n";
    assert.deepEqual(
      findImports(text).map((i) => [i.line, i.specifier]),
      [[3, '@iln/sdk']]
    );
    assert.equal(
      stripComments("const u = 'https://x.dev'; // c").trim(),
      "const u = 'https://x.dev';"
    );
  });

  it('resolves every export form through relative export-star chains', () => {
    write(root, 'sdk/src/index.ts', "export * from './a';\nexport * as ns from './b';\n");
    write(
      root,
      'sdk/src/a/index.ts',
      [
        "export * from './c';",
        'export const A = 1;',
        'export function fnA() {}',
        'export class ClsA {}',
        'export interface IfA {}',
        'export type TA = 1;',
        'export enum EnA { X }',
        'export const enum CEnA { X }',
        'export declare const DA: number;',
        "export { local as Renamed, type Other } from './c';",
        'export default A;',
        '// export const Commented = 1;',
      ].join('\n')
    );
    write(root, 'sdk/src/a/c.ts', 'export async function fnC() {}\nexport const index = 1;\n');
    const { names, unresolved } = collectModuleExports(join(root, 'sdk/src/index.ts'));
    assert.deepEqual(unresolved, []);
    assert.deepEqual(
      [...names].sort(),
      [
        'A',
        'CEnA',
        'ClsA',
        'DA',
        'EnA',
        'IfA',
        'Other',
        'Renamed',
        'TA',
        'default',
        'fnA',
        'fnC',
        'index',
        'ns',
      ].sort()
    );
  });

  it('survives an export-star cycle', () => {
    write(root, 'sdk/src/index.ts', "export * from './a';\nexport const ROOT = 1;\n");
    write(root, 'sdk/src/a.ts', "export * from './index';\nexport const A = 1;\n");
    assert.deepEqual([...collectModuleExports(join(root, 'sdk/src/index.ts')).names].sort(), [
      'A',
      'ROOT',
    ]);
  });

  it('derives package names from scoped, unscoped and subpath specifiers', () => {
    assert.equal(packageNameOf('@iln/sdk'), '@iln/sdk');
    assert.equal(packageNameOf('@iln/sdk/legacy'), '@iln/sdk');
    assert.equal(packageNameOf('react/jsx-runtime'), 'react');
  });

  it('allows node builtins and devDependencies that rollup bundles', () => {
    write(
      root,
      'packages/react/src/a.ts',
      "import { join } from 'node:path';\nimport { EventEmitter } from 'events';\nimport { LineChart } from 'recharts';\n"
    );
    assert.deepEqual(rules(root), []);
  });
});
