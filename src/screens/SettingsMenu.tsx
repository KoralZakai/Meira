/**
 * SettingsMenu — settings hub (language, theme, notifications entry points).
 * Dependencies: TaskStorage (settings persistence).
 */
import React, { useState, useEffect } from 'react';
import { View, ScrollView, StyleSheet, Text, TouchableOpacity, Switch } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BRAND, FONTS } from '../constants/theme';
import { UserProfile } from '../types';
// TaskStorage keeps its OWN profile under a different key, and nothing in the
// app writes to it — reading it here is why every row below said "Not set".
// UserProfileStorage is the store onboarding and the profile screen fill in.
import { loadProfile } from '../services/UserProfileStorage';
import { normalizeProfile } from '../utils/profileShape';

interface SettingsMenuProps {
  navigation: any;
}

export default function SettingsMenu({ navigation }: SettingsMenuProps) {
  const insets = useSafeAreaInsets();
  const bgColor = BRAND.cream;
  const textColor = BRAND.warmInk;

  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [notificationsEnabled, setNotificationsEnabled] = useState(true);

  useEffect(() => {
    loadProfile().then((p) => setProfile(normalizeProfile(p)));
  }, []);

  return (
    <View style={[styles.container, { backgroundColor: bgColor, paddingTop: insets.top }]}>
      <View style={styles.headerWithClose}>
        <Text style={[styles.headerTitle, { color: textColor }]}>⚙️ Settings</Text>
        <TouchableOpacity onPress={() => navigation.goBack()}>
          <Text style={styles.closeButton}>✕</Text>
        </TouchableOpacity>
      </View>

      <ScrollView style={styles.scrollView} showsVerticalScrollIndicator={false}>
        <SettingSection title="Profile">
          <SettingItem label="Name" value={profile?.name || 'Not set'} />
          <SettingItem label="Home Address" value={profile?.homeAddress || 'Not set'} />
          <SettingItem label="Transport" value={profile?.transportType || 'Not set'} />
          <SettingButton label="Edit Profile" icon="✏️" onPress={() => navigation.navigate('ProfileEdit')} />
          <SettingButton label="My Agents" icon="🤖" onPress={() => navigation.navigate('Agents')} />
        </SettingSection>

        <SettingSection title="Notifications">
          <SettingToggle
            label="Wake-up Alarms"
            value={notificationsEnabled}
            onChange={setNotificationsEnabled}
          />
          <SettingToggle label="Deadline Reminders" value onChange={() => {}} />
          <SettingToggle label="Achievement Badges" value onChange={() => {}} />
        </SettingSection>

        <SettingSection title="Integrations">
          <SettingButton label="Google Calendar" icon="📅" onPress={() => {}} />
          <SettingButton label="Gmail" icon="📧" onPress={() => {}} />
          <SettingButton label="Contacts" icon="👥" onPress={() => {}} />
        </SettingSection>

        <SettingSection title="About">
          <SettingItem label="Version" value="1.0.0" />
          <SettingButton label="Privacy Policy" onPress={() => {}} />
          <SettingButton label="Terms of Service" onPress={() => {}} />
        </SettingSection>

        <View style={{ height: 40 }} />
      </ScrollView>
    </View>
  );
}

function SettingSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
    </View>
  );
}

function SettingItem({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.settingItem}>
      <Text style={styles.settingLabel}>{label}</Text>
      <Text style={styles.settingValue}>{value}</Text>
    </View>
  );
}

function SettingToggle({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <View style={styles.settingToggle}>
      <Text style={styles.settingLabel}>{label}</Text>
      <Switch
        value={value}
        onValueChange={onChange}
        trackColor={{ false: BRAND.line, true: BRAND.amber }}
        thumbColor={value ? BRAND.sunGold : BRAND.inkSoft}
      />
    </View>
  );
}

function SettingButton({ label, icon, onPress }: { label: string; icon?: string; onPress: () => void }) {
  return (
    <TouchableOpacity style={styles.settingButton} onPress={onPress} activeOpacity={0.7}>
      <Text style={styles.settingLabel}>
        {icon ? `${icon} ` : ''}
        {label}
      </Text>
      <Text style={styles.settingArrow}>›</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  headerWithClose: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingBottom: 16,
  },
  headerTitle: { fontSize: 24, fontFamily: FONTS.bodyBold },
  closeButton: { fontSize: 20, fontFamily: FONTS.bodyBold, color: BRAND.inkSoft },
  scrollView: { flex: 1 },
  section: { paddingHorizontal: 16, marginBottom: 24 },
  sectionTitle: {
    fontSize: 14,
    fontFamily: FONTS.bodyBold,
    color: BRAND.sunGold,
    textTransform: 'uppercase',
    marginBottom: 12,
  },
  settingItem: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: BRAND.line,
  },
  settingLabel: { fontSize: 14, fontFamily: FONTS.bodySemi, color: BRAND.warmInk },
  settingValue: { fontSize: 14, color: BRAND.inkSoft },
  settingToggle: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: BRAND.line,
  },
  settingButton: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: BRAND.line,
  },
  settingArrow: { fontSize: 20, color: BRAND.inkSoft },
});
