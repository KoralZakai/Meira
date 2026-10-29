/**
 * BellCount — how many things wait in the 🔔, shared by the screens that show a bell.
 *
 * Today computes the list (utils/waitingList — clashes need the whole day);
 * the chat home shows the same number on its own bell (28.10, Koral: "the bell
 * does not appear on the home page"). null = not counted yet — the home bell
 * shows no number rather than a 0 it does not know (rule 1).
 */
import { useEffect, useState } from 'react';

let count: number | null = null;
const listeners = new Set<(n: number | null) => void>();

export function setBellCount(n: number): void {
  if (n === count) return;
  count = n;
  listeners.forEach((fn) => { try { fn(n); } catch (e) { console.warn('[BellCount] listener failed', e); } });
}

export function useBellCount(): number | null {
  const [n, setN] = useState<number | null>(count);
  useEffect(() => {
    listeners.add(setN);
    setN(count);
    return () => { listeners.delete(setN); };
  }, []);
  return n;
}
