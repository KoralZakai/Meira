/**
 * WakeCalculator — standalone "when do I wake/leave" tool; lets the user pick
 * an ORIGIN (not just home) and a mode, then shows the Google-backed plan.
 * Dependencies: GoogleService (transit/car plans), NearbyTaskReminderService
 * (geocoding), TaskStorage.
 */
import React, { useEffect, useState } from 'react';
import {
  View,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
} from 'react-native';
import DateTimePicker from '@react-native-community/datetimepicker';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BRAND, FONTS, RADIUS } from '../constants/theme';
import { calculateWakeTime } from '../utils/timeUtils';
import { loadProfile } from '../services/TaskStorage';
import {
  searchLocationCandidates,
  openLocationInMaps,
  getCurrentLocationDetails,
} from '../services/NearbyTaskReminderService';
import { GoogleService } from '../services/GoogleService';
import { UserProfile } from '../types';

interface WakeCalculatorProps {
  navigation: any;
}

const pad = (n: number) => String(n).padStart(2, '0');
const toHHMM = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const toDateStr = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fmtDate = (d: Date) => d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });

interface Candidate {
  label: string;
  lat: number;
  lng: number;
}

interface Result {
  wakeBy: string;
  leaveHomeBy: string;
  travel: number;
  routine: number;
  buffer: number;
}

export default function WakeCalculator({ navigation }: WakeCalculatorProps) {
  const insets = useSafeAreaInsets();
  const bgColor = BRAND.cream;
  const textColor = BRAND.warmInk;
  const subColor = BRAND.inkSoft;
  const cardColor = BRAND.creamCard;
  const borderColor = BRAND.line;
  const field = { backgroundColor: cardColor, borderColor };

  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [query, setQuery] = useState('');
  const [destination, setDestination] = useState<Candidate | null>(null);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [searching, setSearching] = useState(false);

  // Origin ("from where"): null = use saved Home; otherwise a chosen place / current location.
  const [origin, setOrigin] = useState<Candidate | null>(null);
  const [originQuery, setOriginQuery] = useState('');
  const [originCandidates, setOriginCandidates] = useState<Candidate[]>([]);
  const [originSearching, setOriginSearching] = useState(false);
  const [locating, setLocating] = useState(false);

  const [arrival, setArrival] = useState(() => {
    const d = new Date();
    d.setHours(10, 0, 0, 0);
    return d;
  });
  const [pickerMode, setPickerMode] = useState<'date' | 'time' | null>(null);

  const [travelMinutes, setTravelMinutes] = useState('45');
  const [travelSource, setTravelSource] = useState<'google' | 'manual'>('manual');
  const [fetchingTravel, setFetchingTravel] = useState(false);
  const [routineMinutes, setRoutineMinutes] = useState('45');
  const [result, setResult] = useState<Result | null>(null);

  useEffect(() => {
    loadProfile().then((p) => {
      if (p) {
        setProfile(p);
        if (p.morningRoutineMinutes) setRoutineMinutes(String(p.morningRoutineMinutes));
      }
    });
  }, []);

  const onPickerChange = (event: any, selected?: Date) => {
    const mode = pickerMode;
    setPickerMode(null);
    if (event?.type === 'dismissed' || !selected) return;
    setArrival((prev) => {
      const d = new Date(prev);
      if (mode === 'date') d.setFullYear(selected.getFullYear(), selected.getMonth(), selected.getDate());
      else d.setHours(selected.getHours(), selected.getMinutes(), 0, 0);
      return d;
    });
    setResult(null);
  };

  const runSearch = async () => {
    const q = query.trim();
    if (!q) return;
    // Show in-app candidates so the user picks exact coords here (tapping one selects it).
    // We no longer auto-launch external Google Maps — that left the app with nothing selected.
    setSearching(true);
    setCandidates([]);
    try {
      const found = await searchLocationCandidates(q);
      if (!found.length) {
        Alert.alert('No places found', `Lumi could not find map results for "${q}".`);
      }
      setCandidates(found);
    } catch (e) {
      console.log('[GetReady] search error:', e);
    } finally {
      setSearching(false);
    }
  };

  const pickDestination = async (c: Candidate) => {
    setDestination(c);
    setCandidates([]);
    setQuery(c.label);
    setResult(null);
    fetchTravelTime(c.label);
  };

  // Search for an origin place (the "from where").
  const runOriginSearch = async () => {
    const q = originQuery.trim();
    if (!q) return;
    setOriginSearching(true);
    setOriginCandidates([]);
    try {
      setOriginCandidates(await searchLocationCandidates(q));
    } catch (e) {
      console.log('[GetReady] origin search error:', e);
    } finally {
      setOriginSearching(false);
    }
  };

  const pickOrigin = (c: Candidate) => {
    setOrigin(c);
    setOriginQuery(c.label);
    setOriginCandidates([]);
    setResult(null);
    if (destination) fetchTravelTime(destination.label);
  };

  const useCurrentOrigin = async () => {
    setLocating(true);
    try {
      const loc = await getCurrentLocationDetails();
      if (!loc) {
        Alert.alert('Location unavailable', 'Lumi could not read your current location right now.');
        return;
      }
      pickOrigin({ label: loc.label, lat: loc.lat, lng: loc.lng });
    } finally {
      setLocating(false);
    }
  };

  const resetOriginToHome = () => {
    setOrigin(null);
    setOriginQuery('');
    setOriginCandidates([]);
    setResult(null);
    if (destination) fetchTravelTime(destination.label);
  };

  const fetchTravelTime = async (destLabel: string) => {
    if (!profile) {
      setTravelSource('manual');
      return;
    }
    setFetchingTravel(true);
    try {
      const dateStr = toDateStr(arrival);
      // Override the profile's home with the chosen origin, so Google routes from there.
      const effectiveProfile: UserProfile = origin
        ? { ...profile, homeAddress: origin.label, homeLat: origin.lat, homeLng: origin.lng }
        : profile;
      const plan =
        effectiveProfile.transportType === 'car'
          ? await GoogleService.getPlanForMode('car', destLabel, toHHMM(arrival), effectiveProfile, dateStr)
          : await GoogleService.getTransitPlan(destLabel, toHHMM(arrival), effectiveProfile, dateStr);
      if (plan?.totalDurationMinutes) {
        setTravelMinutes(String(plan.totalDurationMinutes));
        setTravelSource('google');
      } else {
        setTravelSource('manual');
      }
    } catch (e) {
      console.log('[GetReady] travel fetch error:', e);
      setTravelSource('manual');
    } finally {
      setFetchingTravel(false);
    }
  };

  const handleCalculate = () => {
    const travel = parseInt(travelMinutes, 10) || 0;
    const routine = parseInt(routineMinutes, 10) || 0;
    const buffer = profile?.wakeBufferMinutes ?? 15;
    const r = calculateWakeTime(toHHMM(arrival), travel, routine, buffer);
    setResult({ ...r, travel, routine, buffer });
  };

  const destName = destination?.label || query || 'your destination';
  const reason = result
    ? `To reach ${destName} by ${toHHMM(arrival)} on ${fmtDate(arrival)}: leave home by ${result.leaveHomeBy} ` +
      `(${result.travel} min ${profile?.transportType === 'car' ? 'drive' : 'travel'}${travelSource === 'google' ? ', live from Google Maps' : ''}), ` +
      `and start getting ready at ${result.wakeBy} (${result.routine} min routine + ${result.buffer} min buffer).`
    : '';

  return (
    <View style={[styles.container, { backgroundColor: bgColor, paddingTop: insets.top }]}>
      <ScrollView style={styles.scroll} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={[styles.title, { color: textColor }]}>⏰ Time Planner</Text>
        <Text style={[styles.subtitle, { color: subColor }]}>
          Set an alert for when to wake & leave so you arrive on time.
        </Text>

        {/* From where (origin) */}
        <Text style={[styles.label, { color: textColor }]}>🏁 From where</Text>
        <View style={styles.originChipsRow}>
          <TouchableOpacity
            style={[styles.originChip, !origin && styles.originChipActive]}
            onPress={resetOriginToHome}
          >
            <Text style={[styles.originChipText, !origin && styles.originChipTextActive]}>
              🏠 Home
            </Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.originChip} onPress={useCurrentOrigin} disabled={locating}>
            {locating ? (
              <ActivityIndicator color={BRAND.sunGold} size="small" />
            ) : (
              <Text style={styles.originChipText}>📍 Current location</Text>
            )}
          </TouchableOpacity>
        </View>
        <View style={styles.searchRow}>
          <TextInput
            style={[styles.input, styles.flex, field, { color: textColor }]}
            placeholder="Or type a starting address…"
            placeholderTextColor={subColor}
            value={originQuery}
            onChangeText={setOriginQuery}
            onSubmitEditing={runOriginSearch}
            returnKeyType="search"
          />
          <TouchableOpacity style={styles.searchBtn} onPress={runOriginSearch} disabled={originSearching}>
            {originSearching ? <ActivityIndicator color="white" size="small" /> : <Text style={styles.searchBtnText}>🔍</Text>}
          </TouchableOpacity>
        </View>
        {originCandidates.length > 0 && (
          <View style={[styles.candidates, field]}>
            {originCandidates.map((c, i) => (
              <TouchableOpacity key={`o-${c.lat},${c.lng},${i}`} style={styles.candidate} onPress={() => pickOrigin(c)}>
                <Text style={styles.candidateIcon}>📍</Text>
                <Text style={[styles.candidateLabel, { color: textColor }]} numberOfLines={1}>{c.label}</Text>
              </TouchableOpacity>
            ))}
          </View>
        )}
        {origin && (
          <Text style={[styles.originActive, { color: subColor }]} numberOfLines={1}>
            Starting from: {origin.label}
          </Text>
        )}

        {/* Location */}
        <Text style={[styles.label, { color: textColor }]}>📍 Destination</Text>
        <View style={styles.searchRow}>
          <TextInput
            style={[styles.input, styles.flex, field, { color: textColor }]}
            placeholder="Search a place (Google Maps)…"
            placeholderTextColor={subColor}
            value={query}
            onChangeText={setQuery}
            onSubmitEditing={runSearch}
            returnKeyType="search"
          />
          <TouchableOpacity style={styles.searchBtn} onPress={runSearch} disabled={searching}>
            {searching ? <ActivityIndicator color="white" size="small" /> : <Text style={styles.searchBtnText}>🔍</Text>}
          </TouchableOpacity>
        </View>

        {candidates.length > 0 && (
          <View style={[styles.candidates, field]}>
            {candidates.map((c, i) => (
              <TouchableOpacity key={`${c.lat},${c.lng},${i}`} style={styles.candidate} onPress={() => pickDestination(c)}>
                <Text style={styles.candidateIcon}>📍</Text>
                <Text style={[styles.candidateLabel, { color: textColor }]} numberOfLines={1}>
                  {c.label}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        )}

        {destination && (
          <TouchableOpacity
            style={styles.mapsLink}
            onPress={() => openLocationInMaps(destination.label, { lat: destination.lat, lng: destination.lng })}
          >
            <Text style={styles.mapsLinkText}>🗺️ Open in Google Maps</Text>
          </TouchableOpacity>
        )}

        {/* Date + Time row */}
        <View style={styles.row}>
          <View style={styles.half}>
            <Text style={[styles.label, { color: textColor }]}>📅 Date</Text>
            <TouchableOpacity style={[styles.pickerBtn, field]} onPress={() => setPickerMode('date')}>
              <Text style={[styles.pickerValue, { color: textColor }]}>{fmtDate(arrival)}</Text>
            </TouchableOpacity>
          </View>
          <View style={styles.half}>
            <Text style={[styles.label, { color: textColor }]}>🕐 Arrival</Text>
            <TouchableOpacity style={[styles.pickerBtn, field]} onPress={() => setPickerMode('time')}>
              <Text style={[styles.pickerValue, { color: textColor }]}>{toHHMM(arrival)}</Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* Travel + Routine row */}
        <View style={styles.row}>
          <View style={styles.half}>
            <Text style={[styles.label, { color: textColor }]}>
              🚌 Travel min {fetchingTravel ? '…' : travelSource === 'google' ? '✓' : ''}
            </Text>
            <TextInput
              style={[styles.input, field, { color: textColor }]}
              value={travelMinutes}
              onChangeText={(t) => {
                setTravelMinutes(t);
                setTravelSource('manual');
              }}
              keyboardType="number-pad"
            />
          </View>
          <View style={styles.half}>
            <Text style={[styles.label, { color: textColor }]}>🛁 Routine min</Text>
            <TextInput
              style={[styles.input, field, { color: textColor }]}
              value={routineMinutes}
              onChangeText={setRoutineMinutes}
              keyboardType="number-pad"
            />
          </View>
        </View>

        <TouchableOpacity style={styles.calcBtn} onPress={handleCalculate}>
          <Text style={styles.calcBtnText}>Calculate ✓</Text>
        </TouchableOpacity>

        {result && (
          <View style={styles.results}>
            <View style={styles.resultsRow}>
              <View style={[styles.resultCard, { marginRight: 6 }]}>
                <Text style={styles.resultEmoji}>⏰</Text>
                <Text style={[styles.resultLabel, { color: subColor }]}>Wake up</Text>
                <Text style={styles.resultTime}>{result.wakeBy}</Text>
              </View>
              <View style={[styles.resultCard, { marginLeft: 6 }]}>
                <Text style={styles.resultEmoji}>🚪</Text>
                <Text style={[styles.resultLabel, { color: subColor }]}>Leave home</Text>
                <Text style={styles.resultTime}>{result.leaveHomeBy}</Text>
              </View>
            </View>
            <Text style={[styles.reason, { color: subColor, backgroundColor: cardColor }]}>{reason}</Text>
          </View>
        )}
      </ScrollView>

      {pickerMode && (
        <DateTimePicker
          value={arrival}
          mode={pickerMode}
          is24Hour
          onChange={onPickerChange}
          minimumDate={pickerMode === 'date' ? new Date() : undefined}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  scroll: { flex: 1 },
  content: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 40 },
  title: { fontSize: 24, fontFamily: FONTS.bodyBold, marginBottom: 2 },
  subtitle: { fontSize: 13, fontFamily: FONTS.bodySemi, marginBottom: 14 },
  label: { fontSize: 13, fontFamily: FONTS.bodySemi, marginBottom: 6, marginTop: 4 },
  flex: { flex: 1 },
  originChipsRow: { flexDirection: 'row', gap: 8, marginBottom: 8 },
  originChip: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1.5,
    borderColor: BRAND.sunGold,
    borderRadius: RADIUS.pill,
    paddingHorizontal: 14,
    paddingVertical: 8,
    minHeight: 36,
  },
  originChipActive: { backgroundColor: BRAND.sunGold },
  originChipText: { color: BRAND.sunGold, fontFamily: FONTS.bodyBold, fontSize: 13 },
  originChipTextActive: { color: 'white' },
  originActive: { fontSize: 12, marginTop: 6, fontStyle: 'italic' },
  searchRow: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  input: {
    borderWidth: 1,
    borderColor: BRAND.line,
    borderRadius: RADIUS.chip,
    paddingHorizontal: 12,
    paddingVertical: 9,
    fontSize: 14,
    backgroundColor: BRAND.creamCard,
  },
  searchBtn: {
    backgroundColor: BRAND.sunGold,
    width: 44,
    height: 40,
    borderRadius: RADIUS.chip,
    alignItems: 'center',
    justifyContent: 'center',
  },
  searchBtnText: { fontSize: 18 },
  candidates: {
    marginTop: 6,
    borderWidth: 1,
    borderColor: BRAND.line,
    borderRadius: RADIUS.chip,
    overflow: 'hidden',
    backgroundColor: BRAND.creamCard,
  },
  candidate: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: BRAND.line,
  },
  candidateIcon: { fontSize: 14, marginRight: 8 },
  candidateLabel: { fontSize: 13, flex: 1 },
  mapsLink: { paddingVertical: 8 },
  mapsLinkText: { color: BRAND.sunGold, fontFamily: FONTS.bodySemi, fontSize: 13 },
  row: { flexDirection: 'row', gap: 12 },
  half: { flex: 1 },
  pickerBtn: {
    borderWidth: 1,
    borderColor: BRAND.line,
    borderRadius: RADIUS.chip,
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: BRAND.creamCard,
  },
  pickerValue: { fontSize: 14, fontFamily: FONTS.bodySemi },
  calcBtn: {
    backgroundColor: BRAND.sunGold,
    paddingVertical: 13,
    borderRadius: RADIUS.chip,
    alignItems: 'center',
    marginTop: 16,
  },
  calcBtnText: { color: 'white', fontFamily: FONTS.bodyBold, fontSize: 15 },
  results: { marginTop: 16 },
  resultsRow: { flexDirection: 'row' },
  resultCard: {
    flex: 1,
    backgroundColor: BRAND.amber,
    borderRadius: RADIUS.chip,
    padding: 14,
    alignItems: 'center',
  },
  resultEmoji: { fontSize: 26, marginBottom: 4 },
  resultLabel: { fontSize: 11, fontFamily: FONTS.bodySemi, marginBottom: 2 },
  resultTime: { fontSize: 22, fontFamily: FONTS.bodyBold, color: BRAND.sunGold },
  reason: {
    fontSize: 13,
    lineHeight: 19,
    marginTop: 14,
    backgroundColor: BRAND.creamCard,
    padding: 12,
    borderRadius: RADIUS.chip,
    borderLeftWidth: 3,
    borderLeftColor: BRAND.sunGold,
  },
});
