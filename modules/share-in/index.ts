/**
 * ShareIn — JS side of "Share → Meira" (the Kotlin is in ./android).
 *
 * Present only in an EAS / dev-client build made after 27.10. Anywhere else the
 * calls say so — `{ ok: false, reason: 'native_unavailable' }` — instead of
 * reading as "nothing was shared" (silent-state rule 1). Nothing here throws,
 * and nothing here logs the shared text: it may be health data.
 */

type RawNative = {
  takeShared(): string | null;
  addListener(event: 'onShare', cb: (e: { text?: string }) => void): { remove(): void };
};

let cached: RawNative | null | undefined;

function native(): RawNative | null {
  if (cached !== undefined) return cached;
  cached = null;
  const nav = (globalThis as { navigator?: { product?: string } }).navigator;
  if (!nav || nav.product !== 'ReactNative') return cached;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const core = require('expo-modules-core') as {
      requireOptionalNativeModule?: <T>(name: string) => T | null;
    };
    cached = core.requireOptionalNativeModule?.<RawNative>('ShareIn') ?? null;
  } catch (e) {
    console.warn('[ShareIn] native module could not be loaded:', String((e as Error)?.message ?? e).slice(0, 120));
  }
  return cached;
}

export type ShareResult =
  | { ok: true; text: string | null }
  | { ok: false; reason: 'native_unavailable' | `native_error:${string}` };

/** The share that opened the app, once. `text: null` = opened normally. */
export function takeShared(): ShareResult {
  const mod = native();
  if (!mod) return { ok: false, reason: 'native_unavailable' };
  try {
    return { ok: true, text: mod.takeShared() ?? null };
  } catch (e) {
    const msg = String((e as Error)?.message ?? e).slice(0, 120);
    console.warn('[ShareIn] takeShared failed:', msg);
    return { ok: false, reason: `native_error:${msg}` };
  }
}

/** A share while the app is already open. -> unsubscribe (a no-op when the module is absent). */
export function onShare(cb: (text: string) => void): () => void {
  const mod = native();
  if (!mod) return () => {};
  try {
    const sub = mod.addListener('onShare', (e) => { if (e?.text) cb(e.text); });
    return () => sub.remove();
  } catch (e) {
    console.warn('[ShareIn] listener not attached:', String((e as Error)?.message ?? e).slice(0, 120));
    return () => {};
  }
}
