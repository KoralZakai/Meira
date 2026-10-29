/** MapPinConfirm — map pin picker to confirm a task's location candidate. */
import React from 'react';
import { Modal, Pressable, SafeAreaView, StyleSheet, Text, View } from 'react-native';
import { BRAND, FONTS, RADIUS } from '../constants/theme';

interface LocationOption {
  id: string;
  displayName: string;
  address: string;
  lat: number;
  lng: number;
}

interface Props {
  visible: boolean;
  title: string;
  options: LocationOption[];
  onSelect: (option: LocationOption) => void;
  onCancel: () => void;
}

export function MapPinConfirm({ visible, title, options, onSelect, onCancel }: Props) {
  return (
    <Modal visible={visible} transparent animationType="slide">
      <SafeAreaView style={styles.container}>
        <View style={styles.header}>
          <Pressable onPress={onCancel} style={styles.closeButton}>
            <Text style={styles.closeText}>×</Text>
          </Pressable>
          <Text style={styles.title}>{title}</Text>
          <View style={styles.closeButtonPlaceholder} />
        </View>

        <View style={styles.optionsList}>
          {options.map(option => (
            <Pressable
              key={option.id}
              onPress={() => {
                onSelect(option);
                onCancel();
              }}
              style={({ pressed }) => [styles.optionButton, pressed && styles.optionButtonPressed]}
            >
              <View style={styles.optionIcon}>
                <Text style={styles.pinIcon}>📍</Text>
              </View>
              <View style={styles.optionText}>
                <Text style={styles.optionName} numberOfLines={1}>
                  {option.displayName}
                </Text>
                <Text style={styles.optionAddress} numberOfLines={1}>
                  {option.address}
                </Text>
              </View>
            </Pressable>
          ))}
        </View>

        <Pressable
          onPress={onCancel}
          style={({ pressed }) => [styles.cancelButton, pressed && styles.cancelButtonPressed]}
        >
          <Text style={styles.cancelText}>Cancel</Text>
        </Pressable>
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: BRAND.cream,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: BRAND.line,
  },
  title: {
    fontSize: 16,
    fontFamily: FONTS.bodyBold,
    color: BRAND.warmInk,
    flex: 1,
    textAlign: 'center',
  },
  closeButton: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  closeText: {
    fontSize: 26,
    color: BRAND.warmInk,
    fontFamily: FONTS.bodySemi,
  },
  closeButtonPlaceholder: {
    width: 36,
  },
  optionsList: {
    flex: 1,
    paddingHorizontal: 16,
    paddingTop: 12,
  },
  optionButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 12,
    marginBottom: 10,
    backgroundColor: BRAND.creamCard,
    borderRadius: RADIUS.chip,
    gap: 12,
  },
  optionButtonPressed: {
    opacity: 0.7,
  },
  optionIcon: {
    width: 40,
    height: 40,
    borderRadius: RADIUS.card,
    backgroundColor: BRAND.sunGold,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pinIcon: {
    fontSize: 20,
  },
  optionText: {
    flex: 1,
  },
  optionName: {
    fontSize: 14,
    fontFamily: FONTS.bodySemi,
    color: BRAND.warmInk,
  },
  optionAddress: {
    fontSize: 12,
    color: BRAND.inkSoft,
    marginTop: 2,
  },
  cancelButton: {
    marginHorizontal: 16,
    marginBottom: 16,
    paddingVertical: 12,
    borderRadius: RADIUS.chip,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: BRAND.line,
  },
  cancelButtonPressed: {
    opacity: 0.7,
  },
  cancelText: {
    fontSize: 14,
    fontFamily: FONTS.bodySemi,
    color: BRAND.warmInk,
  },
});
