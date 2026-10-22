# Runbook: SDK Clean Consumer Install

**Control:** `scripts/check-sdk-consumer-install.mjs`
**Tests:** `scripts/__tests__/check-sdk-consumer-install.test.mjs`
**CI:** `.github/workflows/sdk-consumer-install.yml` (blocking on PRs that touch
the SDK, shared types, React package or lockfile; every push to `main`/`dev`;
and a weekly scheduled sweep). The `Core · test` job runs the guard's unit
tests and the static checks against the repository.
**Evidence artifact:** `sdk-consumer-install-report` (JSON, 30-day retention)
with per-probe results and timings, plus a probe table in the job summary.
**Owner:** @iln/sdk maintainers.
**Origin:** #1223 (complements the tarball path checks in
[sdk-rc-smoke.md](sdk-rc-smoke.md), which never install dependencies)

## What it protects

Inside the monorepo, every `@iln/*` import resolves through pnpm workspace
links, so the SDK builds and tests green even when its published manifest
cannot be installed. A consumer installing from the registry does not have
those links.

**Baseline (before #1223):** `pnpm pack` rewrote `"@iln/shared": "workspace:*"`
in `sdk/package.json` `dependencies` to `"0.1.0"`, but `@iln/shared` is not on
the npm registry. A clean `npm install` of the packed `@iln/sdk` failed:

```
npm error 404  '@iln/shared@0.1.0' is not in this registry.
```

**Fix:** `@iln/shared` contributes types only. The SDK's JS bundles never
reference it, and tsup inlines its declarations into `dist/*.d.ts`. It is now a
`devDependency`, and the published manifest has only registry dependencies
(`@stellar/freighter-api`, `@stellar/stellar-sdk`, `axios`).

**After:** the clean consumer installs the tarball, `require()`s and
`import()`s `@iln/sdk` and `@iln/sdk/legacy`, and type-checks both with
`skipLibCheck: false` under `nodenext` and `bundler` resolution (7/7 probes,
about 14 s).

## Rules

| Rule | Mode | What fails |
|---|---|---|
| `local-protocol` | static | a runtime, optional or peer dependency uses `file:` or `link:` |
| `unpublished-dependency` | static | a runtime, optional or peer dependency is a workspace package outside the install set (`@iln/sdk`, `@iln/react`) |
| `types-leak` | static | a built `.d.ts` imports a package the manifest does not declare as a dependency or peer (scanned when `dist/` exists) |
| `not-built` | install | an export-map target is missing (fails closed instead of packing an empty package) |
| `pack-failed` | install | `pnpm pack` failed |
| `install-failed` | install | `npm install --ignore-scripts` of the tarball failed. The finding names the npm code and the unresolvable spec (`E404`, `ETARGET`, `EUNSUPPORTEDPROTOCOL`, network errors). |
| `require-resolve` / `import-resolve` | install | an export subpath cannot be loaded, or exports nothing |
| `runtime-exports` | install | the root entry lacks `ILNSdk`, `ILN_TESTNET`, `createKeypairSigner` or `SDK_VERSION` |
| `types-resolve` | install | `tsc` reports an error in an `@iln/*` declaration file or the probe, or cannot run. Errors inside third-party declarations, such as `@stellar/stellar-sdk`'s own types, are out of scope. |

The consumer directory is deleted and recreated on every run. A re-run after a
failure therefore starts from the same clean state. The work dir must be
outside the repository, because a consumer inside it would resolve workspace
packages.

## Run it locally

```bash
pnpm check:sdk-consumer-install                         # static checks only
pnpm --filter @iln/shared build && pnpm --filter @iln/sdk build
pnpm check:sdk-consumer-install --install --json=report.json   # full install (needs registry access)
pnpm test:sdk-consumer-install                          # unit tests
```

## When the check fails

1. Open the `sdk-consumer-install-report` artifact. `summary.installs[].probes`
   shows which probe failed, and `findings[]` gives the reason.
2. Fix it:
   - `unpublished-dependency` / `install-failed` with an `@iln/*` spec: if the
     package only provides types, move it to `devDependencies` and let tsup
     inline them. If it provides runtime code, publish it first and add it to
     `CONSUMER_TARGETS`.
   - `install-failed` with a third-party spec: the dependency was yanked or its
     range has no published match. Pin to a published version.
   - `local-protocol`: replace `file:`/`link:` with a registry range or
     `workspace:*`.
   - `types-leak` / `types-resolve`: re-export the type from the SDK, or
     declare the package as a dependency or peer.
   - `not-built`: build `@iln/shared` and `@iln/sdk` before running.
3. Re-run until all probes pass.

## Known gap

`@iln/react` gets the static checks only. Its `rollup.config.js` bundles
declarations from `dist/esm/index.d.ts`, which the build does not emit, so
`pnpm --filter @iln/react build` fails before packing. This is pre-existing and
outside this control. Once the React build is fixed, set `install: true` on
its entry in `CONSUMER_TARGETS` to add it to the clean-consumer install.

## Cross-repository note

`ILN-Frontend` (the `sync:frontend` repo) needs no change: after this fix,
`npm install @iln/sdk` resolves with registry packages only.
