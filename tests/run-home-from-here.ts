/**
 * run-home-from-here — 📍 in the chat never changes home without her yes.
 *
 * The reported bug (7.10, Koral's phone): the chat's 📍 sat beside the 🎤,
 * and one tap saved the GPS fix as home with no question. A mis-tap while
 * reaching for the mic overwrote home. Home is every route's origin, so the
 * write she did not mean is a plan she cannot see is wrong.
 *
 * Also: a fix that IS the saved home says so (nothing to ask), the card shows
 * the home it would replace, and a save that does not read back is not ✓.
 *
 * Run:  npx tsx tests/run-home-from-here.ts
 */
import { findHomeHere, saveHomeHere, SAME_HOME_M, HOME_HERE_CHIP } from '../src/utils/homeFromHere';
import { blankProfile, UserProfile } from '../src/models/UserProfile';

let failures = 0;
let checks = 0;
function check(label: string, ok: boolean, detail = '') {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `  — ${detail}` : ''}`);
}

// Ra'anana, Herzl 12 — and a fix ~1.1 km away on Ahuza.
const HOME = { lat: 32.1848, lng: 34.8713 };
const ELSEWHERE = { lat: 32.1838, lng: 34.8830 };
const NEXT_DOOR = { lat: 32.1852, lng: 34.8716 };   // ~50 m

function store(initial: UserProfile | null) {
  let profile = initial;
  const writes: UserProfile[] = [];
  return {
    writes,
    load: async () => profile,
    save: async (p: UserProfile) => { writes.push(p); profile = p; },
    blank: blankProfile,
  };
}
const saved = (address: string, at: { lat: number; lng: number } | null): UserProfile =>
  ({ ...blankProfile(), homeAddress: address, homeLatLng: at });

async function main() {
  console.log('\nHome from here\n');

  // ── 1. the reported bug ─────────────────────────────────────────────────
  console.log('1. A tap only ASKS — home is untouched until yes');
  {
    const s = store(saved('הרצל 12 רעננה', HOME));
    const found = await findHomeHere({ locate: async () => ELSEWHERE, addressOf: async () => 'אחוזה 100 רעננה', load: s.load });
    check('found a proposal', found.ok);
    check('nothing was written by the tap', s.writes.length === 0, `${s.writes.length} writes`);
    check('home is still the old one', (await s.load())?.homeAddress === 'הרצל 12 רעננה');
    if (found.ok) {
      check('the card shows the address found', found.ask.address === 'אחוזה 100 רעננה');
      check('the card shows the home it would replace', found.ask.current === 'הרצל 12 רעננה');
      check('a different place is NOT marked same', !found.ask.same);
      check('no answer yet', found.ask.outcome === undefined);
    }
  }

  // ── 2. what happened on 7.10: the same address ──────────────────────────
  console.log('\n2. Standing at home: "already your home", nothing to save');
  {
    const s = store(saved('הרצל 12 רעננה', HOME));
    const found = await findHomeHere({ locate: async () => NEXT_DOOR, addressOf: async () => 'הרצל 14 רעננה', load: s.load });
    check(`within ${SAME_HOME_M} m → same`, found.ok && found.ask.same === true);
    const words = store(saved('Herzl 12, Raanana', null));   // typed home, never geocoded
    const byWords = await findHomeHere({ locate: async () => ELSEWHERE, addressOf: async () => 'Herzl 12 Raanana', load: words.load });
    check('same words, no saved coords → same', byWords.ok && byWords.ask.same === true);
    check('still no writes', s.writes.length === 0 && words.writes.length === 0);
  }

  // ── 3. her yes ─────────────────────────────────────────────────────────
  console.log('\n3. Yes writes home, and it reads back');
  {
    const s = store(saved('הרצל 12 רעננה', HOME));
    const found = await findHomeHere({ locate: async () => ELSEWHERE, addressOf: async () => 'אחוזה 100 רעננה', load: s.load });
    if (!found.ok) throw new Error('setup');
    const r = await saveHomeHere(found.ask, s, new Date('2026-10-07T12:00:00Z'));
    check('saved', r.ok);
    check('exactly one write', s.writes.length === 1);
    const now = await s.load();
    check('home address is the found one', now?.homeAddress === 'אחוזה 100 רעננה');
    check('home coords are the fix', now?.homeLatLng?.lat === ELSEWHERE.lat && now?.homeLatLng?.lng === ELSEWHERE.lng);
    check('the rest of the profile is kept', now?.name === blankProfile().name);
  }

  // ── 4. no profile at all (before onboarding) ───────────────────────────
  console.log('\n4. No profile yet');
  {
    const s = store(null);
    const found = await findHomeHere({ locate: async () => HOME, addressOf: async () => null, load: s.load });
    check('coords stand in for a missing street name', found.ok && found.ask.address === '32.18480, 34.87130');
    check('no current home to show', found.ok && found.ask.current === undefined && !found.ask.same);
    if (found.ok) check('yes saves into a blank profile', (await saveHomeHere(found.ask, s)).ok && s.writes.length === 1);
  }

  // ── 5. failures say so ─────────────────────────────────────────────────
  console.log('\n5. Failures are failures, not ✓');
  {
    const s = store(null);
    const none = await findHomeHere({ locate: async () => null, addressOf: async () => 'x', load: s.load });
    check('no fix → nofix', !none.ok && none.error === 'nofix');
    const lost = { ...store(saved('A', HOME)), save: async () => {} };   // a save that does not land
    const r1 = await saveHomeHere({ address: 'B', ...ELSEWHERE }, lost);
    check('a save that does not read back is not ok', !r1.ok, r1.ok ? '' : r1.reason);
    const thrown = { ...store(null), save: async () => { throw new Error('SecureStore unavailable'); } };
    const r2 = await saveHomeHere({ address: 'B', ...ELSEWHERE }, thrown);
    check('a thrown save is not ok, with the reason', !r2.ok && /SecureStore/.test(r2.reason));
    const answered = store(saved('A', HOME));   // a card whose coordinates were dropped
    const r3 = await saveHomeHere({ address: 'B', outcome: 'declined' }, answered);
    check('no coordinates → no write, never 0,0', !r3.ok && answered.writes.length === 0);
  }

  // ── 6. both languages ──────────────────────────────────────────────────
  console.log('\n6. The chip is named in both languages');
  check('EN and HE labels, both with 📍', HOME_HERE_CHIP.en.startsWith('📍') && HOME_HERE_CHIP.he.startsWith('📍'));

  console.log(`\n${checks - failures}/${checks} passed${failures ? ` — ${failures} FAILED` : ''}\n`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
