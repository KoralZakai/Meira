/**
 * SkyBackdrop — the time-of-day sky behind every v3 screen (canvas v4, 28.10).
 *
 * Koral: "all screens the same design, changing with the time of day". Today
 * drew the sky itself; the chat home, Trips and Tasks were flat cream. One
 * hook + one backdrop, so no screen can drift: the same real sunrise/sunset at
 * home (Tel Aviv when no home is saved — a background, not a fact), the same
 * minute tick, the same ink for text drawn straight on the sky.
 *
 * Trigger (rule 7): a tick a minute while the app is active, and at once when
 * it comes back to the foreground.
 */
import React from 'react';
import { AppState, StyleSheet } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { StatusBar } from 'expo-status-bar';
import { FALLBACK_PLACE, INK, NIGHT, Sky, skyFor, sunTimes, washedSky } from '../../utils/skyGradient';
import { nightNow, THEME_NIGHT } from '../../constants/theme';
import { reloadAppAsync } from 'expo';
import { loadProfile } from '../../services/UserProfileStorage';

/** Five-minute steps: a colour change per minute is invisible, a re-render per minute is not free. */
function nowMinutes(): number {
  const d = new Date();
  const m = d.getHours() * 60 + d.getMinutes();
  return m - (m % 5);
}

type Place = { lat: number; lng: number };
/** Read once per app run and shared by every screen (one decrypt, not four). */
let homePlace: Promise<Place> | null = null;
function home(): Promise<Place> {
  if (!homePlace) {
    homePlace = loadProfile()
      .then((p: any) => {
        // The stored profile keeps `homeLatLng`; older shapes had homeLat/homeLng.
        const ll = p?.homeLatLng ?? (p?.homeLat && p?.homeLng ? { lat: p.homeLat, lng: p.homeLng } : null);
        return ll && ll.lat && ll.lng ? { lat: ll.lat, lng: ll.lng } : FALLBACK_PLACE;
      })
      .catch((e) => {
        console.warn('[SkyBackdrop] profile unavailable, using Tel Aviv sky', e);
        homePlace = null;   // try again on the next mount
        return FALLBACK_PLACE;
      });
  }
  return homePlace;
}

/**
 * ONE clock for every screen and row (night mode reaches into each list row,
 * so a timer per caller would be dozens): a minute tick while the app is
 * active, a tick at once when it comes back, none in the background.
 */
const listeners = new Set<() => void>();
let shared = nowMinutes();
let timer: ReturnType<typeof setInterval> | null = null;
let appSub: { remove: () => void } | null = null;
function tick() {
  const m = nowMinutes();
  if (m !== shared) { shared = m; listeners.forEach((l) => l()); }
}
function subscribe(l: () => void) {
  listeners.add(l);
  if (!appSub) {
    timer = setInterval(tick, 60 * 1000);
    appSub = AppState.addEventListener('change', (s) => {
      if (s === 'active') { tick(); if (!timer) timer = setInterval(tick, 60 * 1000); }
      else if (timer) { clearInterval(timer); timer = null; }
    });
  }
  return () => {
    listeners.delete(l);
    if (!listeners.size) { if (timer) clearInterval(timer); timer = null; appSub?.remove(); appSub = null; }
  };
}

let placeNow: Place = FALLBACK_PLACE;
export function useSky(): Sky & { ink: string } {
  const minute = React.useSyncExternalStore(subscribe, () => shared);
  const [place, setPlace] = React.useState<Place>(placeNow);
  React.useEffect(() => {
    let alive = true;
    home().then((p) => { placeNow = p; if (alive) setPlace(p); });
    return () => { alive = false; };
  }, []);
  return React.useMemo(() => {
    const sky = skyFor(minute, sunTimes(new Date(), place.lat, place.lng));
    // The palette of this run decides light vs dark (constants/theme), so the
    // sky can never be dark under day cards or light under night ones.
    const out = THEME_NIGHT && !sky.dark ? { ...sky, phase: 'night' as const, colors: NIGHT } : sky;
    return { ...out, dark: THEME_NIGHT, ink: THEME_NIGHT ? INK.light : INK.dark };
  }, [minute, place.lat, place.lng]);
}

/** True while the sky is dark — the screens switch to the night palette (constants/nightTone). */
export function useNight(): boolean {
  return THEME_NIGHT;
}

export default function SkyBackdrop({ sky }: { sky: Sky }) {
  return (
    <>
      <LinearGradient colors={sky.colors} style={StyleSheet.absoluteFill} pointerEvents="none" />
    </>
  );
}

/**
 * The phone's own status bar (clock, battery) follows the sky: dark icons by
 * day, light ones at night — 28.10 "you cannot see the clock" (dark on navy).
 * Screens drawn on cream (WashedSky) push dark icons over it while open.
 */
export function SkyStatusBar() {
  // Trigger (rule 7): when she comes back to the app after at least a minute
  // away — if the sky crossed dusk or dawn since this run's palette was chosen,
  // reload once so every screen changes together. A quick hop out (Google
  // sign-in, a picker, the camera) never reloads: its result would be lost.
  React.useEffect(() => {
    let leftAt = 0;
    const check = () => {
      if (Date.now() - leftAt < 60 * 1000) return;
      if (nightNow() === THEME_NIGHT) return;
      // Expo's own reload — it works in a release build (RN's DevSettings.reload does not).
      reloadAppAsync(THEME_NIGHT ? 'theme:day' : 'theme:night')
        .catch((e) => console.warn('[Theme] could not switch day/night', e));
    };
    const sub = AppState.addEventListener('change', (st) => {
      if (st === 'active') check(); else if (st === 'background') leftAt = Date.now();
    });
    return () => sub.remove();
  }, []);
  return <StatusBar style={THEME_NIGHT ? 'light' : 'dark'} />;
}

/**
 * The washed sky for screens drawn for cream (menu, review, agents, focus, leave
 * now, …): the hour's hue at 15%, so their dark text keeps ≥ 4.5:1 all day
 * (tests/run-sky-wash.ts) and every screen still follows the time of day.
 */
export function WashedSky() {
  const sky = useSky();
  const colors = React.useMemo(() => washedSky(sky), [sky]);
  // At night the whole palette is dark, so these screens get the night ground too.
  return <LinearGradient colors={THEME_NIGHT ? NIGHT : colors} style={StyleSheet.absoluteFill} pointerEvents="none" />;
}


