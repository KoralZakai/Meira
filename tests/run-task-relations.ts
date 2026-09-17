/**
 * run-task-relations — which task belongs under which.
 *
 * The two cases the user gave, which need two different mechanisms:
 *   "לשפר את ה-UX UI של לומי"      → belongs under "לשפר את לומי" by WORDING
 *   "לתקן את הבאג בנוטיפיקציות"    → belongs under it too, but shares no words
 *                                     at all, so only context can relate them
 *
 * The second case is the point of this file: it asserts that wording does NOT
 * catch it, so nobody later "fixes" the scorer by loosening it until unrelated
 * tasks start nesting. Loose nesting is worse than none — a task filed under
 * the wrong project is a task you cannot find.
 *
 * Run:  npx tsx tests/run-task-relations.ts
 */
import {
  relatednessScore, canBeParent, buildTaskTree, childProgress,
  SUGGEST_THRESHOLD, AUTO_FILE_THRESHOLD,
} from '../src/utils/taskRelations';
import { Task } from '../src/types/index';

let failures = 0;
let checks = 0;
function check(label: string, ok: boolean, detail = '') {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `  — ${detail}` : ''}`);
}

const t = (id: string, text: string, extra: Partial<Task> = {}): Task => ({
  id,
  text,
  status: 'pending',
  isFixed: false,
  durationMinutes: 30,
  date: '2026-08-21',
  createdAt: 0,
  historicalDurations: [],
  ...extra,
} as Task);

function main() {
  console.log('\nTask nesting\n');

  const project = t('p', 'לשפר את לומי');

  console.log('1. Wording relates a child to its project');
  const uxChild = t('c1', 'לשפר את ה-UX UI של לומי');
  const uxScore = relatednessScore(uxChild, project);
  check('"לשפר את ה-UX UI של לומי" nests under "לשפר את לומי"',
    uxScore >= SUGGEST_THRESHOLD, uxScore.toFixed(2));

  const dupChild = t('c2', 'לומי - לתקן דופליקציות');
  check('"לומי - לתקן דופליקציות" nests too',
    relatednessScore(dupChild, project) >= SUGGEST_THRESHOLD,
    relatednessScore(dupChild, project).toFixed(2));

  console.log('\n2. Wording alone must NOT relate everything');
  // Deliberately asserted as a NON-match: this task genuinely belongs under
  // the project, but nothing in its words says so. It is reached through the
  // recently-used parent instead. If this ever starts matching, the scorer has
  // been loosened far enough to nest unrelated work.
  const bugChild = t('c3', 'לתקן את הבאג בנוטיפיקציות');
  check('"לתקן את הבאג בנוטיפיקציות" is NOT matched by wording',
    relatednessScore(bugChild, project) < SUGGEST_THRESHOLD,
    `${relatednessScore(bugChild, project).toFixed(2)} — needs the recent-parent path`);

  for (const [label, text] of [
    ['groceries', 'לקנות חלב'],
    ['yoga', 'יוגה ב-11:00 ביגאל אלון'],
    ['doctor', 'תור לרופא שיניים'],
  ] as const) {
    const score = relatednessScore(t('x', text), project);
    check(`unrelated task (${label}) does not nest`, score < SUGGEST_THRESHOLD, score.toFixed(2));
  }

  console.log('\n3. Confident enough to file without asking?');
  // The user should only be interrupted when the answer is genuinely in doubt.
  // Being asked to confirm the obvious trains you to tap "yes" unread — and
  // once one pair is confirmed the next card looks the same, so the whole
  // thing reads as "nothing happened".
  check('an obvious child is filed automatically, not asked about',
    relatednessScore(uxChild, project) >= AUTO_FILE_THRESHOLD,
    uxScore.toFixed(2));
  check('a partial match is asked about, not assumed',
    relatednessScore(dupChild, project) >= SUGGEST_THRESHOLD
    && relatednessScore(dupChild, project) < AUTO_FILE_THRESHOLD,
    relatednessScore(dupChild, project).toFixed(2));
  check('the auto bar sits above the ask bar', AUTO_FILE_THRESHOLD > SUGGEST_THRESHOLD);

  console.log('\n3. Structure rules');
  check('a completed task cannot be a parent',
    !canBeParent(t('done', 'לשפר את לומי', { status: 'complete' })));
  check('a child cannot be a parent (one level only)',
    !canBeParent(t('kid', 'משהו', { parentId: 'p' })));
  check('a task never parents itself', relatednessScore(project, project) === 0);

  console.log('\n4. Building the tree');
  const tasks = [
    project,
    t('c1', 'לשפר את ה-UX', { parentId: 'p' }),
    t('c2', 'לתקן באג', { parentId: 'p', status: 'complete' }),
    t('solo', 'לקנות חלב'),
  ];
  const tree = buildTaskTree(tasks);
  check('two roots', tree.length === 2, `${tree.length}`);
  check('the project owns both children',
    tree.find((n) => n.task.id === 'p')?.children.length === 2);
  const prog = childProgress(tree.find((n) => n.task.id === 'p')!.children);
  check('progress counts completed children', prog.done === 1 && prog.total === 2,
    `${prog.done}/${prog.total}`);

  // A child whose parent is filtered out of the current view must still appear.
  const orphaned = buildTaskTree([t('c9', 'ילד יתום', { parentId: 'missing' })]);
  check('an orphan is shown at top level, never hidden', orphaned.length === 1);

  console.log(`\n${failures === 0 ? '✅' : '❌'} ${checks - failures}/${checks} checks passed\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
