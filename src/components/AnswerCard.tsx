/**
 * AnswerCard — Meira's answer to "how do I get home from here?" or "which
 * beach is fastest by car?", drawn in the chat under her reply (7.10).
 *
 * Her picks from the mockup: the winner on gold, the other options as rows
 * with the minutes on the side; tapping a row makes it the chosen one. The
 * main button is "leaving now" (the trip goes on today, routed and alerted,
 * with "I left") — for places, "navigate". A taxi row always carries a Gett
 * button, never a price. Every button reports whether it worked (rule 3).
 *
 * Numbers come from the server (place_ranker); words and links from
 * utils/answerCard.
 */
import React, { useMemo, useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { BRAND, FONTS, MIN_TOUCH } from '../constants/theme';
import {
  AnswerMode, CardOption, GETT_STORE, LookupAnswer, cardHeading, cardOptions, gettLink,
  mapsLink, placeLink, primaryLabel, wazeLink,
} from '../utils/answerCard';
import { openLink, startTripNow } from '../services/AnswerActions';

const ICON: Record<AnswerMode, string> = {
  car: '🚗', taxi: '🚕', bus: '🚌', train: '🚆', walk: '🚶', bike: '🚲',
};

interface Props {
  answer: LookupAnswer;
  he: boolean;
  /** Put words in the chat: sent at once, or typed into the box for her to finish. */
  onAsk: (text: string, send: boolean) => void;
  /** Meira's one-line confirmation of what a button did, as a chat message. */
  onSay: (text: string) => void;
}

export default function AnswerCard({ answer, he, onAsk, onSay }: Props) {
  const options = useMemo(() => cardOptions(answer, he), [answer, he]);
  const head = useMemo(() => cardHeading(answer, he), [answer, he]);
  const [sel, setSel] = useState(0);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const chosen: CardOption | undefined = options[sel];
  const route = answer.kind === 'route';
  const isBeach = /חוף|beach/i.test(answer.query ?? '');
  const placeIcon = isBeach ? '🏖️' : '📍';
  const dest = chosen?.lat != null && chosen?.lng != null ? { lat: chosen.lat, lng: chosen.lng } : null;

  const primary = async () => {
    if (!chosen || busy) return;
    if (!route) {
      if (!dest) return onSay(he ? 'אין לי מיקום מדויק למקום הזה' : 'No exact position for this place');
      const ok = await openLink(wazeLink(dest.lat, dest.lng), mapsLink(dest, chosen.mode, answer.origin));
      if (!ok) onSay(he ? 'לא הצלחתי לפתוח ניווט — אין Waze או מפות?' : "Couldn't open navigation — no Waze or Maps?");
      return;
    }
    setBusy(true);
    const r = await startTripNow(answer, chosen, he);
    setBusy(false);
    if (!r.ok) {
      onSay(he ? `לא הוספתי את הנסיעה: ${r.reason}` : `Couldn't add the trip: ${r.reason}`);
      return;
    }
    const line = he
      ? `✓ ${r.task.text} ${ICON[chosen.mode]} נכנס להיום · הגעה ${r.arriveAt}. אתריע כשצריך לצאת.`
      : `✓ ${r.task.text} ${ICON[chosen.mode]} is on today · arrive ${r.arriveAt}. I'll tell you when to leave.`;
    setDone(line);
    onSay(line);
  };

  const rtl = he ? styles.rtl : null;
  const row = he ? styles.rowRtl : null;

  return (
    <View style={styles.card}>
      <View style={[styles.headRow, row]}>
        <Text style={[styles.title, rtl]} numberOfLines={1}>{head.title}</Text>
      </View>
      <Text style={[styles.sub, rtl]}>{head.sub}</Text>

      {options.map((o, i) => {
        const on = i === sel;
        return (
          <TouchableOpacity key={o.key} activeOpacity={0.8} onPress={() => setSel(i)}
            accessibilityRole="radio" accessibilityState={{ selected: on }}
            style={[styles.opt, row, on ? styles.optOn : styles.optOff]}>
            <View style={[styles.icon, on ? styles.iconOn : null]}>
              <Text style={styles.iconText}>{route ? ICON[o.mode] : placeIcon}</Text>
            </View>
            <View style={styles.optBody}>
              <Text style={[styles.optTitle, rtl, o.closed ? styles.closed : null]} numberOfLines={1}>
                {o.title}{!route ? ` · ${ICON[o.mode]}` : ''}
              </Text>
              {o.detail ? <Text style={[styles.optDetail, rtl]} numberOfLines={2}>{o.detail}</Text> : null}
            </View>
            {o.mode === 'taxi' && (o.lat ?? answer.destination?.lat) != null ? (
              <TouchableOpacity style={styles.gett} hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
                onPress={() => {
                  const lat = o.lat ?? answer.destination?.lat;
                  const lng = o.lng ?? answer.destination?.lng;
                  if (lat == null || lng == null) return;
                  void openLink(gettLink({ lat, lng }, answer.destination?.name), GETT_STORE).then((ok) => {
                    if (!ok) onSay(he ? 'לא הצלחתי לפתוח את Gett' : "Couldn't open Gett");
                  });
                }}>
                <Text style={styles.gettText}>Gett ↗</Text>
              </TouchableOpacity>
            ) : null}
            {!route ? (
              // Where IS it? The place's own page on Google Maps.
              <TouchableOpacity style={styles.pin} hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
                accessibilityLabel={he ? `${o.title} במפה` : `${o.title} on the map`}
                onPress={() => void openLink(placeLink(o)).then((ok) => {
                  if (!ok) onSay(he ? 'לא הצלחתי לפתוח מפה' : "Couldn't open the map");
                })}>
                <Text style={styles.pinText}>🗺️</Text>
              </TouchableOpacity>
            ) : null}
            {/* The number alone was a bare 17 — minutes? a price? — so it carries its unit. */}
            <View style={styles.minBox}>
              <Text style={styles.min}>{o.minutes}</Text>
              <Text style={styles.minUnit}>{he ? 'דק׳' : 'min'}</Text>
            </View>
          </TouchableOpacity>
        );
      })}

      {chosen ? (
        <View style={[styles.actions, row]}>
          <TouchableOpacity style={[styles.btn, styles.btnGold, done ? styles.btnDone : null]}
            onPress={primary} disabled={busy || Boolean(done)} accessibilityRole="button">
            <Text style={styles.btnGoldText}>
              {done ? (he ? '✓ בדרך' : '✓ On it') : busy ? '…' : `${route ? '▶' : '🧭'} ${primaryLabel(answer, chosen, he)}`}
            </Text>
          </TouchableOpacity>
          {dest ? (
            <TouchableOpacity style={styles.btn}
              onPress={() => void openLink(mapsLink(dest, chosen.mode, answer.origin)).then((ok) => {
                if (!ok) onSay(he ? 'לא הצלחתי לפתוח מפה' : "Couldn't open the map");
              })}>
              <Text style={styles.btnText}>🗺️ {he ? 'מפה' : 'Map'}</Text>
            </TouchableOpacity>
          ) : null}
          {route ? (
            <TouchableOpacity style={styles.btn} onPress={() => onAsk(he
              ? `תוסיפי נסיעה ל${answer.to_home ? 'בית' : answer.destination?.name ?? ''} ב-` : `Add a trip to ${answer.to_home ? 'home' : answer.destination?.name ?? ''} at `, false)}>
              <Text style={styles.btnText}>🗓️ {he ? 'לשעה אחרת' : 'Another time'}</Text>
            </TouchableOpacity>
          ) : (
            <>
              <TouchableOpacity style={styles.btn}
                onPress={() => onAsk(he ? `תוסיפי להיום: ${chosen.title}, ב-` : `Add ${chosen.title} today at `, false)}>
                <Text style={styles.btnText}>🗓️ {he ? 'הוסיפי ליום' : 'Add to today'}</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.btn}
                onPress={() => onAsk(he ? 'ואם באופניים או באוטובוס?' : 'And by bike or bus?', true)}>
                <Text style={styles.btnText}>🔁 {he ? 'אופניים / אוטובוס?' : 'Bike / bus?'}</Text>
              </TouchableOpacity>
            </>
          )}
        </View>
      ) : null}
      {options.some((o) => o.mode === 'car' || o.mode === 'taxi') ? (
        <Text style={[styles.note, rtl]}>
          {he ? '~ = הערכה (חניה, המתנה למונית)' : '~ = estimate (parking, taxi pickup)'}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: BRAND.creamCard, borderRadius: 16, borderWidth: 1, borderColor: BRAND.line,
    padding: 12, marginTop: 6, maxWidth: '92%', alignSelf: 'stretch',
  },
  headRow: { flexDirection: 'row', alignItems: 'baseline' },
  title: { fontFamily: FONTS.bodyBold, fontSize: 15, color: BRAND.warmInk, flex: 1 },
  sub: { fontFamily: FONTS.body, fontSize: 12, color: BRAND.inkSoft, marginTop: 2, marginBottom: 6 },
  opt: { flexDirection: 'row', alignItems: 'center', paddingVertical: 9, paddingHorizontal: 8, borderRadius: 12, gap: 10 },
  // The chosen row says so with an edge, not only a tint: honey on creamCard is 1.2:1, invisible to many eyes.
  optOn: { backgroundColor: BRAND.honey, borderWidth: 1.5, borderColor: BRAND.goldInk },
  optOff: { borderWidth: 1.5, borderColor: 'transparent', borderTopColor: BRAND.line, borderRadius: 0 },
  icon: {
    width: 32, height: 32, borderRadius: 16, backgroundColor: BRAND.goldSoft,
    alignItems: 'center', justifyContent: 'center',
  },
  iconOn: { backgroundColor: BRAND.creamCard },
  iconText: { fontSize: 16 },
  optBody: { flex: 1 },
  optTitle: { fontFamily: FONTS.bodySemi, fontSize: 14, color: BRAND.warmInk },
  closed: { color: BRAND.inkFaint, textDecorationLine: 'line-through' },
  optDetail: { fontFamily: FONTS.body, fontSize: 12, color: BRAND.inkSoft, marginTop: 1 },
  minBox: { minWidth: 40, alignItems: 'center' },
  min: { fontFamily: FONTS.bodyBold, fontSize: 20, lineHeight: 22, color: BRAND.warmInk, textAlign: 'center' },
  minUnit: { fontFamily: FONTS.bodySemi, fontSize: 11, lineHeight: 13, color: BRAND.inkSoft },
  gett: {
    borderWidth: 1, borderColor: BRAND.goldInk, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4, minHeight: 32, justifyContent: 'center',
  },
  gettText: { fontFamily: FONTS.bodySemi, fontSize: 12, color: BRAND.onGold },
  pin: {
    width: 34, height: 34, borderRadius: 17, borderWidth: 1, borderColor: BRAND.line,
    backgroundColor: BRAND.creamCard, alignItems: 'center', justifyContent: 'center',
  },
  pinText: { fontSize: 16 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 10 },
  btn: {
    borderWidth: 1, borderColor: BRAND.line, backgroundColor: BRAND.creamCard, borderRadius: 999,
    paddingHorizontal: 14, paddingVertical: 8, minHeight: MIN_TOUCH, justifyContent: 'center', alignItems: 'center',
  },
  btnText: { fontFamily: FONTS.bodySemi, fontSize: 13, color: BRAND.warmInk },
  btnGold: { backgroundColor: BRAND.sunGold, borderColor: BRAND.goldInk },
  btnDone: { backgroundColor: BRAND.goldSoft },
  btnGoldText: { fontFamily: FONTS.bodyBold, fontSize: 13, color: BRAND.onGold },
  note: { fontFamily: FONTS.body, fontSize: 12, color: BRAND.inkSoft, marginTop: 8 },
  rtl: { textAlign: 'right', writingDirection: 'rtl' },
  rowRtl: { flexDirection: 'row-reverse' },
});
