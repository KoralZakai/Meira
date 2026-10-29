/**
 * EventDetailsSection — the calendar event behind a task, one tap from the card.
 *
 * Link to the event, the video-call join link, dial-in, who organised it, who
 * is invited (and who said yes), the invitation's text and its attachments —
 * everything Google Calendar already holds, read live when the card opens
 * (GoogleService.getEventDetails → utils/eventDetails). Nothing is stored.
 *
 * It never says nothing: while loading it says so, and when the calendar
 * could not be asked it says why and offers a retry (silent-state rule 3).
 */

/**
 * EventDetailsSection — the calendar event behind a task, one tap from the card.
 *
 * Link to the event, video-call join link, dial-in, organiser, guests,
 * invitation text and attachments. Read live from Google Calendar.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Linking, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { BRAND, FONTS, surf } from '../constants/theme';
import { GoogleService } from '../services/GoogleService';
import type { EventDetails, GuestAnswer } from '../utils/eventDetails';

/** Per session: opening the same card twice does not ask Google twice. */
const cache = new Map<string, EventDetails>();

interface Props { eventId: string; he: boolean }

const MARK: Record<GuestAnswer, string> = { yes: '✓', no: '✗', maybe: '?', none: '·' };
const SHOW_GUESTS = 8;

// Log only the link scheme, never the full URL or any sensitive query parameters.
const open = (url: string) =>
  Linking.openURL(url).catch(() =>
    console.warn('[EventDetails] could not open a', url.split(':')[0], 'link')
  );

const hostOf = (url: string): string => {
  const m = /^https:\/\/([^/?#]+)/i.exec(url);
  return m ? m[1].replace(/^www\./, '') : '';
};

// Restrict dial-in links to phone dialler symbols.
const dialable = (p: string): string => p.replace(/[^0-9+*#,;]/g, '');
const EMAIL = /^[^\s@?&=]+@[^\s@?&=]+\.[^\s@?&=]+$/;

function why(error: string, he: boolean): string {
  if (error === 'not_connected') return he ? 'גוגל לא מחובר — התחברי מחדש בפרופיל' : 'Google is not connected — sign in again in Profile';
  if (error === 'not_found') return he ? 'האירוע לא נמצא ביומן (אולי נמחק או שהוא ביומן אחר)' : 'The event is not in your calendar (deleted, or on another calendar)';
  if (error.startsWith('network')) return he ? 'אין חיבור — לא הצלחתי לשאול את היומן' : 'No connection — could not ask the calendar';
  return he ? `גוגל סירב (${error.slice(0, 40)})` : `Google refused (${error.slice(0, 40)})`;
}

export default function EventDetailsSection({ eventId, he }: Props) {
  const [details, setDetails] = useState<EventDetails | undefined>(() => cache.get(eventId));
  const [error, setError] = useState<string | undefined>();
  const [loading, setLoading] = useState(() => !cache.has(eventId));
  const [allGuests, setAllGuests] = useState(false);
  const [fullText, setFullText] = useState(false);

  const load = useCallback(() => {
    let alive = true;
    setLoading(true);
    setError(undefined);

    GoogleService.getEventDetails(eventId).then((r) => {
      if (!alive) return;
      if (r.details) {
        cache.set(eventId, r.details);
        setDetails(r.details);
      } else {
        setError(r.error || 'not_found');
      }
      setLoading(false);
    }).catch((e) => {
      if (alive) {
        setError(`network: ${String(e?.message || e)}`);
        setLoading(false);
      }
    });

    return () => { alive = false; };
  }, [eventId]);

  useEffect(() => {
    if (cache.has(eventId)) return;
    return load();
  }, [eventId, load]);

  const row = (icon: string, label: string, onPress?: () => void, sub?: string) => (
    <TouchableOpacity key={icon + label} style={styles.row} disabled={!onPress} onPress={onPress} activeOpacity={0.7}>
      <Text style={styles.icon}>{icon}</Text>
      <View style={{ flex: 1 }}>
        <Text style={[styles.label, onPress && styles.link]} numberOfLines={2}>{label}</Text>
        {sub ? <Text style={styles.sub}>{sub}</Text> : null}
      </View>
    </TouchableOpacity>
  );

  if (loading) {
    return <View style={styles.box}><ActivityIndicator color={BRAND.sunGold} /><Text style={styles.sub}>{he ? 'טוען את פרטי האירוע…' : 'Loading event details…'}</Text></View>;
  }

  if (error || !details) {
    return (
      <View style={styles.box}>
        <Text style={styles.sub}>{why(error || 'not_found', he)}</Text>
        <TouchableOpacity onPress={load}><Text style={styles.link}>{he ? 'נסי שוב' : 'Try again'}</Text></TouchableOpacity>
      </View>
    );
  }

  const guests = allGuests ? details.guests : details.guests.slice(0, SHOW_GUESTS);

  return (
    <View style={styles.box}>
      <Text style={styles.head}>{he ? 'פרטי האירוע' : 'Event details'}</Text>
      {details.url ? row('📅', he ? 'פתחי ביומן גוגל' : 'Open in Google Calendar', () => open(details.url!)) : null}
      {details.joinUrl ? row('💻', he ? 'הצטרפי לשיחה' : 'Join the call', () => open(details.joinUrl!), hostOf(details.joinUrl)) : null}
      {details.dialIn ? row('📞', details.dialIn.phone, dialable(details.dialIn.phone) ? () => open(`tel:${dialable(details.dialIn!.phone)}`) : undefined, details.dialIn.pin ? `PIN ${details.dialIn.pin}` : undefined) : null}
      {details.organizer ? row('🧑‍💼', details.organizer.name, EMAIL.test(details.organizer.email) ? () => open(`mailto:${details.organizer!.email}`) : undefined, he ? 'מארגן/ת' : 'organiser') : null}
      {details.guests.length > 0 ? (
        <View style={styles.row}>
          <Text style={styles.icon}>👥</Text>
          <View style={{ flex: 1 }}>
            {guests.map((g) => (
              <Text key={g.email || g.name} style={styles.label}>{`${MARK[g.answer]} ${g.name}${g.self ? (he ? ' (את)' : ' (you)') : ''}`}</Text>
            ))}
            {details.guests.length > SHOW_GUESTS ? (
              <TouchableOpacity onPress={() => setAllGuests((v) => !v)}>
                <Text style={styles.link}>{allGuests ? (he ? 'פחות' : 'Fewer') : (he ? `ועוד ${details.guests.length - SHOW_GUESTS}` : `+${details.guests.length - SHOW_GUESTS} more`)}</Text>
              </TouchableOpacity>
            ) : null}
          </View>
        </View>
      ) : null}
      {details.description ? (
        <TouchableOpacity style={styles.row} onPress={() => setFullText((v) => !v)} activeOpacity={0.8}>
          <Text style={styles.icon}>📝</Text>
          <Text style={[styles.label, { flex: 1 }]} numberOfLines={fullText ? undefined : 4}>{details.description}</Text>
        </TouchableOpacity>
      ) : null}
      {details.attachments.map((f) => row('📎', f.title, () => open(f.url), hostOf(f.url)))}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { marginTop: 8, borderRadius: 16, backgroundColor: surf(BRAND.white), borderWidth: 1, borderColor: BRAND.line, padding: 12, gap: 8 },
  head: { fontFamily: FONTS.bodyHeavy, fontSize: 13, color: BRAND.goldInk },
  row: { flexDirection: 'row', gap: 10, alignItems: 'flex-start' },
  icon: { fontSize: 16, width: 24, textAlign: 'center' },
  label: { fontFamily: FONTS.bodyBold, fontSize: 13, color: BRAND.warmInk },
  link: { fontFamily: FONTS.bodyHeavy, fontSize: 13, color: BRAND.danger },
  sub: { fontFamily: FONTS.body, fontSize: 12, color: BRAND.inkFaint },
});
