/** useTasks — stateful task list for a date with CRUD helpers. Depends on TaskStorage. */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AppState } from 'react-native';
import { parseSpeechToTasksWithExpansion, extractTaskTags, inferTaskDetails, ParsedTask } from '../services/TaskParser';
import { parseTimeExpression } from '../utils/timeParser';
import { parseWakeRequest } from '../utils/wakeRequest';
import { extractHebrewPlaceParts } from '../utils/hebrewPlace';
import { armTaskAlerts } from '../services/NotificationService';
import { taskNeedsAlerts } from '../utils/alertPlan';
import { armDueAlarms } from '../services/AlarmPlanner';
import { recallPlace } from '../services/KnownPlacesStore';
import { loadProfile } from '../services/UserProfileStorage';
import { planArrivedTasks } from '../services/ArrivedTaskPlanner';
import { routineForTask, sameHourOfDay } from '../utils/routines';
import {
  addTask,
  addTasksForDate,
  deleteTask,
  editTaskText,
  repairAutoRolledTasks,
  getAllTasks,
  purgeDuplicateTasks,
  flushPendingCloudWrites,
  getBacklogBeforeDate,
  markTaskComplete,
  toDateKey,
  updateTaskFields,
} from '../services/TaskStorage';
import { pullWhatsAppTasks } from '../services/WhatsAppTaskSync';
import { classifyTaskIntent, extractPatch, resolveTargetTask, TaskIntentKind } from '../services/TaskIntent';
import { textSimilarity } from '../utils/fuzzyMatch';
import { Task, TaskPriority } from '../types/index';

/** A recognized non-create voice command, awaiting user confirmation. */
export interface PendingTaskAction {
  kind: Exclude<TaskIntentKind, 'create'>;
  task: Task;
  patch: Partial<Task>;
}

/** Outcome of processSpeechCommand — the screen decides what UI to show. */
export type SpeechCommandResult =
  | { type: 'create' }
  | { type: 'confirm'; action: PendingTaskAction }
  | { type: 'ambiguous'; kind: Exclude<TaskIntentKind, 'create'>; patch: Partial<Task>; candidates: Task[] }
  | { type: 'not_found'; kind: Exclude<TaskIntentKind, 'create'> }
  /** New text closely matches an existing task — ask "same task?" before adding. */
  | { type: 'duplicate'; action: PendingTaskAction };

export interface BacklogGroup {
  date: string;
  tasks: Task[];
}

function priorityWeight(priority?: TaskPriority): number {
  if (priority === 'must') {
    return 0;
  }
  if (priority === 'have_to') {
    return 1;
  }
  if (priority === 'need_to') {
    return 2;
  }
  if (priority === 'nice_to_do') {
    return 3;
  }
  return 1;
}

export function useTasks() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const today = toDateKey();

  const refresh = useCallback(async () => {
    setIsLoading(true);
    // Undo the old silent auto-rollover once (see TaskStorage). NOTHING moves
    // a task between days on its own any more — an unfinished task keeps its
    // date and the Today screen asks about it.
    await repairAutoRolledTasks(today).catch(() => 0);
    const all = await getAllTasks();
    setTasks(all);
    setIsLoading(false);
  }, [today]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // One-time cleanup of accumulated duplicate rows in the cloud/server stores
  // (getAllTasks already de-dupes what the UI sees; this removes them for good).
  // Anything the server never received, sent again — on mount and whenever
  // the app comes back, which is when a dead connection has usually revived.
  useEffect(() => {
    const flush = () => { flushPendingCloudWrites().catch(() => {}); };
    flush();
    const sub = AppState.addEventListener('change', (st) => {
      if (st === 'active') flush();
    });
    return () => sub.remove();
  }, []);

  useEffect(() => {
    purgeDuplicateTasks()
      .then((n) => { if (n > 0) refresh(); })
      .catch(() => {});
  }, [refresh]);

  // Pull in any tasks the user created over WhatsApp — once on mount, and again
  // every time the app returns to the foreground (a task sent to Lumi while the
  // app was backgrounded shows up on the next open). Best-effort — never blocks
  // the local load.
  useEffect(() => {
    const pull = () => {
      pullWhatsAppTasks()
        .then((added) => { if (added > 0) refresh(); })
        .catch(() => {});
    };
    pull();
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') pull();
    });
    return () => sub.remove();
  }, [refresh]);

  const todayTasks = useMemo(
    () => tasks
      .filter((task) => task.date === today && task.status !== 'moved')
      .sort((a, b) => {
        const priorityDelta = priorityWeight(a.priority) - priorityWeight(b.priority);
        if (priorityDelta !== 0) {
          return priorityDelta;
        }
        return a.createdAt - b.createdAt;
      }),
    [tasks, today],
  );

  const progress = useMemo(() => {
    const total = todayTasks.length;
    const complete = todayTasks.filter((task) => task.status === 'complete').length;
    return { total, complete };
  }, [todayTasks]);

  const [backlog, setBacklog] = useState<BacklogGroup[]>([]);

  const refreshBacklog = useCallback(async () => {
    const previous = await getBacklogBeforeDate(today);
    const grouped = previous.reduce<Record<string, Task[]>>((acc, task) => {
      if (!acc[task.date]) {
        acc[task.date] = [];
      }
      acc[task.date].push(task);
      return acc;
    }, {});

    const byDate: BacklogGroup[] = Object.entries(grouped)
      .map(([date, groupTasks]) => ({ date, tasks: groupTasks }))
      .sort((a, b) => (a.date < b.date ? 1 : -1));

    setBacklog(byDate);
  }, [today]);

  useEffect(() => {
    refreshBacklog();
  }, [refreshBacklog, tasks]);

  const toggleTask = useCallback(
    async (taskId: string, shouldComplete: boolean) => {
      await markTaskComplete(taskId, shouldComplete);
      await refresh();
    },
    [refresh],
  );

  const removeTask = useCallback(
    async (taskId: string) => {
      await deleteTask(taskId);
      await refresh();
    },
    [refresh],
  );

  const updateTaskText = useCallback(
    async (taskId: string, text: string) => {
      const derived = inferTaskDetails(text);
      await editTaskText(taskId, text, extractTaskTags(text));
      await updateTaskFields(taskId, {
        category: derived.category,
        subgroup: derived.subgroup ?? undefined,
      });
      await refresh();
    },
    [refresh],
  );

  const updateTaskDetails = useCallback(
    async (taskId: string, patch: Partial<Task>) => {
      await updateTaskFields(taskId, patch);
      await refresh();
    },
    [refresh],
  );

  const addManualTask = useCallback(
    // `date` matters: the + button on a timeline showing TOMORROW used to add
    // the task to today, because this always wrote today's date. A screen that
    // knows which day it is drawing has to be able to say so.
    async (text: string, extra?: { fixedTime?: string; durationMinutes?: number; date?: string }) => {
      const derived = inferTaskDetails(text);
      // READ THE SENTENCE. This used to take the time from the From/Until
      // pickers and nothing else, so "אימון ב 8 בערב ביגאל אלון 94" typed into
      // the + screen contributed its category and NOTHING else — no hour, no
      // address — and whatever the picker happened to hold became the time.
      // The pickers still win when the user actually set one; they are an
      // explicit choice. The text is the fallback, not the other way round.
      const te = parseTimeExpression(text);
      const onDate = extra?.date ?? te.deadline ?? today;
      // HER WEEK ALREADY SAYS. "קיקבוקס" is a line in her routines with an hour
      // and an address, and the task used to be created with neither. The
      // routine's hour is used when she named none, or named the same hour of
      // day ("ב 8 וחצי" for a 20:30 class); a picker she actually set wins.
      const routine = await loadProfile()
        .then((p: any) => routineForTask(text, p?.routinesNotes, onDate))
        .catch(() => null);
      const said = extra?.fixedTime ?? te.fixedTime ?? undefined;
      const useRoutineHour = !extra?.fixedTime && Boolean(routine?.timeApplies)
        && (!said || sameHourOfDay(said, routine?.time));
      const fixedTime = useRoutineHour ? routine!.time : said;
      // "תעירי אותי ב-7" is an instruction, and nothing used to write it down:
      // Task.alarmAt was read by the alarm planner and set by no one, so the
      // only alarm possible was the one derived from a route.
      const alarmAt = parseWakeRequest(text) ?? undefined;
      const { place, activity } = extractHebrewPlaceParts(text);
      // SHE ALREADY TOLD US WHERE THIS HAPPENS.
      //
      // "יוגה ב-11" names an activity and no address, and until now that meant
      // no place, no route, no leave time and no alert — every single time,
      // however many times she had written the address before. `activityKey`
      // was stored on the task for exactly this and read by nothing.
      //
      // Only when she named no place herself: what she types now always wins
      // over what she typed last month. See utils/knownPlaces.
      const recalled = place ? null : await recallPlace(text).catch(() => null);
      const hasTime = Boolean(fixedTime);
      const saved = await addTask({
        text,
        tags: extractTaskTags(text),
        date: onDate,
        status: 'pending',
        source: 'manual',
        category: derived.category,
        priority: 'need_to',
        isFixed: hasTime,
        fixedTime,
        scheduledTime: fixedTime,
        durationMinutes:
          extra?.durationMinutes ?? te.durationMinutes
          ?? (useRoutineHour ? routine?.minutes : undefined) ?? derived.durationMinutes ?? 30,
        // A string here is enough: GoogleSync.ensureTravelChain geocodes it and
        // builds the leave/wake chain, which is the whole point of typing an
        // address into a task.
        ...(place
          ? { location: place, hasLocation: true }
          : recalled
            ? {
              // Stored placed, with the coordinates we already had — so the map
              // has a pin and the travel chain has somewhere to route to on the
              // very first sweep, with no lookup at all.
              location: {
                address: recalled.address,
                lat: recalled.lat ?? 0,
                lng: recalled.lng ?? 0,
                confirmed: false,
              },
              hasLocation: true,
            }
            : routine?.address
              // From her routines: a string is enough — the travel chain
              // geocodes it (with her city) a moment from now.
              ? { location: routine.address, hasLocation: true }
              : {}),
        // "בחדר כושר" says WHAT KIND of place without saying which. Keeping it
        // is what lets Lumi ask "your usual gym?" once and remember the answer
        // (known_places), instead of asking for an address every single time.
        ...(activity ? { activityKey: activity } : {}),
        historicalDurations: [],
        subgroup: derived.subgroup ?? undefined,
        ...(alarmAt ? { alarmAt, alarmState: 'planned' as const } : {}),
      });
      // Not just fixedTime: a trip with a route and no appointment hour still
      // needs its wake / leave alerts, and the phone is the only thing awake.
      if (saved && taskNeedsAlerts(saved)) armTaskAlerts(saved).catch(() => {});
      // An explicit wake time can be for TOMORROW morning, which is already
      // inside Android's 24 h reach — so sweep now rather than waiting for the
      // next cold start.
      if (saved?.alarmAt) armDueAlarms([saved]).catch(() => {});
      // Route it now, not on some other screen's next sweep (ArrivedTaskPlanner).
      if (saved) planArrivedTasks([saved]).catch(() => {});
      await refresh();
    },
    [refresh, today],
  );

  // Understand a spoken/typed sentence BEFORE inserting: "move the gym to 6"
  // must patch the existing gym task, not create "move the gym to 6" as a new
  // one. Returns what it decided; the screen confirms before applyTaskAction.
  const processSpeechCommand = useCallback(
    async (speechText: string): Promise<SpeechCommandResult> => {
      const intent = await classifyTaskIntent(speechText);
      if (intent.kind === 'create') {
        // Same task said differently ("interview tomorrow in Ramat Gan" then
        // "interview tomorrow, Ramat Gan, 11:30, bring CV")? Don't silently
        // add a twin — surface it so the screen can ask "same task?".
        const all = await getAllTasks();
        const twin = all.find(
          (t) => t.status === 'pending' && textSimilarity(t.text, speechText) >= 0.7,
        );
        if (twin) {
          const patch: Partial<Task> = extractPatch(speechText);
          if (speechText.trim().length > twin.text.length) patch.text = speechText.trim();
          return { type: 'duplicate', action: { kind: 'update', task: twin, patch } };
        }
        return { type: 'create' };
      }
      const all = await getAllTasks();
      const candidates = all.filter((t) => t.status === 'pending');
      const { task, ambiguous } = resolveTargetTask(intent.reference, candidates);
      if (ambiguous.length > 1) {
        return { type: 'ambiguous', kind: intent.kind, patch: intent.patch, candidates: ambiguous };
      }
      const target = task ?? ambiguous[0];
      if (!target) return { type: 'not_found', kind: intent.kind };
      return { type: 'confirm', action: { kind: intent.kind, task: target, patch: intent.patch } };
    },
    [],
  );

  /** Apply a confirmed voice command. */
  const applyTaskAction = useCallback(
    async (action: PendingTaskAction) => {
      if (action.kind === 'complete') {
        await markTaskComplete(action.task.id, true);
      } else if (action.kind === 'delete') {
        await deleteTask(action.task.id);
      } else {
        await updateTaskFields(action.task.id, action.patch);
      }
      await refresh();
    },
    [refresh],
  );

  /**
   * `defaultDate` is the day the CALLER was looking at.
   *
   * addManualTask learned this months ago; this path never did, so the + on a
   * timeline showing tomorrow went through the parser, came back with no date
   * of its own ("ללמוד לראיון" names no day) and fell through to `today`. The
   * task was created, the screen went back to tomorrow, and tomorrow was
   * unchanged — indistinguishable from a button that does nothing.
   *
   * A date the SENTENCE carries still wins: "next Monday" means next Monday
   * however the screen got here.
   */
  const addMorningTasksFromSpeech = useCallback(
    async (speechText: string, defaultDate?: string) => {
      console.warn('[LLM_PARSER] addMorningTasksFromSpeech input:', speechText);
      try {
        const parsed = await parseSpeechToTasksWithExpansion(speechText);
        if (!parsed.length) {
          // warn, not log: a release build drops console.log, and "the parser
          // returned nothing" is exactly the state that looks like a dead
          // button from the outside.
          console.warn('[LLM_PARSER] no parsed tasks found, skipping store write');
          return [];
        }

        // Group tasks by date and add them
        const tasksByDate = new Map<string, typeof parsed>();
        for (const task of parsed) {
          const taskDate = task.deadline || defaultDate || today;
          if (!tasksByDate.has(taskDate)) {
            tasksByDate.set(taskDate, []);
          }
          tasksByDate.get(taskDate)!.push(task);
        }

        const allCreated = [];
        for (const [taskDate, tasksForDate] of tasksByDate) {
          console.warn(`[LLM_PARSER] writing ${tasksForDate.length} tasks for ${taskDate}`);
          const created = await addTasksForDate(taskDate, tasksForDate);
          allCreated.push(...created);
        }

        // A wake request belongs to the SENTENCE, not to one of the tasks it
        // produced ("interview tomorrow at 13:00, wake me at 7 to study"), so
        // it is stamped on the earliest timed task of the batch — the one the
        // morning is actually about.
        const wakeAt = parseWakeRequest(speechText);
        if (wakeAt) {
          const morningTask = [...allCreated]
            .filter((t) => t.fixedTime)
            .sort((a, b) => (a.date + (a.fixedTime ?? '') < b.date + (b.fixedTime ?? '') ? -1 : 1))[0]
            ?? allCreated[0];
          if (morningTask) {
            await updateTaskFields(morningTask.id, {
              alarmAt: wakeAt, alarmState: 'planned',
            }).catch(() => {});
            morningTask.alarmAt = wakeAt;
            morningTask.alarmState = 'planned';
            armDueAlarms([morningTask]).catch(() => {});
          }
        }

        // Auto-schedule reminders for every task that needs any — a fixed
        // time, a route, a deadline or an alarm (utils/alertPlan.taskNeedsAlerts).
        for (const t of allCreated) {
          if (taskNeedsAlerts(t)) armTaskAlerts(t).catch(() => {});
        }

        console.log('[LLM_PARSER] all tasks created:', allCreated);
        await refresh();
        return allCreated;
      } catch (error) {
        console.error('[LLM_PARSER] Error parsing speech:', error);
        return [];
      }
    },
    [refresh, today],
  );

  const addMorningTasksFromParsed = useCallback(
    async (parsed: ParsedTask[]) => {
      console.log('[TASK_SPLITTER] addMorningTasksFromParsed input:', parsed);
      if (!parsed.length) {
        console.log('[TASK_SPLITTER] no parsed tasks provided, skipping store write');
        return [];
      }
      const withCoordinates = await Promise.all(
        parsed.map(async (entry) => ({
          ...entry,
          subgroup: entry.subgroup ?? undefined,
          location: entry.location ?? undefined,
          deadline: entry.deadline ?? undefined,
          how: entry.how ?? undefined,
          why: entry.why ?? undefined,
          contactName: entry.contactName ?? undefined,
          contactPhone: entry.contactPhone ?? undefined,
        })),
      );
      console.log('[TASK_SPLITTER] writing parsed tasks via addTasksForDate');
      const created = await addTasksForDate(today, withCoordinates);
      console.log('[TASK_SPLITTER] addTasksForDate returned:', created);
      await refresh();
      return created;
    },
    [refresh, today],
  );

  return {
    isLoading,
    tasks,
    today,
    todayTasks,
    backlog,
    progress,
    refresh,
    toggleTask,
    removeTask,
    processSpeechCommand,
    applyTaskAction,
    updateTaskText,
    updateTaskDetails,
    addManualTask,
    addMorningTasksFromSpeech,
    addMorningTasksFromParsed,
  };
}
