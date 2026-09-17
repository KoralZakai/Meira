#!/usr/bin/env npx tsx
/**
 * EDD (Evaluation Driven Development) Test Runner
 * Loads fixture JSON files and validates parsing + schedule generation
 */

import * as fs from 'fs';
import * as path from 'path';
import { parseSpeechToTasksWithExpansion } from '../src/services/TaskParser';
import { sortTasksByPriorityAndTime } from '../src/utils/timeUtils';
import { evaluateParsing, evaluateSchedule } from './edd-evaluator';
import { Task, DailySchedule } from '../src/types/index';

interface ParsingFixture {
  id: string;
  description: string;
  input: string;
  date: string;
  expected: any;
}

interface ScheduleFixture {
  id: string;
  description: string;
  input_tasks: Task[];
  expected_schedule: any;
}

const PARSING_FIXTURE_DIR = path.join(__dirname, 'fixtures', 'parsing');
const SCHEDULE_FIXTURE_DIR = path.join(__dirname, 'fixtures', 'schedule');

async function runParsingTests(): Promise<{ passed: number; failed: number }> {
  console.log('\n📝 PARSING TESTS\n');

  const files = fs.readdirSync(PARSING_FIXTURE_DIR).filter(f => f.endsWith('.json'));
  let passed = 0;
  let failed = 0;

  for (const file of files) {
    const fixture = JSON.parse(fs.readFileSync(path.join(PARSING_FIXTURE_DIR, file), 'utf-8')) as ParsingFixture;

    try {
      const actual = await parseSpeechToTasksWithExpansion(fixture.input, fixture.date);
      const result = evaluateParsing(actual, fixture.expected);

      if (result.pass) {
        console.log(`✅ ${fixture.id}`);
        passed++;
      } else {
        console.log(`❌ ${fixture.id}`);
        result.errors.forEach(e => console.log(`   └ ${e}`));
        failed++;
      }
    } catch (e) {
      console.log(`❌ ${fixture.id} (error)`);
      console.log(`   └ ${e instanceof Error ? e.message : String(e)}`);
      failed++;
    }
  }

  return { passed, failed };
}

function runScheduleTests(): { passed: number; failed: number } {
  console.log('\n📅 SCHEDULE TESTS\n');

  const files = fs.readdirSync(SCHEDULE_FIXTURE_DIR).filter(f => f.endsWith('.json'));
  let passed = 0;
  let failed = 0;

  for (const file of files) {
    const fixture = JSON.parse(fs.readFileSync(path.join(SCHEDULE_FIXTURE_DIR, file), 'utf-8')) as ScheduleFixture;

    try {
      const sorted = sortTasksByPriorityAndTime(fixture.input_tasks);
      const schedule: DailySchedule = {
        date: new Date().toISOString().split('T')[0],
        tasks: sorted,
        wakeUpTime: '07:00',
        generatedAt: Date.now(),
        lumiSummary: '',
        lumiSummaryHe: '',
      };

      const result = evaluateSchedule(schedule, fixture.expected_schedule);

      if (result.pass) {
        console.log(`✅ ${fixture.id}`);
        passed++;
      } else {
        console.log(`❌ ${fixture.id}`);
        result.errors.forEach(e => console.log(`   └ ${e}`));
        failed++;
      }
    } catch (e) {
      console.log(`❌ ${fixture.id} (error)`);
      console.log(`   └ ${e instanceof Error ? e.message : String(e)}`);
      failed++;
    }
  }

  return { passed, failed };
}

async function main() {
  const args = process.argv.slice(2);
  const type = args.find(a => a.startsWith('--type='))?.split('=')[1];

  let totalPassed = 0;
  let totalFailed = 0;

  if (!type || type === 'parsing') {
    const result = await runParsingTests();
    totalPassed += result.passed;
    totalFailed += result.failed;
  }

  if (!type || type === 'schedule') {
    const result = runScheduleTests();
    totalPassed += result.passed;
    totalFailed += result.failed;
  }

  console.log(`\n${'='.repeat(50)}`);
  console.log(`Results: ${totalPassed} passed, ${totalFailed} failed`);
  console.log(`${'='.repeat(50)}\n`);

  process.exit(totalFailed > 0 ? 1 : 0);
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
