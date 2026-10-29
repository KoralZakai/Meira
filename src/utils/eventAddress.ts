import { namesACity } from './addressCompletion';

/**
 * Getting a PLACE out of a calendar event that has no `location` field.
 *
 * Koral's Ceva interview, 23/09/2026, is the case this exists for. The event
 * was on her calendar, she had accepted it, and Lumi still planned no route,
 * no leave-home time and no alarm — because the organiser (Comeet / Spark
 * Hire, and every other recruiting system that mails an invite) puts the
 * address in the BODY and leaves Google's own `location` field empty:
 *
 *   |  7 HaPnina Street, Ra'anana, Center District
 *   [ ](https://www.google.com/maps/place/7+HaPnina+Street%2C+Ra%27anana%2C+...)
 *
 * `addrOf` — the one chokepoint every route flows through — reads
 * `task.location`. Empty there means the whole travel chain is skipped in
 * silence, which is the worst possible failure for an interview.
 *
 * Two sources, most deliberate first:
 *  1. A Google Maps link in the body. The organiser put it there ON PURPOSE to
 *     say "here is where you are going" — it is the highest-confidence signal
 *     in the whole email, and it is machine-readable.
 *  2. A labelled line ("Address: …", "כתובת: …").
 *
 * Deliberately NOT guessing at unlabelled prose: an invented address gets
 * geocoded, routed and given a wake alarm, and a confident wrong place is
 * worse than no place — that is the same rule meetingLink enforces for URLs.
 */

/** Google Maps URL shapes that carry a query we can read back out. */
const MAP_PATTERNS: RegExp[] = [
  // .../maps/place/7+HaPnina+Street%2C+Ra'anana
  /https?:\/\/(?:www\.)?google\.[a-z.]+\/maps\/place\/([^/?\s)\]]+)/i,
  // .../maps/search/?api=1&query=... and .../maps?q=...
  /https?:\/\/(?:www\.)?google\.[a-z.]+\/maps[^\s)\]]*[?&](?:query|q)=([^&\s)\]]+)/i,
  // maps.google.com/?q=...
  /https?:\/\/maps\.google\.[a-z.]+\/[^\s)\]]*[?&]q=([^&\s)\]]+)/i,
];

/** "Address:" / "Location:" / "Venue:" and their Hebrew equivalents. */
const LABEL_RE =
  /(?:^|\n)\s*(?:address|location|venue|where|כתובת|מיקום|מקום|איפה)\s*[:：-]\s*(.+)/i;

/** Decode one captured map query into readable text, or '' when it is junk. */
function decodeQuery(raw: string): string {
  let text = raw;
  try {
    text = decodeURIComponent(raw);
  } catch {
    // A stray '%' in the URL makes decodeURIComponent throw; the raw form with
    // '+' unpacked is still better than nothing.
  }
  return text.replace(/\+/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Strip the decoration mail templates wrap a line in: leading table pipes,
 * markdown bullets, trailing whitespace. "|  7 HaPnina Street, Ra'anana" is
 * one line of an HTML table Google flattened into text.
 */
function cleanLine(line: string): string {
  return line
    .replace(/^[\s|>*•\-–—]+/, '')
    .replace(/[\s|]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Too short to be a place, or so long it is a paragraph rather than an address. */
function plausible(text: string): boolean {
  if (text.length < 4 || text.length > 160) return false;
  // A bare coordinate pair is a place; anything else needs a letter in it.
  if (/^-?\d{1,3}\.\d+\s*,\s*-?\d{1,3}\.\d+$/.test(text)) return true;
  return /[a-z֐-׿]/i.test(text);
}

/**
 * The address an event's description points at, or undefined.
 *
 * Never returns a meeting link: the map patterns only match Google Maps hosts,
 * and a labelled line carrying a URL is rejected outright.
 */
export function addressFromDescription(description?: string | null): string | undefined {
  const body = String(description || '');
  if (!body.trim()) return undefined;

  for (const pattern of MAP_PATTERNS) {
    const match = body.match(pattern);
    if (!match?.[1]) continue;
    const text = cleanLine(decodeQuery(match[1]));
    if (plausible(text)) return text;
  }

  const labelled = body.match(LABEL_RE);
  if (labelled?.[1]) {
    const text = cleanLine(labelled[1]);
    // "Location: https://zoom.us/j/…" is a link, not somewhere to stand.
    if (plausible(text) && !/https?:\/\//i.test(text)) return text;
  }

  return undefined;
}

/**
 * An address the TITLE spells out — "סרט ברציף רחוב הגליל 6 תל אביב" (18.10, Koral).
 *
 * She typed the venue straight into the event's title and left `location` and the
 * description empty, so every reader above found nothing: no place, no route, no
 * leave time — and nothing said so. Not a guess: this takes ONLY a street the title
 * names with its own word (רחוב / רח׳ / Street) and a house number; a title that
 * merely mentions a place ("ארוחה ברציף") is still no address. The city, when the
 * title gives one the app knows, rides along so the geocoder does not pick another
 * town's street of the same name.
 */
const HE_STREET_RE =
  /(?:^|[\s,(])(?:ב)?(?:רחוב|רח['׳])\s+([\u0590-\u05FF'"׳-]+(?:\s[\u0590-\u05FF'"׳-]+)?)\s+(\d{1,3}[א-ת]?)(?![\d])(?:\s*,?\s*(?:ב)?([\u0590-\u05FF-]+(?:\s[\u0590-\u05FF-]+)?))?/;
const EN_STREET_RE =
  /\b(\d{1,3})\s+([A-Z][\w'.-]*(?:\s[A-Z][\w'.-]*)?)\s+(?:Street|St|Road|Rd|Avenue|Ave|Blvd|Boulevard)\b\.?(?:,?\s*([A-Z][\w'-]*(?:\s[A-Z][\w'-]*)?))?/;

export function addressFromTitle(title?: string | null): string | undefined {
  const text = String(title || '');
  const he = text.match(HE_STREET_RE);
  if (he) {
    const [, street, num, tail] = he;
    // The tail is a city only when the app knows it; a word after the number that is not one
    // ("... 6 בשבע") is dropped, not sent to the geocoder as part of the address.
    const words = tail ? tail.trim().split(/\s+/) : [];
    const city = [words.join(' '), words[0]].find((c) => c && namesACity(c)) ?? '';
    return `${street.trim()} ${num}${city ? `, ${city}` : ''}`;
  }
  const en = text.match(EN_STREET_RE);
  if (en) return en[0].replace(/\s+/g, ' ').trim();
  return undefined;
}
