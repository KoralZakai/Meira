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

/** True when `text` is a link, not a place. Used to refuse it as a route target. */
export function isMeetingLink(text?: string | null): boolean {
  if (!text) return false;
  const s = String(text).trim();
  if (!s) return false;
  // A bare "zoom" is a hint, not a link — someone may genuinely be going to a
  // room called that. Only an actual URL counts.
  return URL_RE.test(s);
}

/** The first URL inside a free-text blob, or undefined. */
export function extractMeetingUrl(...sources: Array<string | null | undefined>): string | undefined {
  for (const src of sources) {
    if (!src) continue;
    const match = String(src).match(URL_RE);
    if (match) {
      const url = match[0].replace(/[),.;]+$/, ''); // trailing punctuation from prose
      return url.startsWith('http') ? url : `https://${url}`;
    }
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
 * Can this be done from anywhere? A task with a video link needs no travel,
 * which is what makes it the flexible half of a clash: the call can happen on
 * the way to the thing that does need a place.
 */
export function isRemoteTask(task: { meetingUrl?: string; category?: string; location?: unknown }): boolean {
  if (task.meetingUrl) return true;
  if (typeof task.location === 'string' && isMeetingLink(task.location)) return true;
  return task.category === 'zoom' || task.category === 'call';
}
