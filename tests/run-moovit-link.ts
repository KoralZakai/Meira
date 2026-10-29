/**
 * run-moovit-link — a bus/train trip opens in Moovit with the place already in
 * (Koral, 1.10). 0,0 is "unknown", never a destination.
 *
 * Run:  npx tsx tests/run-moovit-link.ts
 */
import { moovitLinks } from '../src/utils/moovitLink';

let bad = 0;
const check = (label: string, ok: boolean) => { if (!ok) bad += 1; console.log(`  ${ok ? '✓' : '✗'} ${label}`); };
const a = moovitLinks({ lat: 32.0806, lng: 34.7942, name: 'הילד 5, רמת גן' })!;
check('coordinates go in', a.app.includes('dest_lat=32.0806') && a.app.includes('dest_lon=34.7942'));
check('the Hebrew name is encoded', a.app.includes(`dest_name=${encodeURIComponent('הילד 5, רמת גן')}`));
check('it plans at once', a.app.includes('auto_run=true'));
check('a web fallback exists', a.web.startsWith('https://moovitapp.com/') && a.web.includes('tll=32.0806_34.7942'));
check('0,0 is not a point — the name carries it', !moovitLinks({ lat: 0, lng: 0, name: 'Herzl 1' })!.app.includes('dest_lat'));
check('nothing to go on → no link', moovitLinks({ name: '' }) === null);
console.log(`\n${bad ? '❌' : '✅'} ${6 - bad}/6 checks passed\n`);
process.exit(bad ? 1 : 0);
