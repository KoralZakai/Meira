import { useEffect, useState } from 'react';

/** Reactive media-query hook. Used to pick the desktop shell vs mobile app. */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(query).matches,
  );
  useEffect(() => {
    const m = window.matchMedia(query);
    const handler = () => setMatches(m.matches);
    handler();
    m.addEventListener('change', handler);
    return () => m.removeEventListener('change', handler);
  }, [query]);
  return matches;
}

export const useIsMobile = () => useMediaQuery('(max-width: 768px)');
