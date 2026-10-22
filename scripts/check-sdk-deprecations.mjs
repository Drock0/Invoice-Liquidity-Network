#!/usr/bin/env node
/**
 * check-sdk-deprecations.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Keeps the deprecated `@iln/sdk` surface warning its users (issue #1222).
 *
 * The registry in sdk/src/deprecations.ts lists every deprecated surface with
 * a stable code (ILN_SDK_DEPnnn). This guard proves each entry is still wired
 * to a runtime warning, documented for integrators, and not overdue.
 *
 * Checks (all error-level, exit 1 on any finding):
 *   1. registry-shape   the registry parses; every entry has code, surface,
 *                       replacement and removedIn; codes are unique and match
 *                       ILN_SDK_DEPnnn.
 *   2. overdue          an entry's removedIn is not above the version in
 *                       sdk/package.json (remove the surface, or the entry).
 *   3. stale-entry      a subpath entry (`@iln/sdk/<sub>`) whose subpath is no
 *                       longer in the package exports map.
 *   4. unwired          no non-test file in sdk/src calls
 *                       emitDeprecationWarning('<code>'); for a subpath, the
 *                       subpath's own entry module must make that call.
 *   5. unknown-code     an emitDeprecationWarning('<code>') call names a code
 *                       that is not registered (it would throw at runtime).
 *   6. side-effects     a deprecated subpath's dist files are not declared in
 *                       package.json `sideEffects`, so a bundler could drop
 *                       the import-time warning.
 *   7. undocumented     docs/sdk-migration-guide.md has no "Deprecated SDK
 *                       surface" section, or that section does not list the
 *                       entry's code, surface and removal version.
 *
 * Usage:
 *   node scripts/check-sdk-deprecations.mjs [--root=<dir>] [--json=<file>]
 *
 * --json writes a machine-readable report (uploaded as a CI artifact by
 * .github/workflows/sdk-deprecations.yml). See
 * docs/runbooks/sdk-deprecations.md.
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(__dirname, '..');

export const REGISTRY_FILE = 'sdk/src/deprecations.ts';
export const SDK_MANIFEST = 'sdk/package.json';
export const SDK_SRC = 'sdk/src';
export const MIGRATION_GUIDE = 'docs/sdk-migration-guide.md';
export const GUIDE_HEADING = 'Deprecated SDK surface';
export const CODE_RE = /^ILN_SDK_DEP\d{3}$/;

const FIELDS = ['code', 'surface', 'replacement', 'removedIn'];

function toPosix(p) {
  return p.split(sep).join('/');
}

function parseVersion(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(v));
  return m ? m.slice(1).map(Number) : null;
}

function cmp(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

/**
 * Extracts the DEPRECATED_SURFACES entries from the registry source.
 *
 * @returns {Array<Record<string, string>> | null} null when the array is absent
 */
export function parseRegistry(source) {
  const block = /DEPRECATED_SURFACES[^=]*=\s*Object\.freeze\(\s*\[([\s\S]*?)\]\s*\)/.exec(source);
  if (!block) return null;
  const entries = [];
  for (const obj of block[1].matchAll(/\{([\s\S]*?)\}/g)) {
    const entry = {};
    for (const field of FIELDS) {
      const m = new RegExp(`\\b${field}\\s*:\\s*(['"\`])((?:(?!\\1)[^\\\\]|\\\\.)*)\\1`).exec(
        obj[1]
      );
      if (m) entry[field] = m[2].replace(/\\(.)/g, '$1');
    }
    entries.push(entry);
  }
  return entries;
}

/** Codes passed to emitDeprecationWarning('<code>') in a source file. */
export function findEmittedCodes(source) {
  return [...source.matchAll(/\bemitDeprecationWarning\(\s*['"]([^'"]+)['"]\s*\)/g)].map(
    (m) => m[1]
  );
}

/** Returns the body of the "Deprecated SDK surface" section, or null. */
export function guideSection(markdown) {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((l) => new RegExp(`^#{2,3}\\s+${GUIDE_HEADING}\\s*$`, 'i').test(l));
  if (start === -1) return null;
  const level = /^#+/.exec(lines[start])[0].length;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const h = /^(#+)\s/.exec(lines[i]);
    if (h && h[1].length <= level) {
      end = i;
      break;
    }
  }
  return lines.slice(start + 1, end).join('\n');
}

function listSourceFiles(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules' && entry.name !== '__tests__') listSourceFiles(abs, out);
    } else if (/\.tsx?$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name)) {
      out.push(abs);
    }
  }
  return out;
}

/** `./dist/legacy-imports.mjs` → `sdk/src/legacy-imports.ts` (tsup entry naming). */
function sourceForDistTarget(target) {
  const m = /^\.\/dist\/(.+)\.(?:mjs|cjs|js)$/.exec(target);
  return m ? `${SDK_SRC}/${m[1]}.ts` : null;
}

function distTargets(entry) {
  if (typeof entry === 'string') return [entry];
  if (!entry || typeof entry !== 'object') return [];
  return Object.entries(entry)
    .filter(([cond, t]) => cond !== 'types' && typeof t === 'string')
    .map(([, t]) => t);
}

export function checkSdkDeprecations(root = DEFAULT_ROOT) {
  const findings = [];
  const add = (f) => findings.push(f);

  let manifest = null;
  try {
    manifest = JSON.parse(readFileSync(join(root, SDK_MANIFEST), 'utf8'));
  } catch {
    add({ rule: 'registry-shape', file: SDK_MANIFEST, message: 'missing or unparseable' });
  }

  let entries = null;
  const registryPath = join(root, REGISTRY_FILE);
  if (!existsSync(registryPath)) {
    add({
      rule: 'registry-shape',
      file: REGISTRY_FILE,
      message: 'deprecation registry is missing',
    });
  } else {
    entries = parseRegistry(readFileSync(registryPath, 'utf8'));
    if (!entries) {
      add({
        rule: 'registry-shape',
        file: REGISTRY_FILE,
        message: 'no `DEPRECATED_SURFACES = Object.freeze([...])` array found',
      });
    }
  }
  entries ??= [];

  const seen = new Set();
  const valid = [];
  for (const [i, entry] of entries.entries()) {
    const missing = FIELDS.filter((f) => !entry[f]);
    if (missing.length) {
      add({
        rule: 'registry-shape',
        file: REGISTRY_FILE,
        message: `entry #${i + 1} is missing ${missing.join(', ')}`,
      });
      continue;
    }
    if (!CODE_RE.test(entry.code)) {
      add({
        rule: 'registry-shape',
        file: REGISTRY_FILE,
        message: `code "${entry.code}" must match ILN_SDK_DEPnnn`,
      });
    }
    if (seen.has(entry.code)) {
      add({
        rule: 'registry-shape',
        file: REGISTRY_FILE,
        message: `duplicate code "${entry.code}"`,
      });
    }
    seen.add(entry.code);
    if (!parseVersion(entry.removedIn)) {
      add({
        rule: 'registry-shape',
        file: REGISTRY_FILE,
        message: `${entry.code}: removedIn "${entry.removedIn}" is not x.y.z`,
      });
      continue;
    }
    valid.push(entry);
  }

  // Overdue: still shipped at or after the version it was due to be removed in.
  const current = manifest ? parseVersion(manifest.version) : null;
  for (const entry of valid) {
    if (current && cmp(parseVersion(entry.removedIn), current) <= 0) {
      add({
        rule: 'overdue',
        file: REGISTRY_FILE,
        message: `${entry.code} (${entry.surface}) was due for removal in ${entry.removedIn}; ${SDK_MANIFEST} is ${manifest.version}`,
      });
    }
  }

  // Which codes are actually emitted, and by which files.
  const emitters = new Map();
  for (const abs of listSourceFiles(join(root, SDK_SRC))) {
    const file = toPosix(relative(root, abs));
    if (file === REGISTRY_FILE) continue;
    for (const code of findEmittedCodes(readFileSync(abs, 'utf8'))) {
      if (!seen.has(code)) {
        add({
          rule: 'unknown-code',
          file,
          message: `emitDeprecationWarning('${code}') names an unregistered code`,
        });
      }
      if (!emitters.has(code)) emitters.set(code, new Set());
      emitters.get(code).add(file);
    }
  }

  const sideEffects = manifest?.sideEffects;
  const sideEffectFiles = Array.isArray(sideEffects) ? new Set(sideEffects) : null;

  for (const entry of valid) {
    const files = emitters.get(entry.code) ?? new Set();
    const sub = entry.surface.startsWith('@iln/sdk/')
      ? entry.surface.slice('@iln/sdk'.length)
      : null;

    if (sub !== null && manifest) {
      const exportEntry = manifest.exports?.[`.${sub}`];
      if (!exportEntry) {
        add({
          rule: 'stale-entry',
          file: REGISTRY_FILE,
          message: `${entry.code}: "${entry.surface}" is not in ${SDK_MANIFEST} exports; drop the entry`,
        });
        continue;
      }
      const targets = distTargets(exportEntry);
      const sources = [...new Set(targets.map(sourceForDistTarget).filter(Boolean))];
      for (const src of sources) {
        if (!files.has(src)) {
          add({
            rule: 'unwired',
            file: src,
            message: `entry module for "${entry.surface}" does not call emitDeprecationWarning('${entry.code}')`,
          });
        }
      }
      if (sources.length === 0) {
        add({
          rule: 'unwired',
          file: SDK_MANIFEST,
          message: `cannot map "${entry.surface}" exports to a source module under ${SDK_SRC}/`,
        });
      }
      if (
        sideEffects === false ||
        (sideEffectFiles && targets.some((t) => !sideEffectFiles.has(t)))
      ) {
        const missing = sideEffectFiles ? targets.filter((t) => !sideEffectFiles.has(t)) : targets;
        add({
          rule: 'side-effects',
          file: SDK_MANIFEST,
          message: `"sideEffects" must list ${missing.join(', ')} or bundlers may drop the ${
            entry.code
          } warning`,
        });
      }
    } else if (files.size === 0) {
      add({
        rule: 'unwired',
        file: REGISTRY_FILE,
        message: `${entry.code} (${entry.surface}) is never emitted by ${SDK_SRC}/`,
      });
    }
  }

  // Documentation for integrators.
  const guidePath = join(root, MIGRATION_GUIDE);
  const section = existsSync(guidePath) ? guideSection(readFileSync(guidePath, 'utf8')) : null;
  if (section === null) {
    add({
      rule: 'undocumented',
      file: MIGRATION_GUIDE,
      message: `missing a "## ${GUIDE_HEADING}" section`,
    });
  } else {
    for (const entry of valid) {
      const missing = [entry.code, entry.surface, entry.removedIn].filter(
        (s) => !section.includes(s)
      );
      if (missing.length) {
        add({
          rule: 'undocumented',
          file: MIGRATION_GUIDE,
          message: `"${GUIDE_HEADING}" does not mention ${missing
            .map((s) => `"${s}"`)
            .join(', ')} for ${entry.code}`,
        });
      }
    }
  }

  const byRule = {};
  for (const f of findings) byRule[f.rule] = (byRule[f.rule] ?? 0) + 1;
  return {
    findings,
    summary: {
      ok: findings.length === 0,
      total: findings.length,
      byRule,
      sdkVersion: manifest?.version ?? null,
      deprecations: valid.map((e) => ({
        code: e.code,
        surface: e.surface,
        removedIn: e.removedIn,
        emittedBy: [...(emitters.get(e.code) ?? [])].sort(),
      })),
    },
  };
}

function main() {
  let root = DEFAULT_ROOT;
  let jsonOut = null;
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith('--root=')) root = resolve(arg.slice('--root='.length));
    else if (arg.startsWith('--json=')) jsonOut = resolve(arg.slice('--json='.length));
  }

  const report = checkSdkDeprecations(root);

  if (jsonOut) {
    writeFileSync(
      jsonOut,
      JSON.stringify({ generatedAt: new Date().toISOString(), ...report }, null, 2) + '\n'
    );
    console.log(`[sdk-deprecations] wrote JSON report to ${jsonOut}`);
  }

  for (const f of report.findings) {
    console.log(`::error file=${f.file}::[${f.rule}] ${f.message}`);
  }

  if (!report.summary.ok) {
    console.error(
      `\x1b[31m[sdk-deprecations] FAILED — ${report.summary.total} finding(s) ${JSON.stringify(
        report.summary.byRule
      )}. See docs/runbooks/sdk-deprecations.md.\x1b[0m`
    );
    process.exit(1);
  }
  const list = report.summary.deprecations.map((d) => `${d.code} ${d.surface}`).join(', ');
  console.log(
    `\x1b[32m[sdk-deprecations] OK — ${report.summary.deprecations.length} deprecated surface(s) warn at runtime and are documented: ${list}\x1b[0m`
  );
  process.exit(0);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
