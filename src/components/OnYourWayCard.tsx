/**
 * OnYourWayCard — "you pass a coffee-machine repair shop at 17:40, and it's open."
 *
 * Shown in the task card of an errand with no place yet. Meira already planned
 * today's and tomorrow's journeys; this asks the server for places that sit on
 * those lines AND are open at the minute she passes (server/errands_along.py).
 * "Plan it" sets the place and that hour on the task — one tap from a vague
 * to-do to a stop on a trip she is making anyway.
 *
 * Trigger (rule 7): opening the task card of a place-less task. Every empty
 * answer says which one it is — "not an errand" is not "Places refused".
 */
import React, { useEffect, useState } from 'react';
import FeedbackThumbs from './FeedbackThumbs';
import { ActivityIndicator, Linking, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { BRAND, FONTS } from '../constants/theme';
import { Task } from '../types/index';
import { ErrandCandidate, ErrandsResult, ErrandTrip, errandsAlong } from '../services/LumiServer';
import { getAllTasks } from '../services/TaskStorage';
import { addMinutes, getTodayString } from '../utils/timeUtils';
import { loadProfile } from '../services/UserProfileStorage';
import { encodePolyline } from '../utils/polyline';
import { dateOffset } from '../services/GoogleSync';

const HEB = /[֐-׿]/;

type LL = [number, number];
const pointOf = (lat?: number, lng?: number): LL | null =>
  (typeof lat === 'number' && typeof lng === 'number' && !(lat === 0 && lng === 0) ? [lat, lng] : null);
const locOf = (t: Task): any => (t.location && typeof t.location === 'object' ? t.location : undefined);

/** A straight leg, as points along it — the server samples by vertex. */
const straight = (a: LL, b: LL, n = 8): LL[] =>
  Array.from({ length: n + 1 }, (_, k) => [a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n] as LL);

/**
 * Her journeys on the errand's day (or today and tomorrow for one with no
 * day): every planned leg TO an event, and the leg AFTER each one — on to the
 * next event, or home when it is the last (Koral, 1.10: "where is the next
 * event? if none, probably going home"). The way home is not routed, so it
 * goes up as a straight line, and its label says it was assumed.
 */
export async function plannedTrips(forDate?: string, now = new Date()): Promise<ErrandTrip[]> {
  const today = getTodayString();
  const dates = forDate && forDate > today ? [forDate] : [today, dateOffset(1)];
  const hhmm = now.toTimeString().slice(0, 5);
  const [all, profile] = await Promise.all([
    getAllTasks(),
    loadProfile().catch((e) => { console.warn('[OnYourWay] profile not read — no way home', e); return null; }),
  ]);
  // UserProfileStorage keeps home as homeLatLng; the older shape as homeLat/Lng.
  const p: any = profile;
  const home = pointOf(p?.homeLatLng?.lat, p?.homeLatLng?.lng) || pointOf(p?.homeLat, p?.homeLng);
  if (!home) console.warn('[OnYourWay] no home coordinates — no way-home leg');
  const out: ErrandTrip[] = [];
  for (const date of dates) {
    const placed = all
      .filter((t) => t.status === 'pending' && t.date === date && (t.fixedTime || t.scheduledTime)
        && pointOf(locOf(t)?.lat, locOf(t)?.lng))
      .sort((a, b) => (a.fixedTime || a.scheduledTime || '').localeCompare(b.fixedTime || b.scheduledTime || ''));
    placed.forEach((t, i) => {
      const loc = locOf(t);
      const plan = loc?.transitPlan as any;
      const start = (t.fixedTime || t.scheduledTime)!;
      const leave = loc?.leaveHomeBy || plan?.leaveHomeAt;
      const arrive = plan?.arriveAt || start;
      if (plan?.overviewPolyline && leave && !(date === today && arrive < hhmm)) {
        out.push({ polyline: plan.overviewPolyline, leave, arrive, date, label: t.text });
      }
      const end = addMinutes(start, t.durationMinutes || 30);
      if (date === today && end < hhmm) return;
      const next = placed[i + 1];
      // The next event's own route already starts here (the chain plans prev→next).
      if (next && (locOf(next)?.transitPlan as any)?.overviewPolyline) return;
      const to = next ? pointOf(locOf(next)?.lat, locOf(next)?.lng) : home;
      const from = pointOf(loc?.lat, loc?.lng);
      if (!to || !from) return;
      const ride = plan?.totalDurationMinutes || loc?.travelMinutes || 30;
      out.push({
        polyline: encodePolyline(straight(from, to)), leave: end, arrive: addMinutes(end, ride), date,
        label: next ? `${t.text} → ${next.text}` : `${t.text} → 🏠`,
        after: true,
      });
    });
  }
  return out.sort((a, b) => `${a.date} ${a.leave}`.localeCompare(`${b.date} ${b.leave}`)).slice(0, 3);
}

/** "yam.example" out of a URL, for the source line. */
function hostOf(url?: string | null): string {
  const m = String(url || '').match(/^https?:\/\/(?:www\.)?([^/]+)/i);
  return m ? m[1] : '';
}

function reasonLine(r: ErrandsResult | null, he: boolean): string {
  switch (r?.reason) {
    case 'no_route': return he ? 'אין נסיעה מתוכננת היום או מחר — אין "בדרך" לחפש עליו.' : 'No trip planned today or tomorrow — no "on the way" to search.';
    case 'not_an_errand': return he ? 'זה לא נראה כמו סידור במקום מסוים.' : "This doesn't look like an errand at a place.";
    case 'nothing_on_route': return he ? `לא מצאתי "${r.query}" ליד המסלולים שלך.` : `Nothing like "${r.query}" near your routes.`;
    case 'nothing_open_when_passing': return he ? 'יש כאלה בדרך — אבל סגורים כשתעברי שם.' : "There are some on the way — closed when you pass.";
    case 'places_refused': return he ? 'גוגל סירב לחיפוש המקומות (מפתח השרת).' : 'Google refused the place search (server key).';
    case 'places_unreachable': return he ? 'לא הצלחתי להגיע לגוגל — נסי שוב.' : "Couldn't reach Google — try again.";
    default: return r ? (he ? 'לא הצלחתי לחפש עכשיו.' : "Couldn't search right now.") : (he ? 'אין חיבור לשרת.' : 'No connection to the server.');
  }
}

interface Props { task: Task; he: boolean; onPlan: (patch: Partial<Task>) => void }

export default function OnYourWayCard({ task, he, onPlan }: Props) {
  const [state, setState] = useState<{ loading: boolean; res: ErrandsResult | null }>({ loading: true, res: null });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setState({ loading: true, res: null });
      try {
        const trips = await plannedTrips(task.date);
        const res = trips.length
          ? await errandsAlong(task.text, trips)
          : ({ ok: false, reason: 'no_route' } as ErrandsResult);
        if (!res?.ok) console.warn('[OnYourWay]', res?.reason ?? 'no answer', 'for task', task.id);
        if (!cancelled) setState({ loading: false, res });
      } catch (e) {
        console.warn('[OnYourWay] failed', e);
        if (!cancelled) setState({ loading: false, res: null });
      }
    })();
    return () => { cancelled = true; };
  }, [task.id, task.text]);

  // Not an errand is the common case (work, study): say nothing at all.
  if (!state.loading && state.res?.reason === 'not_an_errand') return null;

  const plan = (c: ErrandCandidate) => onPlan({
    location: { address: c.address || c.name, displayName: c.name, lat: c.lat, lng: c.lng, confirmed: true } as any,
    date: c.date || task.date,
    scheduledTime: c.pass_at,
    durationMinutes: state.res?.minutes || task.durationMinutes || 15,
  });

  return (
    <View style={styles.card}>
      <Text style={styles.kicker}>🛣️ {he ? 'בדרך שלך' : 'On your way'}</Text>
      {state.loading ? (
        <View style={styles.loading}><ActivityIndicator color={BRAND.sunGold} size="small" />
          <Text style={styles.sub}>{he ? 'מחפשת מקומות על המסלולים שלך…' : 'Looking along your routes…'}</Text></View>
      ) : state.res?.ok && state.res.candidates?.length ? (
        state.res.candidates.map((c) => (
          <View key={c.place_id} style={styles.row}>
            <View style={{ flex: 1 }}>
              {c.recommended ? (
                <Text style={styles.pick}>⭐ {he ? 'ההמלצה של מאירה' : "Meira's pick"}</Text>
              ) : null}
              <Text style={[styles.name, HEB.test(c.name) && styles.rtl]} numberOfLines={1}>{c.name}</Text>
              <Text style={styles.facts} numberOfLines={1}>
                {[
                  c.rating ? `★ ${c.rating}${c.reviews ? ` (${c.reviews})` : ''}` : null,
                  c.price_level != null ? (c.price_level === 0 ? (he ? 'חינם' : 'free') : '₪'.repeat(c.price_level)) : null,
                  c.hours_today ? `🕘 ${c.hours_today}` : null,
                ].filter(Boolean).join(' · ')}
              </Text>
              <Text style={styles.sub} numberOfLines={2}>
                {c.open_when_passing
                  ? (he ? `פתוח כשתעברי ב-${c.pass_at}` : `Open when you pass at ${c.pass_at}`)
                  : (he ? `תעברי ב-${c.pass_at} · שעות לא ידועות` : `You pass at ${c.pass_at} · hours unknown`)}
                {` · ${c.off_route_m} ${he ? 'מ׳ מהמסלול' : 'm off route'}`}
                {c.trip ? ` · ${he ? 'בדרך ל' : 'on the way to '}${c.trip}` : ''}
              </Text>
              {c.price?.price ? (
                // A real number from the web, verified against its source (server/errand_prices.py).
                <TouchableOpacity
                  onPress={() => c.price?.source_url && Linking.openURL(c.price.source_url).catch((e) => console.warn('[OnYourWay] price source', e))}
                  hitSlop={6}
                >
                  <Text style={styles.price} numberOfLines={1}>
                    💰 {c.price.price}
                    <Text style={styles.source}>{` · ${he ? 'מקור' : 'source'}: ${hostOf(c.price.source_url) || c.price.source_title || ''} ›`}</Text>
                  </Text>
                </TouchableOpacity>
              ) : null}
              {c.recommended || c.your_verdict ? (
                <FeedbackThumbs surface="errand" subject={c.name} place_id={c.place_id}
                  about={state.res?.query} he={he} />
              ) : null}
            </View>
            {c.maps_url ? (
              <TouchableOpacity onPress={() => Linking.openURL(c.maps_url!).catch((e) => console.warn('[OnYourWay] map', e))} hitSlop={8}>
                <Text style={styles.map}>🗺️</Text>
              </TouchableOpacity>
            ) : null}
            <TouchableOpacity style={styles.planBtn} onPress={() => plan(c)} accessibilityRole="button">
              <Text style={styles.planText}>{he ? 'לתכנן' : 'Plan it'}</Text>
            </TouchableOpacity>
          </View>
        ))
      ) : (
        <Text style={styles.sub}>{reasonLine(state.res, he)}</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  price: { fontSize: 12, fontFamily: FONTS.bodySemi, color: BRAND.success, marginTop: 2 },
  source: { fontSize: 11, fontFamily: FONTS.body, color: BRAND.inkSoft },
  card: {
    backgroundColor: BRAND.honey, borderRadius: 16, borderWidth: 1, borderColor: BRAND.sunGold,
    padding: 12, gap: 8, marginVertical: 8,
  },
  kicker: { fontFamily: FONTS.bodyHeavy, fontSize: 12, color: BRAND.onGold, letterSpacing: 0.5 },
  loading: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  pick: { fontFamily: FONTS.bodyHeavy, fontSize: 11, color: BRAND.goldInk, letterSpacing: 0.3 },
  facts: { fontFamily: FONTS.bodyBold, fontSize: 12, color: BRAND.warmInk },
  name: { fontFamily: FONTS.bodyHeavy, fontSize: 14, color: BRAND.warmInk },
  rtl: { writingDirection: 'rtl', textAlign: 'right' },
  sub: { fontFamily: FONTS.bodySemi, fontSize: 12, color: BRAND.goldInk, lineHeight: 17 },
  map: { fontSize: 18 },
  planBtn: { backgroundColor: BRAND.warmInk, borderRadius: 999, paddingVertical: 8, paddingHorizontal: 12, minHeight: 36, justifyContent: 'center' },
  planText: { color: BRAND.creamCard, fontFamily: FONTS.bodyHeavy, fontSize: 12 },
});
