/**
 * BottomSheet — the one sheet every new surface uses (date picker, add task,
 * menu, chat, voice). Design handoff: cream scrim rgba(252,247,236,.82), the
 * sheet springs up (cubic-bezier(.34,1.3,.64,1) ≈ a light overshoot spring),
 * radius 28 on top, a 40×5 handle.
 */
import React, { useEffect, useRef } from 'react';
import { Animated, Dimensions, KeyboardAvoidingView, Modal, Platform, Pressable, StyleSheet, View, ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BRAND } from '../../constants/theme';

interface Props {
  visible: boolean;
  onClose: () => void;
  children: React.ReactNode;
  /** Height as a share of the screen (760/844 ≈ 0.9). Omit to fit content. */
  heightRatio?: number;
  background?: string;
  style?: ViewStyle;
}

export default function BottomSheet({ visible, onClose, children, heightRatio, background = BRAND.creamCard, style }: Props) {
  const insets = useSafeAreaInsets();
  const rise = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!visible) { rise.setValue(0); return; }
    Animated.spring(rise, { toValue: 1, useNativeDriver: true, friction: 8, tension: 70 }).start();
  }, [visible, rise]);
  const screenH = Dimensions.get('window').height;
  // Room under the last button. The Modal draws edge-to-edge, under Android's
  // navigation bar, and inside a Modal the inset can come back as 0 — so the
  // "Later" button sat under the gesture bar, cut (17.10, on her phone). A
  // measured inset gets breathing room on top; an unmeasured one on Android
  // gets a floor that clears both the gesture bar and 3-button navigation.
  const bottomRoom = insets.bottom > 0 ? insets.bottom + 12 : (Platform.OS === 'android' ? 48 : 16);
  const translateY = rise.interpolate({ inputRange: [0, 1], outputRange: [screenH * 0.6, 0] });
  return (
    <Modal visible={visible} transparent animationType="none" onRequestClose={onClose} statusBarTranslucent>
      <KeyboardAvoidingView style={styles.fill} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <Pressable style={styles.scrim} onPress={onClose} accessibilityLabel="Close" />
        <Animated.View
          style={[
            styles.sheet,
            { backgroundColor: background, paddingBottom: bottomRoom, transform: [{ translateY }] },
            heightRatio ? { height: screenH * heightRatio } : null,
            style,
          ]}
        >
          <View style={styles.handle} />
          {children}
        </Animated.View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, justifyContent: 'flex-end' },
  scrim: { ...StyleSheet.absoluteFill, backgroundColor: 'rgba(252,247,236,0.82)' },
  sheet: {
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    paddingTop: 12,
    shadowColor: '#D6A537',
    shadowOpacity: 0.18,
    shadowRadius: 30,
    shadowOffset: { width: 0, height: -10 },
    elevation: 16,
    overflow: 'hidden',
  },
  handle: { alignSelf: 'center', width: 40, height: 5, borderRadius: 3, backgroundColor: BRAND.line, marginBottom: 8 },
});
