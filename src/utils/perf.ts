/**
 * Wall-clock marks for the paths she feels as "slow": Today's first paint and
 * the voice turn (19.10, before/after numbers for the speed work).
 *
 * console.warn on purpose — release builds drop console.log, and these are
 * read from her phone with `adb logcat -s ReactNativeJS:V | grep '\[Perf\]'`.
 *
 * APP_T0 is taken when this module is first imported; App.tsx imports it
 * first thing, so "+app" is roughly "since the JS bundle started".
 */
export const APP_T0 = Date.now();

let firstPaintLogged = false;

export function perfMark(label: string, since: number): void {
  console.warn(`[Perf] ${label} ${Date.now() - since}ms`);
}

/** Once per app run: the first time Today drew real rows. */
export function perfFirstPaint(label: string): void {
  if (firstPaintLogged) return;
  firstPaintLogged = true;
  console.warn(`[Perf] first paint (${label}) +app ${Date.now() - APP_T0}ms`);
}
