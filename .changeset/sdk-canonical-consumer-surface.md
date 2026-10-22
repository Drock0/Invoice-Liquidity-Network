---
"@iln/sdk": patch
"@iln/react": patch
---

Make the canonical SDK installable and consistent for consumers (#1220–#1223).

- `@iln/sdk` no longer lists the unpublished `@iln/shared` workspace package as a runtime dependency. It only ever supplied types, and those are now inlined into `dist/*.d.ts`. Before this change, a clean `npm install @iln/sdk` failed with `E404 '@iln/shared@0.1.0'`.
- `@iln/sdk` re-exports the dispute workflow types (`DisputeAnalytics`, `DisputeEvidence`, `DisputeReasonCategory`, `DisputeRecord`, `DisputeResolutionDecision`, `DisputeStatus`). `@iln/react` now imports them from `@iln/sdk` instead of the undeclared `@iln/shared`. These are type-only changes, so the runtime bundles are unchanged.
- Importing the deprecated `@iln/sdk/legacy` subpath now emits a one-time `DeprecationWarning` with code `ILN_SDK_DEP001`. Import from `@iln/sdk` instead; the subpath will be removed in 1.0.0. `sideEffects` lists the legacy bundles so bundlers keep the warning.
