/**
 * run-routine-threeway — a routine one side dropped stays dropped (21.10, Koral: "routines don't update").
 * Run:  npx tsx tests/run-routine-threeway.ts
 */
import { threeWayRoutineLines } from '../src/utils/routineConsolidate';

let failures = 0; let checks = 0;
const check = (l: string, ok: boolean, d = '') => { checks += 1; if (!ok) failures += 1; console.log(`  ${ok ? '✓' : '✗'} ${l}${d ? ` — ${d}` : ''}`); };

const OLD = 'אימון · יום ראשון, שני ושלישי · 20:00 · יגאל אלון 76, תל אביב';
const NEW_OLD = 'אימון · ימי א׳ ו-ב׳ · 20:00 · יגאל אלון 76, תל אביב';
const YOGA = 'יוגה · יום שלישי · 20:00-21:30 · יגאל אלון 76, תל אביב';
const KICK = 'קיקבוקס · Sundays · 20:30 · יגאל אלון 76, תל אביב';

// She told Meira "yoga on Tuesday instead": Meira rewrote the old line and added the yoga.
const told = [NEW_OLD, YOGA, KICK];
const box = [OLD, KICK];                      // the phone still holds the old line
const snapshot = [OLD, KICK];                 // what both held when they last agreed

const r = threeWayRoutineLines(box, told, snapshot);
check('the old line Meira rewrote does NOT come back from the phone', !r.includes(OLD), JSON.stringify(r));
check('the rewritten line and the yoga are kept', r.includes(NEW_OLD) && r.includes(YOGA));
check('what was untouched stays', r.includes(KICK));

// She removed a routine on the phone (×): Meira's side still has it.
const r2 = threeWayRoutineLines([KICK], [OLD, KICK], [OLD, KICK]);
check('a routine she removed on the phone does NOT come back from Meira', !r2.includes(OLD) && r2.includes(KICK), JSON.stringify(r2));

// She typed a new line on the phone: it is not in the snapshot, so it is kept.
const typed = 'פילאטיס · יום רביעי · 09:00';
const r3 = threeWayRoutineLines([OLD, typed], [OLD], [OLD]);
check('a line typed on the phone is kept', r3.includes(typed));

// A new line Meira got (spoken), not in the snapshot: kept even though the phone never saw it.
const r4 = threeWayRoutineLines([OLD], [OLD, YOGA], [OLD]);
check('a line told to Meira is kept', r4.includes(YOGA));

// First run: no snapshot — plain union, as before.
const r5 = threeWayRoutineLines([OLD], [YOGA], null);
check('no snapshot: both sides are joined, nothing is lost', r5.length === 2 && r5.includes(OLD) && r5.includes(YOGA));

check('blank lines never become routines', threeWayRoutineLines([' ', OLD], ['', YOGA], [OLD]).every((l) => l.trim()));
console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
