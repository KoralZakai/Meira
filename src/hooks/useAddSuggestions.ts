/**
 * useAddSuggestions — the rows under an empty Add input.
 *
 * Two passes, so the list is never held up by the slow source: the local ones
 * (storage — instant) rank and show first; the errand-on-your-way question (a
 * server round trip, remembered for three hours) re-ranks when it answers.
 *
 * Every source that could not be read is warned with its reason and
 * contributes no row (utils/addSuggestions). `allFailed` lets the screen say
 * "I couldn't look" instead of an empty list that reads as "nothing to suggest".
 *
 * Trigger (rule 7): the screen opening — the one moment the list is on screen.
 */
import { useEffect, useState } from 'react';
import { loadLocalSources, loadWaySource } from '../services/AddSuggestionSources';
import { rankSuggestions, type Suggestion, type SuggestionResult } from '../utils/addSuggestions';
import { getTodayString } from '../utils/timeUtils';

export interface SuggestionsView {
  loading: boolean;
  rows: Suggestion[];
  /** Every source failed — an empty list here is NOT "nothing to suggest". */
  allFailed: boolean;
}

const failedCount = (r: SuggestionResult): number => new Set(r.skipped.map((s) => s.source)).size;

export function useAddSuggestions(target: string | undefined): SuggestionsView {
  const [view, setView] = useState<SuggestionsView>({ loading: true, rows: [], allFailed: false });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const local = await loadLocalSources(target || getTodayString());
        if (cancelled) return;
        const first = rankSuggestions(local.input);
        for (const s of first.skipped) console.warn(`[AddSuggestions] ${s.source} contributes nothing: ${s.reason}`);
        // Three local sources (tomorrow, gaps, open); the fourth is still on its way.
        setView({ loading: false, rows: first.rows, allFailed: first.rows.length === 0 && failedCount(first) >= 3 });

        // The errand source speaks to the server; show what we have meanwhile.
        const way = await loadWaySource(local.tasks);
        if (cancelled) return;
        if (!way.ok) console.warn(`[AddSuggestions] way contributes nothing: ${way.reason}`);
        const second = rankSuggestions({ ...local.input, way });
        if (!second.rows.length) {
          // "Nothing to suggest" with 5 tasks open (17.10) — say what each source saw.
          const n = (r: any) => (r?.ok ? (Array.isArray(r.data) ? r.data.length : 'ok') : `failed: ${r?.reason}`);
          console.warn('[AddSuggestions] empty list —', JSON.stringify({
            open: n(local.input.open), gaps: n(local.input.gaps), tomorrow: n(local.input.tomorrow), way: n(way),
            gapSpans: (local.input.gaps as any)?.ok ? (local.input.gaps as any).data.map((g: any) => `${g.start}-${g.end}`) : [],
            now: local.input.now,
          }));
        }
        setView({ loading: false, rows: second.rows, allFailed: second.rows.length === 0 && failedCount(second) >= 4 });
      } catch (e) {
        console.warn('[AddSuggestions] could not build the list', e);
        if (!cancelled) setView({ loading: false, rows: [], allFailed: true });
      }
    })();
    return () => { cancelled = true; };
  }, [target]);

  return view;
}
