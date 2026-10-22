# Runbook: @iln/react Imports the Canonical SDK

**Control:** `scripts/check-react-sdk-imports.mjs`
**Tests:** `scripts/__tests__/check-react-sdk-imports.test.mjs`
**CI:** `.github/workflows/react-sdk-imports.yml` (blocking on PRs and pushes
to `main`/`dev`) and the `Core · test` job (guard unit tests).
**Evidence artifact:** `react-sdk-imports-report` (JSON, 30-day retention) on
every run, plus a one-line job summary.
**Owner:** @iln/react maintainers.
**Origin:** #1221 (complements the peer contract in
[react-peer-contract.md](react-peer-contract.md))

## What it protects

A host app installs exactly two ILN packages to use the hooks: `@iln/react` and
its peer `@iln/sdk`. Every ILN symbol `@iln/react` uses must therefore come from
the `@iln/sdk` root. Before #1221, five files imported dispute types from
`@iln/shared`, an unpublished workspace package that `@iln/react` does not
declare. Inside the monorepo that resolved through workspace hoisting. A
consumer's `node_modules` has no such package, so `tsc` on `packages/react`
already reported `Cannot find module '@iln/shared'`, and the emitted
declarations would have pointed consumers at the same missing module.

The fix re-exports the dispute types (`DisputeAnalytics`, `DisputeEvidence`,
`DisputeReasonCategory`, `DisputeRecord`, `DisputeResolutionDecision`,
`DisputeStatus`) from `@iln/sdk` (type-only, so the runtime bundle does not
grow) and switches `@iln/react` to import them from there.

## Rules

| Rule | What fails |
|---|---|
| `non-canonical-sdk` | an `@iln/*` (or retired `@invoice-liquidity/*`) import other than the `@iln/sdk` root: `@iln/shared`, `@iln/sdk-next`, `@iln/sdk/legacy` (deprecated), `@iln/sdk/dist/...` |
| `escapes-package` | a relative import that resolves outside `packages/react/` (e.g. `../../../sdk/src/types`) |
| `undeclared-package` | a bare import declared nowhere in `packages/react/package.json` (it only resolves through hoisting). devDependencies are allowed: rollup bundles everything that is not a peer. |
| `missing-sdk-export` | a name imported (or re-exported) from `@iln/sdk` that `sdk/src/index.ts` does not export, including a default import |
| `sdk-entry` | `sdk/src/index.ts` is missing, or an `export *` in its chain targets a bare package whose names cannot be enumerated. The check fails closed instead of passing every import. |

The SDK export surface is resolved statically from `sdk/src/index.ts` by
following relative `export *` chains, so the check needs no build or install.
When it was added, it resolved the same 294 names that tsup emits in
`sdk/dist/index.d.ts`.

## Run it locally

```bash
pnpm check:react-sdk-imports                  # human output, exit 1 on findings
node scripts/check-react-sdk-imports.mjs --json=report.json
pnpm test:react-sdk-imports                   # unit tests
```

## When the check fails

1. Open the `react-sdk-imports-report` artifact or the inline `::error`
   annotations. Each finding gives `rule`, `file`, `line` and a message.
2. Fix it:
   - `non-canonical-sdk` / `escapes-package`: import from `@iln/sdk`. If the
     symbol is not exported there yet, add it to the SDK's public entry
     (`export type { … } from '@iln/shared'` in `sdk/src/types.ts` for shared
     domain types), then import it from `@iln/sdk`.
   - `missing-sdk-export`: fix the name, or export it from `sdk/src/index.ts`.
   - `undeclared-package`: add the package to `packages/react/package.json`:
     a peer if the host app must supply it, otherwise a devDependency that
     rollup bundles.
   - `sdk-entry`: replace the bare `export * from '<pkg>'` in the SDK with
     explicit named re-exports.
3. Re-run `pnpm check:react-sdk-imports` until it prints `OK`.

## Verifying the control is active

- Every run of **React SDK Imports** uploads `react-sdk-imports-report`. A
  healthy report has `summary.ok: true` and a non-zero `summary.sdkImports`.
- The unit tests include a check against the real repository. A regression
  fails `Core · test` even if the dedicated workflow is disabled.

## Cross-repository note

`ILN-Frontend` (the `sync:frontend` repo) should import dispute types from
`@iln/sdk` as well. Nothing changes for code that already imports from
`@iln/sdk`.
