/**
 * run-task-search — finding a task again in a list of a hundred-plus.
 *
 * The list had four filters and no search at all. The asks were specific:
 * free text, and by topic — "interviews", "sport", "party". Topics are unions
 * of existing categories, because nobody thinks in the app's internal category
 * names, and "sport" spans gym AND hobby_class.
 *
 * The keyword fallback matters as much as the category match: categories are
 * auto-assigned by an LLM and are often wrong, so a task that plainly says
 * "yoga" must be findable under sport even when it was filed as 'general'.
 *
 * Run:  npx tsx tests/run-task-search.ts
 */
import { searchTasks, matchesTopic, TASK_TOPICS } from '../src/utils/searchTasks';
import { Task } from '../src/types/index';

let failures = 0;
let checks = 0;
function check(label: string, ok: boolean, detail = '') {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `  — ${detail}` : ''}`);
}

const t = (text: string, category: any, over: Partial<Task> = {}): Task => ({
  id: text, text, category, priority: 'need_to', isFixed: false,
  durationMinutes: 60, date: '2026-08-27', status: 'pending',
  createdAt: 0, historicalDurations: [], ...over,
} as Task);

// Drawn from her real list.
const tasks = [
  t('1st Job Interview - Koral Zakai', 'interview'),
  t('כנס של האקריות', 'conference'),
  t('אימון עיצוב', 'gym'),
  t('שיעור יוגה', 'general'),                    // MISFILED on purpose
  t('הופעה בערב עם אורטל של ברי סחרוב', 'leisure'),
  t('תור לרן קידר', 'doctor'),
  t('אפטר אופיס', 'general'),                    // misfiled too
  t('פגישת זום', 'zoom'),
  t('הכנסת פסטה', 'general'),
  t('VLM homework', 'course', { location: 'Yigal Alon 94' as any }),
];
const topic = (id: string) => TASK_TOPICS.find((x) => x.id === id)!;

function main() {
  console.log('\nTask search\n');

  console.log('1. Free text');
  check('finds by a Hebrew word', searchTasks(tasks, 'יוגה').length === 1);
  check('finds by an English word', searchTasks(tasks, 'interview').length === 1);
  check('is case-insensitive', searchTasks(tasks, 'INTERVIEW').length === 1);
  check('matches a partial word', searchTasks(tasks, 'הופע').length === 1);
  check('searches the location too',
    searchTasks(tasks, 'Yigal').length === 1, searchTasks(tasks, 'Yigal')[0]?.text);
  check('no match returns nothing', searchTasks(tasks, 'zzzz').length === 0);
  check('an empty query returns everything', searchTasks(tasks, '').length === tasks.length);

  console.log('\n2. Topics — the three she named');
  const interviews = searchTasks(tasks, '', 'interviews');
  check('Interviews finds the interview', interviews.length === 1, interviews[0]?.text);
  const sport = searchTasks(tasks, '', 'sport');
  check('Sport finds both the workout AND the yoga', sport.length === 2,
    sport.map((x) => x.text).join(' · '));
  const social = searchTasks(tasks, '', 'social');
  check('Going out finds the concert and after-office', social.length === 2,
    social.map((x) => x.text).join(' · '));

  console.log('\n3. A wrong category must not hide a task');
  // This is the whole reason for keyword matching.
  check('yoga filed as "general" still counts as sport',
    matchesTopic(t('שיעור יוגה', 'general'), topic('sport')));
  check('after-office filed as "general" still counts as going out',
    matchesTopic(t('אפטר אופיס', 'general'), topic('social')));
  check('pasta is NOT sport', !matchesTopic(t('הכנסת פסטה', 'general'), topic('sport')));

  console.log('\n4. Text and topic together');
  const both = searchTasks(tasks, 'יוגה', 'sport');
  check('narrows within the topic', both.length === 1, both[0]?.text);
  check('a contradiction returns nothing', searchTasks(tasks, 'interview', 'sport').length === 0);

  console.log('\n5. Every topic is usable');
  for (const tp of TASK_TOPICS) {
    check(`${tp.labelEn} has categories and keywords`,
      tp.categories.length > 0 && tp.keywords.length > 0);
  }

  console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${checks - failures}/${checks} checks\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
