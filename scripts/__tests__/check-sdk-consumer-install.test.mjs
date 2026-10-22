import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  checkConsumerInstall,
  checkInstall,
  checkStatic,
  exportSubpaths,
  findDeclarationImports,
  parseInstallError,
  prepareConsumer,
  probeSource,
  readWorkspace,
  scopedTypeErrors,
} from '../check-sdk-consumer-install.mjs';

const SCRIPT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../check-sdk-consumer-install.mjs'
);
const REPO_ROOT = resolve(dirname(SCRIPT), '..');
const TARGETS = [
  { dir: 'sdk', pkg: '@iln/sdk', install: true },
  { dir: 'packages/react', pkg: '@iln/react', install: false },
];

function write(root, rel, content) {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
}

function sdkManifest(overrides = {}) {
  return {
    name: '@iln/sdk',
    version: '0.1.0',
    exports: {
      '.': { types: './dist/index.d.ts', import: './dist/index.mjs', require: './dist/index.cjs' },
      './legacy': {
        types: './dist/legacy.d.ts',
        import: './dist/legacy.mjs',
        require: './dist/legacy.cjs',
      },
    },
    dependencies: { '@stellar/stellar-sdk': '^15.0.1' },
    devDependencies: { '@iln/shared': 'workspace:*' },
    peerDependencies: { react: '^19.0.0' },
    ...overrides,
  };
}

function scaffold(root) {
  write(root, 'pnpm-workspace.yaml', "packages:\n  - sdk\n  - 'packages/*' # libraries\n");
  write(root, 'sdk/package.json', sdkManifest());
  write(root, 'packages/shared/package.json', { name: '@iln/shared', version: '0.1.0' });
  write(root, 'packages/react/package.json', {
    name: '@iln/react',
    version: '0.1.0',
    peerDependencies: { '@iln/sdk': '^0.1.0', react: '^19.0.0' },
    devDependencies: { '@iln/sdk': 'workspace:*' },
  });
  for (const f of ['index.mjs', 'index.cjs', 'legacy.mjs', 'legacy.cjs'])
    write(root, `sdk/dist/${f}`, '');
  write(
    root,
    'sdk/dist/index.d.ts',
    "import { Keypair } from '@stellar/stellar-sdk';\n/** @example import { ILNSdk } from '@iln/sdk'; */\nexport declare const x: Keypair;\n"
  );
}

/** Scripted stand-in for spawnSync: answers by command, records every call. */
function fakeExec(handlers = {}) {
  const calls = [];
  const exec = (command, args, options) => {
    calls.push({ command, args, cwd: options?.cwd });
    const key =
      command === process.execPath ? (args.includes('--noEmit') ? 'tsc' : 'node') : command;
    const handler = handlers[key];
    const res = typeof handler === 'function' ? handler(args, options) : handler;
    return { status: 0, stdout: '', stderr: '', ...res };
  };
  exec.calls = calls;
  return exec;
}

const PACK_OK = { pnpm: { stdout: 'iln-sdk-0.1.0.tgz\n/tmp/w/tarballs/iln-sdk-0.1.0.tgz\n' } };

let root;
let workDir;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'consumer-install-repo-'));
  workDir = mkdtempSync(join(tmpdir(), 'consumer-install-work-'));
  scaffold(root);
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(workDir, { recursive: true, force: true });
});

describe('success', () => {
  it('passes the static checks when runtime deps are registry packages', () => {
    const { findings, typesScanned } = checkStatic(root, TARGETS);
    assert.deepEqual(findings, []);
    assert.deepEqual(typesScanned, ['sdk/dist/index.d.ts']);
  });

  it('runs every probe against a freshly installed tarball', () => {
    const exec = fakeExec(PACK_OK);
    const { findings, results } = checkInstall(root, { exec, workDir, targets: TARGETS });
    assert.deepEqual(findings, []);
    assert.deepEqual(
      results[0].probes.map((p) => p.probe),
      [
        'install',
        'require @iln/sdk',
        'import @iln/sdk',
        'require @iln/sdk/legacy',
        'import @iln/sdk/legacy',
        'types (nodenext)',
        'types (bundler)',
      ]
    );
    const install = exec.calls.find((c) => c.command === 'npm');
    assert.ok(install.args.includes('--ignore-scripts'));
    const consumer = JSON.parse(readFileSync(join(install.cwd, 'package.json'), 'utf8'));
    assert.equal(consumer.dependencies['@iln/sdk'], 'file:/tmp/w/tarballs/iln-sdk-0.1.0.tgz');
    assert.ok(!exec.calls.some((c) => c.command === 'pnpm' && c.cwd.endsWith('packages/react')));
  });

  it('the repository itself passes the static checks (regression guard for #1223)', () => {
    const report = checkConsumerInstall(REPO_ROOT);
    assert.deepEqual(
      report.findings.map((f) => `${f.rule} ${f.pkg}: ${f.message}`),
      []
    );
  });

  it('exits 0 from the CLI and writes a JSON report', () => {
    const out = join(root, 'report.json');
    const res = spawnSync(process.execPath, [SCRIPT, `--root=${root}`, `--json=${out}`], {
      encoding: 'utf8',
    });
    assert.equal(res.status, 0, res.stdout + res.stderr);
    const report = JSON.parse(readFileSync(out, 'utf8'));
    assert.equal(report.summary.mode, 'static');
  });
});

describe('failure', () => {
  it('flags a runtime dependency on an unpublished workspace package (the #1223 baseline)', () => {
    write(
      root,
      'sdk/package.json',
      sdkManifest({ dependencies: { '@iln/shared': 'workspace:*' } })
    );
    const [f] = checkStatic(root, TARGETS).findings;
    assert.equal(f.rule, 'unpublished-dependency');
    assert.match(f.message, /"@iln\/shared"/);
  });

  it('flags a pinned version of a workspace package as well as workspace:*', () => {
    write(
      root,
      'sdk/package.json',
      sdkManifest({ optionalDependencies: { '@iln/shared': '0.1.0' } })
    );
    assert.deepEqual(
      checkStatic(root, TARGETS).findings.map((f) => f.rule),
      ['unpublished-dependency']
    );
  });

  it('flags file: and link: dependencies', () => {
    write(
      root,
      'sdk/package.json',
      sdkManifest({
        dependencies: { '@stellar/stellar-sdk': '^15.0.1', x: 'file:../x', y: 'link:../y' },
      })
    );
    assert.deepEqual(
      checkStatic(root, TARGETS).findings.map((f) => f.rule),
      ['local-protocol', 'local-protocol']
    );
  });

  it('flags declarations that import an undeclared package', () => {
    write(
      root,
      'sdk/dist/index.d.ts',
      "import { Invoice } from '@iln/shared';\nexport type { Invoice };\n"
    );
    const [f] = checkStatic(root, TARGETS).findings;
    assert.equal(f.rule, 'types-leak');
    assert.equal(f.file, 'sdk/dist/index.d.ts');
  });

  it('reports the unresolvable package when npm install 404s', () => {
    const exec = fakeExec({
      ...PACK_OK,
      npm: {
        status: 1,
        stderr:
          "npm error code E404\nnpm error 404 Not Found - GET https://registry.npmjs.org/@iln%2fshared - Not found\nnpm error 404  '@iln/shared@0.1.0' is not in this registry.\n",
      },
    });
    const { findings, results } = checkInstall(root, { exec, workDir, targets: TARGETS });
    assert.deepEqual(
      findings.map((f) => f.rule),
      ['install-failed']
    );
    assert.match(findings[0].message, /E404: "@iln\/shared@0\.1\.0"/);
    assert.deepEqual(results[0].probes, [{ probe: 'install', ok: false }]);
  });

  it('flags a subpath that fails to load and a root missing required exports', () => {
    const exec = fakeExec({
      ...PACK_OK,
      node: (args) => {
        const code = args[args.length - 1];
        if (code.includes('@iln/sdk/legacy'))
          return { status: 1, stderr: 'Error: Cannot find module' };
        if (code.includes('require(')) return { status: 3, stderr: 'missing ILNSdk' };
        return {};
      },
    });
    const rules = checkInstall(root, { exec, workDir, targets: TARGETS }).findings.map(
      (f) => f.rule
    );
    assert.deepEqual(rules, ['runtime-exports', 'require-resolve', 'import-resolve']);
  });

  it('flags type errors in ILN declarations but not in third-party ones', () => {
    const exec = fakeExec({
      ...PACK_OK,
      tsc: {
        status: 2,
        stdout: [
          "node_modules/@iln/sdk/dist/index.d.ts(2,24): error TS2307: Cannot find module '@iln/shared'.",
          "node_modules/@stellar/stellar-sdk/lib/contract/spec.d.ts(1,34): error TS2307: Cannot find module 'json-schema'.",
        ].join('\n'),
      },
    });
    const findings = checkInstall(root, { exec, workDir, targets: TARGETS }).findings;
    assert.deepEqual(
      findings.map((f) => f.rule),
      ['types-resolve', 'types-resolve']
    );
    assert.ok(findings.every((f) => f.message.includes("'@iln/shared'")));
  });

  it('exits 1 from the CLI on a static finding', () => {
    write(
      root,
      'sdk/package.json',
      sdkManifest({ dependencies: { '@iln/shared': 'workspace:*' } })
    );
    const res = spawnSync(process.execPath, [SCRIPT, `--root=${root}`], { encoding: 'utf8' });
    assert.equal(res.status, 1);
    assert.match(res.stdout, /::error file=sdk\/package\.json::\[unpublished-dependency\]/);
  });
});

describe('unavailable dependency (fails closed)', () => {
  it('reports a missing build instead of packing an empty package', () => {
    rmSync(join(root, 'sdk/dist'), { recursive: true });
    const exec = fakeExec(PACK_OK);
    const { findings } = checkInstall(root, { exec, workDir, targets: TARGETS });
    assert.deepEqual(
      findings.map((f) => f.rule),
      ['not-built']
    );
    assert.equal(exec.calls.length, 0);
  });

  it('reports a failed pack', () => {
    const exec = fakeExec({ pnpm: { status: 1, stderr: 'ERR_PNPM_PACK' } });
    assert.deepEqual(
      checkInstall(root, { exec, workDir, targets: TARGETS }).findings.map((f) => f.rule),
      ['pack-failed']
    );
  });

  it('reports an unreachable registry as install-failed', () => {
    const exec = fakeExec({
      ...PACK_OK,
      npm: { status: 1, stderr: 'npm error code ECONNREFUSED\n' },
    });
    const [f] = checkInstall(root, { exec, workDir, targets: TARGETS }).findings;
    assert.equal(f.rule, 'install-failed');
    assert.match(f.message, /ECONNREFUSED/);
  });

  it('reports tsc that could not run at all', () => {
    const exec = fakeExec({ ...PACK_OK, tsc: { status: 127, stderr: 'spawn ENOENT' } });
    const rules = checkInstall(root, { exec, workDir, targets: TARGETS }).findings.map(
      (f) => f.rule
    );
    assert.deepEqual(rules, ['types-resolve', 'types-resolve']);
  });

  it('refuses a work dir inside the repository (workspace links would mask failures)', () => {
    assert.throws(
      () =>
        checkInstall(root, {
          exec: fakeExec(PACK_OK),
          workDir: join(root, 'tmp'),
          targets: TARGETS,
        }),
      /outside the repository/
    );
  });
});

describe('replay / restart', () => {
  it('recreates the consumer project from scratch on every run', () => {
    const dir = join(workDir, 'consumer');
    prepareConsumer(dir, { '@iln/sdk': 'file:/a.tgz' });
    write(dir, 'node_modules/@iln/shared/stale.js', '');
    prepareConsumer(dir, { '@iln/sdk': 'file:/b.tgz' });
    assert.equal(existsSync(join(dir, 'node_modules')), false);
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    assert.deepEqual(pkg.dependencies, { '@iln/sdk': 'file:/b.tgz' });
    assert.equal(pkg.private, true);
  });

  it('passes after a failed run once the cause is fixed', () => {
    const failing = fakeExec({
      ...PACK_OK,
      npm: { status: 1, stderr: "404  '@iln/shared@0.1.0' is not in this registry." },
    });
    assert.equal(
      checkInstall(root, { exec: failing, workDir, targets: TARGETS }).findings.length,
      1
    );
    assert.deepEqual(
      checkInstall(root, { exec: fakeExec(PACK_OK), workDir, targets: TARGETS }).findings,
      []
    );
  });

  it('produces the same static report on repeated runs', () => {
    write(
      root,
      'sdk/package.json',
      sdkManifest({ dependencies: { '@iln/shared': 'workspace:*' } })
    );
    assert.deepEqual(checkStatic(root, TARGETS), checkStatic(root, TARGETS));
  });
});

describe('boundary conditions', () => {
  it('allows a peer on another package in the install set', () => {
    assert.ok(!checkStatic(root, TARGETS).findings.some((f) => f.pkg === '@iln/react'));
  });

  it('ignores devDependencies on workspace packages (they are not installed)', () => {
    assert.deepEqual(sdkManifest().devDependencies, { '@iln/shared': 'workspace:*' });
    assert.deepEqual(checkStatic(root, TARGETS).findings, []);
  });

  it('extracts bare declaration imports, skipping comments, relatives and self-references', () => {
    const dts = [
      '/// <reference types="node" />',
      "import { A } from '@stellar/stellar-sdk';",
      "import type { B } from './b';",
      "export { C } from 'react';",
      "type D = import('@iln/shared').Invoice;",
      "// import { E } from 'not-real';",
      "/** @example import { F } from '@iln/sdk'; */",
    ].join('\n');
    assert.deepEqual(findDeclarationImports(dts), [
      '@iln/shared',
      '@stellar/stellar-sdk',
      'node',
      'react',
    ]);
  });

  it('parses npm failures into a code and package spec', () => {
    assert.deepEqual(
      parseInstallError("npm error 404  '@iln/shared@0.1.0' is not in this registry."),
      {
        code: 'E404',
        spec: '@iln/shared@0.1.0',
      }
    );
    assert.deepEqual(
      parseInstallError('npm error notarget No matching version found for axios@^99.0.0.'),
      {
        code: 'ETARGET',
        spec: 'axios@^99.0.0',
      }
    );
    assert.deepEqual(
      parseInstallError('npm error Unsupported URL Type "workspace:": workspace:*'),
      {
        code: 'EUNSUPPORTEDPROTOCOL',
        spec: 'workspace:*',
      }
    );
    assert.deepEqual(parseInstallError('npm ERR! code EACCES'), { code: 'EACCES', spec: null });
  });

  it('keeps only ILN and probe diagnostics', () => {
    const out = [
      'probe.ts(1,1): error TS2307: x',
      'node_modules/@iln/sdk/dist/index.d.ts(1,1): error TS2304: y',
      'node_modules/@stellar/stellar-sdk/x.d.ts(1,1): error TS2304: z',
      'Found 3 errors.',
    ].join('\n');
    assert.equal(scopedTypeErrors(out).length, 2);
  });

  it('builds a probe that imports every subpath', () => {
    const src = probeSource('@iln/sdk', exportSubpaths(sdkManifest()));
    assert.match(src, /from '@iln\/sdk';/);
    assert.match(src, /from '@iln\/sdk\/legacy';/);
    assert.match(src, /export const entries = \[entry0, entry1\];/);
  });

  it('indexes workspace packages from pnpm-workspace.yaml globs and comments', () => {
    const index = readWorkspace(root);
    assert.deepEqual([...index.keys()].sort(), ['@iln/react', '@iln/sdk', '@iln/shared']);
  });
});
