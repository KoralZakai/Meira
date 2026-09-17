/**
 * CrashCatcher — the app had no error boundary, so ONE bad render anywhere
 * took the whole thing down with nothing on screen and nothing to report. That
 * is why "pressing on a task crashes" could not be diagnosed: no message, no
 * stack, no way back except killing the app.
 *
 * It does three things, in order of what the user needs:
 *   1. keeps the app alive — "try again" re-mounts the tree, so a crash in one
 *      screen is a bump, not the end of the session;
 *   2. shows WHAT broke, in plain text, with the component that threw;
 *   3. keeps the last crash in AsyncStorage, so the message is still there
 *      after a restart and can be read from the Settings screen.
 *
 * It cannot catch native crashes (a map view, a missing native module) — those
 * never reach JS. If the screen simply vanishes with no card, that is the tell.
 */
import React from 'react';
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { BRAND, FONTS, RADIUS } from '../constants/theme';

export const LAST_CRASH_KEY = 'lumi.lastCrash.v1';

export interface StoredCrash {
  message: string;
  stack?: string;
  componentStack?: string;
  at: number;
}

/** The last crash this app recorded, or null. Read by the Settings screen. */
export async function getLastCrash(): Promise<StoredCrash | null> {
  try {
    const raw = await AsyncStorage.getItem(LAST_CRASH_KEY);
    return raw ? (JSON.parse(raw) as StoredCrash) : null;
  } catch {
    return null;
  }
}

export async function clearLastCrash(): Promise<void> {
  await AsyncStorage.removeItem(LAST_CRASH_KEY).catch(() => {});
}

interface Props {
  children: React.ReactNode;
  language?: 'en' | 'he';
}

interface State {
  error: Error | null;
  componentStack?: string;
}

export default class CrashCatcher extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string }) {
    // Console first: on a dev build this is the fastest read.
    console.error('[CrashCatcher]', error?.message, info?.componentStack);
    this.setState({ componentStack: info?.componentStack });
    AsyncStorage.setItem(
      LAST_CRASH_KEY,
      JSON.stringify({
        message: String(error?.message ?? error),
        stack: error?.stack?.slice(0, 2000),
        componentStack: info?.componentStack?.slice(0, 2000),
        at: Date.now(),
      } as StoredCrash),
    ).catch(() => {});
  }

  render() {
    const { error, componentStack } = this.state;
    if (!error) return this.props.children as React.ReactElement;
    const he = this.props.language === 'he';

    return (
      <View style={styles.root}>
        <ScrollView contentContainerStyle={styles.content}>
          <Text style={styles.title}>{he ? 'משהו נשבר 😕' : 'Something broke 😕'}</Text>
          <Text style={styles.sub}>
            {he
              ? 'האפליקציה לא נסגרה. זה מה שקרה — שלחי לי את השורה הזאת:'
              : "The app didn't close. Here's what happened — send me this line:"}
          </Text>

          <View style={styles.box}>
            <Text selectable style={styles.msg}>{String(error.message ?? error)}</Text>
          </View>

          {componentStack ? (
            <View style={styles.box}>
              <Text selectable style={styles.stack}>
                {componentStack.trim().split('\n').slice(0, 8).join('\n')}
              </Text>
            </View>
          ) : null}

          <TouchableOpacity
            style={styles.btn}
            onPress={() => this.setState({ error: null, componentStack: undefined })}
            activeOpacity={0.85}
          >
            <Text style={styles.btnText}>{he ? 'לנסות שוב' : 'Try again'}</Text>
          </TouchableOpacity>
        </ScrollView>
      </View>
    );
  }
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: BRAND.cream },
  content: { padding: 24, paddingTop: 80, gap: 14 },
  title: { fontFamily: FONTS.display, fontSize: 26, color: BRAND.warmInk },
  sub: { fontFamily: FONTS.body, fontSize: 14, color: BRAND.inkSoft, lineHeight: 20 },
  box: {
    backgroundColor: BRAND.creamCard, borderRadius: RADIUS.card,
    borderWidth: 1, borderColor: BRAND.line, padding: 12,
  },
  msg: { fontFamily: FONTS.bodyHeavy, fontSize: 13, color: '#EF476F', lineHeight: 19 },
  stack: { fontFamily: FONTS.body, fontSize: 11, color: BRAND.inkSoft, lineHeight: 16 },
  btn: {
    backgroundColor: BRAND.sunGold, borderRadius: RADIUS.button,
    paddingVertical: 14, alignItems: 'center', marginTop: 4,
  },
  btnText: { fontFamily: FONTS.bodyHeavy, fontSize: 15, color: '#4A3512' },
});
