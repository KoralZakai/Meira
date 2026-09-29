/**
 * routeFailure — why there is no route, in Google's own words.
 *
 * Koral, 2026-09-22: "why no route for the chosen way of getting there?"
 *
 * The honest answer was that the app did not know. `🚫 No route for the chosen
 * way of getting there` was printed whenever `plan === null`, and plan was null
 * for at least six unrelated reasons that the code collapsed into one string:
 * no key in the bundle, an empty home address, a rejected key, an exhausted
 * quota, a dropped connection, and — the only one the sentence actually claimed
 * — no bus or train at that hour.
 *
 * WHAT THE CONSOLE SAID
 *
 * Her own Google Cloud project, over one day:
 *
 *     Directions API      107 requests    99% errors    9 ms median
 *     Places API            2 requests   100% errors
 *     Maps SDK for Android  3 requests     0% errors
 *     Google Calendar API 2,021 requests   0% errors
 *
 * Nine milliseconds is not a routing engine failing to find a train. It is a
 * rejection at the edge, before any routing happened. The app had never once
 * received a route, and told her there was no train.
 *
 * THE MISSING LINE
 *
 * Google answers "why" in `status` and `error_message` on every Directions
 * response. Neither RoutePlanner nor transitParse ever read either field. The
 * reason was in the reply the whole time and was thrown away on arrival —
 * which is rule 1 of THE SILENT-STATE RULE, in the one place she was asking
 * about.
 *
 * WHAT THIS DOES
 *
 * One classifier, one set of sentences, both languages. Every kind names a
 * DIFFERENT cause and a DIFFERENT thing to do about it, because "there is no
 * train to Ra'anana" and "Google refused the key" are not the same news and
 * must never read the same.
 *
 * Pure: tests/run-route-failure.ts covers every Google status with no device,
 * no network and no Expo runtime.
 */
import type { AppLanguage } from '../types/index';

/**
 * Why a route lookup produced nothing.
 *
 * Ordered roughly from "we never asked" to "we asked and the world said no".
 * Only `no_service` is a fact about transport; every other kind is a fact
 * about us, and saying otherwise is the bug this module exists to kill.
 */
export type RouteFailureKind =
  | 'no_key'       // the bundle shipped without EXPO_PUBLIC_GOOGLE_MAPS_API_KEY
  | 'no_origin'    // no home address — there is nothing to route FROM
  | 'bad_time'     // the arrival stamp did not parse; nothing was ever sent
  | 'denied'       // REQUEST_DENIED — key restriction, or API not enabled
  | 'over_limit'   // OVER_QUERY_LIMIT — quota or billing
  | 'not_found'    // NOT_FOUND — Google cannot place one of the addresses
  | 'invalid'      // INVALID_REQUEST / MAX_ROUTE_LENGTH_EXCEEDED / …
  | 'network'      // fetch threw: no connection, DNS, TLS, timeout
  | 'no_service'   // ZERO_RESULTS — the ONLY "there is genuinely no route"
  | 'unknown';     // a status we have not seen; carried through verbatim

export interface RouteFailure {
  kind: RouteFailureKind;
  /** Google's own `status`, when it answered at all. */
  status?: string;
  /** Google's own `error_message`, or the thrown error's message. */
  detail?: string;
  /** The vehicle that was asked for, when the caller asked for one. */
  mode?: string;
  /** When this was learned, so a stale reason can be recognised as stale. */
  at?: number;
}

/** Google statuses that mean "we asked properly and there is no route". */
const GENUINELY_NONE = new Set(['ZERO_RESULTS']);

/**
 * A Directions response's `status` → why we got nothing.
 *
 * `OK` is not a failure and returns null: a caller that got OK and still has
 * no plans has a parsing problem, not a Google problem, and must not be handed
 * a sentence blaming Google for it.
 */
export function classifyDirectionsStatus(
  status?: string,
  errorMessage?: string,
  mode?: string,
): RouteFailure | null {
  const s = String(status ?? '').toUpperCase();
  if (s === 'OK') return null;
  const base = { status: s || undefined, detail: errorMessage || undefined, mode, at: Date.now() };
  if (GENUINELY_NONE.has(s)) return { ...base, kind: 'no_service' };
  switch (s) {
    case 'REQUEST_DENIED':
      return { ...base, kind: 'denied' };
    // ── statuses the SERVER invents, not Google ──────────────────────────
    // The proxy answers in the same envelope so one classifier covers both
    // hops. A server that cannot ask is not a destination with no bus.
    case 'NO_SERVER_KEY':
      return { ...base, kind: 'no_key' };
    case 'UPSTREAM_ERROR':
    case 'NO_RESULT':
      return { ...base, kind: 'network' };
    case 'BAD_REQUEST':
      return { ...base, kind: 'invalid' };
    case 'OVER_QUERY_LIMIT':
    case 'OVER_DAILY_LIMIT':
      return { ...base, kind: 'over_limit' };
    case 'NOT_FOUND':
      return { ...base, kind: 'not_found' };
    case 'INVALID_REQUEST':
    case 'MAX_ROUTE_LENGTH_EXCEEDED':
    case 'MAX_WAYPOINTS_EXCEEDED':
      return { ...base, kind: 'invalid' };
    case '':
      // No status field at all. That is not a route answer; something else
      // came back down the pipe (a captive portal, an HTML error page).
      return { ...base, kind: 'unknown' };
    default:
      return { ...base, kind: 'unknown' };
  }
}

/** A thrown fetch/parse error → a failure record that keeps the message. */
export function networkFailure(e: unknown, mode?: string): RouteFailure {
  return {
    kind: 'network',
    detail: e instanceof Error ? e.message : String(e),
    mode,
    at: Date.now(),
  };
}

/**
 * The worst of several failures — the one worth telling her about.
 *
 * Three queries run in parallel (rail, bus, unconstrained). If two say
 * ZERO_RESULTS and one says REQUEST_DENIED, "there is no train" is a lie: we
 * never got a real answer from the third. A cause that is about US outranks a
 * cause that is about the timetable, always.
 */
const SEVERITY: Record<RouteFailureKind, number> = {
  denied: 0,
  no_key: 1,
  no_origin: 2,
  over_limit: 3,
  network: 4,
  not_found: 5,
  invalid: 6,
  bad_time: 7,
  unknown: 8,
  no_service: 9,   // least severe: the only one that is genuinely about routes
};

export function worstFailure(
  failures: Array<RouteFailure | null | undefined>,
): RouteFailure | undefined {
  let worst: RouteFailure | undefined;
  for (const f of failures) {
    if (!f) continue;
    if (!worst || SEVERITY[f.kind] < SEVERITY[worst.kind]) worst = f;
  }
  return worst;
}

/** Is this a fact about transport, or a fact about us? */
export function isAboutTransport(f?: RouteFailure): boolean {
  return f?.kind === 'no_service';
}

/**
 * One short line and the action that fixes it, in her language.
 *
 * Every kind reads differently on purpose. CLAUDE.md rule 3: "sign in again"
 * and "enable the API in Google Cloud" are different fixes and must not share
 * a sentence — a check that cannot tell her which one she is looking at ended
 * the investigation last time instead of starting it.
 *
 * `action` is null where there is nothing SHE can do from the phone. A button
 * that cannot help is worse than no button: it invites a tap that changes
 * nothing and teaches her the app is lying.
 */
export function describeRouteFailure(
  f: RouteFailure,
  lang: AppLanguage,
): { text: string; action?: string; fixable: boolean } {
  const he = lang === 'he';
  switch (f.kind) {
    case 'no_service':
      return he
        ? { text: '🚫 אין תחבורה ציבורית לשם בשעה הזאת', action: 'נסי אמצעי אחר', fixable: true }
        : { text: '🚫 No public transport there at that hour', action: 'Try another mode', fixable: true };
    case 'no_origin':
      return he
        ? { text: '🏠 אין כתובת בית — אין מאיפה לחשב מסלול', action: 'קבעי כתובת בית', fixable: true }
        : { text: '🏠 No home address — nothing to plan the route from', action: 'Set home address', fixable: true };
    case 'no_key':
      return he
        ? { text: '🔑 הבילד הזה נבנה בלי מפתח מפות — אי אפשר לחשב מסלולים', fixable: false }
        : { text: '🔑 This build shipped without a Maps key — routes cannot be computed', fixable: false };
    case 'denied':
      return he
        ? { text: '🔑 גוגל דחתה את הבקשה (REQUEST_DENIED) — המפתח לא מורשה ל‑Directions', fixable: false }
        : { text: '🔑 Google refused the request (REQUEST_DENIED) — the key is not authorised for Directions', fixable: false };
    case 'over_limit':
      return he
        ? { text: '⏳ נגמרה המכסה של גוגל — מסלולים יחזרו כשהיא מתאפסת', fixable: false }
        : { text: '⏳ Google quota is used up — routes return when it resets', fixable: false };
    case 'not_found':
      return he
        ? { text: '📍 גוגל לא מזהה את הכתובת הזאת', action: 'תקני את הכתובת', fixable: true }
        : { text: '📍 Google cannot place this address', action: 'Fix the address', fixable: true };
    case 'invalid':
      return he
        ? { text: '⚠️ הבקשה לגוגל לא תקינה — כנראה כתובת או שעה חסרה', action: 'פתחי את המשימה', fixable: true }
        : { text: '⚠️ The request to Google was malformed — likely a missing address or time', action: 'Open the task', fixable: true };
    case 'bad_time':
      return he
        ? { text: '🕗 השעה של המשימה לא נקראה, אז לא נשלחה בקשה', action: 'קבעי שעה', fixable: true }
        : { text: '🕗 The task time could not be read, so nothing was asked', action: 'Set a time', fixable: true };
    case 'network':
      return he
        ? { text: '📡 לא הצלחתי להגיע לגוגל', action: 'נסי שוב', fixable: true }
        : { text: '📡 Could not reach Google', action: 'Try again', fixable: true };
    default:
      return he
        ? { text: `⚠️ גוגל החזירה ${f.status || 'תשובה לא מוכרת'}`, action: 'נסי שוב', fixable: true }
        : { text: `⚠️ Google answered ${f.status || 'something unrecognised'}`, action: 'Try again', fixable: true };
  }
}

/**
 * The same reason as one line for a log — the thing worth grepping for when
 * standing in front of her phone with adb running.
 *
 * `console.warn`, never `console.log`: release builds drop log, and a reason
 * that only exists in a debug build is not a reason she can ever be told.
 */
export function failureLogLine(f: RouteFailure, destination: string): string {
  const bits = [`no route to "${destination}"`, `kind=${f.kind}`];
  if (f.mode) bits.push(`mode=${f.mode}`);
  if (f.status) bits.push(`status=${f.status}`);
  if (f.detail) bits.push(`detail=${f.detail}`);
  return bits.join(' · ');
}
