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
import { FALLBACK_PLACE, INK, Sky, skyFor, sunTimes, washedSky } from '../../utils/skyGradient';
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

export function useSky(): Sky & { ink: string } {
  const [minute, setMinute] = React.useState(nowMinutes);
  const [place, setPlace] = React.useState<Place>(FALLBACK_PLACE);
  React.useEffect(() => {
    let alive = true;
    home().then((p) => { if (alive) setPlace(p); });
    const tick = () => setMinute((m) => (m === nowMinutes() ? m : nowMinutes()));
    // A minute-resolution sky: one tick a minute, none while the app is in the background.
    let t: ReturnType<typeof setInterval> | null = setInterval(tick, 60 * 1000);
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') { tick(); if (!t) t = setInterval(tick, 60 * 1000); }
      else if (t) { clearInterval(t); t = null; }
    });
    return () => { alive = false; if (t) clearInterval(t); sub.remove(); };
  }, []);
  return React.useMemo(() => {
    const sky = skyFor(minute, sunTimes(new Date(), place.lat, place.lng));
    return { ...sky, ink: sky.dark ? INK.light : INK.dark };
  }, [minute, place.lat, place.lng]);
}

export default function SkyBackdrop({ sky }: { sky: Sky }) {
  return <LinearGradient colors={sky.colors} style={StyleSheet.absoluteFill} pointerEvents="none" />;
}

/**
 * The washed sky for screens drawn for cream (menu, review, agents, focus, leave
 * now, …): the hour's hue at 15%, so their dark text keeps ≥ 4.5:1 all day
 * (tests/run-sky-wash.ts) and every screen still follows the time of day.
 */
export function WashedSky() {
  const sky = useSky();
  const colors = React.useMemo(() => washedSky(sky), [sky]);
  return <LinearGradient colors={colors} style={StyleSheet.absoluteFill} pointerEvents="none" />;
}
