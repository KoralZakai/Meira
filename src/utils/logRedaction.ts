/**
 * logRedaction — what the app is allowed to say out loud.
 *
 * 236 console statements ship in the release bundle, and on this build they
 * reach logcat: that is how the `.select('id')` regression was caught one
 * minute after install, and it is worth keeping. But the same channel has been
 * carrying things it should not — the live log showed `pulling from
 * …/tasks/972500000009`, task titles, addresses and Supabase error payloads.
 * On a personal phone that is a diagnostic; on a stranger's phone, with their
 * data in it, it is an information leak, and Play's Data Safety declaration
 * asks about exactly this.
 *
 * The usual answer is babel-plugin-transform-remove-console, which deletes
 * every call in production. Rejected deliberately, for two reasons: this repo
 * has no babel config at all, so introducing one days before a release changes
 * the whole build pipeline to solve a runtime problem; and it would remove the
 * one channel that has actually been finding bugs on her device.
 *
 * So: keep the channel, clean what goes through it.
 *
 *   log / info / debug   silenced in production. These are the narration
 *                        ("parsing on the phone", "would schedule reminders
 *                        for: <task title>") — useful in development, and the
 *                        ones that carry content.
 *   warn / error         kept, always. Losing these means losing the ability
 *                        to diagnose a stranger's phone at all, which is worse
 *                        than the residue they carry — and they go through the
 *                        redactor.
 *
 * The redactor is pattern-based and deliberately conservative: it is the last
 * line, not the first. A value that matters should not be handed to console in
 * the first place; this catches what slips through, and catches it in code
 * nobody has to remember to call.
 *
 * Pure except for `install`, so tests/run-log-redaction.ts drives every
 * pattern with no device.
 */

/** Patterns replaced wherever they appear in a logged value. */
const RULES: Array<{ re: RegExp; to: string }> = [
  // Bearer tokens and JWTs. Three dot-separated base64 chunks is a JWT
  // whoever minted it, so this catches Supabase access tokens, Google tokens
  // and anything else shaped like one.
  { re: /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g, to: '<jwt>' },
  { re: /\b(Bearer|bearer)\s+[A-Za-z0-9._~+/-]{8,}=*/g, to: 'Bearer <redacted>' },
  // Google / Firebase API keys.
  { re: /\bAIza[0-9A-Za-z_-]{20,}/g, to: '<api-key>' },
  // Israeli mobile numbers in either form, plus generic E.164. Her own number
  // reached the log 53 times in 200 lines; a stranger's would too.
  { re: /\b(?:\+?972|0)5\d[-\s]?\d{3}[-\s]?\d{4}\b/g, to: '<phone>' },
  // No leading \b: a word boundary cannot exist between the start of a string
  // (or a space) and '+', so `\b\+` matches nothing at all. Caught by the test
  // for exactly one international number, which is what tests are for.
  { re: /\+\d{10,15}\b/g, to: '<phone>' },
  { re: /\b972\d{9}\b/g, to: '<phone>' },
  // Email addresses.
  { re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, to: '<email>' },
  // Coordinates precise enough to be a doorstep. Two signed decimals with 4+
  // places, comma-separated, is a GPS fix and nothing else.
  { re: /-?\d{1,3}\.\d{4,}\s*,\s*-?\d{1,3}\.\d{4,}/g, to: '<lat,lng>' },
];

/** Replace every known-sensitive pattern in a string. */
export function redactString(input: string): string {
  let out = input;
  for (const { re, to } of RULES) out = out.replace(re, to);
  return out;
}

/**
 * Redact anything console might be handed: strings, Errors, arrays, objects.
 *
 * Depth-limited and cycle-safe, because this runs inside console and a crash
 * in the logger is a spectacularly annoying bug to chase — anything it cannot
 * walk is returned untouched rather than thrown over.
 */
export function redact(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') return redactString(value);
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;
  if (depth >= 4) return value;

  const obj = value as object;
  if (seen.has(obj)) return '<circular>';
  seen.add(obj);

  try {
    if (value instanceof Error) {
      const copy = new Error(redactString(value.message));
      copy.name = value.name;
      if (value.stack) copy.stack = redactString(value.stack);
      return copy;
    }
    if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1, seen));
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redact(v, depth + 1, seen);
    }
    return out;
  } catch {
    return value;   // never let logging be the thing that breaks
  }
}

/**
 * Put the gate in place. Call once, as early as possible.
 *
 * `isDev` is passed rather than read, so the decision is testable and so this
 * module does not depend on __DEV__ existing.
 */
export function installLogGate(isDev: boolean): void {
  if (isDev) return;   // development keeps everything, unredacted and complete

  const silent = () => {};
  console.log = silent;
  console.info = silent;
  console.debug = silent;

  const warn = console.warn.bind(console);
  const error = console.error.bind(console);
  console.warn = (...args: unknown[]) => warn(...args.map((a) => redact(a)));
  console.error = (...args: unknown[]) => error(...args.map((a) => redact(a)));
}
