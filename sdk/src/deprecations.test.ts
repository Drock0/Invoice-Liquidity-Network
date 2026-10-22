import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { compareVersions, SDK_VERSION } from './compatibility';
import {
  DEPRECATED_SURFACES,
  MIGRATION_GUIDE_URL,
  emitDeprecationWarning,
  formatDeprecationMessage,
  resetDeprecationWarnings,
} from './deprecations';

const LEGACY = 'ILN_SDK_DEP001';

describe('deprecation warnings (#1222)', () => {
  let emitWarning: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    resetDeprecationWarnings();
    emitWarning = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetDeprecationWarnings();
  });

  describe('success', () => {
    it('emits a Node DeprecationWarning carrying the stable code', () => {
      expect(emitDeprecationWarning(LEGACY)).toBe(true);
      expect(emitWarning).toHaveBeenCalledTimes(1);
      const [message, options] = emitWarning.mock.calls[0];
      expect(options).toEqual({ type: 'DeprecationWarning', code: LEGACY });
      expect(message).toContain('@iln/sdk/legacy is deprecated');
      expect(message).toContain('removed in @iln/sdk 1.0.0');
      expect(message).toContain("import from '@iln/sdk'");
      expect(message).toContain(MIGRATION_GUIDE_URL);
    });

    it('fires when the deprecated @iln/sdk/legacy entry point is imported', async () => {
      vi.resetModules();
      const legacy = await import('./legacy-imports');
      expect(typeof legacy.ILNSdk).toBe('function');
      expect(emitWarning).toHaveBeenCalledWith(expect.stringContaining('@iln/sdk/legacy'), {
        type: 'DeprecationWarning',
        code: LEGACY,
      });
    });

    it('does not fire for the canonical @iln/sdk entry point', async () => {
      vi.resetModules();
      await import('./index');
      expect(emitWarning).not.toHaveBeenCalled();
    });
  });

  describe('failure', () => {
    it('rejects an unknown code without recording it', () => {
      expect(() => emitDeprecationWarning('ILN_SDK_DEP999')).toThrow(TypeError);
      expect(emitWarning).not.toHaveBeenCalled();
      expect(emitDeprecationWarning(LEGACY)).toBe(true);
    });

    it('falls back to console.warn when process.emitWarning is unavailable', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const original = process.emitWarning;
      (process as { emitWarning?: unknown }).emitWarning = undefined;
      try {
        expect(emitDeprecationWarning(LEGACY)).toBe(true);
      } finally {
        process.emitWarning = original;
      }
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toMatch(/^DeprecationWarning \[ILN_SDK_DEP001\]: /);
    });
  });

  describe('replay / restart', () => {
    it('warns once per process however often the surface is used', () => {
      expect(emitDeprecationWarning(LEGACY)).toBe(true);
      expect(emitDeprecationWarning(LEGACY)).toBe(false);
      expect(emitDeprecationWarning(LEGACY)).toBe(false);
      expect(emitWarning).toHaveBeenCalledTimes(1);
    });

    it('stays deduplicated across a second copy of the module', async () => {
      emitDeprecationWarning(LEGACY);
      vi.resetModules();
      const fresh = await import('./deprecations');
      expect(fresh.emitDeprecationWarning(LEGACY)).toBe(false);
      expect(emitWarning).toHaveBeenCalledTimes(1);
    });

    it('warns again after a reset (a restarted process)', () => {
      emitDeprecationWarning(LEGACY);
      resetDeprecationWarnings();
      expect(emitDeprecationWarning(LEGACY)).toBe(true);
      expect(emitWarning).toHaveBeenCalledTimes(2);
    });
  });

  describe('boundary conditions', () => {
    it('honours --no-deprecation through Node itself', async () => {
      emitWarning.mockRestore();
      const seen: Error[] = [];
      const listener = (w: Error) => seen.push(w);
      process.on('warning', listener);
      const previous = process.noDeprecation;
      process.noDeprecation = true;
      try {
        expect(emitDeprecationWarning(LEGACY)).toBe(true);
        await new Promise((r) => setImmediate(r));
      } finally {
        process.noDeprecation = previous;
        process.off('warning', listener);
      }
      expect(seen).toEqual([]);
    });

    it('is observable by code through process.on("warning")', async () => {
      emitWarning.mockRestore();
      const seen: Array<Error & { code?: string }> = [];
      const listener = (w: Error) => seen.push(w);
      process.on('warning', listener);
      try {
        emitDeprecationWarning(LEGACY);
        await new Promise((r) => setImmediate(r));
      } finally {
        process.off('warning', listener);
      }
      expect(seen.map((w) => [w.name, w.code])).toEqual([['DeprecationWarning', LEGACY]]);
    });

    it('keeps the registry well-formed and ahead of the current version', () => {
      const codes = DEPRECATED_SURFACES.map((s) => s.code);
      expect(new Set(codes).size).toBe(codes.length);
      for (const entry of DEPRECATED_SURFACES) {
        expect(entry.code).toMatch(/^ILN_SDK_DEP\d{3}$/);
        expect(entry.replacement.length).toBeGreaterThan(0);
        // A surface still shipped at or past its removal version is overdue.
        expect(compareVersions(entry.removedIn, SDK_VERSION)).toBe(1);
        expect(formatDeprecationMessage(entry)).toContain(entry.surface);
      }
      expect(Object.isFrozen(DEPRECATED_SURFACES)).toBe(true);
    });
  });
});
