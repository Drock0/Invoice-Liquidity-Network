# Runbook: SDK Deprecation Warnings

**Control:** `sdk/src/deprecations.ts` (runtime) and
`scripts/check-sdk-deprecations.mjs` (CI guard)
**Tests:** `sdk/src/deprecations.test.ts` (runtime behaviour) and
`scripts/__tests__/check-sdk-deprecations.test.mjs` (guard)
**CI:** `.github/workflows/sdk-deprecations.yml` (blocking on PRs and pushes to
`main`/`dev`, plus a weekly scheduled sweep) and the `Core · test` job.
**Evidence artifact:** `sdk-deprecations-report` (JSON, 30-day retention) on
every run, plus a job-summary table of each code and the file that emits it.
**Owner:** @iln/sdk maintainers.
**Origin:** #1222

## What it protects

Before #1222, the SDK's deprecated surface was silent. The `@iln/sdk/legacy`
compatibility subpath (#1219) gave no signal to the apps importing it, and the
`getVersion`/`getContractVersion` entries in `getAllDeprecationWarnings()` describe
methods `ILNSdk` does not have. Nothing told an integrator what to migrate
before removal.

Now every deprecated surface has a stable code in `DEPRECATED_SURFACES`, and
using it emits **one** warning per process:

```
(node:1234) [ILN_SDK_DEP001] DeprecationWarning: @iln/sdk/legacy is deprecated and will be removed in @iln/sdk 1.0.0. Migrate: import from '@iln/sdk' (the exports are identical). See https://github.com/…/docs/sdk-migration-guide.md#deprecated-sdk-surface
```

- **Node:** `process.emitWarning(…, { type: 'DeprecationWarning', code })`.
  `--no-deprecation` silences it, `--trace-deprecation` shows the importer, and
  `--throw-deprecation` makes it fatal.
- **Browsers / React Native:** one `console.warn`.
- **Deduplication** uses a `Symbol.for` key on `globalThis`, so the root and
  legacy bundles in the same process still warn once.
- **Bundlers:** `sdk/package.json` `sideEffects` lists the legacy dist files, so
  tree-shaking cannot drop the import-time warning.
- **Bundle budget:** the module is imported only by deprecated entry points.
  `dist/index.mjs` stays at 109.79 KB of its 110 KB budget.

## Current deprecations

| Code | Surface | Use instead | Removed in |
|---|---|---|---|
| `ILN_SDK_DEP001` | `@iln/sdk/legacy` | `@iln/sdk` | `1.0.0` |

## Guard rules

| Rule | What fails |
|---|---|
| `registry-shape` | the registry is missing or unparseable, or an entry lacks `code`/`surface`/`replacement`/`removedIn`, uses a code outside `ILN_SDK_DEPnnn`, or duplicates a code |
| `overdue` | `removedIn` ≤ the version in `sdk/package.json`: the surface was due to be removed |
| `stale-entry` | a subpath entry whose subpath is gone from the exports map |
| `unwired` | the deprecated entry module (or, for an API, any non-test file in `sdk/src`) does not call `emitDeprecationWarning('<code>')` |
| `unknown-code` | `emitDeprecationWarning` is called with an unregistered code (it would throw at runtime) |
| `side-effects` | `sideEffects` is `false` or omits a deprecated subpath's dist file |
| `undocumented` | `docs/sdk-migration-guide.md` has no `## Deprecated SDK surface` section listing the code, surface and removal version |

## Run it locally

```bash
pnpm check:sdk-deprecations                   # human output, exit 1 on findings
pnpm test:sdk-deprecations                    # guard unit tests
pnpm --filter @iln/sdk exec vitest run src/deprecations.test.ts
node -e 'require("./sdk/dist/legacy-imports.cjs")'   # after a build: prints ILN_SDK_DEP001 once
```

## Deprecating something new

1. Add an entry to `DEPRECATED_SURFACES` with the next free code.
2. Call `emitDeprecationWarning('<code>')`: at the top of the entry module for
   a subpath, or inside the deprecated function or method for an API.
3. For a subpath, add its dist files to `sideEffects` in `sdk/package.json`.
4. Add a row to "Deprecated SDK surface" in `docs/sdk-migration-guide.md`.
5. Add a changeset. Run `pnpm check:sdk-deprecations` until it prints `OK`.

## When the check fails

- `overdue`: remove the surface in this release (and its registry entry, doc
  row and `sideEffects` files), or, if removal must slip, raise `removedIn`
  and note why in the changeset.
- `stale-entry`: the surface is gone. Delete its registry entry and doc row.
- `unwired` / `unknown-code` / `side-effects` / `undocumented`: restore the
  missing piece listed in the finding.

## Measuring remaining usage

A service can count deprecated usage before an upgrade:

```ts
process.on('warning', (w) => {
  const code = (w as { code?: string }).code;
  if (code?.startsWith('ILN_SDK_DEP')) metrics.increment('iln_sdk_deprecated_surface_used', { code });
});
```

Zero counts across a release window means the surface can be removed safely.

## Cross-repository note

`ILN-Frontend` (the `sync:frontend` repo) should search for `@iln/sdk/legacy`
and import from `@iln/sdk` instead. The exports are identical.
