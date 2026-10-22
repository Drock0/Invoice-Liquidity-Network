/**
 * Runtime migration warnings for deprecated SDK surface (issue #1222).
 *
 * Each deprecated surface has a stable code. Importing or calling it emits one
 * warning per process through `process.emitWarning` (type
 * `DeprecationWarning`), so Node's own controls apply: `--no-deprecation`
 * silences it, `--trace-deprecation` adds a stack, `--throw-deprecation` makes
 * it fatal, and `process.on('warning')` lets an operator count usage by
 * `warning.code`. Runtimes without `process.emitWarning` (browsers, React
 * Native) get a single `console.warn` instead.
 *
 * This module is only imported by deprecated entry points, so it adds nothing
 * to the main `@iln/sdk` bundle. `scripts/check-sdk-deprecations.mjs` keeps
 * this registry, the entry points and docs/sdk-migration-guide.md in step.
 */

export interface DeprecatedSurface {
  /** Stable warning code, also the `code` on the emitted warning. */
  code: string;
  /** The deprecated import path or API, as a consumer would write it. */
  surface: string;
  /** What to use instead. */
  replacement: string;
  /** First `@iln/sdk` version that no longer ships the surface. */
  removedIn: string;
}

export const DEPRECATED_SURFACES: readonly DeprecatedSurface[] = Object.freeze([
  {
    code: 'ILN_SDK_DEP001',
    surface: '@iln/sdk/legacy',
    replacement: "import from '@iln/sdk' (the exports are identical)",
    removedIn: '1.0.0',
  },
]);

export const MIGRATION_GUIDE_URL =
  'https://github.com/Invoice-Liquidity-Network/Invoice-Liquidity-Network/blob/dev/docs/sdk-migration-guide.md#deprecated-sdk-surface';

// Shared through the global symbol registry so that two copies of the SDK in
// one process (e.g. the root bundle and the legacy bundle) still warn once.
const EMITTED = Symbol.for('iln.sdk.deprecations.emitted');

type WarningSink = {
  emitWarning?: (message: string, options: { type: string; code: string }) => void;
};

function emittedCodes(): Set<string> {
  const g = globalThis as unknown as Record<symbol, Set<string> | undefined>;
  return (g[EMITTED] ??= new Set<string>());
}

/** Builds the warning text for a deprecated surface. */
export function formatDeprecationMessage(entry: DeprecatedSurface): string {
  return (
    `${entry.surface} is deprecated and will be removed in @iln/sdk ${entry.removedIn}. ` +
    `Migrate: ${entry.replacement}. See ${MIGRATION_GUIDE_URL}`
  );
}

/**
 * Emits the migration warning for `code` once per process.
 *
 * @returns `true` if a warning was emitted by this call, `false` if it had
 *   already been emitted.
 * @throws TypeError for a code that is not in {@link DEPRECATED_SURFACES}.
 */
export function emitDeprecationWarning(code: string): boolean {
  const entry = DEPRECATED_SURFACES.find((s) => s.code === code);
  if (!entry) {
    throw new TypeError(`Unknown @iln/sdk deprecation code: ${code}`);
  }
  const emitted = emittedCodes();
  if (emitted.has(code)) return false;
  emitted.add(code);

  const message = formatDeprecationMessage(entry);
  const proc = (globalThis as { process?: WarningSink }).process;
  if (proc && typeof proc.emitWarning === 'function') {
    proc.emitWarning(message, { type: 'DeprecationWarning', code });
  } else if (typeof console !== 'undefined' && typeof console.warn === 'function') {
    console.warn(`DeprecationWarning [${code}]: ${message}`);
  }
  return true;
}

/** Re-arms every warning, e.g. between test cases. */
export function resetDeprecationWarnings(): void {
  emittedCodes().clear();
}
