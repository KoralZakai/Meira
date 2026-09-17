/**
 * wakeRequest — "wake me at 7" is an instruction, and it was being thrown away.
 *
 * Task.alarmAt is the first thing plannedAlarmTime looks at, and NOTHING in the
 * app or on the server has ever written it. So the only alarm anyone could get
 * was the one derived from a route — and that one goes through needsWakeAlarm,
 * which deliberately stays quiet when the computed wake time is LATER than the
 * hour she normally gets up ("you'll be awake anyway").
 *
 * Both rules are individually sensible, and together they produced the reported
 * bug: "תעירי אותי מוקדם ב-7 בבוקר שאקום ללמוד" before an interview whose route
 * only needs her up at 09:04 set no alarm at all. She asked for 07:00; the
 * route said 09:04; the route won and the phone stayed silent.
 *
 * An explicitly requested hour is not a suggestion to be weighed against a
 * profile default. It is the answer.
 *
 * Pure — no storage, no clock. Consumed by hooks/useTasks (typed/spoken adds)
 * and mirrored server-side in main.py so a WhatsApp request lands on the task
 * too. Tested by tests/run-wake-request.ts.
 */

/** HH:MM, or null when the message is not asking to be woken. */
export function parseWakeRequest(text: string): string | null {
  if (!text) return null;

  // The ASK. Hebrew has no ASCII word boundaries, so no \b anywhere near it.
  const asks = /wake me( up)?|set an alarm|alarm for|תעיר[יני]? אותי|להעיר אותי|תעורר[יי]? אותי|שעון מעורר|תעירי/i;
  if (!asks.test(text)) return null;

  // The HOUR, taken from the part of the sentence that does the asking — so
  // "wake me at 7, the interview is at 13:00" is 07:00 and never 13:00.
  const from = text.search(asks);
  const tail = text.slice(from);

  // Take whichever time comes FIRST after the ask. Matching "HH:MM" anywhere
  // first was wrong: "wake me at 7, the interview is at 13:00" answered 13:00,
  // because the appointment is the one written with minutes.
  const explicit = tail.match(/(\d{1,2}):(\d{2})/);
  // A bare hour must be introduced ("at 7", "ב-7", "בשעה 6"), so a stray number
  // ("wake me before the 3 meetings") is never read as a time.
  const bare = tail.match(/(?:\bat\b|\bfor\b|בשעה|ב-|ב\s|ב(?=\d))\s*(\d{1,2})(?!\d|:)/i);

  const explicitAt = explicit ? explicit.index ?? Infinity : Infinity;
  const bareAt = bare ? bare.index ?? Infinity : Infinity;

  if (explicit && explicitAt <= bareAt) {
    const h = Number(explicit[1]);
    const m = Number(explicit[2]);
    if (h <= 23 && m <= 59) return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }
  if (!bare) return null;
  let hour = Number(bare[1]);
  if (hour > 23) return null;

  // Which 7? "7 in the morning" is 07:00; "at 7 tonight" is 19:00. With nothing
  // said, an alarm request means the morning — that is what an alarm is for.
  const evening = /\bpm\b|tonight|evening|בערב|בלילה/i.test(tail);
  const morning = /\bam\b|morning|בבוקר/i.test(tail);
  if (evening && !morning && hour < 12) hour += 12;

  return `${String(hour).padStart(2, '0')}:00`;
}

// Self-check: npx tsx src/utils/wakeRequest.ts
if (typeof require !== 'undefined' && require.main === module) {
  const cases: Array<[string, string | null]> = [
    ['תעירי אותי מוקדם ב 7 בבוקר שאקום ללמוד!!', '07:00'],
    ['תעיר אותי בשעה 06:30', '06:30'],
    ['wake me at 7', '07:00'],
    ['wake me up at 6:30am', '06:30'],
    ['wake me at 7, the interview is at 13:00', '07:00'],
    ['ראיון עבודה ב-13:00', null],
    ['buy a new alarm clock', null],
  ];
  for (const [input, want] of cases) {
    const got = parseWakeRequest(input);
    console.assert(got === want, `${JSON.stringify(input)} → ${got}, wanted ${want}`);
  }
  console.log('wakeRequest self-check OK');
}
