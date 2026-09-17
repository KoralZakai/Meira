import { Task, DailySchedule } from '../src/types/index';

interface ParsingExpected {
  count?: number;
  count_gte?: number;
  tasks: Array<{
    text_contains?: string;
    category?: string;
    category_in?: string[];
    priority?: string;
    hasLocation?: boolean;
    location_contains?: string;
    fixedTime?: string;
    isFixed?: boolean;
    durationMinutes_approx?: number;
    hasDeadline?: boolean;
    deadline?: string;
  }>;
}

interface ScheduleExpected {
  tasks_count_gte?: number;
  tasks_are_sorted?: boolean;
  all_tasks_have_times?: boolean;
  fixed_tasks_preserve_time?: boolean;
  first_task_priority_must?: boolean;
  fixed_task_at_index_0_has_time?: string;
  fixed_task_at_index_1_has_time?: string;
  flexible_task_has_assigned_time?: boolean;
}

export function evaluateParsing(actual: Task[], expected: ParsingExpected): { pass: boolean; errors: string[] } {
  const errors: string[] = [];

  if (expected.count !== undefined && actual.length !== expected.count) {
    errors.push(`Expected ${expected.count} tasks, got ${actual.length}`);
  }

  if (expected.count_gte !== undefined && actual.length < expected.count_gte) {
    errors.push(`Expected >= ${expected.count_gte} tasks, got ${actual.length}`);
  }

  for (let i = 0; i < Math.min(actual.length, expected.tasks.length); i++) {
    const actualTask = actual[i];
    const expectedTask = expected.tasks[i];

    if (expectedTask.text_contains && !actualTask.text.includes(expectedTask.text_contains)) {
      errors.push(`Task ${i}: text should contain "${expectedTask.text_contains}", got "${actualTask.text}"`);
    }

    if (expectedTask.category && actualTask.category !== expectedTask.category) {
      errors.push(`Task ${i}: expected category "${expectedTask.category}", got "${actualTask.category}"`);
    }

    if (expectedTask.category_in && !expectedTask.category_in.includes(actualTask.category)) {
      errors.push(`Task ${i}: category should be one of ${expectedTask.category_in.join('/')}, got "${actualTask.category}"`);
    }

    if (expectedTask.priority && actualTask.priority !== expectedTask.priority) {
      errors.push(`Task ${i}: expected priority "${expectedTask.priority}", got "${actualTask.priority}"`);
    }

    if (expectedTask.hasLocation !== undefined) {
      const hasLoc = !!actualTask.location;
      if (hasLoc !== expectedTask.hasLocation) {
        errors.push(`Task ${i}: hasLocation mismatch, expected ${expectedTask.hasLocation}, got ${hasLoc}`);
      }
    }

    if (expectedTask.location_contains && actualTask.location?.address) {
      if (!actualTask.location.address.includes(expectedTask.location_contains)) {
        errors.push(`Task ${i}: location should contain "${expectedTask.location_contains}", got "${actualTask.location.address}"`);
      }
    }

    if (expectedTask.fixedTime && actualTask.fixedTime !== expectedTask.fixedTime) {
      errors.push(`Task ${i}: expected fixedTime "${expectedTask.fixedTime}", got "${actualTask.fixedTime}"`);
    }

    if (expectedTask.isFixed !== undefined && actualTask.isFixed !== expectedTask.isFixed) {
      errors.push(`Task ${i}: isFixed mismatch, expected ${expectedTask.isFixed}, got ${actualTask.isFixed}`);
    }

    if (expectedTask.durationMinutes_approx) {
      const diff = Math.abs((actualTask.durationMinutes || 0) - expectedTask.durationMinutes_approx);
      if (diff > 30) {
        errors.push(`Task ${i}: duration should be ~${expectedTask.durationMinutes_approx}min, got ${actualTask.durationMinutes}min`);
      }
    }

    if (expectedTask.hasDeadline !== undefined) {
      const hasDead = !!actualTask.deadline;
      if (hasDead !== expectedTask.hasDeadline) {
        errors.push(`Task ${i}: hasDeadline mismatch, expected ${expectedTask.hasDeadline}, got ${hasDead}`);
      }
    }

    if (expectedTask.deadline && actualTask.deadline !== expectedTask.deadline) {
      errors.push(`Task ${i}: expected deadline "${expectedTask.deadline}", got "${actualTask.deadline}"`);
    }
  }

  return { pass: errors.length === 0, errors };
}

export function evaluateSchedule(actual: DailySchedule, expected: ScheduleExpected): { pass: boolean; errors: string[] } {
  const errors: string[] = [];

  if (expected.tasks_count_gte && actual.tasks.length < expected.tasks_count_gte) {
    errors.push(`Expected >= ${expected.tasks_count_gte} tasks, got ${actual.tasks.length}`);
  }

  if (expected.tasks_are_sorted) {
    for (let i = 1; i < actual.tasks.length; i++) {
      const prevTask = actual.tasks[i - 1];
      const currTask = actual.tasks[i];
      const prevPrio = getPriorityNum(prevTask.priority);
      const currPrio = getPriorityNum(currTask.priority);

      if (prevPrio > currPrio) {
        errors.push(`Tasks not sorted by priority: ${prevTask.text} (${prevTask.priority}) before ${currTask.text} (${currTask.priority})`);
        break;
      }
    }
  }

  if (expected.all_tasks_have_times && actual.tasks.some(t => !t.scheduledTime)) {
    errors.push('Not all tasks have scheduledTime assigned');
  }

  if (expected.fixed_tasks_preserve_time) {
    for (const task of actual.tasks) {
      if (task.isFixed && task.fixedTime && task.scheduledTime !== task.fixedTime) {
        errors.push(`Fixed task "${task.text}" scheduled at ${task.scheduledTime} but fixedTime is ${task.fixedTime}`);
      }
    }
  }

  if (expected.first_task_priority_must && actual.tasks[0] && actual.tasks[0].priority !== 'must') {
    errors.push(`First task priority is "${actual.tasks[0].priority}", expected "must"`);
  }

  if (expected.fixed_task_at_index_0_has_time && actual.tasks[0]) {
    if (actual.tasks[0].fixedTime !== expected.fixed_task_at_index_0_has_time) {
      errors.push(`Task at index 0 fixedTime is "${actual.tasks[0].fixedTime}", expected "${expected.fixed_task_at_index_0_has_time}"`);
    }
  }

  if (expected.fixed_task_at_index_1_has_time && actual.tasks[1]) {
    if (actual.tasks[1].fixedTime !== expected.fixed_task_at_index_1_has_time) {
      errors.push(`Task at index 1 fixedTime is "${actual.tasks[1].fixedTime}", expected "${expected.fixed_task_at_index_1_has_time}"`);
    }
  }

  if (expected.flexible_task_has_assigned_time) {
    const flexibleTask = actual.tasks.find(t => !t.isFixed);
    if (flexibleTask && !flexibleTask.scheduledTime) {
      errors.push(`Flexible task "${flexibleTask.text}" has no scheduledTime assigned`);
    }
  }

  return { pass: errors.length === 0, errors };
}

function getPriorityNum(priority: string): number {
  const map: Record<string, number> = { must: 0, have_to: 1, need_to: 2, nice_to_do: 3 };
  return map[priority] ?? 4;
}
