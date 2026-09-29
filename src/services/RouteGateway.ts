/**
 * RouteGateway — where route questions get asked from.
 *
 * `RoutePlanner` must stay free of expo-* imports: it is the one network
 * module that also runs in a plain node harness (tests/run-week-schedule.ts
 * hits the real Directions API). `LumiServer` reaches SupabaseAuthService,
 * which does not run there. So RoutePlanner takes its transport as a value,
 * and this is the value the app installs at startup.
 *
 * WHY THE PHONE NO LONGER ASKS GOOGLE DIRECTLY
 *
 * The Maps key compiled into the APK is restricted to `com.lumi.app` + a SHA-1
 * fingerprint. Google enforces that through the `X-Android-Package` and
 * `X-Android-Cert` headers, which ONLY the Maps SDK sends — a plain `fetch()`
 * sends neither, so every Directions call came back REQUEST_DENIED. Her
 * console: 107 requests, 99% errors, 9 ms median. The restriction is correct
 * and stays; what changes is who asks.
 *
 * The server already holds an unrestricted `GOOGLE_MAPS_API_KEY` Fly secret
 * and already proxies Geocoding for exactly this reason (`POST /app/geocode`).
 * This adds the Directions half.
 *
 * ONE ROUND TRIP. The chain asks rail, bus and unconstrained for every stop.
 * Those three used to be three separate calls to Google from the phone; they
 * are now one call to the server, which fans out concurrently and caches.
 *
 * Trigger: installed by App.tsx at startup, before any sync can run.
 */
import { getSession } from './SupabaseAuthService';
import { setDirectionsGateway } from './RoutePlanner';

const SERVER_URL = process.env.EXPO_PUBLIC_SERVER_URL || '';

/** A route lookup is a person waiting. Shorter than the extract budgets. */
const ROUTE_TIMEOUT_MS = 15_000;

export interface DirectionsQuery {
  /** Widened to string so this matches RoutePlanner.DirectionsGateway exactly;
   *  the SERVER is what validates the value, and refuses anything else. */
  mode: string;
  transit_mode?: string;
  depart_epoch?: number;
}

export interface DirectionsResult {
  status: string;
  error_message?: string;
  /** Google's own response body, or null when the status was not OK. */
  data: any | null;
  cached?: boolean;
}

export interface DirectionsRequest {
  origin: string;
  destination: string;
  date: string;
  arriveBy?: string;
  queries: DirectionsQuery[];
}

/**
 * Ask the server for several route queries at once.
 *
 * Throws rather than returning a value on transport failure: the caller
 * (RoutePlanner) turns a throw into a typed `network` RouteFailure, and a
 * thrown error carries the message an empty array cannot.
 */
export async function askServerForDirections(
  req: DirectionsRequest,
): Promise<DirectionsResult[]> {
  if (!SERVER_URL) throw new Error('no EXPO_PUBLIC_SERVER_URL in this build');

  const token = (await getSession().catch(() => null))?.access_token;
  // Signed out is a real, nameable state — not a missing bus.
  if (!token) throw new Error('signed out — the server cannot know who is asking');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ROUTE_TIMEOUT_MS);
  try {
    const res = await fetch(`${SERVER_URL}/app/route/directions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        origin: req.origin,
        destination: req.destination,
        date: req.date,
        arrive_by: req.arriveBy,
        queries: req.queries,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = (await res.text().catch(() => '')).slice(0, 200);
      throw new Error(`server said ${res.status} ${body}`);
    }
    const json = await res.json();
    const results = json?.results;
    if (!Array.isArray(results)) throw new Error('server returned no results array');
    return results as DirectionsResult[];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Point RoutePlanner at the server. Idempotent.
 *
 * Called at MODULE SCOPE, not from a `useEffect` — the same requirement as
 * `TaskManager.defineTask` in CalendarAutoSync. A headless background sync can
 * start the JS runtime without ever mounting a component, and a route lookup
 * that ran before a hook fired would fall through to the direct path and be
 * refused by Google, silently, exactly as before. Name the trigger (rule 7):
 * this one is "the bundle was loaded at all".
 */
export function installRouteGateway(): void {
  setDirectionsGateway(askServerForDirections);
}
