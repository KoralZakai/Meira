/**
 * run-ask-examples — the chat's "What can I ask?" starters (21.10).
 * Run:  npx tsx tests/run-ask-examples.ts
 */
import { ASK_GROUPS, isStarter } from '../src/constants/askExamples';

let failures = 0; let checks = 0;
const check = (l: string, ok: boolean) => { checks += 1; if (!ok) failures += 1; console.log(`  ${ok ? '✓' : '✗'} ${l}`); };

const all = ASK_GROUPS.flatMap((g) => g.examples);
check('every example has both languages', all.every((e) => e.en.trim() && e.he.trim()));
check('ids are unique', new Set(all.map((e) => e.id)).size === all.length);
check('a starter and its Hebrew twin agree on being a starter', all.every((e) => isStarter(e.en) === isStarter(e.he)));
check('"When do I get home tomorrow from…" is offered (the question Koral asked on 21.10)', all.some((e) => e.id === 'home'));
check('a finished question is sent, a starter is not', !isStarter('Plan my day') && isStarter('How do I get to…'));
check('at least one example per theme', ASK_GROUPS.every((g) => g.examples.length >= 3));

if (failures) { console.error(`\nFAIL — ${checks - failures}/${checks}`); process.exit(1); }
console.log(`\n✅ ${checks}/${checks} checks passed`);
