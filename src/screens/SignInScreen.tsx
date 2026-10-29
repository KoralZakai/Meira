/**
 * SignInScreen — Google sign-in gate enabling Supabase cloud sync.
 * Dependencies: SupabaseAuthService.
 */
import React, { useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { BRAND, FONTS, RADIUS, SHADOWS } from '../constants/theme';
import { signInWithGoogle } from '../services/SupabaseAuthService';

interface Props {
  /** Called when the user chooses to skip auth and use the app locally. */
  onContinueOffline: () => void;
}

// Minimal sign-in gate. A successful login is picked up by the auth listener in
// App.tsx (onAuthChange), which then renders the main app in cloud mode.
export default function SignInScreen({ onContinueOffline }: Props) {
  const [loading, setLoading] = useState(false);

  const handleSignIn = async () => {
    try {
      setLoading(true);
      const session = await signInWithGoogle();
      if (!session) {
        // User dismissed the browser — stay on this screen.
        setLoading(false);
      }
      // On success, onAuthChange in App.tsx swaps to the main app.
    } catch (err) {
      setLoading(false);
      Alert.alert('Sign-in failed', err instanceof Error ? err.message : 'Please try again.');
    }
  };

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.content}>
        <View style={styles.avatar}>
          <Text style={styles.avatarEmoji}>💛</Text>
        </View>
        <Text style={styles.title}>Meira</Text>
        <Text style={styles.subtitle}>Sign in to sync your day across devices</Text>

        <Pressable
          style={({ pressed }) => [styles.googleBtn, pressed && styles.pressed]}
          onPress={handleSignIn}
          disabled={loading}
        >
          {loading ? (
            <ActivityIndicator color={BRAND.warmInk} />
          ) : (
            <Text style={styles.googleText}>Sign in with Google</Text>
          )}
        </Pressable>

        <Pressable onPress={onContinueOffline} disabled={loading} hitSlop={12}>
          <Text style={styles.offlineLink}>Continue offline</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: BRAND.cream },
  content: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32 },
  avatar: {
    width: 96,
    height: 96,
    borderRadius: 48,
    backgroundColor: BRAND.sunGold,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 20,
  },
  avatarEmoji: { fontSize: 44 },
  title: { fontSize: 34, fontFamily: FONTS.bodyHeavy, color: BRAND.warmInk, marginBottom: 8 },
  subtitle: {
    fontSize: 15,
    color: BRAND.inkSoft,
    textAlign: 'center',
    marginBottom: 40,
  },
  googleBtn: {
    backgroundColor: BRAND.sunGold,
    borderRadius: RADIUS.card,
    paddingVertical: 16,
    paddingHorizontal: 32,
    width: '100%',
    alignItems: 'center',
    shadowColor: SHADOWS.card.shadowColor,
    shadowOpacity: 0.08,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
    elevation: 2,
  },
  pressed: { opacity: 0.85 },
  googleText: { fontSize: 17, fontFamily: FONTS.bodyBold, color: BRAND.warmInk },
  offlineLink: {
    marginTop: 22,
    fontSize: 14,
    color: BRAND.inkSoft,
    textDecorationLine: 'underline',
  },
});
