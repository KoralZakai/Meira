/**
 * CheckInScreen — the morning/afternoon/evening voice check-in hub: STT input,
 * intent routing, task matching, profile voice updates, nearby-task nudges.
 * Dependencies: SpeechService (STT/TTS), LumiAgentService (intents),
 * TaskParser/TaskMatcher/TaskAnalysis, LumiOnboardingAgent +
 * ProfileVoiceUpdateService, TaskStorage, UserProfileStorage,
 * NearbyTaskReminderService.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  BackHandler,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
// COLORS.danger only — BRAND has no danger token yet (flagged for theme.ts).
import { BRAND, COLORS, FONTS, RADIUS, SHADOWS, surf } from '../constants/theme';
import LumiWordmark from '../components/LumiWordmark';
import { CHECK_IN_TITLES, STRINGS } from '../constants/strings';
import { useLumiContext } from '../hooks/useLumiContext';
import { matchTasksFromSpeech } from '../services/TaskMatcher';
import { ParsedTask, extractTaskTags } from '../services/TaskParser';
import { analyzeTasks, TaskAnalysis } from '../services/TaskAnalysis';
import { lumiAgentService } from '../services/LumiAgentService';
import { parseSpeechToTasksWithExpansion } from '../services/TaskParser';
import { parseTimeExpression } from '../utils/timeParser';
import { extractFromAnswer } from '../services/LumiOnboardingAgent';
import { mergeProfileUpdate, summarizeProfileUpdate, toOnboardingExtractionInput } from '../services/ProfileVoiceUpdateService';
import { loadProfile, saveProfile } from '../services/UserProfileStorage';
import { LocationCandidate, geocodeTaskLocation, openLocationInMaps, searchLocationCandidates } from '../services/NearbyTaskReminderService';
import { movePendingTasksToTomorrow, addTask, toDateKey } from '../services/TaskStorage';
import { textSimilarity } from '../utils/fuzzyMatch';
import {
  getSpeechRecognitionUnavailableReason,
  isSpeechRecognitionAvailable,
  setupSpeechRecognitionCallbacks,
  speak,
  startSpeechToText,
  stopSpeaking,
  stopSpeechToText,
} from '../services/SpeechService';
import { CheckInFlowMode, RootStackParamList } from '../types/navigation';
import { Task } from '../types/models';

type Props = NativeStackScreenProps<RootStackParamList, 'CheckIn'>;

function formatDuration(totalMinutes: number): string {
  if (totalMinutes < 60) {
    return `${totalMinutes} min`;
  }

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

function normalizeForMatch(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim();
}

function resolveMatchedTasksByText(spokenMatches: string[], candidates: Task[]): Task[] {
  const normalizedCandidatePairs = candidates.map((task) => ({
    task,
    normalized: normalizeForMatch(task.text),
  }));

  const chosen: Task[] = [];
  for (const phrase of spokenMatches) {
    const normalizedPhrase = normalizeForMatch(phrase);
    if (!normalizedPhrase) {
      continue;
    }

    const found = normalizedCandidatePairs.find(
      (entry) =>
        entry.normalized === normalizedPhrase
        || entry.normalized.includes(normalizedPhrase)
        || normalizedPhrase.includes(entry.normalized),
    );

    if (found && !chosen.some((task) => task.id === found.task.id)) {
      chosen.push(found.task);
    }
  }

  return chosen;
}

function findTaskByTargetText(targetText: string, candidates: Task[]): Task | null {
  const normalizedTarget = normalizeForMatch(targetText);
  if (!normalizedTarget) {
    return null;
  }

  return candidates.find((task) => {
    const normalizedTask = normalizeForMatch(task.text);
    return normalizedTask === normalizedTarget
      || normalizedTask.includes(normalizedTarget)
      || normalizedTarget.includes(normalizedTask);
  }) ?? null;
}

function formatCapturedDeadline(value?: string | null): string | null {
  if (!value) {
    return null;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  return parsed.toLocaleString([], {
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function mergeCaptureTaskWithLocalHints(task: ParsedTask, localTask?: ParsedTask): ParsedTask {
  if (!localTask) {
    return task;
  }

  return {
    ...task,
    priority: localTask.priority ?? task.priority,
    category: localTask.category ?? task.category,
    subgroup: localTask.subgroup ?? task.subgroup,
    deadline: localTask.deadline ?? task.deadline,
    hasDeadline: localTask.hasDeadline ?? task.hasDeadline,
    fixedTime: localTask.fixedTime ?? task.fixedTime,
    location: localTask.location ?? task.location,
    hasLocation: localTask.hasLocation ?? task.hasLocation,
    contactName: localTask.contactName ?? task.contactName,
    contactPhone: localTask.contactPhone ?? task.contactPhone,
    how: localTask.how ?? task.how,
    why: localTask.why ?? task.why,
  };
}

// Resolve relative dates ("tomorrow", "in 2 days") and clock times ("at 8pm") from
// free text into a concrete fixedTime + absolute YYYY-MM-DD deadline. parseTimeExpression
// returns on the first match (time OR date), so when we get a time we re-run on the
// time-stripped text to also capture the date.
function resolveTimingHints(text: string): { fixedTime?: string; deadline?: string; hasDeadline: boolean } {
  const expr = parseTimeExpression(text);
  let fixedTime = expr.fixedTime;
  let deadline = expr.deadline;

  if (fixedTime && !deadline) {
    const dateOnly = text.replace(/\b(?:at|by)\s+\d{1,2}(?::\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.)?/gi, ' ');
    const dateExpr = parseTimeExpression(dateOnly);
    if (dateExpr.deadline) {
      deadline = dateExpr.deadline;
    }
  }

  return { fixedTime, deadline, hasDeadline: Boolean(deadline) };
}

async function openCandidateInMaps(candidate: LocationCandidate): Promise<boolean> {
  return openLocationInMaps(candidate.label, { lat: candidate.lat, lng: candidate.lng });
}

type TaskMapSelection = {
  originalQuery: string;
  candidates: LocationCandidate[];
  selectedIndex: number;
  confirmed: boolean;
};

export default function CheckInScreen({ route, navigation }: Props) {
  const { type, mandatory, flow: routeFlow } = route.params;
  const flow: CheckInFlowMode = routeFlow ?? 'review';

  const { tasksState, checkInState } = useLumiContext();
  const { tasks, todayTasks, backlog, addMorningTasksFromParsed, toggleTask, refresh, updateTaskDetails } = tasksState;
  const { settings, markDone } = checkInState;

  const strings = STRINGS[settings.language];
  const [subtitle, setSubtitle] = useState('');
  const [transcript, setTranscript] = useState('');
  const [fullResponse, setFullResponse] = useState('');
  const [manualInput, setManualInput] = useState('');
  const [isListening, setIsListening] = useState(false);
  const [sttError, setSttError] = useState('');

  const [parsedMorningTasks, setParsedMorningTasks] = useState<ParsedTask[]>([]);
  const [mapCandidates, setMapCandidates] = useState<Record<string, TaskMapSelection>>({});
  const [morningAnalysis, setMorningAnalysis] = useState<TaskAnalysis | null>(null);
  const [matchedTasks, setMatchedTasks] = useState<Task[]>([]);
  const [ambiguousTasks, setAmbiguousTasks] = useState<Task[]>([]);
  const [selectedAmbiguous, setSelectedAmbiguous] = useState<Record<string, boolean>>({});
  const inputRef = useRef<TextInput>(null);
  const lastFinalTranscriptRef = useRef<string>('');

  const backlogYesterday = useMemo(
    () => backlog.find((group) => group.date < tasksState.today)?.tasks ?? [],
    [backlog, tasksState.today],
  );

  const getPrompt = useCallback(() => {
    if (flow === 'capture') {
      return settings.language === 'he'
        ? 'מה התוכניות שלך להיום? ספר לי את רשימת המשימות שלך!'
        : 'What are your plans for today? Tell me your to-do list!';
    }

    const period = type === 'morning' ? 'morning' : type === 'afternoon' ? 'afternoon' : 'evening';
    if (settings.language === 'he') {
      return `היי, ${period === 'morning' ? 'בוקר טוב' : period === 'afternoon' ? 'צהריים טובים' : 'ערב טוב'}! מה כבר השלמת?`;
    }
    return `Hi, good ${period}! What have you completed?`;
  }, [flow, settings.language, type]);

  useEffect(() => {
    const blockBack = mandatory
      ? BackHandler.addEventListener('hardwareBackPress', () => true)
      : null;

    return () => {
      blockBack?.remove();
      stopSpeechToText();
      stopSpeaking();
    };
  }, [mandatory]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const processTranscript = useCallback(
    async (value: string) => {
      setTranscript(value);
      setFullResponse(value);

      const pendingTodayTasks = todayTasks.filter((task) => task.status === 'pending');
      const agentResponse = await lumiAgentService.parseTranscript(
        value,
        flow === 'capture' ? 'capture' : 'review',
        pendingTodayTasks.map((task) => task.text),
      );
      console.log('[LUMI_AGENT] processTranscript result:', agentResponse);

      if (flow === 'capture') {
        const localParsed = await parseSpeechToTasksWithExpansion(value);
        if (agentResponse?.intent === 'profile_update') {
          const profile = await loadProfile();
          if (!profile) {
            const message = 'I could not find your profile. Please complete onboarding first.';
            setSubtitle(message);
            await speak(message, settings.language);
            return;
          }

          const extraction = await extractFromAnswer(value, toOnboardingExtractionInput(profile));
          const nextProfile = mergeProfileUpdate(profile, extraction);
          await saveProfile(nextProfile);

          const summary = summarizeProfileUpdate(profile, nextProfile);
          setSubtitle(summary);
          await speak(summary, settings.language);

          setParsedMorningTasks([]);
          setMorningAnalysis(null);
          return;
        }

        if (agentResponse?.intent === 'task_update' || (agentResponse?.taskUpdates.length ?? 0) > 0) {
          const updates = agentResponse?.taskUpdates ?? [];
          const mutableCandidates = tasks.filter((task) => task.status !== 'moved');
          let applied = 0;

          for (const update of updates) {
            const target = findTaskByTargetText(update.targetText, mutableCandidates);
            if (!target) {
              continue;
            }

            const patch: Partial<Task> = {};

            if (update.newText) {
              patch.text = update.newText;
              patch.tags = extractTaskTags(update.newText);
            }

            if (update.newDeadline) {
              patch.dueDate = update.newDeadline;
              patch.hasDeadline = true;
            }

            if (update.newLocation) {
              patch.location = update.newLocation;
              patch.hasLocation = true;
              const coords = await geocodeTaskLocation(update.newLocation);
              if (coords) {
                patch.locationLat = coords.lat;
                patch.locationLng = coords.lng;
              }
            }

            if (!Object.keys(patch).length) {
              continue;
            }

            await updateTaskDetails(target.id, patch);
            applied += 1;
          }

          if (applied > 0) {
            const message = `Updated ${applied} task${applied > 1 ? 's' : ''} based on what you said.`;
            setSubtitle(message);
            await speak(message, settings.language);
            await refresh();
            return;
          }
        }

        console.log('[CHECKIN_CAPTURE] parsing voice input into new tasks');
        const parsed = agentResponse?.tasks.length
          ? agentResponse.tasks.map((task, index) => {
            const timing = resolveTimingHints(task.text);
            return mergeCaptureTaskWithLocalHints({
              text: task.text,
              tags: extractTaskTags(task.text),
              priority: task.priority,
              category: task.category,
              subgroup: task.subgroup,
              hasLocation: task.hasLocation,
              location: task.location,
              hasDeadline: task.hasDeadline || timing.hasDeadline,
              deadline: timing.deadline ?? task.deadline,
              fixedTime: timing.fixedTime,
              how: task.how,
              why: task.why,
              contactName: task.contactName,
              contactPhone: task.contactPhone,
            }, localParsed[index]);
          })
          : localParsed;
        setParsedMorningTasks(parsed);
        const nextMapCandidates: Record<string, TaskMapSelection> = {};
        for (const task of parsed) {
          if (!task.location) {
            continue;
          }

          const foundLocations = await searchLocationCandidates(task.location);
          if (!foundLocations.length) {
            continue;
          }

          nextMapCandidates[task.text] = {
            originalQuery: task.location,
            candidates: foundLocations,
            selectedIndex: 0,
            confirmed: false,
          };
        }
        setMapCandidates(nextMapCandidates);
        setMatchedTasks([]);
        setAmbiguousTasks([]);
        setSelectedAmbiguous({});

        if (!parsed.length) {
          setMorningAnalysis(null);
          return;
        }

        const analysis = analyzeTasks(parsed);
        setMorningAnalysis(analysis);
        let locationConfirmation = '';
        const firstLocatedTask = parsed.find((task) => task.location);
        if (firstLocatedTask?.location) {
          const candidateState = nextMapCandidates[firstLocatedTask.text];
          const candidate = candidateState?.candidates[candidateState.selectedIndex];
          const deadlineLabel = formatCapturedDeadline(firstLocatedTask.deadline);
          if (candidate) {
            await openCandidateInMaps(candidate);
          }
          locationConfirmation = candidate
            ? ` I found ${candidateState.candidates.length} possible places for "${firstLocatedTask.location}". I opened the top result, "${candidate.label}"${deadlineLabel ? ` at ${deadlineLabel}` : ''}. Please confirm the correct place.`
            : ` I heard the place as "${firstLocatedTask.location}"${deadlineLabel ? ` at ${deadlineLabel}` : ''}. Is that what you meant?`;
        }
        const message = `${agentResponse?.lumiMessage || analysis.spokenSummary}${locationConfirmation}`.trim();
        setSubtitle(message);
        await speak(message, settings.language);
        return;
      }

      console.log('[CHECKIN_REVIEW] matching spoken input against existing pending tasks');
      const agentMatched = agentResponse?.matchedTaskTexts.length
        ? resolveMatchedTasksByText(agentResponse.matchedTaskTexts, pendingTodayTasks)
        : [];

      const result = agentMatched.length
        ? { matches: agentMatched, ambiguous: [] as Task[] }
        : matchTasksFromSpeech(value, pendingTodayTasks);
      setMatchedTasks(result.matches);
      setAmbiguousTasks(result.ambiguous);
      setParsedMorningTasks([]);
      setMorningAnalysis(null);

      // Things the user DID that aren't on the list ("visited mom", "gym 1.5h")
      // → verify, then log as COMPLETED tasks so Lumi learns the real day.
      await offerLogUnmatched(value, [...result.matches, ...result.ambiguous]);
    },
    [flow, settings.language, todayTasks],
  );

  const offerLogUnmatched = async (value: string, matched: Task[]) => {
    try {
      const parsed = await parseSpeechToTasksWithExpansion(value);
      const known = [...todayTasks, ...matched];
      const unmatched = parsed.filter(
        (p) => p.text && !known.some((t) => textSimilarity(t.text, p.text) >= 0.5),
      );
      if (!unmatched.length) return;
      const he = settings.language === 'he';
      const summary = unmatched
        .map((p) => `• ${p.text}${p.durationMinutes ? ` (~${p.durationMinutes}m)` : ''}`)
        .join('\n');
      Alert.alert(
        he ? 'לרשום כבוצעו? ✅' : 'Log these as done? ✅',
        (he ? 'שמעתי שגם עשית:\n' : 'Sounds like you also did:\n') + summary,
        [
          { text: he ? 'לא' : 'No', style: 'cancel' },
          {
            text: he ? 'כן, תרשמי' : 'Yes, log them',
            onPress: async () => {
              for (const p of unmatched) {
                await addTask({
                  text: p.text,
                  tags: extractTaskTags(p.text),
                  category: p.category ?? 'general',
                  priority: 'nice_to_do',
                  isFixed: false,
                  durationMinutes: p.durationMinutes ?? 30,
                  actualDurationMinutes: p.durationMinutes ?? undefined,
                  date: toDateKey(),
                  status: 'complete',
                  source: 'voice',
                  historicalDurations: [],
                } as unknown as Omit<Task, 'id' | 'createdAt' | 'completedAt'>).catch(() => {});
              }
              refresh?.().catch?.(() => {});
            },
          },
        ],
      );
    } catch (e) {
      console.log('[CHECKIN] unmatched logging skipped:', e);
    }
  };

  useEffect(() => {
    const teardown = setupSpeechRecognitionCallbacks({
      onStart: () => {
        setIsListening(true);
        setSttError('');
      },
      onEnd: () => setIsListening(false),
      onResult: async (recognizedText, isFinal) => {
        const normalizedText = recognizedText.trim();
        if (!normalizedText) {
          return;
        }

        setTranscript(normalizedText);
        setManualInput(normalizedText);

        if (isFinal) {
          if (lastFinalTranscriptRef.current === normalizedText) {
            console.log('[STT] duplicate final transcript ignored:', normalizedText);
            return;
          }
          lastFinalTranscriptRef.current = normalizedText;
          setFullResponse(normalizedText);
          await processTranscript(normalizedText);
        }
      },
      onError: (error, message) => {
        const composed = message ? `${error}: ${message}` : error;
        setSttError(composed);
      },
    });

    return () => {
      teardown();
    };
  }, [processTranscript]);

  const begin = useCallback(async () => {
    const prompt = getPrompt();
    setSubtitle(prompt);
    await speak(prompt, settings.language);
  }, [getPrompt, settings.language]);

  useEffect(() => {
    begin();
  }, [begin]);

  const confirmMorning = async () => {
    if (flow === 'capture') {
      if (parsedMorningTasks.length) {
        const unresolvedLocationTask = parsedMorningTasks.find((task) => task.location && !mapCandidates[task.text]?.confirmed);
        if (unresolvedLocationTask) {
          Alert.alert('Confirm the location', `Please confirm the map result for "${unresolvedLocationTask.location}" before saving.`);
          return;
        }

        const enrichedTasks = parsedMorningTasks.map((task) => {
          const candidateState = task.location ? mapCandidates[task.text] : undefined;
          const candidate = candidateState?.candidates[candidateState.selectedIndex];
          return candidateState?.confirmed && candidate
            ? {
              ...task,
              location: candidate.label,
            }
            : task;
        });

        await addMorningTasksFromParsed(enrichedTasks);
        const spokenTasks = parsedMorningTasks.map((item) => item.text).join(', ');
        const message = strings.morningConfirm(spokenTasks);
        setSubtitle(message);
        await speak(message, settings.language);
      }

      await refresh();
      navigation.navigate('Home');
      return;
    }

    await confirmMatches();
  };

  const confirmMatches = async () => {
    const chosenFromAmbiguous = ambiguousTasks.filter((task) => selectedAmbiguous[task.id]);
    const combined = [...matchedTasks, ...chosenFromAmbiguous];

    for (const task of combined) {
      await toggleTask(task.id, true);
    }

    const taskNames = combined.map((task) => task.text).join(', ');
    const pendingAfter = todayTasks.filter(
      (t) => t.status === 'pending' && !combined.some((c) => c.id === t.id),
    );

    if (type === 'morning') {
      if (combined.length) {
        const doneCount = combined.length;
        const stillPending = pendingAfter.length;
        const msg = settings.language === 'he'
          ? `מעולה! סימנתי שהשלמת: ${taskNames}.${stillPending ? ` נותרו ${stillPending} משימות.` : ' כל הכבוד, הכול הושלם!'}`
          : `Great! Marked ${doneCount} task${doneCount !== 1 ? 's' : ''} done: ${taskNames}.${stillPending ? ` Still pending: ${stillPending} task${stillPending !== 1 ? 's' : ''}.` : ' Everything complete!'}`;
        setSubtitle(msg);
        await speak(msg, settings.language);
      }
      await markDone('morning');
      await refresh();
      navigation.navigate('Home');
      return;
    }

    if (type === 'afternoon') {
      if (combined.length) {
        const stillPending = pendingAfter.length;
        const base = strings.afternoonConfirm(taskNames);
        const msg = stillPending
          ? `${base} You still have ${stillPending} task${stillPending !== 1 ? 's' : ''} pending.`
          : `${base} All tasks done — well done!`;
        setSubtitle(msg);
        await speak(msg, settings.language);
      }
      await markDone('afternoon');
      await refresh();
      navigation.navigate('Home');
      return;
    }

    if (type === 'evening') {
      if (combined.length) {
        const doneMsg = strings.eveningConfirmDone(taskNames);
        setSubtitle(doneMsg);
        await speak(doneMsg, settings.language);
      }

      const moved = await movePendingTasksToTomorrow(tasksState.today);
      if (moved === 0) {
        setSubtitle(strings.eveningAllDone);
        await speak(strings.eveningAllDone, settings.language);
      } else {
        const msg = strings.eveningMoveSummary(moved);
        setSubtitle(msg);
        await speak(msg, settings.language);
      }

      await markDone('evening');
      await refresh();
      navigation.navigate('Home');
    }
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView contentContainerStyle={styles.content}>
        <LumiWordmark size={34} style={styles.brandLogo} />
        <Text style={styles.title}>
          {flow === 'capture' ? (settings.language === 'he' ? 'דבר עם לומי' : 'Talk with Lumi') : CHECK_IN_TITLES[settings.language][type]}
        </Text>
        <Text style={styles.subtitle}>{subtitle}</Text>

        <View style={styles.card}>
          <Text style={styles.label}>Type your tasks</Text>
          <Text style={styles.helperText}>
            {isSpeechRecognitionAvailable()
              ? 'You can type or use voice input on this build.'
              : 'Voice recognition is unavailable in this runtime. Use a dev/client build with speech plugin.'}
          </Text>
          <Text style={styles.transcriptText}>{transcript || 'Waiting for your input...'}</Text>
          {sttError ? <Text style={styles.errorText}>STT error: {sttError}</Text> : null}

          <Pressable
            style={[styles.primaryButton, styles.secondaryButton]}
            onPress={async () => {
              if (isListening) {
                stopSpeechToText();
                return;
              }

              const started = await startSpeechToText(settings.language);
              if (!started) {
                const reason = getSpeechRecognitionUnavailableReason();
                Alert.alert(
                  'Voice input unavailable',
                  reason || 'Could not start speech recognition. Check permissions and logs.',
                );
              }
            }}
          >
            <Text style={styles.primaryButtonText}>{isListening ? 'Stop listening' : 'Start voice input'}</Text>
          </Pressable>

          <TextInput
            ref={inputRef}
            value={manualInput}
            onChangeText={(text) => {
              setManualInput(text);
              setTranscript(text);
            }}
            placeholder="Type your tasks here"
            style={styles.input}
            multiline
            autoFocus
            returnKeyType="done"
            onSubmitEditing={async () => {
              const value = manualInput.trim();
              if (!value) {
                return;
              }
              setFullResponse(value);
              await processTranscript(value);
            }}
          />

          <Pressable
            style={styles.primaryButton}
            onPress={async () => {
              const value = manualInput.trim();
              if (!value) {
                return;
              }
              setFullResponse(value);
              await processTranscript(value);
            }}
            disabled={!manualInput.trim()}
          >
            <Text style={styles.primaryButtonText}>Done</Text>
          </Pressable>
        </View>

        {flow === 'capture' && Boolean(fullResponse) && (
          <View style={styles.card}>
            <Text style={styles.label}>Your full response</Text>
            <Text style={styles.fullResponseText}>{fullResponse}</Text>
          </View>
        )}

        {flow === 'capture' && parsedMorningTasks.length > 0 && (
          <View style={styles.card}>
            <Text style={styles.label}>New tasks to save</Text>
            {parsedMorningTasks.map((task, index) => (
              <View key={`${task.text}-${index}`} style={styles.captureTaskBlock}>
                <Text style={styles.listText}>☐ {task.text}</Text>
                {task.deadline ? <Text style={styles.captureMetaText}>Time: {formatCapturedDeadline(task.deadline)}</Text> : null}
                {task.location ? <Text style={styles.captureMetaText}>Place: {task.location}</Text> : null}
                {task.location && mapCandidates[task.text] ? (
                  <View style={styles.mapConfirmBlock}>
                    <Text style={styles.captureMetaText}>Map results for: {mapCandidates[task.text].originalQuery}</Text>
                    {mapCandidates[task.text].candidates.map((candidate, candidateIndex) => {
                      const selected = mapCandidates[task.text].selectedIndex === candidateIndex;
                      return (
                        <View key={`${task.text}-${candidate.label}-${candidateIndex}`} style={styles.locationCandidateRow}>
                          <Pressable
                            style={[styles.locationCandidateChip, selected && styles.locationCandidateChipSelected]}
                            onPress={() => setMapCandidates((prev) => ({
                              ...prev,
                              [task.text]: {
                                ...prev[task.text],
                                selectedIndex: candidateIndex,
                                confirmed: false,
                              },
                            }))}
                          >
                            <Text style={styles.locationCandidateText}>{candidate.label}</Text>
                          </Pressable>
                          <View style={styles.mapConfirmActions}>
                            <Pressable
                              style={styles.smallActionButton}
                              onPress={async () => {
                                await openCandidateInMaps(candidate);
                              }}
                            >
                              <Text style={styles.smallActionText}>Open map</Text>
                            </Pressable>
                            {selected ? (
                              <Pressable
                                style={[styles.smallActionButton, mapCandidates[task.text].confirmed && styles.smallActionButtonSelected]}
                                onPress={() => setMapCandidates((prev) => ({
                                  ...prev,
                                  [task.text]: {
                                    ...prev[task.text],
                                    confirmed: true,
                                  },
                                }))}
                              >
                                <Text style={styles.smallActionText}>This is the place</Text>
                              </Pressable>
                            ) : null}
                          </View>
                        </View>
                      );
                    })}
                  </View>
                ) : null}
                {task.contactName ? <Text style={styles.captureMetaText}>Person: {task.contactName}{task.contactPhone ? ` · ${task.contactPhone}` : ''}</Text> : null}
              </View>
            ))}
            <Pressable style={styles.primaryButton} onPress={confirmMorning}>
              <Text style={styles.primaryButtonText}>Save as new tasks</Text>
            </Pressable>
          </View>
        )}

        {flow === 'capture' && morningAnalysis && (
          <View style={styles.card}>
            <Text style={styles.label}>Lumi analysis</Text>
            <Text style={styles.analysisTotal}>
              Estimated total: {formatDuration(morningAnalysis.totalMinutes)}
            </Text>

            {morningAnalysis.estimates.map((task) => (
              <Text key={`${task.text}-${task.reason}`} style={styles.listText}>
                • {task.text} - {task.minutes} min ({task.reason})
              </Text>
            ))}

            <Text style={[styles.label, { marginTop: 10 }]}>Suggested approach</Text>
            {morningAnalysis.suggestedApproach.map((tip, index) => (
              <Text key={`${tip}-${index}`} style={styles.tipText}>
                {index + 1}. {tip}
              </Text>
            ))}
          </View>
        )}

        {flow === 'review' && (matchedTasks.length > 0 || ambiguousTasks.length > 0) && (
          <View style={styles.card}>
            <Text style={styles.label}>Matched tasks</Text>
            {matchedTasks.map((task) => (
              <Text key={task.id} style={styles.listText}>
                • {task.text}
              </Text>
            ))}

            {ambiguousTasks.length > 0 && (
              <View>
                <Text style={[styles.label, { marginTop: 8 }]}>Ambiguous, select to confirm:</Text>
                {ambiguousTasks.map((task) => (
                  <Pressable
                    key={task.id}
                    style={styles.ambiguousOption}
                    onPress={() =>
                      setSelectedAmbiguous((prev) => ({
                        ...prev,
                        [task.id]: !prev[task.id],
                      }))
                    }
                  >
                    <View style={[styles.pickBox, selectedAmbiguous[task.id] && styles.pickBoxSelected]} />
                    <Text style={styles.listText}>{task.text}</Text>
                  </Pressable>
                ))}
              </View>
            )}

            <Pressable style={styles.primaryButton} onPress={confirmMatches}>
              <Text style={styles.primaryButtonText}>Mark selected tasks complete</Text>
            </Pressable>
          </View>
        )}

        {flow === 'review' && type === 'morning' && mandatory && (
          <Pressable
            style={styles.skipButton}
            onPress={async () => {
              await markDone('morning');
              await refresh();
              navigation.navigate('Home');
            }}
          >
            <Text style={styles.skipText}>Skip today</Text>
          </Pressable>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: BRAND.cream,
  },
  content: {
    padding: 16,
    paddingBottom: 36,
  },
  brandLogo: {
    marginBottom: 8,
  },
  title: {
    fontSize: 30,
    fontFamily: FONTS.display,
    color: BRAND.warmInk,
    marginBottom: 8,
  },
  subtitle: {
    color: BRAND.inkSoft,
    fontFamily: FONTS.body,
    fontSize: 16,
    minHeight: 48,
  },
  card: {
    backgroundColor: BRAND.creamCard,
    borderRadius: RADIUS.card,
    borderWidth: 1,
    borderColor: BRAND.line,
    padding: 16,
    marginTop: 14,
    ...SHADOWS.card,
  },
  label: {
    color: BRAND.warmInk,
    fontFamily: FONTS.bodyBold,
    marginBottom: 8,
  },
  helperText: {
    color: BRAND.inkSoft,
    fontFamily: FONTS.body,
    fontSize: 14,
    marginBottom: 10,
  },
  transcriptText: {
    color: BRAND.inkSoft,
    fontFamily: FONTS.body,
    marginBottom: 10,
  },
  fullResponseText: {
    color: BRAND.warmInk,
    fontFamily: FONTS.body,
    lineHeight: 22,
  },
  input: {
    borderWidth: 1,
    borderColor: BRAND.line,
    borderRadius: RADIUS.chip,
    minHeight: 72,
    textAlignVertical: 'top',
    padding: 10,
    marginBottom: 10,
    backgroundColor: surf(BRAND.white),
    fontFamily: FONTS.body,
    color: BRAND.warmInk,
  },
  primaryButton: {
    backgroundColor: BRAND.sunGold,
    borderRadius: RADIUS.chip,
    paddingVertical: 11,
    alignItems: 'center',
    marginTop: 8,
    ...SHADOWS.button,
  },
  primaryButtonText: {
    color: BRAND.warmInk,
    fontFamily: FONTS.bodyBold,
  },
  secondaryButton: {
    backgroundColor: BRAND.honey,
    marginTop: 0,
    marginBottom: 10,
  },
  errorText: {
    color: COLORS.danger,
    fontFamily: FONTS.bodySemi,
    marginBottom: 10,
  },
  listText: {
    color: BRAND.warmInk,
    fontFamily: FONTS.body,
    marginBottom: 4,
  },
  captureTaskBlock: {
    marginBottom: 8,
  },
  captureMetaText: {
    color: BRAND.inkSoft,
    fontFamily: FONTS.body,
    fontSize: 13,
    marginLeft: 18,
    marginBottom: 2,
  },
  mapConfirmBlock: {
    marginLeft: 18,
    marginTop: 4,
    marginBottom: 4,
  },
  mapConfirmActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 4,
  },
  locationCandidateRow: {
    marginTop: 6,
    marginBottom: 4,
  },
  locationCandidateChip: {
    backgroundColor: BRAND.timeChipBg,
    borderRadius: RADIUS.chip,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  locationCandidateChipSelected: {
    backgroundColor: BRAND.honey,
  },
  locationCandidateText: {
    color: BRAND.warmInk,
    fontFamily: FONTS.bodySemi,
    fontSize: 12,
  },
  smallActionButton: {
    backgroundColor: BRAND.honey,
    borderRadius: RADIUS.pill,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  smallActionButtonSelected: {
    backgroundColor: BRAND.sunGold,
  },
  smallActionText: {
    color: BRAND.warmInk,
    fontFamily: FONTS.bodyBold,
    fontSize: 12,
  },
  analysisTotal: {
    color: BRAND.warmInk,
    fontFamily: FONTS.bodyBold,
    marginBottom: 8,
  },
  tipText: {
    color: BRAND.inkSoft,
    fontFamily: FONTS.body,
    marginBottom: 4,
  },
  ambiguousOption: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 6,
  },
  pickBox: {
    width: 18,
    height: 18,
    borderWidth: 1,
    borderColor: BRAND.line,
    borderRadius: 5,
    marginRight: 8,
  },
  pickBoxSelected: {
    backgroundColor: BRAND.sunGold,
    borderColor: BRAND.sunGold,
  },
  skipButton: {
    alignSelf: 'center',
    marginTop: 20,
    paddingVertical: 9,
    paddingHorizontal: 18,
  },
  skipText: {
    color: BRAND.inkSoft,
    fontFamily: FONTS.bodySemi,
  },
});
