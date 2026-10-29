/**
 * Telling a meeting LINK apart from a PLACE.
 *
 * Google Calendar puts a video-call URL wherever the organiser typed it, and
 * very often that is the `location` field. Lumi treats anything in `location`
 * as somewhere to travel to: it geocodes it, asks Google Directions for a
 * route, computes a leave-home time and sets a WAKE ALARM. For a Zoom call
 * that is nonsense in the most disruptive possible way — an alarm and a bus
 * plan for something you attend from the sofa.
 *
 * The guard lives here so every producer (calendar sync, chat extraction,
 * WhatsApp) is covered by the same rule, and `dayPlanning.addrOf` — the single
 * chokepoint every route goes through — can refuse a URL outright.
 */

/** Video-call hosts worth naming in the UI. Order matters: first match wins. */
const PROVIDERS: Array<[RegExp, string]> = [
  [/zoom\.us|zoomgov\.com/i, 'Zoom'],
  [/meet\.google\.com|hangouts\.google\.com/i, 'Google Meet'],
  [/teams\.microsoft\.com|teams\.live\.com/i, 'Teams'],
  [/whereby\.com/i, 'Whereby'],
  [/webex\.com/i, 'Webex'],
  [/meet\.jit\.si|jitsi/i, 'Jitsi'],
  [/discord\.gg|discord\.com/i, 'Discord'],
  [/slack\.com/i, 'Slack'],
];

/** Anything that is a web address rather than somewhere you can stand. */
const URL_RE = /(https?:\/\/|www\.)\S+/i;
/** Every web address in a blob, not just the first. */
const URL_RE_G = /(https?:\/\/|www\.)\S+/gi;

/**
 * URLs that are emphatically NOT a way to attend a meeting.
 *
 * This list exists because of a real interview. A Comeet invitation carries
 * no `location` field and puts the address in the body — beside a Google MAPS
 * link. `extractMeetingUrl` took the first URL it saw in that body, so the
 * map link became the "meeting link", which made the event a `zoom` category
 * and `isRemoteTask` true. From there `overlapKind.departureOf` returns
 * undefined for a remote task, so an in-person interview in Ra'anana had no
 * departure, no travel leg on the timeline and a 💻 badge.
 *
 * The irony is exact: the code added to FIND the address is what convinced
 * the app she did not have to travel to it.
 */
const NOT_A_MEETING_RE = new RegExp([
  'google\\.[a-z.]+/maps',
  'maps\\.google',
  'maps\\.app\\.goo\\.gl',
  'goo\\.gl/maps',
  'openstreetmap\\.org',
  'waze\\.com',
  'apple\\.com/maps',
  'mailto:',
  'tel:',
  'unsubscribe',
  'calendar\\.google\\.[a-z.]+',
  'mail\\.google\\.com',
].join('|'), 'i');

/** Is this URL a known way to JOIN a call? */
function isConferenceUrl(url: string): boolean {
  return PROVIDERS.some(([re]) => re.test(url));
}

/** True when `text` is a link, not a place. Used to refuse it as a route target. */
export function isMeetingLink(text?: string | null): boolean {
  if (!text) return false;
  const s = String(text).trim();
  if (!s) return false;
  // A bare "zoom" is a hint, not a link — someone may genuinely be going to a
  // room called that. Only an actual URL counts.
  return URL_RE.test(s);
}

/** Tidy a matched URL: drop trailing prose punctuation, force a scheme. */
function cleanUrl(raw: string): string {
  const url = raw.replace(/[),.;\]]+$/, '');
  return url.startsWith('http') ? url : `https://${url}`;
}

/**
 * The first URL inside a free-text blob that could actually be a meeting.
 *
 * Skips map links, mailto:, tel: and the rest of NOT_A_MEETING_RE, and scans
 * EVERY url in each source rather than stopping at the first — an invitation
 * whose first link is a map and whose second is a Zoom room has a Zoom room.
 */
export function extractMeetingUrl(...sources: Array<string | null | undefined>): string | undefined {
  for (const src of sources) {
    if (!src) continue;
    for (const match of String(src).match(URL_RE_G) ?? []) {
      const url = cleanUrl(match);
      if (NOT_A_MEETING_RE.test(url)) continue;
      return url;
    }
  }
  return undefined;
}

/**
 * The join link for a calendar event, read from the two places it can hide.
 *
 * The two sources are NOT equivalent, and treating them as one is what broke
 * the Ceva interview:
 *
 *   location     — the organiser typed a URL where the venue goes. That is a
 *                  deliberate "this happens online", so any link counts.
 *   description  — free prose. An invitation body legitimately contains map
 *                  links, reply-to addresses, careers pages and unsubscribe
 *                  footers. Only a RECOGNISED conferencing host counts here;
 *                  guessing from prose is how a map became a meeting.
 */
export function meetingUrlFromEvent(
  location?: string | null,
  description?: string | null,
): string | undefined {
  const fromLocation = extractMeetingUrl(location);
  if (fromLocation) return fromLocation;
  for (const match of String(description ?? '').match(URL_RE_G) ?? []) {
    const url = cleanUrl(match);
    if (NOT_A_MEETING_RE.test(url)) continue;
    if (isConferenceUrl(url)) return url;
  }
  return undefined;
}

/** "Zoom" / "Google Meet" / … for display, or undefined when it is a plain link. */
export function meetingProvider(url?: string | null): string | undefined {
  if (!url) return undefined;
  for (const [re, name] of PROVIDERS) if (re.test(url)) return name;
  return undefined;
}

/**
 * "Microsoft Teams Meeting" is what Outlook writes into `location` for every
 * Teams call. It is not a URL, so isMeetingLink passes it, and it would be
 * geocoded, routed and given a wake alarm — the map-link bug in a new coat
 * (CLAUDE.md rule 8). A location that only names a video service is not a place.
 *
 * Lives here, not in calendarEventTask (which re-exports it), because
 * isRemoteTask below needs it and calendarEventTask already imports this file.
 */
const ONLINE_PLACE_RE =
  // A preposition is part of how people write it: "בזום", "on Zoom", "via Teams".
  /^\s*(?:(?:on|via|by|over)\s+|ב[-־]?|דרך\s+)?(microsoft\s+teams(\s+meeting)?|teams(\s+meeting)?|zoom(\s+meeting)?|google\s+meet|webex|skype(\s+meeting)?|online|virtual|remote|phone|video(\s+call)?|אונליין|זום|טימס|מקוון|טלפון|וידאו)\s*$/i;

export function isOnlineOnlyPlace(location?: string | null): boolean {
  if (!location) return false;
  return ONLINE_PLACE_RE.test(location) || isMeetingLink(location);
}

/** A place she would have to travel to — not a link, not "Teams Meeting". */
function hasPhysicalPlace(location: unknown): boolean {
  const l: any = location;
  const text = String((typeof l === 'string' ? l : (l?.address || l?.displayName)) ?? '').trim();
  return Boolean(text) && !isOnlineOnlyPlace(text);
}

/**
 * Can this be done from anywhere? A task with a video link needs no travel,
 * which is what makes it the flexible half of a clash: the call can happen on
 * the way to the thing that does need a place.
 *
 * A 'call' or 'zoom' CATEGORY only counts when nothing says otherwise. The
 * category is a guess; an address is a fact. On 30.9 "AI Performance
 * Engineering meetup" was filed as a call with Sarona Market as its place, so
 * the app treated an evening she had to cross town for as something she could
 * do from anywhere — and a two-hour business plan laid over it was called
 * "parallel" and never shown, while the server reported the same overlap.
 */
export function isRemoteTask(task: { meetingUrl?: string; category?: string; location?: unknown }): boolean {
  if (task.meetingUrl) return true;
  if (typeof task.location === 'string' && isMeetingLink(task.location)) return true;
  if (task.category === 'zoom' || task.category === 'call') return !hasPhysicalPlace(task.location);
  return false;
}
