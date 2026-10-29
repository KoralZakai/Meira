/**
 * run-today-suggest — Koral's 17.10 Today asks, pinned at the source.
 *
 * 1. "+ Add something" opens Meira's suggestions IN PLACE, with "+ Add your own ›"
 *    at the bottom leading to the Add screen; a new idea arrives in the Add
 *    screen's box (initialText).
 * 2. Every unfinished row opens its full text on a tap. On v35 nothing opened:
 *    the "is it long?" measure (an invisible copy's onTextLayout) never saw a
 *    second line on her phone, and the tap was gated on it.
 * 3. The row icons are small to the eye and 44dp to the finger.
 *
 * Source checks, like run-ui-contrast: the bug was a gate in the JSX, not logic.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MIN_TOUCH } from '../src/constants/theme';

let checks = 0;
let failures = 0;
function check(label: string, ok: boolean, detail = '') {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${label}${ok ? '' : `  — ${detail}`}`);
}
const root = join(__dirname, '..');
const read = (rel: string) => readFileSync(join(root, rel), 'utf8');
/** Source with comments removed — a word in a comment is not code. */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/([^:'"`])\/\/.*$/gm, '$1');

const today = code(read('src/screens/TodaySchedule.tsx'));
const panel = code(read('src/components/today/SuggestPanel.tsx'));
const add = code(read('src/screens/AddTaskScreen.tsx'));
const nav = read('src/types/navigation.ts');
const card = code(read('src/components/YesterdayCard.tsx'));

console.log('\n1. "+ Add something" → suggestions in place, "+ Add your own" last\n');
check('the now-row + toggles the panel instead of navigating', /NowAddRow[\s\S]{0,300}onPress=\{\(\) => setSuggestOpen\(\(v\) => !v\)\}/.test(today));
check('the panel is drawn under it while open', /suggestOpen \? \(\s*<SuggestPanel/.test(today));
check('"Add your own" opens the Add screen for the day on screen', /onAddOwn=\{\(\) => navigation\.navigate\('AddTask', \{[^}]*initialDate: dateKey/.test(today));
check('a new idea arrives in the Add screen\'s box', /initialText:/.test(today) && /useState\(route\.params\?\.initialText \?\? ''\)/.test(add) && /initialText\?: string/.test(nav));
check('the panel shows the Add screen\'s own rows (one ranking, two places)', /useAddSuggestions\(date\)/.test(panel) && /<SuggestionList[\s\S]*onToday/.test(panel));
check('"+ Add your own" is the panel\'s last row', /\+ Add your own[\s\S]*<\/Pressable>\s*<\/View>\s*\);\s*\}/.test(panel));
// Since 27.10 the apply + Undo lives in hooks/useApplySuggestion, shared with the chat home's card.
const applyHook = readFileSync(join(__dirname, '..', 'src', 'hooks', 'useApplySuggestion.ts'), 'utf8');
check('a picked suggestion can be undone', /takeBack/.test(panel) && /useApplySuggestion\(/.test(panel)
  && /updateTaskFields\(taskId, before\)/.test(applyHook));
check('a failed apply is said, not swallowed', /setFailed\(/.test(applyHook) && /console\.warn\('\[Suggestion\]/.test(applyHook));
check('no glyph Inter cannot draw (＋)', !/＋/.test(panel));

console.log('\n1b. "+" is smart from now until the next event (18.10)\n');
const list = code(read('src/components/add/SuggestionList.tsx'));
const sources = code(read('src/services/AddSuggestionSources.ts'));
check('the + row is counted from now with the SHORT floor, not the timeline\'s 45 minutes', /plusSlot\(/.test(today) && /minMinutes: PLUS_MIN_MINUTES/.test(today));
check('the now window is not drawn twice (compared by start, not identity)', /listGaps\.filter\(\(g\) => !\(nowGap && g\.start === nowGap\.start\)\)/.test(today));
check('+ Add your own carries where the window closes', /initialUntil: plus\?\.until/.test(today) && /initialUntil\?: string/.test(nav));
check('the Add screen ends a block at the window, never an hour past the next event', /initialUntil && initialUntil > from && initialUntil < hour/.test(add));
check('the suggestions read today\'s window from NOW, however short', /PLUS_MIN_MINUTES/.test(sources) && /timeToMinutes\(g\.start\) <= timeToMinutes\(time\)/.test(sources));
check('a row that only OPENS the task is a ›, never a + that adds nothing', /r\.action\.kind === 'open'[\s\S]{0,160}styles\.open/.test(list));

console.log('\n2. every unfinished row opens on a tap\n');
check('the row tap is not gated on a measurement', /onPress=\{\(\) => toggle\(setExpanded, task\.id\)\}/.test(card) && !/canOpen/.test(card));
check('no invisible onTextLayout measure is left', !/onTextLayout/.test(card));
check('closed rows show two lines, open rows all of it', /numberOfLines=\{isOpen \? undefined : 2\}/.test(card));

console.log('\n3. icons: small to the eye, 44dp to the finger\n');
const icon = Number((card.match(/const ICON = (\d+);/) ?? [])[1]);
const slop = card.match(/const ICON_SLOP = \{ top: (\d+), bottom: (\d+)/);
check(`the icon circle is ≤ 26dp (is ${icon})`, icon > 0 && icon <= 26);
check('its touch height still reaches 44dp', Boolean(slop) && icon + Number(slop![1]) + Number(slop![2]) >= MIN_TOUCH);
check('all three icon buttons carry the slop', (card.match(/hitSlop=\{ICON_SLOP\}/g) ?? []).length === 3);

console.log(`\n${failures === 0 ? '✅' : '❌'} ${checks - failures}/${checks} checks passed`);
if (failures > 0) process.exit(1);
