// 27.10: on Tomorrow, tapping a transport chip saved the new route and the card stayed on the
// old one — the handler redrew TODAY's list (setTasks) from a cloud download, but Tomorrow is
// drawn from otherDayTasks. Source-level guard: the handlers must redraw through redrawDay.
import { readFileSync } from 'fs';

const src = readFileSync('src/screens/TodaySchedule.tsx', 'utf8');
const body = (name: string) => {
  const i = src.indexOf(`const ${name} = async`);
  if (i < 0) throw new Error(`${name} not found`);
  const j = src.indexOf('\n  };\n', i);
  return src.slice(i, j);
};
let bad = 0;
for (const h of ['handleTransportChange', 'handlePickAlternative']) {
  const b = body(h);
  if (!b.includes('redrawDay(')) { console.error(`✗ ${h} does not redraw the shown day`); bad++; }
  if (/setTasks\(/.test(b) || /getTasksForDate\(/.test(b)) { console.error(`✗ ${h} reads/draws today's list directly`); bad++; }
}
const r = body('redrawDay');
if (!r.includes('setOtherDayTasks')) { console.error('✗ redrawDay does not update the other-day list'); bad++; }
// 27.10: bus tapped → a direct train came back, because all vehicles were ranked together.
const sync = readFileSync('src/services/GoogleSync.ts', 'utf8');
if (!/herVehicle[\s\S]{0,200}vehicleOf\(c\) === herVehicle/.test(sync)) {
  console.error('✗ an explicit bus/train choice is not filtered to that vehicle'); bad++;
}
if (bad) process.exit(1);
console.log('✓ mode switch redraws the day on screen');
