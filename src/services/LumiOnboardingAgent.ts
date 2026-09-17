/**
 * LumiOnboardingAgent — profile fields (name, home address, transport, routine
 * minutes…) out of free-form onboarding answers, EN + HE.
 *
 * The extraction moved to the server (POST /app/profile/extract). It used to
 * run here against Nebius with the API key compiled into the APK, and — worse
 * for the product — it wrote its answers only into the app's own profile, so
 * the WhatsApp brain never learned the home address the user had just spent
 * five minutes dictating. The server writes both.
 *
 * `localFallbackExtraction` stays and is NOT dead code: it is what runs when
 * the phone has no network, and losing an onboarding answer is worse than
 * extracting it crudely. Everything below it (normalisers, the required-field
 * list, the follow-up question copy) is UI-facing and stays on the device.
 *
 * Dependencies: LumiServer (extraction), models/UserProfile
 * (OnboardingExtraction), LumiAgentService.stripFillerWords.
 * Consumed by OnboardingScreen and ProfileVoiceUpdateService flows.
 */
import { OnboardingExtraction, TransportMode } from '../models/UserProfile';
import { stripFillerWords } from './LumiAgentService';
import { extractProfile } from './LumiServer';

const REQUIRED_FIELDS = ['name', 'transportMode', 'morningHabitsOrTotal', 'workStartTime', 'sleepTime'] as const;
type RequiredField = (typeof REQUIRED_FIELDS)[number];


function normalizeTime(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const raw = value.trim();
  if (!raw) {
    return undefined;
  }

  const match = raw.match(/^(\d{1,2}):(\d{2})$/);
  if (match) {
    const hh = Number(match[1]);
    const mm = Number(match[2]);
    if (Number.isNaN(hh) || Number.isNaN(mm) || hh < 0 || hh > 23 || mm < 0 || mm > 59) {
      return undefined;
    }

    return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
  }

  const amPmMatch = raw.match(/^(?:between\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i);
  if (amPmMatch) {
    let hh = Number(amPmMatch[1]);
    const mm = amPmMatch[2] ? Number(amPmMatch[2]) : 0;
    const meridiem = amPmMatch[3].toLowerCase();

    if (meridiem === 'pm' && hh < 12) {
      hh += 12;
    }
    if (meridiem === 'am' && hh === 12) {
      hh = 0;
    }

    if (Number.isNaN(hh) || Number.isNaN(mm) || hh < 0 || hh > 23 || mm < 0 || mm > 59) {
      return undefined;
    }

    return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
  }

  return undefined;
}

function extractStandaloneTime(text: string): string | undefined {
  const lower = normalizeKeyValue(text);
  const rangeMatch = lower.match(/(?:between|from)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:-|to|and)\s*\d{1,2}(?::\d{2})?\s*(?:am|pm)?/i);
  if (rangeMatch?.[1]) {
    const minutes = rangeMatch[2] ?? '00';
    const meridiem = rangeMatch[3] ? ` ${rangeMatch[3]}` : '';
    return normalizeTime(`${rangeMatch[1]}:${minutes}${meridiem}`.trim())
      ?? normalizeTime(`${rangeMatch[1]}${meridiem}`.trim());
  }

  const exactMatch = lower.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i);
  if (exactMatch?.[1]) {
    const minutes = exactMatch[2] ?? '00';
    return normalizeTime(`${exactMatch[1]}:${minutes} ${exactMatch[3]}`);
  }

  const hhmmMatch = lower.match(/\b(\d{1,2}):(\d{2})\b/);
  if (hhmmMatch?.[1] && hhmmMatch[2]) {
    return normalizeTime(`${hhmmMatch[1]}:${hhmmMatch[2]}`);
  }

  return undefined;
}

function normalizeTransportMode(value: unknown): TransportMode | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  if (value === 'car' || value === 'foot' || value === 'bicycle' || value === 'transit') {
    return value;
  }
  return undefined;
}

function safeDefault(): OnboardingExtraction {
  return {
    missingFields: ['name', 'transportMode', 'morningHabitsOrTotal', 'workStartTime', 'sleepTime'],
    followUpQuestion: 'Tell me your name and one morning habit with minutes, like shower 15 minutes.',
    isComplete: false,
  };
}

function normalizeKeyValue(value: string): string {
  return value.trim().toLowerCase();
}

const NAME_BLOCKLIST = new Set([
  'what', 'when', 'where', 'why', 'how', 'listen', 'listening', 'profile', 'routine',
  'morning', 'habit', 'habits', 'transport', 'transportation', 'public', 'work', 'sleep',
  'time', 'times', 'start', 'starts', 'between', 'about', 'lumi', 'tell', 'says', 'said',
]);

function normalizePersonName(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const cleaned = value.trim().replace(/\s+/g, ' ').replace(/[^a-zA-Z\s'-]/g, '');
  if (!cleaned || cleaned.length < 2) {
    return undefined;
  }

  const parts = cleaned.split(' ').filter(Boolean);
  if (parts.length === 0 || parts.length > 3) {
    return undefined;
  }

  if (parts.some((part) => part.length < 2 || NAME_BLOCKLIST.has(part.toLowerCase()))) {
    return undefined;
  }

  return parts
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(' ');
}

function extractName(text: string, allowBareAnswer = false): string | undefined {
  const match = text.match(/(?:my name is|i am|i'm)\s+([a-z][a-z\s'-]{1,30})/i);
  const explicitName = normalizePersonName(match?.[1]);
  if (explicitName) {
    return explicitName;
  }

  if (!allowBareAnswer) {
    return undefined;
  }

  const bareCandidate = text.trim();
  if (bareCandidate.length > 24 || /\b(am|pm|minute|minutes|bus|train|car|work|sleep)\b/i.test(bareCandidate)) {
    return undefined;
  }

  return normalizePersonName(bareCandidate);
}

function extractTransport(text: string): TransportMode | undefined {
  const value = normalizeKeyValue(text);
  if (/\b(car|drive|driving)\b/.test(value)) {
    return 'car';
  }
  if (/\b(train|bus|metro|subway|tram|transit|public transport|public transportation)\b/.test(value)) {
    return 'transit';
  }
  if (/\b(bike|bicycle|cycling)\b/.test(value)) {
    return 'bicycle';
  }
  if (/\b(walk|walking|on foot)\b/.test(value)) {
    return 'foot';
  }
  return undefined;
}

function normalizeHabitLabel(raw: string): string {
  const cleaned = raw.replace(/\b(i|my|the|a|an|in|at|to|for)\b/gi, ' ').replace(/\s+/g, ' ').trim();
  if (!cleaned) {
    return 'Morning routine';
  }
  return cleaned
    .split(' ')
    .slice(0, 4)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(' ');
}

function extractHabits(text: string): Array<{ habit: string; estimatedMinutes: number }> {
  const lower = normalizeKeyValue(text);
  const habits: Array<{ habit: string; estimatedMinutes: number }> = [];
  const seen = new Set<string>();

  const keywordMap: Array<{ rgx: RegExp; label: string }> = [
    { rgx: /\b(shower|bath)\b/, label: 'Shower' },
    { rgx: /\b(eat|breakfast|coffee)\b/, label: 'Breakfast' },
    { rgx: /\b(dress|dressing|get dressed|clothes|makeup|make up)\b/, label: 'Get dressed' },
    { rgx: /\b(dog walk|walk dog|walk the dog)\b/, label: 'Dog walk' },
    { rgx: /\b(train|commute|drive|travel|bus|metro|subway)\b/, label: 'Commute' },
  ];

  for (const pair of lower.matchAll(/([a-z\s]{2,40}?)\s+(\d{1,3})\s*(?:minutes|min|mins)\b/gi)) {
    const phrase = pair[1]?.trim() ?? '';
    const minutes = Number(pair[2]);
    if (!phrase || Number.isNaN(minutes) || minutes <= 0) {
      continue;
    }

    let label = normalizeHabitLabel(phrase);
    for (const mapItem of keywordMap) {
      if (mapItem.rgx.test(phrase)) {
        label = mapItem.label;
        break;
      }
    }

    if (seen.has(label.toLowerCase())) {
      continue;
    }
    seen.add(label.toLowerCase());
    habits.push({
      habit: label,
      estimatedMinutes: Math.max(5, Math.min(180, Math.round(minutes))),
    });
  }

  for (const mapItem of keywordMap) {
    if (!mapItem.rgx.test(lower)) {
      continue;
    }

    if (seen.has(mapItem.label.toLowerCase())) {
      continue;
    }

    const nearNumber = lower.match(new RegExp(`${mapItem.rgx.source}[^0-9]{0,20}(\\d{1,3})\\s*(?:minutes|min|mins)\\b`, 'i'));
    const minutes = nearNumber?.[1] ? Number(nearNumber[1]) : NaN;
    if (Number.isNaN(minutes) || minutes <= 0) {
      continue;
    }

    seen.add(mapItem.label.toLowerCase());
    habits.push({
      habit: mapItem.label,
      estimatedMinutes: Math.max(5, Math.min(180, Math.round(minutes))),
    });
  }

  return habits;
}

function extractTotalMinutes(text: string): number | undefined {
  const lower = normalizeKeyValue(text);
  const hourMinute = lower.match(/(?:about|around|roughly|total)?\s*(\d{1,2})\s*hour[s]?\s*(?:and\s*(\d{1,2})\s*min(?:ute)?s?)?/i);
  if (hourMinute) {
    const hours = Number(hourMinute[1]);
    const mins = hourMinute[2] ? Number(hourMinute[2]) : 0;
    const total = (hours * 60) + mins;
    if (total > 0) {
      return Math.min(300, total);
    }
  }

  const mins = lower.match(/(?:total|routine|morning|takes?)\s*(?:is|of|about|around)?\s*(\d{1,3})\s*(?:minutes|min|mins)\b/i);
  if (!mins?.[1]) {
    return undefined;
  }
  const value = Number(mins[1]);
  if (Number.isNaN(value) || value <= 0) {
    return undefined;
  }
  return Math.min(300, Math.round(value));
}

function extractTimeFromText(text: string, hints: string[]): string | undefined {
  const lower = normalizeKeyValue(text);
  const hintRegex = hints.join('|');
  const hhmm = lower.match(new RegExp(`(?:${hintRegex})[^0-9]{0,20}(\\d{1,2})(?::(\\d{2}))?\\s*(am|pm)?`, 'i'));
  if (!hhmm?.[1]) {
    return undefined;
  }

  let hour = Number(hhmm[1]);
  const minute = hhmm[2] ? Number(hhmm[2]) : 0;
  const meridiem = hhmm[3]?.toLowerCase();

  if (meridiem === 'pm' && hour < 12) {
    hour += 12;
  }
  if (meridiem === 'am' && hour === 12) {
    hour = 0;
  }
  if (hour > 23 || minute > 59) {
    return undefined;
  }

  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function buildFollowUp(field: RequiredField): string {
  if (field === 'name') {
    return 'What name should I call you?';
  }
  if (field === 'transportMode') {
    return 'How do you usually travel: car, walk, bicycle, or public transportation?';
  }
  if (field === 'morningHabitsOrTotal') {
    return 'Tell me your morning habits with minutes, like shower 15 and breakfast 10.';
  }
  if (field === 'workStartTime') {
    return 'What time does your work or first commitment usually start?';
  }
  return 'What time do you usually go to sleep?';
}

function missingFieldsFromMerged(
  merged: Partial<{
    name: string;
    transportMode: TransportMode;
    morningHabits: Array<{ habit: string; estimatedMinutes: number }>;
    totalMorningMinutesEstimate: number;
    workStartTime: string;
    sleepTime: string;
  }>,
): RequiredField[] {
  const missing: RequiredField[] = [];

  if (!merged.name) {
    missing.push('name');
  }
  if (!merged.transportMode) {
    missing.push('transportMode');
  }
  if (!(merged.morningHabits?.length || (merged.totalMorningMinutesEstimate && merged.totalMorningMinutesEstimate > 0))) {
    missing.push('morningHabitsOrTotal');
  }
  if (!merged.workStartTime) {
    missing.push('workStartTime');
  }
  if (!merged.sleepTime) {
    missing.push('sleepTime');
  }

  return missing;
}

function localFallbackExtraction(
  transcript: string,
  currentProfile: Partial<{
    name: string;
    transportMode: TransportMode;
    homeAddress: string;
    morningHabits: Array<{ habit: string; estimatedMinutes: number }>;
    totalMorningMinutesEstimate: number;
    workStartTime: string;
    sleepTime: string;
  }>,
): OnboardingExtraction {
  const cleaned = stripFillerWords(transcript);
  const missingBefore = missingFieldsFromMerged(currentProfile);
  const name = extractName(cleaned, missingBefore.includes('name'));
  const transportMode = extractTransport(cleaned);
  const morningHabits = extractHabits(cleaned);
  const totalMorningMinutesEstimate = extractTotalMinutes(cleaned);
  const hintedWorkStartTime = extractTimeFromText(cleaned, ['work', 'job', 'start', 'office', 'shift', 'first commitment']);
  const hintedSleepTime = extractTimeFromText(cleaned, ['sleep', 'bed', 'go to sleep', 'night']);
  const standaloneTime = extractStandaloneTime(cleaned);

  let workStartTime = hintedWorkStartTime;
  let sleepTime = hintedSleepTime;

  if (!workStartTime && standaloneTime && missingBefore.includes('workStartTime')) {
    workStartTime = standaloneTime;
  }

  if (!sleepTime && standaloneTime && missingBefore.includes('sleepTime') && !workStartTime) {
    sleepTime = standaloneTime;
  }

  const extracted: OnboardingExtraction = {
    ...(name ? { name } : {}),
    ...(transportMode ? { transportMode } : {}),
    ...(morningHabits.length ? { morningHabits } : {}),
    ...(totalMorningMinutesEstimate ? { totalMorningMinutesEstimate } : {}),
    ...(workStartTime ? { workStartTime } : {}),
    ...(sleepTime ? { sleepTime } : {}),
    missingFields: [],
    followUpQuestion: '',
    isComplete: false,
  };

  const merged = {
    ...currentProfile,
    ...extracted,
    morningHabits: morningHabits.length ? morningHabits : currentProfile.morningHabits,
  };

  const missing = missingFieldsFromMerged(merged);
  extracted.missingFields = missing;
  extracted.isComplete = missing.length === 0;
  extracted.followUpQuestion = extracted.isComplete ? '' : buildFollowUp(missing[0]);

  return extracted;
}

/** LLM-extract profile fields (name/home/transport/routine...) from one free-form onboarding answer, EN or HE. */
export async function extractFromAnswer(
  transcript: string,
  currentProfile: Partial<{
    name: string;
    transportMode: TransportMode;
    homeAddress: string;
    morningHabits: Array<{ habit: string; estimatedMinutes: number }>;
    totalMorningMinutesEstimate: number;
    workStartTime: string;
    sleepTime: string;
  }>,
): Promise<OnboardingExtraction> {
  try {
    const parsed = await extractProfile(stripFillerWords(transcript), currentProfile);
    if (!parsed) {
      console.log('[LUMI_ONBOARDING_AGENT] server unreachable — extracting on the phone');
      return localFallbackExtraction(transcript, currentProfile);
    }

    const morningHabits = Array.isArray(parsed.morningHabits)
      ? parsed.morningHabits
        .filter((item: any) => item && typeof item === 'object'
          && typeof item.habit === 'string'
          && typeof item.estimatedMinutes === 'number' && item.estimatedMinutes > 0)
        .map((item: any) => ({
          habit: item.habit.trim(),
          estimatedMinutes: Math.round(item.estimatedMinutes),
        }))
      : [];

    // The server already normalised and merged; these run anyway because they
    // are what the SCREEN needs — a display name, a transport mode the picker
    // knows, an HH:MM the time fields can render.
    const normalized: OnboardingExtraction = {
      name: typeof parsed.name === 'string' ? normalizePersonName(parsed.name.trim()) : undefined,
      transportMode: normalizeTransportMode(parsed.transportMode),
      homeAddress: typeof parsed.homeAddress === 'string' ? parsed.homeAddress.trim() : undefined,
      // Asked for in the opening question, so it must be carried through —
      // an answer Lumi collects and drops is worse than never asking.
      workAddress: typeof parsed.workAddress === 'string' ? parsed.workAddress.trim() : undefined,
      routinesNotes: typeof parsed.routinesNotes === 'string' ? parsed.routinesNotes.trim() : undefined,
      morningHabits,
      totalMorningMinutesEstimate:
        typeof parsed.totalMorningMinutesEstimate === 'number' && parsed.totalMorningMinutesEstimate > 0
          ? Math.round(parsed.totalMorningMinutesEstimate)
          : undefined,
      workStartTime: normalizeTime(parsed.workStartTime),
      sleepTime: normalizeTime(parsed.sleepTime),
      missingFields: Array.isArray(parsed.missingFields)
        ? parsed.missingFields.filter((item: any): item is string => typeof item === 'string')
        : [],
      followUpQuestion: typeof parsed.followUpQuestion === 'string' ? parsed.followUpQuestion.trim() : '',
      isComplete: Boolean(parsed.isComplete),
    };

    const merged = {
      ...currentProfile,
      ...normalized,
      morningHabits: normalized.morningHabits?.length ? normalized.morningHabits : currentProfile.morningHabits,
    };

    // Completeness is decided here as well as on the server: `isComplete` is
    // the flag that ENDS onboarding, and it must never be something a model
    // asserted its way past.
    const missing = missingFieldsFromMerged(merged);
    const completed = missing.length === 0;

    const withCompleteness: OnboardingExtraction = {
      ...normalized,
      missingFields: missing,
      isComplete: completed,
      followUpQuestion: completed ? '' : (normalized.followUpQuestion || buildFollowUp(missing[0])),
    };

    console.log('[LUMI_ONBOARDING_AGENT] extracted response:', withCompleteness);
    return withCompleteness;
  } catch (error) {
    console.log('[LUMI_ONBOARDING_AGENT] extractFromAnswer failed:', error);
    return localFallbackExtraction(transcript, currentProfile);
  }
}
