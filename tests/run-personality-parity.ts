/**
 * Parity test: the TS scorer must agree with the Python scorer on every fixture
 * case. The fixture (server/personality_parity_fixture.json) is generated FROM the
 * Python source of truth, so if src/services/personalityScoring.ts drifts from
 * server/personality_learning_service.py, this fails.
 *
 * Run: npx tsx tests/run-personality-parity.ts   (or: npm run test:parity)
 */
import * as fs from 'fs';
import * as path from 'path';
import { computePersonality } from '../src/services/personalityScoring';
import { MBTIType, PersonalitySignalType } from '../src/types';

interface Case {
  quickType: string | null;
  quickConf: number;
  signals: { signalType: PersonalitySignalType; confidence: number }[];
  expected: {
    finalType: string | null;
    behavioralType: string | null;
    signalCount: number;
    behavioralConfidence: number;
    finalConfidence: number;
  };
}

const fixturePath = path.join(__dirname, '..', 'server', 'personality_parity_fixture.json');
const cases: Case[] = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));

let failures = 0;
const approx = (a: number, b: number) => Math.abs(a - b) < 1e-6;

cases.forEach((c, i) => {
  const r = computePersonality('u', (c.quickType ?? undefined) as MBTIType | undefined, c.quickConf, c.signals);
  const got = {
    finalType: r.finalType ?? null,
    behavioralType: r.behavioralType ?? null,
    signalCount: r.signalCount,
  };
  const e = c.expected;
  const mismatch =
    got.finalType !== e.finalType ||
    got.behavioralType !== e.behavioralType ||
    got.signalCount !== e.signalCount ||
    !approx(r.behavioralConfidence, e.behavioralConfidence) ||
    !approx(r.finalConfidence, e.finalConfidence);
  if (mismatch) {
    failures++;
    console.error(`✗ case ${i}: expected ${JSON.stringify(e)}, got ${JSON.stringify({ ...got, behavioralConfidence: r.behavioralConfidence, finalConfidence: r.finalConfidence })}`);
  }
});

if (failures) {
  console.error(`\n${failures}/${cases.length} parity case(s) FAILED — TS and Python scorers disagree.`);
  process.exit(1);
}
console.log(`✓ personality parity: TS matches Python on all ${cases.length} fixture cases.`);
