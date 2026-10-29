/**
 * run-voice-hint-names — the person inside a title reaches Whisper's hint.
 * 20.10: "שיחה עם דותן" was transcribed five different ways.
 * Run: npx tsx tests/run-voice-hint-names.ts
 */
import { namesInTitle } from '../src/utils/namesInTitle';

let failures = 0;
let checks = 0;
function check(label: string, got: string[], want: string[]) {
  checks += 1;
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${label}  — ${JSON.stringify(got)}`);
}

check('שיחה עם דותן', namesInTitle('שיחה עם דותן'), ['דותן']);
check('glued ל after a call word', namesInTitle('להתקשר לדותן בבוקר'), ['דותן']);
check('פגישת זום עם נועה', namesInTitle('פגישת זום עם נועה'), ['נועה']);
check('English with', namesInTitle('Call with Paul Dotan'), ['Paul Dotan']);
check('English call', namesInTitle('call Noa'), ['Noa']);
check('not a person: the doctor', namesInTitle('תור אצל הרופא'), []);
check('not a person: tomorrow', namesInTitle('meeting with the team'), []);
check('nothing in a plain title', namesInTitle('ללכת לבנק'), []);

console.log(`\n${failures === 0 ? '✅' : '❌'} ${checks - failures}/${checks} checks passed\n`);
process.exit(failures === 0 ? 0 : 1);
