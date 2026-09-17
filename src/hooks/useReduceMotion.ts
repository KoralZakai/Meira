/**
 * useReduceMotion — whether the OS "reduce motion" setting is on.
 *
 * Nothing in the app checked this: a user who had explicitly asked their phone
 * to stop animating still got every loop, bob and pulse. Android exposes it
 * through AccessibilityInfo like iOS does, and it is the one accessibility
 * setting that matters most here — ambient motion beside a task is the most
 * consistently cited barrier in ADHD interface research.
 *
 * Returns false until the first read resolves, so the default is the normal
 * (animated) path rather than a flash of changed layout.
 *
 * Dependencies: react-native AccessibilityInfo.
 */
import { useEffect, useState } from 'react';
import { AccessibilityInfo } from 'react-native';

export function useReduceMotion(): boolean {
  const [reduce, setReduce] = useState(false);

  useEffect(() => {
    let mounted = true;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((v) => { if (mounted) setReduce(v); })
      .catch(() => {});
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduce);
    return () => {
      mounted = false;
      sub?.remove?.();
    };
  }, []);

  return reduce;
}
