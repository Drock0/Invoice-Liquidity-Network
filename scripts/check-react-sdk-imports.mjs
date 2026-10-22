#!/usr/bin/env node
/**
 * check-react-sdk-imports.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Keeps every `@iln/react` import aligned with the canonical SDK (issue #1221).
 *
 * `@iln/react` ships to host apps that install exactly two ILN packages:
 * `@iln/react` and its peer `@iln/sdk`. Any other ILN specifier in its source
 * (the unpublished `@iln/shared` workspace package, the experimental
 * `@iln/sdk-next`, a retired name, a deep `@iln/sdk/dist/...` path, or a
 * relative path into ../../sdk) resolves inside this monorepo but not in a
 * consumer's node_modules, and the published `.d.ts` then points at a module
 * the consumer never installed.
 *
 * Checks (all error-level, exit 1 on any finding):
 *   1. non-canonical-sdk    an `@iln/*` import other than the `@iln/sdk` root.
 *   2. escapes-package      a relative import resolving outside packages/react/.
 *   3. undeclared-package   a bare import declared nowhere in
 *                           packages/react/package.json, so it only resolves
 *                           through workspace hoisting. (A devDependency is
 *                           fine: rollup bundles everything that is not a
 *                           peer, so it never reaches the consumer.)
 *   4. missing-sdk-export   a name imported from `@iln/sdk` that the SDK's
 *                           public entry (sdk/src/index.ts) does not export.
 *   5. sdk-entry            the SDK entry, or a module it re-exports with
 *                           `export *`, cannot be read (fails closed).
 *
 * Usage:
 *   node scripts/check-react-sdk-imports.mjs [--root=<dir>] [--json=<file>]
 *
 * --json writes a machine-readable report (uploaded as a CI artifact by
 * .github/workflows/react-sdk-imports.yml). See
 * docs/runbooks/react-sdk-imports.md.
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(__dirname, '..');

export const REACT_DIR = 'packages/react';
export const REACT_SRC = 'packages/react/src';
export const CANONICAL_SDK = '@iln/sdk';
export const SDK_ENTRY = 'sdk/src/index.ts';

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts'];
const RESOLVE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.js'];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage']);
const BUILTINS = new Set(builtinModules);

function toPosix(p) {
  return p.split(sep).join('/');
}

function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

/** Blanks comments while keeping offsets (and so line numbers) intact. */
export function stripComments(text) {
  const blank = (m) => m.replace(/[^\n]/g, ' ');
  return text
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, (m, lead) => lead + blank(m.slice(lead.length)));
}

/** `@scope/name/sub` → `@scope/name`, `pkg/sub` → `pkg`. */
export function packageNameOf(specifier) {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

function parseNamedClause(clause) {
  const names = [];
  const braces = /\{([^}]*)\}/.exec(clause);
  const head = clause.replace(/\{[^}]*\}/, '').replace(/^\s*type\s+/, '');
  for (const part of head.split(',')) {
    const t = part.trim();
    if (!t) continue;
    if (t.startsWith('*')) continue; // namespace import: every export is reachable
    names.push('default');
  }
  if (braces) {
    for (const raw of braces[1].split(',')) {
      const t = raw.trim().replace(/^type\s+/, '');
      if (!t) continue;
      names.push(t.split(/\s+as\s+/)[0].trim());
    }
  }
  return names;
}

/**
 * Lists every module specifier a source file references, with the names it
 * imports where they are statically known.
 *
 * @returns {Array<{specifier: string, line: number, names: string[]}>}
 */
export function findImports(text) {
  const code = stripComments(text);
  const out = [];
  const patterns = [
    // import x, { a, type b as c } from '...';  import type { a } from '...';
    {
      re: /\bimport\s+((?:type\s+)?[\w$*\s{},]+?)\s*from\s*['"]([^'"]+)['"]/g,
      named: true,
    },
    // export { a } from '...';  export * from '...';  export * as ns from '...';
    {
      re: /\bexport\s+(?:type\s+)?(\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s*from\s*['"]([^'"]+)['"]/g,
      named: true,
    },
    // import '...';
    { re: /\bimport\s*['"]([^'"]+)['"]/g },
    // import('...');  require('...');
    { re: /\b(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g },
  ];
  for (const { re, named } of patterns) {
    let m;
    while ((m = re.exec(code)) !== null) {
      const specifier = named ? m[2] : m[1];
      out.push({
        specifier,
        line: lineOf(code, m.index),
        names: named ? parseNamedClause(m[1]) : [],
      });
    }
  }
  return out.sort((a, b) => a.line - b.line);
}

function resolveRelativeModule(fromFile, specifier) {
  const base = resolve(dirname(fromFile), specifier);
  const candidates = [
    base,
    ...RESOLVE_EXTENSIONS.map((ext) => base + ext),
    ...RESOLVE_EXTENSIONS.map((ext) => join(base, `index${ext}`)),
  ];
  return candidates.find((c) => existsSync(c) && statSync(c).isFile()) ?? null;
}

/**
 * Statically resolves the names a TypeScript module exports, following
 * relative `export *` chains. Bare `export *` targets cannot be enumerated
 * and are reported in `unresolved` so the caller can fail closed.
 *
 * @returns {{ names: Set<string>, unresolved: Array<{file: string, specifier: string}> }}
 */
export function collectModuleExports(entryFile) {
  const names = new Set();
  const unresolved = [];
  const seen = new Set();

  const visit = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    let code;
    try {
      code = stripComments(readFileSync(file, 'utf8'));
    } catch {
      unresolved.push({ file, specifier: '(unreadable)' });
      return;
    }

    for (const m of code.matchAll(/\bexport\s+\*\s+as\s+([\w$]+)\s+from\s*['"][^'"]+['"]/g)) {
      names.add(m[1]);
    }
    for (const m of code.matchAll(/\bexport\s+\*\s+from\s*['"]([^'"]+)['"]/g)) {
      const target = m[1].startsWith('.') ? resolveRelativeModule(file, m[1]) : null;
      if (target) visit(target);
      else unresolved.push({ file, specifier: m[1] });
    }
    for (const m of code.matchAll(/\bexport\s+(?:type\s+)?\{([^}]*)\}/g)) {
      for (const raw of m[1].split(',')) {
        const t = raw.trim().replace(/^type\s+/, '');
        if (!t) continue;
        const parts = t.split(/\s+as\s+/);
        names.add((parts[1] ?? parts[0]).trim());
      }
    }
    for (const m of code.matchAll(
      /\bexport\s+(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:const\s+enum|const|let|var|function\*?|class|interface|type|enum|namespace)\s+([\w$]+)/g
    )) {
      names.add(m[1]);
    }
    if (/\bexport\s+default\b/.test(code)) names.add('default');
  };

  visit(entryFile);
  return { names, unresolved };
}

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(join(dir, entry.name), out);
    } else if (entry.isFile()) {
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

/**
 * Validates every import in packages/react/src against the canonical SDK.
 *
 * @param {string} root repository root
 * @returns {{ findings: Array<object>, summary: object }}
 */
export function checkReactSdkImports(root = DEFAULT_ROOT) {
  const findings = [];
  const add = (f) => findings.push(f);

  const manifestPath = join(root, REACT_DIR, 'package.json');
  let manifest = {};
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    add({
      rule: 'undeclared-package',
      file: `${REACT_DIR}/package.json`,
      message: 'missing or unparseable; cannot verify declared packages',
    });
  }
  const declared = new Set(
    ['dependencies', 'peerDependencies', 'devDependencies'].flatMap((field) =>
      Object.keys(manifest[field] ?? {})
    )
  );

  const sdkEntry = join(root, SDK_ENTRY);
  let sdkExports = new Set();
  if (!existsSync(sdkEntry)) {
    add({ rule: 'sdk-entry', file: SDK_ENTRY, message: 'canonical SDK entry is missing' });
  } else {
    const collected = collectModuleExports(sdkEntry);
    sdkExports = collected.names;
    for (const u of collected.unresolved) {
      add({
        rule: 'sdk-entry',
        file: toPosix(relative(root, u.file)),
        message: `cannot enumerate \`export * from '${u.specifier}'\`; re-export names explicitly`,
      });
    }
  }

  const reactRoot = join(root, REACT_DIR);
  const files = walk(join(root, REACT_SRC))
    .filter((f) => SOURCE_EXTENSIONS.some((ext) => f.endsWith(ext)) || f.endsWith('.testx'))
    .sort();

  let sdkImportCount = 0;
  for (const abs of files) {
    const file = toPosix(relative(root, abs));
    for (const imp of findImports(readFileSync(abs, 'utf8'))) {
      const { specifier, line } = imp;

      if (specifier.startsWith('.')) {
        const target = resolve(dirname(abs), specifier);
        if (relative(reactRoot, target).startsWith('..')) {
          add({
            rule: 'escapes-package',
            file,
            line,
            message: `"${specifier}" resolves outside ${REACT_DIR}/; import the published "${CANONICAL_SDK}" instead`,
          });
        }
        continue;
      }
      if (specifier.startsWith('node:') || BUILTINS.has(specifier)) continue;

      const pkg = packageNameOf(specifier);
      if (pkg.startsWith('@iln/') || pkg.startsWith('@invoice-liquidity/')) {
        if (specifier !== CANONICAL_SDK) {
          add({
            rule: 'non-canonical-sdk',
            file,
            line,
            message: `imports "${specifier}"; @iln/react may only import the "${CANONICAL_SDK}" root (re-export the type from the SDK if it is missing)`,
          });
          continue;
        }
        sdkImportCount++;
        for (const name of imp.names) {
          if (!sdkExports.has(name)) {
            add({
              rule: 'missing-sdk-export',
              file,
              line,
              message: `"${name}" is not exported by ${CANONICAL_SDK} (${SDK_ENTRY})`,
            });
          }
        }
      }

      if (!declared.has(pkg)) {
        add({
          rule: 'undeclared-package',
          file,
          line,
          message: `"${pkg}" is not declared in ${REACT_DIR}/package.json; it only resolves through workspace hoisting`,
        });
      }
    }
  }

  findings.sort(
    (a, b) =>
      a.file.localeCompare(b.file) || (a.line ?? 0) - (b.line ?? 0) || a.rule.localeCompare(b.rule)
  );
  const byRule = {};
  for (const f of findings) byRule[f.rule] = (byRule[f.rule] ?? 0) + 1;

  return {
    findings,
    summary: {
      ok: findings.length === 0,
      total: findings.length,
      byRule,
      filesScanned: files.length,
      sdkImports: sdkImportCount,
      sdkExports: sdkExports.size,
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

  const report = checkReactSdkImports(root);

  if (jsonOut) {
    writeFileSync(
      jsonOut,
      JSON.stringify({ generatedAt: new Date().toISOString(), ...report }, null, 2) + '\n'
    );
    console.log(`[react-sdk-imports] wrote JSON report to ${jsonOut}`);
  }

  for (const f of report.findings) {
    console.log(
      `::error file=${f.file}${f.line ? `,line=${f.line}` : ''}::[${f.rule}] ${f.message}`
    );
  }

  const { total, byRule, filesScanned, sdkImports, sdkExports } = report.summary;
  if (!report.summary.ok) {
    console.error(
      `\x1b[31m[react-sdk-imports] FAILED — ${total} finding(s) ${JSON.stringify(
        byRule
      )}. See docs/runbooks/react-sdk-imports.md.\x1b[0m`
    );
    process.exit(1);
  }
  console.log(
    `\x1b[32m[react-sdk-imports] OK — ${filesScanned} files, ${sdkImports} ${CANONICAL_SDK} imports, all resolve against ${sdkExports} SDK exports\x1b[0m`
  );
  process.exit(0);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
