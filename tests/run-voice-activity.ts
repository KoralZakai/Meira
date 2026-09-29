/**
 * run-voice-activity — when has she finished speaking?
 *
 * The app's mic used Android's recogniser, which stopped at the first pause
 * and cut long sentences in half. Recording ourselves means deciding "done"
 * ourselves, from loudness alone. These are the cases that decision must get
 * right: a pause between words is not the end, silence after speech is, a
 * room nobody spoke in sends nothing (Whisper invents "תודה רבה" from
 * silence), and a phone that reports no levels waits for her tap.
 *
 *   npx tsx tests/run-voice-activity.ts
 */
import { VAD, initVad, stepVad, heardSpeech, VadState } from '../src/utils/voiceActivity';

let pass = 0;
let fail = 0;
const ok = (cond: boolean, label: string) => {
  if (cond) { pass += 1; console.log(`  ✓ ${label}`); } else { fail += 1; console.error(`  ✗ ${label}`); }
};
const section = (s: string) => console.log(`\n${s}`);

const TICK = 120;

/** Feed a sequence of [dB, durationMs] segments; return the first stop. */
function run(segments: Array<[number | undefined, number]>) {
  let state: VadState = initVad(0);
  let t = 0;
  for (const [db, ms] of segments) {
    for (let end = t + ms; t < end; t += TICK) {
      const { state: next, decision } = stepVad(state, db, t);
      state = next;
      if (decision.stop) return { stopAt: t, reason: decision.reason, state };
    }
  }
  return { stopAt: null as number | null, reason: undefined, state };
}

const ROOM = -52;     // a quiet room
const VOICE = -28;    // normal speech into a phone
const FAN = -38;      // a kitchen with the fan on

section('1. a sentence with a pause in it is one recording');
{
  const r = run([[ROOM, 600], [VOICE, 2000], [ROOM, 700], [VOICE, 1500], [ROOM, 3000]]);
  ok(r.reason === 'silence_after_speech', `stops on silence after speech (${r.reason})`);
  // The 700 ms pause is shorter than SILENCE_MS, so it must not have ended it.
  ok(r.stopAt !== null && r.stopAt > 600 + 2000 + 700 + 1500,
    `not cut at the pause between words (stopped at ${r.stopAt} ms)`);
  ok(r.stopAt !== null && r.stopAt - (600 + 2000 + 700 + 1500) <= VAD.SILENCE_MS + TICK,
    'stops within SILENCE_MS of the last word');
}

section('2. nobody spoke → stop, and send nothing');
{
  const r = run([[ROOM, 12000]]);
  ok(r.reason === 'no_speech', `reason no_speech (${r.reason})`);
  ok(r.stopAt !== null && r.stopAt >= VAD.NO_SPEECH_MS, 'waits NO_SPEECH_MS before giving up');
  ok(!heardSpeech(r.state), 'nothing is uploaded — Whisper would invent a sentence');
}

section('3. the threshold follows the room');
{
  // In a fan-noisy kitchen, the fan itself must not count as speech...
  const noisy = run([[FAN, 9000]]);
  ok(noisy.reason === 'no_speech', 'a steady fan is not speech');
  // ...and speech above the fan still is.
  const talk = run([[FAN, 500], [FAN + 16, 1500], [FAN, 3000]]);
  ok(talk.reason === 'silence_after_speech', 'speech over the fan is heard and ends normally');
}

section('4. a word in the first 400 ms does not become "silence"');
{
  // She starts talking immediately. The floor must come from the quietest
  // sample, so the speech that follows still reads as speech.
  const r = run([[VOICE, 200], [ROOM, 200], [VOICE, 1500], [ROOM, 2500]]);
  ok(r.reason === 'silence_after_speech', `an early start still ends on silence (${r.reason})`);
  ok(heardSpeech(r.state), 'and it is sent');
}

section('4b. she talks from the first instant, without a breath, then stops');
{
  // The whole opening is her voice (with the ordinary dips between syllables),
  // so no early reading is the room. The pause at the end reveals the room, and
  // everything before it must be recognised as speech after the fact.
  const talking: Array<[number, number]> = [];
  for (let i = 0; i < 12; i += 1) talking.push([VOICE, 240], [VOICE - 6, 120]);
  const r = run([...talking, [ROOM, 4000]]);
  ok(r.reason === 'silence_after_speech', `ends as speech, not as "nobody spoke" (${r.reason})`);
  ok(heardSpeech(r.state), 'and it is sent');
}

section('4c. ten seconds without a breath is not "nobody spoke"');
{
  const flat: Array<[number, number]> = [];
  for (let i = 0; i < 30; i += 1) flat.push([VOICE, 240], [VOICE - 4, 120]);
  const r = run([...flat, [ROOM, 4000]]);
  ok(r.stopAt === null || r.stopAt > 30 * 360, `not cut off while she is still talking (stopped at ${r.stopAt})`);
  ok(r.reason === 'silence_after_speech', `ends when she stops (${r.reason})`);
}

section('5. a phone that reports no levels waits for her tap');
{
  const r = run([[undefined, 20000]]);
  ok(r.stopAt === null, 'no auto-stop without levels (until MAX_MS)');
  ok(heardSpeech(r.state), 'an unmetered recording gets the benefit of the doubt');
  const capped = run([[undefined, VAD.MAX_MS + 1000]]);
  ok(capped.reason === 'max_length', 'MAX_MS still stops it');
}

section('6. the recorder\'s "no signal" value is not a room');
{
  const r = run([[-160, 3000], [ROOM, 600], [VOICE, 1500], [ROOM, 2500]]);
  ok(r.reason === 'silence_after_speech', `-160 readings are ignored (${r.reason})`);
}

section('7. the waveform level');
{
  const { decision: loud } = stepVad(initVad(0), -3, 10);
  const { decision: quiet } = stepVad(initVad(0), -70, 10);
  ok(loud.level > 0.9 && loud.level <= 1, `loud ≈ 1 (${loud.level.toFixed(2)})`);
  ok(quiet.level === 0, 'below the UI floor = 0');
}

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
