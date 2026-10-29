/**
 * run-ui-contrast — the owner's brief: "check icon visibility, no text out of
 * the box, keep the UI clean and easy".
 *
 * Nothing here was BROKEN in the sense the type checker or a render test can
 * see — the stepper rendered, the tab bar rendered, the ✕ rendered. They were
 * unreadable (half-opacity labels, hint text at 3.2:1), unreachable (40 dp
 * buttons), cut (the time at the end of a line that truncates) or drawn in a
 * fallback face (glyphs Inter does not have). So this reads the SOURCE of the
 * styles — the token each one actually uses — and measures it.
 *
 *   1. WCAG contrast of the real text/fill pairs, resolved from the code.
 *   2. No glyph Inter lacks (checked against the font file itself).
 *   3. The structural fixes: own row, flexShrink on the label and not the
 *      time, MIN_TOUCH on buttons, a capped sheet, RTL arrows.
 *
 *   npx tsx tests/run-ui-contrast.ts
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { BRAND, MIN_TOUCH } from '../src/constants/theme';

let checks = 0;
let failures = 0;
function check(label: string, ok: boolean, detail = '') {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${label}${ok ? '' : `  — ${detail}`}`);
}

const root = join(__dirname, '..');
const read = (rel: string) => readFileSync(join(root, rel), 'utf8');

// ── WCAG 2.x relative luminance / contrast ──────────────────────────────────
function luminance(hex: string): number {
  const n = parseInt(hex.replace('#', ''), 16);
  const lin = (c: number) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
  return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
}
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// ── reading a StyleSheet entry out of source ────────────────────────────────
/** The `name: { … }` literal of a StyleSheet entry, braces balanced. */
function styleBlock(src: string, name: string): string {
  const m = new RegExp(`\\n\\s*${name}:\\s*\\{`).exec(src);
  if (!m) throw new Error(`no style "${name}"`);
  let i = m.index + m[0].length;
  let depth = 1;
  while (i < src.length && depth > 0) {
    const c = src[i++];
    if (c === '{') depth += 1; else if (c === '}') depth -= 1;
  }
  return src.slice(m.index, i);
}
/** Resolve `prop: BRAND.x` or `prop: '#abc'` inside a block to a hex colour. */
function colorOf(src: string, style: string, prop: 'color' | 'backgroundColor' | 'borderColor'): string {
  const block = styleBlock(src, style);
  const m = new RegExp(`(?<![A-Za-z])${prop}:\\s*(?:BRAND\\.(\\w+)|'(#[0-9A-Fa-f]{6})')`).exec(block);
  if (!m) throw new Error(`style "${style}" has no ${prop} token`);
  if (m[2]) return m[2];
  const hex = (BRAND as Record<string, string>)[m[1]];
  if (!hex) throw new Error(`BRAND.${m[1]} does not exist`);
  return hex;
}
const numberOf = (src: string, style: string, prop: string): number | undefined => {
  const m = new RegExp(`(?<![A-Za-z])${prop}:\\s*([0-9.]+)`).exec(styleBlock(src, style));
  return m ? Number(m[1]) : undefined;
};
/** Source with comments removed — a glyph named in a comment is not drawn. */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/([^:'"`])\/\/.*$/gm, '$1');

const dayCard = read('src/components/today/DayCard.tsx');
const nowAdd = read('src/components/today/NowAddRow.tsx');
const earlier = read('src/components/today/EarlierRow.tsx');
const clash = read('src/components/today/ClashQuestion.tsx');
const tabBar = read('src/components/CustomTabBar.tsx');
const voice = read('src/components/VoiceSheet.tsx');
const answer = read('src/components/AnswerCard.tsx');
const transit = read('src/components/TransitOptionsList.tsx');
const menu = read('src/screens/SettingsMenu.tsx');
const today = read('src/screens/TodaySchedule.tsx');

const AA = 4.5;
const atLeast = (label: string, fg: string, bg: string, min = AA) => {
  const c = contrast(fg, bg);
  check(`${label}: ${c.toFixed(2)}:1 (needs ${min})`, c >= min, `${fg} on ${bg}`);
};

console.log('\n1. Contrast — the token each style really uses\n');

{
  const trayBg = colorOf(dayCard, 'stepper', 'backgroundColor');
  const btnFill = colorOf(dayCard, 'stepBtn', 'backgroundColor');
  atLeast('stepper button label on its fill', colorOf(dayCard, 'stepBtnText', 'color'), btnFill);
  atLeast('stepper button arrow on its fill', colorOf(dayCard, 'stepArrow', 'color'), btnFill);
  atLeast('stepper hint on the stepper tray', colorOf(dayCard, 'stepperHint', 'color'), trayBg);
  atLeast('stepper journey line on the tray', colorOf(dayCard, 'stepperLine', 'color'), trayBg);
  atLeast('stepper "late" journey line on the tray', BRAND.lateInk, trayBg);
  atLeast('stepper button edge against the tray (non-text, 3:1)', colorOf(dayCard, 'stepBtn', 'borderColor'), trayBg, 3);
  check('the tray is a theme token, not a literal', !/stepper:[^}]*#[0-9A-Fa-f]{6}/.test(styleBlock(dayCard, 'stepper')));
}
{
  const bar = colorOf(tabBar, 'container', 'backgroundColor');
  atLeast('tab bar inactive label on the bar', colorOf(tabBar, 'inactive', 'color'), bar);
  atLeast('tab bar active label on the bar', colorOf(tabBar, 'label', 'color'), bar);
  atLeast('selected-tab bar on the bar (non-text, 3:1)', colorOf(tabBar, 'selectedBar', 'backgroundColor'), bar, 3);
}
{
  const gold = BRAND.sunGold;
  atLeast('leave pill small label on sunGold', colorOf(dayCard, 'lvSmall', 'color'), gold);
  atLeast('leave pill big label on sunGold', colorOf(dayCard, 'lvBig', 'color'), gold);
  atLeast('done pill label on its pale fill', colorOf(dayCard, 'lvDoneInk', 'color'), colorOf(dayCard, 'lvDone', 'backgroundColor'));
  atLeast('late pill label on its rose fill', colorOf(dayCard, 'lateInk', 'color'), colorOf(dayCard, 'lvLate', 'backgroundColor'));
  atLeast('mode minutes on the mode chip', colorOf(dayCard, 'modeMin', 'color'), colorOf(dayCard, 'mode', 'backgroundColor'));
  atLeast('"title" of a done card on the card', colorOf(dayCard, 'strike', 'color'), BRAND.creamCard);
}
{
  const row = colorOf(nowAdd, 'row', 'backgroundColor');
  atLeast('"Free now" label on its row', colorOf(nowAdd, 'label', 'color'), row);
  atLeast('"until 15:03" time on its row', colorOf(nowAdd, 'time', 'color'), row);
  atLeast('"53 min" on its row', colorOf(nowAdd, 'span', 'color'), row);
  atLeast('EarlierRow label on its row', colorOf(earlier, 'label', 'color'), colorOf(earlier, 'row', 'backgroundColor'));
  atLeast('ClashQuestion title on the card', colorOf(clash, 'title', 'color'), BRAND.creamCard);
  atLeast('ClashQuestion subtitle on the card', colorOf(clash, 'sub', 'color'), BRAND.creamCard);
}
{
  atLeast('AnswerCard chosen row: label on honey', colorOf(answer, 'optTitle', 'color'), colorOf(answer, 'optOn', 'backgroundColor'));
  atLeast('AnswerCard chosen row: its edge against the card (non-text, 3:1)', colorOf(answer, 'optOn', 'borderColor'), BRAND.creamCard, 3);
  atLeast('AnswerCard minutes unit on the card', colorOf(answer, 'minUnit', 'color'), BRAND.creamCard);
  atLeast('AnswerCard estimate legend on the card', colorOf(answer, 'note', 'color'), BRAND.creamCard);
  atLeast('late-call buttons (Today): label on the button', colorOf(today, 'lateBtnText', 'color'), colorOf(today, 'lateBtn', 'backgroundColor'));
  atLeast('Menu quick buttons: label on the button', colorOf(menu, 'quickText', 'color'), colorOf(menu, 'quickBtn', 'backgroundColor'));
  atLeast('Transit list: "leave in …" on the row', colorOf(transit, 'urgency', 'color'), BRAND.creamCard);
  atLeast('Transit list: urgent "leave in …" on the row', colorOf(transit, 'urgencyNow', 'color'), BRAND.creamCard);
  atLeast('Transit list: station line on the row', colorOf(transit, 'board', 'color'), BRAND.creamCard);
}

console.log('\n2. Touch targets — MIN_TOUCH, not a literal\n');

check('MIN_TOUCH is 44', MIN_TOUCH === 44);
check('DayCard stepper buttons', /MIN_TOUCH/.test(styleBlock(dayCard, 'stepBtn')));
check('DayCard "Take this one" keeps the 46 dp action height', /minHeight:\s*46/.test(styleBlock(dayCard, 'btn')) && /flex:\s*0/.test(styleBlock(dayCard, 'btnTake')));
check('DayCard route link, brief, why-button, steps', ['routeLink', 'brief', 'whyBtn', 'step', 'mode'].every((s) => /MIN_TOUCH/.test(styleBlock(dayCard, s))));
check('late-call buttons (Today)', /MIN_TOUCH/.test(styleBlock(today, 'lateBtn')));
check('"Not now" on the missed-trip banner', /MIN_TOUCH/.test(styleBlock(today, 'missedDismiss')));
check('AnswerCard buttons', /MIN_TOUCH/.test(styleBlock(answer, 'btn')));
check('Transit list "Take it"', /MIN_TOUCH/.test(styleBlock(transit, 'pickBtn')));
check('Voice sheet primary + secondary', /MIN_TOUCH/.test(styleBlock(voice, 'primary')) && /MIN_TOUCH/.test(styleBlock(voice, 'secondary')));
check('Menu quick buttons', /MIN_TOUCH/.test(styleBlock(menu, 'quickBtn')));
check('NowAddRow', /MIN_TOUCH/.test(styleBlock(nowAdd, 'row')));

console.log('\n3. Text that must not be cut\n');

{
  const tagOf = (src: string, styleName: string) => {
    const at = src.indexOf(`styles.${styleName}`);
    const open = src.lastIndexOf('<Text', at);
    return src.slice(open, src.indexOf('>', at));
  };
  check('the stepper journey line has no numberOfLines (it has a row of its own)',
    !/numberOfLines/.test(tagOf(dayCard, 'stepperLine')), tagOf(dayCard, 'stepperLine'));
  check('…and it comes BEFORE the buttons row',
    dayCard.indexOf('styles.stepperLine') < dayCard.indexOf('styles.stepBtn') && dayCard.indexOf('styles.stepperLine') > 0);
  check('a lone stepper hint does not stretch (flex only in the row with the button)',
    !/flex:\s*1/.test(styleBlock(dayCard, 'stepperHint')) && /flex:\s*1/.test(styleBlock(dayCard, 'stepperHintFlex')));
  check('the wake step icon is minWidth, not a fixed width (two emoji)',
    /minWidth:\s*24/.test(styleBlock(dayCard, 'stepIcon')) && !/[^n]width:\s*24/.test(styleBlock(dayCard, 'stepIcon')));
  check('a done card is not faded as a whole (opacity would dim the tick)', !/opacity/.test(styleBlock(dayCard, 'done')));
  check('…only its title fades', colorOf(dayCard, 'strike', 'color') === BRAND.inkFaint);

  // ClashQuestion: the label gives way, the time never does.
  check('Clash answer label shrinks', /flexShrink:\s*1/.test(styleBlock(clash, 'goldText')) && /flexShrink:\s*1/.test(styleBlock(clash, 'softText')));
  check('Clash answer time never shrinks', /flexShrink:\s*0/.test(styleBlock(clash, 'goldSmall')) && /flexShrink:\s*0/.test(styleBlock(clash, 'softSmall')));
  check('Clash answer label is capped at two lines', (clash.match(/numberOfLines=\{2\}/g) ?? []).length >= 3);

  // NowAddRow: the time is a Text of its own.
  check('NowAddRow: the time is its own Text and never shrinks',
    /styles\.time\}>\{time\}/.test(nowAdd) && /flexShrink:\s*0/.test(styleBlock(nowAdd, 'time')) && /flexShrink:\s*1/.test(styleBlock(nowAdd, 'label')));
  check('NowAddRow: the label no longer carries the clock inside its string', !/\$\{freeUntil\}|\$\{nextStart\}/.test(code(nowAdd)));

  // Transit list: "leave in N min" ahead of the station, so the station is what a cut takes.
  const boardAt = transit.indexOf('{boardLabel(o, he)}\n              </Text>');
  const urgencyAt = transit.indexOf('styles.urgency, urgent');
  check('Transit list: urgency is written BEFORE the station/board text', urgencyAt > 0 && boardAt > urgencyAt);
  check('Transit list: "Take it" has a role and a label that names the time',
    /accessibilityRole="button"/.test(transit) && /accessibilityLabel=\{he \? `[^`]*\$\{o\.departAt\}[^`]*` : `[^`]*\$\{o\.departAt\}[^`]*`\}/.test(transit));
  const sizes = [...code(transit).matchAll(/fontSize:\s*([0-9.]+)/g)].map((m) => Number(m[1]));
  check(`Transit list: every font is at least 12 (smallest ${Math.min(...sizes)})`, Math.min(...sizes) >= 12);

  // AnswerCard.
  check('AnswerCard minutes carry a unit (min / דק׳)', /styles\.minUnit/.test(answer) && /'דק׳' : 'min'/.test(answer));
  check('AnswerCard: the "~" legend is only shown where a "~" can be drawn (car / taxi rows)',
    /options\.some\(\(o\) => o\.mode === 'car' \|\| o\.mode === 'taxi'\)/.test(answer));

  // Voice sheet: capped, and the words scroll over fixed buttons.
  check('Voice sheet is capped at 85% of the window', /maxHeight:\s*windowH \* 0\.85/.test(voice));
  check('Voice sheet body scrolls', /<ScrollView style=\{styles\.body\}/.test(voice));
  check('"See my day" sits outside the ScrollView',
    voice.indexOf('</ScrollView>') > 0 && voice.indexOf('</ScrollView>') < voice.indexOf("'לראות את היום'"));

  // Tab bar.
  check('Tab bar: no half-opacity label', !/inactive:[^}]*opacity/.test(styleBlock(tabBar, 'inactive')));
  check(`Tab bar: label font is at least 11 (is ${numberOf(tabBar, 'label', 'fontSize')})`, (numberOf(tabBar, 'label', 'fontSize') ?? 0) >= 11);

  // DayCard small type.
  check(`DayCard: mode minutes at least 11 (is ${numberOf(dayCard, 'modeMin', 'fontSize')})`, (numberOf(dayCard, 'modeMin', 'fontSize') ?? 0) >= 11);

  // Menu.
  check('Menu: a Door line may take two lines', /doorLine, he && styles\.rtl\]\} numberOfLines=\{2\}/.test(menu));
  check('Menu: …and is pinned to the app language with an LRM / RLM',
    /\\u200F' : '\\u200E'\) \+ line/.test(menu));
  check('Menu quick buttons centre their label and have padding',
    /textAlign:\s*'center'/.test(styleBlock(menu, 'quickText')) && /paddingHorizontal/.test(styleBlock(menu, 'quickBtn')));

  // Late banner on Today.
  check('Late-call row wraps', /flexWrap:\s*'wrap'/.test(styleBlock(today, 'lateRow')));
  check('Late-call label is centred', /textAlign:\s*'center'/.test(styleBlock(today, 'lateBtnText')));
}

console.log('\n4. Glyphs Inter does not have\n');

const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => {
  const p = join(dir, f);
  return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(f) ? [p] : [];
});
const scanned = [...walk(join(root, 'src/components')), join(root, 'src/screens/SettingsMenu.tsx')];
{
  const banned = ['⤵', '＋', '▴', '▾', '✕'];
  const hits: string[] = [];
  for (const f of scanned) {
    const c = code(readFileSync(f, 'utf8'));
    for (const g of banned) if (c.includes(g)) hits.push(`${f.replace(root + '/', '')} has ${g}`);
  }
  check('no ⤵ ＋ ▴ ▾ ✕ left in src/components or the Menu', hits.length === 0, hits.join('; '));
}
{
  // The general guard, against the font file itself: any arrow / geometric shape / dingbat /
  // fullwidth form that is not an emoji (no U+FE0F after it) must be in Inter, or it is drawn
  // in whatever face Android falls back to.
  const fontFile = join(root, 'node_modules/@expo-google-fonts/inter/600SemiBold/Inter_600SemiBold.ttf');
  if (!existsSync(fontFile)) {
    check('Inter font file present (skipped glyph coverage: run npm ci)', true);
  } else {
    const have = interGlyphs(fontFile);
    const watched = (cp: number) => (cp >= 0x2190 && cp <= 0x21ff) || (cp >= 0x25a0 && cp <= 0x25ff)
      || (cp >= 0x2700 && cp <= 0x27bf) || (cp >= 0x2900 && cp <= 0x297f) || (cp >= 0xff00 && cp <= 0xffef)
      || (cp >= 0x2b00 && cp <= 0x2bff);
    const missing = new Map<string, string[]>();
    for (const f of scanned) {
      const chars = [...code(readFileSync(f, 'utf8'))];
      chars.forEach((ch, i) => {
        const cp = ch.codePointAt(0)!;
        // Emoji (⭐ ✨ ✅ ➕ ❓ — or any glyph followed by U+FE0F) are drawn by the emoji font on purpose.
        if (!watched(cp) || have.has(cp) || chars[i + 1] === '\uFE0F' || /\p{Emoji_Presentation}/u.test(ch)) return;
        const list = missing.get(ch) ?? [];
        list.push(f.replace(root + '/', ''));
        missing.set(ch, list);
      });
    }
    const text = [...missing].map(([ch, files]) => `${ch} U+${ch.codePointAt(0)!.toString(16).toUpperCase()} in ${[...new Set(files)].join(', ')}`).join('; ');
    check('every arrow / shape / dingbat drawn as text exists in Inter', missing.size === 0, text);
  }
}

/** The code points an Inter .ttf draws (cmap formats 4 and 12). */
function interGlyphs(file: string): Set<number> {
  const b = readFileSync(file);
  const tables = b.readUInt16BE(4);
  let cmap = -1;
  for (let i = 0; i < tables; i += 1) {
    const o = 12 + i * 16;
    if (b.toString('latin1', o, o + 4) === 'cmap') cmap = b.readUInt32BE(o + 8);
  }
  const out = new Set<number>();
  const n = b.readUInt16BE(cmap + 2);
  for (let i = 0; i < n; i += 1) {
    const off = cmap + b.readUInt32BE(cmap + 4 + i * 8 + 4);
    const fmt = b.readUInt16BE(off);
    if (fmt === 4) {
      const segX2 = b.readUInt16BE(off + 6);
      const endO = off + 14;
      const startO = endO + segX2 + 2;
      for (let s = 0; s < segX2 / 2; s += 1) {
        const end = b.readUInt16BE(endO + s * 2);
        for (let c = b.readUInt16BE(startO + s * 2); c <= end && c < 0xffff; c += 1) out.add(c);
      }
    } else if (fmt === 12) {
      const groups = b.readUInt32BE(off + 12);
      for (let g = 0; g < groups; g += 1) {
        const end = b.readUInt32BE(off + 20 + g * 12);
        for (let c = b.readUInt32BE(off + 16 + g * 12); c <= end; c += 1) out.add(c);
      }
    }
  }
  return out;
}

console.log('\n5. Right-to-left: arrows that read the right way\n');

{
  const { neighbourLine } = require('../src/utils/neighbourDeparture');
  const { walkRideWalkLine } = require('../src/utils/rideLine');
  const plan = {
    totalDurationMinutes: 40, leaveHomeAt: '10:00', arriveAt: '10:40', firstBusDeparture: '10:05', firstBusStop: 'x',
    walkToStopMinutes: 5, source: 'google', fetchedAt: 0,
    legs: [
      { type: 'walk', from: 'a', to: 'b', durationMinutes: 5, departureTime: '10:00', arrivalTime: '10:05' },
      { type: 'bus', from: 'b', to: 'c', durationMinutes: 30, departureTime: '10:05', arrivalTime: '10:35', lineNumber: '61', stopName: 'ארלוזורוב' },
      { type: 'walk', from: 'c', to: 'd', durationMinutes: 5, departureTime: '10:35', arrivalTime: '10:40' },
    ],
  };
  const task = { text: 'x', location: { address: 'x', lat: 0, lng: 0, confirmed: true, transitPlan: plan } };
  check('Hebrew journey line: ←, never →', neighbourLine(plan, '11:00', true).includes('←') && !neighbourLine(plan, '11:00', true).includes('→'));
  check('English journey line: →, never ←', neighbourLine(plan, '11:00', false).includes('→') && !neighbourLine(plan, '11:00', false).includes('←'));
  check('Hebrew closed-card route: ←', walkRideWalkLine(task, true).includes(' ← ') && !walkRideWalkLine(task, true).includes('→'));
  check('English closed-card route: →', walkRideWalkLine(task, false).includes(' → ') && !walkRideWalkLine(task, false).includes('←'));

  // The step buttons' arrow: pulled out of DayCard's own source and run.
  const m = /const stepArrow = \(dir: StepDir, he: boolean\): string => (.+);/.exec(dayCard);
  check('DayCard has stepArrow', Boolean(m));
  if (m) {
    const arrow = new Function('dir', 'he', `return ${m[1]};`) as (dir: string, he: boolean) => string;
    check('English: earlier ← (left), later → (right)', arrow('earlier', false) === '←' && arrow('later', false) === '→');
    check('Hebrew: earlier → (right), later ← (left) — outward, like the timeline', arrow('earlier', true) === '→' && arrow('later', true) === '←');
  }

  // readingRow: all four (app language) x (phone direction) combinations land on the same physical side.
  const Module = require('module');
  const rn = { I18nManager: { isRTL: false } };
  const orig = Module._load;
  Module._load = function patched(request: string, ...rest: unknown[]) {
    if (request === 'react-native') return rn;
    // eslint-disable-next-line prefer-rest-params
    return orig.apply(this, [request, ...rest]);
  };
  const { readingRow, flowArrow } = require('../src/components/today/readingRow');
  Module._load = orig;
  const sideOf = (dir: string, phoneRtl: boolean) => (phoneRtl ? (dir === 'row' ? 'right' : 'left') : (dir === 'row' ? 'left' : 'right'));
  const rows: Array<[boolean, boolean, string]> = [[false, false, 'left'], [true, false, 'right'], [true, true, 'right'], [false, true, 'left']];
  for (const [he, phoneRtl, want] of rows) {
    rn.I18nManager.isRTL = phoneRtl;
    check(`first child on the ${want}: app ${he ? 'Hebrew' : 'English'}, phone ${phoneRtl ? 'RTL' : 'LTR'}`, sideOf(readingRow(he), phoneRtl) === want);
  }
  rn.I18nManager.isRTL = false;
  check('a plain row on an LTR phone → points right', flowArrow() === '→');
  rn.I18nManager.isRTL = true;
  check('a plain row on an RTL phone ← points left', flowArrow() === '←');
}


// 17.10: the "Later" button of a sheet was cut by Android's navigation bar.
{
  const sheet = require('fs').readFileSync('src/components/ui/BottomSheet.tsx', 'utf8');
  const okRoom = /insets\.bottom > 0 \? insets\.bottom \+ 12 : \(Platform\.OS === 'android' \? 48 : 16\)/.test(sheet)
    && /paddingBottom: bottomRoom/.test(sheet);
  if (okRoom) { console.log('  ✓ every bottom sheet clears the navigation bar, even when the inset reads 0'); }
  else { console.error('  ✗ bottom sheet can sit under the navigation bar'); process.exitCode = 1; }
}
console.log(`\n${failures === 0 ? '✅' : '❌'} ${checks - failures}/${checks} checks passed`);
if (failures > 0) process.exit(1);
