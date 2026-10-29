/**
 * useAddUnderstand — Meira's conclusions for what is being typed.
 *
 * The chips are free and instant (utils/liveParse). THIS is the one step that
 * costs: after she stops typing for 1.5 s, and only when the sense of the
 * sentence moved (utils/addConclusions.shouldAsk), ONE server call asks what
 * follows from it — a greeting for a birthday, a gift reminder, the prep an
 * interview gets. At most twice per add flow, never again once the server has
 * said today's allowance is used up.
 *
 * Trigger (rule 7): the typing pause itself. Cancelled on unmount and when a
 * newer answer overtakes an older one — a slow reply for a sentence she has
 * since changed must not land on the new one.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ASK_PAUSE_MS, freshAskState, shouldAsk, type AskState, type Conclusion, type UnderstandResult,
} from '../utils/addConclusions';
import { parseSignature, type LiveParse } from '../utils/liveParse';
import { addUnderstand, type UnderstandPayload } from '../services/AddUnderstandService';

export interface UnderstandView {
  status: 'idle' | 'thinking' | 'ok' | 'failed';
  reason?: UnderstandResult['reason'];
  conclusions: Conclusion[];
  greeting?: { to: string; text_he: string; text_en: string };
  /** The sense of the sentence these were computed for. */
  forSignature?: string;
}

interface Args {
  text: string;
  parse: LiveParse;
  he: boolean;
  /** What will actually be saved: the pickers and the date, not just the words. */
  effective: { time?: string; endTime?: string; date?: string };
  /** The person's contact has a phone number on this device (the number itself never goes up). */
  personHasPhone: boolean;
  tomorrow: Array<{ text: string; time?: string; place?: string }>;
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const pad = (n: number) => String(n).padStart(2, '0');

export function useAddUnderstand(args: Args): UnderstandView {
  const { text, parse } = args;
  const [view, setView] = useState<UnderstandView>({ status: 'idle', conclusions: [] });
  const ask = useRef<AskState>(freshAskState());
  const ticket = useRef(0);
  const latest = useRef(args);
  latest.current = args;
  const signature = useMemo(() => parseSignature(parse), [parse]);

  useEffect(() => {
    const timer = setTimeout(async () => {
      const a = latest.current;
      const gate = shouldAsk(a.text, a.parse, ask.current);
      if (!gate.ask) return;
      const sig = parseSignature(a.parse);
      ask.current = { ...ask.current, calls: ask.current.calls + 1, lastText: a.text.trim(), lastSignature: sig };
      const mine = ++ticket.current;
      setView((v) => ({ ...v, status: 'thinking' }));

      const d = new Date();
      const payload: UnderstandPayload = {
        text: a.text.trim(),
        lang: a.he ? 'he' : 'en',
        parsed: {
          category: a.parse.category,
          ...(a.effective.time ? { time: a.effective.time } : {}),
          ...(a.effective.endTime ? { endTime: a.effective.endTime } : {}),
          ...(a.effective.date ? { date: a.effective.date } : {}),
          ...(a.parse.person ? {
            person: {
              label: a.parse.person.label,
              ...(a.parse.person.relation ? { relation: a.parse.person.relation } : {}),
              hasPhone: a.personHasPhone,
            },
          } : {}),
          ...(a.parse.place ? { place: a.parse.place.text } : {}),
          ...(a.parse.occasion ? { occasion: a.parse.occasion } : {}),
        },
        context: {
          now: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())} (${WEEKDAYS[d.getDay()]})`,
          tomorrow: a.tomorrow.slice(0, 8),
        },
      };
      const res = await addUnderstand(payload);
      if (mine !== ticket.current) return;                       // a newer question overtook this one
      if (!res.ok) {
        if (res.reason === 'ai_limit') ask.current = { ...ask.current, blocked: 'ai_limit' };
        setView({ status: 'failed', reason: res.reason, conclusions: [] });
        return;
      }
      setView({ status: 'ok', conclusions: res.conclusions ?? [], greeting: res.greeting, forSignature: sig });
    }, ASK_PAUSE_MS);
    return () => clearTimeout(timer);
  }, [text, signature]);

  // Gone with the screen: an answer arriving later has nowhere to land.
  useEffect(() => () => { ticket.current += 1; }, []);

  // Conclusions belong to the sentence they were drawn from. Once its sense has
  // moved they would describe something she no longer wrote.
  if (view.status === 'ok' && view.forSignature !== signature) {
    return { status: 'idle', conclusions: [] };
  }
  return view;
}
