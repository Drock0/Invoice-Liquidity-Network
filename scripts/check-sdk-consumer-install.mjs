#!/usr/bin/env node
/**
 * check-sdk-consumer-install.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the canonical SDK installs and resolves from a clean consumer
 * project, outside this workspace (issue #1223).
 *
 * Inside the monorepo every `@iln/*` import resolves through pnpm workspace
 * links, so a published manifest that depends on an unpublished workspace
 * package (or declarations that import one) still builds and tests green.
 * A consumer installing from the registry then fails: before #1223 the packed
 * `@iln/sdk` declared `"@iln/shared": "0.1.0"`, a package that 404s on npm.
 *
 * Static checks (default; dependency-free, no network):
 *   1. local-protocol         a runtime/peer dependency uses `file:` or `link:`,
 *                             which a registry consumer cannot install.
 *   2. unpublished-dependency a runtime/optional/peer dependency is a
 *                             workspace package outside the install set.
 *   3. types-leak             a built `.d.ts` imports a package the manifest
 *                             does not declare as a dependency or peer.
 *
 * Install checks (`--install`; needs a built SDK and registry access):
 *   4. not-built              the export-map targets are missing (fails closed).
 *   5. pack-failed            `pnpm pack` (the release packer) failed.
 *   6. install-failed         `npm install <tarball>` failed in a fresh
 *                             consumer directory under the OS temp dir.
 *   7. require-resolve        `require()` of a subpath fails or exports nothing.
 *   8. import-resolve         `import()` of a subpath fails or exports nothing.
 *   9. runtime-exports        the root entry lacks a required runtime export.
 *  10. types-resolve          `tsc` (nodenext and bundler resolution) reports
 *                             an error in an `@iln/*` declaration file or the
 *                             consumer probe.
 *
 * The consumer directory is deleted and recreated on every run, so a re-run
 * after a failure starts from the same clean state.
 *
 * Usage:
 *   node scripts/check-sdk-consumer-install.mjs [--root=<dir>] [--json=<file>]
 *                                               [--install] [--work-dir=<dir>]
 *
 * --json writes a machine-readable report (uploaded as a CI artifact by
 * .github/workflows/sdk-consumer-install.yml). See
 * docs/runbooks/sdk-consumer-install.md.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(__dirname, '..');

/**
 * Packages a clean consumer installs. `install: true` targets are packed and
 * installed from their tarball; the others get the static manifest checks.
 * @iln/react's build does not emit its declarations yet, so its tarball is
 * not installable; its manifest is still checked (see the runbook).
 */
export const CONSUMER_TARGETS = Object.freeze([
  { dir: 'sdk', pkg: '@iln/sdk', install: true },
  { dir: 'packages/react', pkg: '@iln/react', install: false },
]);

/** Runtime exports every consumer relies on (mirrors check-example-sdk-resolution). */
export const REQUIRED_EXPORTS = Object.freeze({
  '@iln/sdk': ['ILNSdk', 'ILN_TESTNET', 'createKeypairSigner', 'SDK_VERSION'],
});

/** Dev tooling the consumer installs next to the tarball for the type probe. */
export const CONSUMER_TOOLING = Object.freeze({ typescript: '^5.9.3', '@types/node': '^20.0.0' });

const RUNTIME_FIELDS = ['dependencies', 'optionalDependencies', 'peerDependencies'];
const BUILTINS = new Set(builtinModules);

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function packageNameOf(specifier) {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

/** Workspace package name → { dir, private }, from pnpm-workspace.yaml globs. */
export function readWorkspace(root) {
  const index = new Map();
  let yaml = '';
  try {
    yaml = readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8');
  } catch {
    return index;
  }
  const patterns = [...yaml.matchAll(/^\s*-\s*['"]?([^'"#\s]+)['"]?\s*(?:#.*)?$/gm)].map(
    (m) => m[1]
  );
  const dirs = [];
  for (const p of patterns) {
    if (p.endsWith('/*')) {
      const parent = p.slice(0, -2);
      try {
        for (const e of readdirSync(join(root, parent), { withFileTypes: true })) {
          if (e.isDirectory()) dirs.push(`${parent}/${e.name}`);
        }
      } catch {
        // pattern points at a missing directory: nothing to index
      }
    } else {
      dirs.push(p);
    }
  }
  for (const dir of dirs) {
    try {
      const pkg = readJson(join(root, dir, 'package.json'));
      if (pkg.name) index.set(pkg.name, { dir, private: pkg.private === true });
    } catch {
      // directory without a manifest
    }
  }
  return index;
}

/** Bare module specifiers a declaration file imports (comments ignored). */
export function findDeclarationImports(text) {
  const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"/])\/\/(?!\/)[^\n]*/g, '$1'); // keeps `///` directives
  const specs = new Set();
  const patterns = [
    /\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bimport\s*['"]([^'"]+)['"]/g,
    /\/\/\/\s*<reference\s+types\s*=\s*['"]([^'"]+)['"]/g,
  ];
  for (const re of patterns) {
    for (const m of code.matchAll(re)) {
      if (!m[1].startsWith('.') && !isAbsolute(m[1])) specs.add(m[1]);
    }
  }
  return [...specs].sort();
}

function declarationFiles(manifest) {
  const files = new Set();
  if (typeof manifest.types === 'string') files.add(manifest.types);
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    for (const [cond, value] of Object.entries(node)) {
      if (cond === 'types' && typeof value === 'string') files.add(value);
      else walk(value);
    }
  };
  walk(manifest.exports);
  return [...files].sort();
}

/** Runtime export targets per subpath: [{ subpath, require?, import? }]. */
export function exportSubpaths(manifest) {
  const out = [];
  for (const [subpath, entry] of Object.entries(manifest.exports ?? {})) {
    if (typeof entry === 'string') {
      out.push({ subpath, require: entry, import: entry });
    } else if (entry && typeof entry === 'object') {
      out.push({
        subpath,
        require: entry.require ?? entry.default,
        import: entry.import ?? entry.default,
      });
    }
  }
  return out;
}

/** Static checks over every target manifest (and its built declarations, if present). */
export function checkStatic(root, targets = CONSUMER_TARGETS) {
  const findings = [];
  const workspace = readWorkspace(root);
  const installSet = new Set(targets.map((t) => t.pkg));
  const typesScanned = [];

  for (const target of targets) {
    const manifestFile = `${target.dir}/package.json`;
    let manifest;
    try {
      manifest = readJson(join(root, manifestFile));
    } catch {
      findings.push({
        rule: 'unpublished-dependency',
        pkg: target.pkg,
        file: manifestFile,
        message: 'manifest is missing or unparseable',
      });
      continue;
    }

    const declared = new Set(RUNTIME_FIELDS.flatMap((f) => Object.keys(manifest[f] ?? {})));
    for (const field of RUNTIME_FIELDS) {
      for (const [name, spec] of Object.entries(manifest[field] ?? {})) {
        if (/^(file|link):/.test(String(spec))) {
          findings.push({
            rule: 'local-protocol',
            pkg: target.pkg,
            file: manifestFile,
            message: `${field}["${name}"] is "${spec}", which a registry consumer cannot install`,
          });
          continue;
        }
        const isWorkspace = workspace.has(name) || String(spec).startsWith('workspace:');
        if (isWorkspace && !installSet.has(name)) {
          findings.push({
            rule: 'unpublished-dependency',
            pkg: target.pkg,
            file: manifestFile,
            message: `${field}["${name}"] is a workspace package outside the clean-consumer install set (${[
              ...installSet,
            ].join(
              ', '
            )}); a registry install cannot resolve it. Bundle what it provides and move it to devDependencies.`,
          });
        }
      }
    }

    for (const rel of declarationFiles(manifest)) {
      const abs = join(root, target.dir, rel);
      if (!existsSync(abs)) continue;
      typesScanned.push(`${target.dir}/${rel.replace(/^\.\//, '')}`);
      for (const spec of findDeclarationImports(readFileSync(abs, 'utf8'))) {
        const name = packageNameOf(spec);
        if (name === target.pkg || spec.startsWith('node:') || BUILTINS.has(spec)) continue;
        if (name === 'node' && declared.has('@types/node')) continue;
        if (!declared.has(name)) {
          findings.push({
            rule: 'types-leak',
            pkg: target.pkg,
            file: `${target.dir}/${rel.replace(/^\.\//, '')}`,
            message: `declarations import "${spec}", which is not a dependency or peer of ${target.pkg}`,
          });
        }
      }
    }
  }
  return { findings, typesScanned };
}

/** Extracts the unresolvable package from npm install output. */
export function parseInstallError(output) {
  const notFound = /404\s+'?([^'\s]+@[^'\s]+)'?\s+is not in (?:this|the npm) registry/.exec(output);
  if (notFound) return { code: 'E404', spec: notFound[1] };
  const noTarget = /No matching version found for ([^\s.]+(?:\.[^\s.]+)*)\./.exec(output);
  if (noTarget) return { code: 'ETARGET', spec: noTarget[1] };
  const protocol = /Unsupported URL Type "([^"]+)":\s*(\S+)/.exec(output);
  if (protocol) return { code: 'EUNSUPPORTEDPROTOCOL', spec: protocol[2] };
  const code = /npm (?:ERR!|error) code (\w+)/.exec(output);
  return { code: code ? code[1] : 'UNKNOWN', spec: null };
}

/** Keeps tsc diagnostics that point at ILN declarations or the consumer probe. */
export function scopedTypeErrors(output, probeFile = 'probe.ts') {
  return output
    .split(/\r?\n/)
    .filter((l) => /error TS\d+/.test(l))
    .filter((l) => l.startsWith('node_modules/@iln/') || l.startsWith(probeFile));
}

/** The probe a consumer type-checks: every subpath imported, so every `.d.ts` loads. */
export function probeSource(pkg, subpaths) {
  const lines = subpaths.map((s, i) => `import * as entry${i} from '${pkg}${s.subpath.slice(1)}';`);
  lines.push(`export const entries = [${subpaths.map((_, i) => `entry${i}`).join(', ')}];`);
  return lines.join('\n') + '\n';
}

/** Wipes and recreates the consumer project (restart-safe). */
export function prepareConsumer(consumerDir, dependencies) {
  rmSync(consumerDir, { recursive: true, force: true });
  mkdirSync(consumerDir, { recursive: true });
  writeFileSync(
    join(consumerDir, 'package.json'),
    JSON.stringify(
      {
        name: 'iln-clean-consumer',
        version: '0.0.0',
        private: true,
        description: 'Throwaway project created by scripts/check-sdk-consumer-install.mjs',
        dependencies,
        devDependencies: { ...CONSUMER_TOOLING },
      },
      null,
      2
    ) + '\n'
  );
}

function defaultExec(command, args, options = {}) {
  const res = spawnSync(command, args, { encoding: 'utf8', ...options });
  return {
    status: res.error ? 127 : res.status,
    stdout: res.stdout ?? '',
    stderr: res.error ? String(res.error.message) : res.stderr ?? '',
  };
}

/**
 * Packs each installable target with pnpm (as the release does), installs the
 * tarball into a fresh consumer project and probes it.
 *
 * @param {string} root
 * @param {{ workDir?: string, exec?: Function, targets?: Array<object> }} options
 */
export function checkInstall(root, options = {}) {
  const exec = options.exec ?? defaultExec;
  const targets = (options.targets ?? CONSUMER_TARGETS).filter((t) => t.install);
  const workDir = resolve(options.workDir ?? join(tmpdir(), 'iln-sdk-consumer-install'));
  const findings = [];
  const results = [];

  if (!relative(resolve(root), workDir).startsWith('..')) {
    throw new Error(
      `--work-dir must be outside the repository (${workDir}); a consumer inside it would resolve workspace packages`
    );
  }

  for (const target of targets) {
    const started = Date.now();
    const probes = [];
    const add = (rule, message) =>
      findings.push({ rule, pkg: target.pkg, file: `${target.dir}/package.json`, message });
    const result = { pkg: target.pkg, tarball: null, probes };
    results.push(result);

    const manifest = readJson(join(root, target.dir, 'package.json'));
    const subpaths = exportSubpaths(manifest);
    const missing = subpaths
      .flatMap((s) => [s.require, s.import])
      .filter(Boolean)
      .filter((t) => !existsSync(join(root, target.dir, t)));
    if (missing.length) {
      add(
        'not-built',
        `build output is missing (${[...new Set(missing)].join(', ')}); run the package build first`
      );
      result.durationMs = Date.now() - started;
      continue;
    }

    const tarballDir = join(workDir, 'tarballs');
    mkdirSync(tarballDir, { recursive: true });
    const packed = exec('pnpm', ['pack', '--pack-destination', tarballDir], {
      cwd: join(root, target.dir),
    });
    const tarball = packed.stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.endsWith('.tgz'))
      .pop();
    if (packed.status !== 0 || !tarball) {
      add(
        'pack-failed',
        `pnpm pack failed: ${(packed.stderr || packed.stdout).trim().slice(-400)}`
      );
      result.durationMs = Date.now() - started;
      continue;
    }
    result.tarball = tarball;

    const consumerDir = join(workDir, 'consumer', target.pkg.replace(/[@/]/g, '_'));
    prepareConsumer(consumerDir, { [target.pkg]: `file:${tarball}` });
    const installed = exec(
      'npm',
      ['install', '--no-audit', '--no-fund', '--ignore-scripts', '--loglevel=error'],
      {
        cwd: consumerDir,
      }
    );
    probes.push({ probe: 'install', ok: installed.status === 0 });
    if (installed.status !== 0) {
      const err = parseInstallError(`${installed.stdout}\n${installed.stderr}`);
      add(
        'install-failed',
        err.spec
          ? `npm install failed with ${err.code}: "${err.spec}" cannot be resolved from the registry`
          : `npm install failed with ${err.code}`
      );
      result.installError = err;
      result.durationMs = Date.now() - started;
      continue;
    }

    for (const s of subpaths) {
      const spec = `${target.pkg}${s.subpath.slice(1)}`;
      const required = s.subpath === '.' ? REQUIRED_EXPORTS[target.pkg] ?? [] : [];
      const assertion = `const missing = ${JSON.stringify(required)}.filter((k) => !(k in m));
        if (Object.keys(m).length === 0) { console.error('exports nothing'); process.exit(2); }
        if (missing.length) { console.error('missing ' + missing.join(',')); process.exit(3); }`;
      for (const [kind, rule, code] of [
        ['require', 'require-resolve', `const m = require(${JSON.stringify(spec)}); ${assertion}`],
        [
          'import',
          'import-resolve',
          `const m = await import(${JSON.stringify(spec)}); ${assertion}`,
        ],
      ]) {
        if (!s[kind]) continue;
        const args = [
          '--no-deprecation',
          ...(kind === 'import' ? ['--input-type=module'] : []),
          '-e',
          code,
        ];
        const res = exec(process.execPath, args, { cwd: consumerDir });
        probes.push({ probe: `${kind} ${spec}`, ok: res.status === 0 });
        if (res.status !== 0) {
          add(
            res.status === 3 ? 'runtime-exports' : rule,
            `${kind}("${spec}") failed: ${(res.stderr || res.stdout).trim().split('\n').pop()}`
          );
        }
      }
    }

    writeFileSync(join(consumerDir, 'probe.ts'), probeSource(target.pkg, subpaths));
    const tsc = join(consumerDir, 'node_modules', 'typescript', 'bin', 'tsc');
    for (const [resolution, moduleKind] of [
      ['nodenext', 'nodenext'],
      ['bundler', 'esnext'],
    ]) {
      const res = exec(
        process.execPath,
        [
          tsc,
          '--noEmit',
          '--strict',
          '--skipLibCheck',
          'false',
          '--types',
          'node',
          '--module',
          moduleKind,
          '--moduleResolution',
          resolution,
          'probe.ts',
        ],
        { cwd: consumerDir }
      );
      const errors = scopedTypeErrors(`${res.stdout}\n${res.stderr}`);
      const toolFailed = res.status !== 0 && res.status !== 2; // 2 = diagnostics reported
      probes.push({ probe: `types (${resolution})`, ok: errors.length === 0 && !toolFailed });
      if (toolFailed)
        add(
          'types-resolve',
          `tsc (${resolution}) did not run: ${(res.stderr || res.stdout).trim().slice(-300)}`
        );
      for (const e of errors) add('types-resolve', `tsc (${resolution}): ${e}`);
    }
    result.durationMs = Date.now() - started;
  }
  return { findings, results, workDir };
}

export function checkConsumerInstall(root = DEFAULT_ROOT, options = {}) {
  const started = Date.now();
  const stat = checkStatic(root, options.targets);
  const install = options.install ? checkInstall(root, options) : null;
  const findings = [...stat.findings, ...(install?.findings ?? [])];
  const byRule = {};
  for (const f of findings) byRule[f.rule] = (byRule[f.rule] ?? 0) + 1;
  return {
    findings,
    summary: {
      ok: findings.length === 0,
      total: findings.length,
      byRule,
      mode: options.install ? 'install' : 'static',
      targets: (options.targets ?? CONSUMER_TARGETS).map((t) => ({
        pkg: t.pkg,
        install: t.install,
      })),
      typesScanned: stat.typesScanned,
      installs: install?.results ?? [],
      durationMs: Date.now() - started,
    },
  };
}

function main() {
  let root = DEFAULT_ROOT;
  let jsonOut = null;
  let install = false;
  let workDir;
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith('--root=')) root = resolve(arg.slice('--root='.length));
    else if (arg.startsWith('--json=')) jsonOut = resolve(arg.slice('--json='.length));
    else if (arg.startsWith('--work-dir=')) workDir = resolve(arg.slice('--work-dir='.length));
    else if (arg === '--install') install = true;
  }

  const report = checkConsumerInstall(root, { install, workDir });

  if (jsonOut) {
    writeFileSync(
      jsonOut,
      JSON.stringify({ generatedAt: new Date().toISOString(), ...report }, null, 2) + '\n'
    );
    console.log(`[sdk-consumer-install] wrote JSON report to ${jsonOut}`);
  }
  for (const f of report.findings) {
    console.log(`::error file=${f.file}::[${f.rule}] ${f.pkg}: ${f.message}`);
  }
  for (const r of report.summary.installs) {
    for (const p of r.probes) console.log(`  ${p.ok ? '✓' : '✗'} ${r.pkg} ${p.probe}`);
  }

  if (!report.summary.ok) {
    console.error(
      `\x1b[31m[sdk-consumer-install] FAILED (${report.summary.mode}) — ${
        report.summary.total
      } finding(s) ${JSON.stringify(
        report.summary.byRule
      )}. See docs/runbooks/sdk-consumer-install.md.\x1b[0m`
    );
    process.exit(1);
  }
  console.log(
    `\x1b[32m[sdk-consumer-install] OK (${report.summary.mode}) — ${report.summary.targets
      .map((t) => t.pkg)
      .join(', ')} resolve for a clean consumer\x1b[0m`
  );
  process.exit(0);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
