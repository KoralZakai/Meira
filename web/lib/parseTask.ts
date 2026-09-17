// Lightweight, dependency-free parser for the web "Add task" box.
// The mobile app uses the full Nebius ReAct agent; the web app is a manual task
// manager, so we do best-effort extraction of the things people type inline:
//   - a time range  "15:00-23:00" / "15:00 - 23:00" / "15:00 to 23:00"
//   - a single time  "at 14:30"
//   - an explicit duration  "~30 min" / "2h" / "1.5 hours" / "90 דקות"
//   - a relative date  "tomorrow" / "מחר" / "in 2 days" / "next week"
// Anything not found is left undefined so the caller can fall back to its
// own defaults / manual form fields.

export interface ParsedTask {
  fixedTime?: string; // HH:MM (start of the slot)
  durationMinutes?: number; // total minutes
  date?: string; // YYYY-MM-DD
}

function pad(n: number): string {
  return n.toString().padStart(2, '0');
}

function toMinutes(h: number, m: number): number {
  return h * 60 + m;
}

function addDays(reference: string, days: number): string {
  const ref = new Date(`${reference}T00:00:00`);
  ref.setDate(ref.getDate() + days);
  return ref.toISOString().slice(0, 10);
}

// "15:00-23:00" → 480 min, start 15:00. Crossing midnight (22:00-02:00) wraps.
function parseTimeRange(text: string): { fixedTime: string; durationMinutes: number } | null {
  const m = text.match(/(\d{1,2}):(\d{2})\s*(?:-|–|—|to|עד|until)\s*(\d{1,2}):(\d{2})/i);
  if (!m) return null;
  const startH = Number(m[1]);
  const startMin = Number(m[2]);
  const endH = Number(m[3]);
  const endMin = Number(m[4]);
  if (startH > 23 || endH > 23 || startMin > 59 || endMin > 59) return null;
  let diff = toMinutes(endH, endMin) - toMinutes(startH, startMin);
  if (diff <= 0) diff += 24 * 60; // wrap past midnight
  return { fixedTime: `${pad(startH)}:${pad(startMin)}`, durationMinutes: diff };
}

// "at 14:30" / a lone "09:00" → just a start time, no duration.
function parseSingleTime(text: string): string | null {
  const m = text.match(/(?:\bat\s+|\bב-?\s*)?(\d{1,2}):(\d{2})\b/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return `${pad(h)}:${pad(min)}`;
}

// "2h", "1.5 hours", "90 min", "30 דקות", "שעתיים"
function parseDuration(text: string): number | null {
  const lower = text.toLowerCase();
  let total = 0;
  let matched = false;

  const hours = lower.match(/(\d+(?:\.\d+)?)\s*(?:h|hr|hrs|hour|hours|שעות|שעה)\b/);
  if (hours) {
    total += Math.round(parseFloat(hours[1]) * 60);
    matched = true;
  }
  const mins = lower.match(/(\d+)\s*(?:m|min|mins|minute|minutes|דקות|דקה)\b/);
  if (mins) {
    total += parseInt(mins[1], 10);
    matched = true;
  }
  if (/\bשעתיים\b/.test(lower)) {
    total += 120;
    matched = true;
  }
  return matched && total > 0 ? total : null;
}

function parseRelativeDate(text: string, referenceDate: string): string | null {
  const lower = text.toLowerCase();
  if (/\b(day after tomorrow)\b|מחרתיים/.test(lower)) return addDays(referenceDate, 2);
  if (/\btomorrow\b|מחר/.test(lower)) return addDays(referenceDate, 1);
  if (/\bnext week\b|שבוע הבא/.test(lower)) return addDays(referenceDate, 7);
  const inDays = lower.match(/\bin (\d+) days?\b/) || lower.match(/בעוד (\d+) ימים?/);
  if (inDays) return addDays(referenceDate, parseInt(inDays[1], 10));

  const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const daysHe = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
  const idxEn = days.findIndex((d) => lower.includes(`next ${d}`) || lower.includes(d));
  const idxHe = daysHe.findIndex((d) => lower.includes(d));
  const target = idxEn !== -1 ? idxEn : idxHe;
  if (target !== -1) {
    const cur = new Date(`${referenceDate}T00:00:00`).getDay();
    const delta = ((target - cur + 7) % 7) || 7;
    return addDays(referenceDate, delta);
  }
  return null;
}

export function parseTaskText(text: string, referenceDate: string): ParsedTask {
  const result: ParsedTask = {};

  const range = parseTimeRange(text);
  if (range) {
    result.fixedTime = range.fixedTime;
    result.durationMinutes = range.durationMinutes;
  } else {
    const single = parseSingleTime(text);
    if (single) result.fixedTime = single;
  }

  // An explicit duration always wins over a range-derived one if the user
  // wrote both (e.g. "14:00-18:00 but only ~30 min of work").
  const duration = parseDuration(text);
  if (duration) result.durationMinutes = duration;

  const date = parseRelativeDate(text, referenceDate);
  if (date) result.date = date;

  return result;
}
