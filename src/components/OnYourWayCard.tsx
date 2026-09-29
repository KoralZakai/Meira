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
import { getTodayString } from '../utils/timeUtils';
import { dateOffset } from '../services/GoogleSync';

const HEB = /[֐-׿]/;

/** The journeys Meira planned for today (still ahead) and tomorrow. */
export async function plannedTrips(now = new Date()): Promise<ErrandTrip[]> {
  const today = getTodayString();
  const tomorrow = dateOffset(1);
  const hhmm = now.toTimeString().slice(0, 5);
  const all = await getAllTasks();
  const out: ErrandTrip[] = [];
  for (const t of all) {
    if (t.status !== 'pending' || (t.date !== today && t.date !== tomorrow)) continue;
    const loc = typeof t.location === 'object' ? t.location : undefined;
    const plan = loc?.transitPlan as any;
    const leave = loc?.leaveHomeBy || plan?.leaveHomeAt;
    const arrive = plan?.arriveAt || t.fixedTime || t.scheduledTime;
    if (!plan?.overviewPolyline || !leave || !arrive) continue;
    if (t.date === today && arrive < hhmm) continue;
    out.push({ polyline: plan.overviewPolyline, leave, arrive, date: t.date, label: t.text });
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
        const trips = await plannedTrips();
        const res = trips.length
          ? await errandsAlong(task.text, trips)
          : ({ ok: false, reason: 'no_route' } as ErrandsResult);
        if (!res?.ok) console.warn('[OnYourWay]', res?.reason ?? 'no answer', 'for', task.text);
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
  sub: { fontFamily: FONTS.bodySemi, fontSize: 12, color: '#7A5A18', lineHeight: 17 },
  map: { fontSize: 18 },
  planBtn: { backgroundColor: BRAND.warmInk, borderRadius: 999, paddingVertical: 8, paddingHorizontal: 12, minHeight: 36, justifyContent: 'center' },
  planText: { color: BRAND.white, fontFamily: FONTS.bodyHeavy, fontSize: 12 },
});
