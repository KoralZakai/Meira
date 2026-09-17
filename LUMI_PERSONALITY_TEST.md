# LUMI — PERSONALITY PARITY: ADD THE TS TEST RUNNER (stdlib-only, no Jest)
# PASTE INTO CLAUDE CODE. Closes the gap: parity was Python-only; this makes the TS side runnable.

---

## WHY
The optimistic TS scorer (PersonalityService.ts) is the copy most likely to drift from the Python
server scorer. Until a TS runner exists, the parity assertion can't execute. This adds one using
Node's BUILT-IN test runner — no Jest, no babel, no faker/lodash. Matches the A3 "stdlib-only" rule.

The scoring code is pure (no React Native runtime), so it runs headless under plain Node.

---

## STEP 1 — PYTHON EMITS A SHARED FIXTURE (both maps AND expected results)

`backend/emit_parity_fixture.py` (stdlib only). Run once; commit both JSON files.
```python
import json, random
from personality_scoring import QUESTION_META, recompute

def gen_maps(seed=42, n=20):
    rng = random.Random(seed)
    qids = list(QUESTION_META.keys())
    maps = []
    for _ in range(n):
        k = rng.randint(4, len(qids))
        chosen = rng.sample(qids, k)
        maps.append({q: rng.randint(-3, 3) for q in chosen})
    return maps

def sign(x): return 0 if x == 0 else (1 if x > 0 else -1)

if __name__ == "__main__":
    maps = gen_maps()
    expected = []
    for m in maps:
        s = recompute(m)  # offsets=None -> quiz-only, which is what the TS optimistic scorer computes
        expected.append({
            "derivedType": s["derivedType"],
            "axes": {a: {"answeredCount": s["axes"][a]["answeredCount"],
                          "sign": sign(s["axes"][a]["signed"]),
                          "signed6": round(s["axes"][a]["signed"], 6)}
                     for a in ("EI", "NS", "TF", "JP")},
        })
    with open("src/__tests__/parity_maps.json", "w") as f: json.dump(maps, f)
    with open("src/__tests__/parity_expected.json", "w") as f: json.dump(expected, f)
    print("wrote parity_maps.json and parity_expected.json")
```
Note: `recompute` with no offsets = quiz-only floats, which is exactly what the app's optimistic
`PersonalityService.recompute` produces (behavior offsets are server-only). So the two are directly
comparable. Compare by per-axis SIGN + answeredCount + derivedType (the product), and `signed6` as a
tie-down. Same integer inputs through identical arithmetic should match to 6 decimals.

---

## STEP 2 — TS PARITY TEST (src/__tests__/personality.parity.test.ts)

Uses `node:test` + `node:assert/strict` — both built into Node, zero install.
```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import maps from './parity_maps.json' assert { type: 'json' };
import expected from './parity_expected.json' assert { type: 'json' };
import { PersonalityService } from '../services/PersonalityService';

const sign = (x: number) => (x === 0 ? 0 : x > 0 ? 1 : -1);
const AXES = ['EI', 'NS', 'TF', 'JP'] as const;

test('TS optimistic scorer matches Python server scorer on seeded maps', () => {
  (maps as Record<string, number>[]).forEach((m, i) => {
    const s = PersonalityService.recompute(PersonalityService.newState(), m);
    const exp = (expected as any[])[i];
    assert.equal(s.derivedType, exp.derivedType, `map ${i}: derivedType`);
    for (const a of AXES) {
      assert.equal(s.axes[a].answeredCount, exp.axes[a].answeredCount, `map ${i}: ${a} answeredCount`);
      assert.equal(sign(s.axes[a].signed), exp.axes[a].sign, `map ${i}: ${a} sign`);
      assert.equal(Number(s.axes[a].signed.toFixed(6)), exp.axes[a].signed6, `map ${i}: ${a} signed6`);
    }
  });
});
```
If `PersonalityService.recompute` signature differs from Part 1, adapt the call but keep the asserts.

---

## STEP 3 — RUN IT (pick the lane that fits the project's Node version)

Add to package.json scripts:
```json
"test:parity": "node --experimental-strip-types --test src/__tests__/personality.parity.test.ts"
```
- **Node ≥ 22.6:** the line above works as-is — native TS type-stripping, ZERO new dependencies.
- **Node < 22.6:** add ONE lightweight dev dep and use:
  ```json
  "test:parity": "tsx --test src/__tests__/personality.parity.test.ts"
  ```
  (`npm i -D tsx` — small, no babel/jest toolchain.)
- If the Expo template already ships `jest-expo`, you MAY instead run under Jest, but do not add Jest
  solely for this — the node:test path keeps deps minimal per A3.

The JSON import assertion syntax may need `--experimental-json-modules` on some Node versions, or read
the fixture with `fs.readFileSync(new URL('./parity_maps.json', import.meta.url), 'utf8')` + `JSON.parse`
if the `assert { type: 'json' }` form errors. Prefer the fs+JSON.parse form if unsure — it's the most
portable and still stdlib-only.

---

## STEP 4 — CORRECT THE EARLIER VERIFY CLAIM
Replace the Part 2 / addendum verify bullet that said "Python and TS agree on all 20 maps" with:
- "Run `npm run test:parity`: the TS optimistic scorer matches the Python-generated fixture on all 20
  seeded maps (per-axis sign + answeredCount + derivedType + signed to 6 dp). Until this script passes,
  treat parity as Python-only."

---

## VERIFY (additive)
1. `python backend/emit_parity_fixture.py` writes both JSON fixtures into src/__tests__/.
2. `npm run test:parity` passes with no external test framework installed (node:test/node:assert only).
3. Deliberately break one valence in QUESTION_META (server) WITHOUT changing personalityQuestions.ts
   (client) → re-emit fixture → `test:parity` FAILS. This proves the harness actually catches drift.
4. Revert the deliberate break; confirm green.

Do NOT skip errors.