/**
 * AiAssistants — the Menu's "AI assistants" section: connect Claude, ChatGPT or
 * Cursor to Meira over MCP (server/mcp_server.py).
 *
 * One tap makes a personal token and shows it ONCE, with the exact line to
 * paste into the assistant. The server keeps only a hash, so "show it again"
 * is not a thing — make a new one. Every token can be revoked here, and the
 * row always says how many are live and when one was last used, because a
 * key to her day that she cannot see is not one she can trust (rule 3).
 */
import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Alert, ActivityIndicator, Share } from 'react-native';

import { BRAND, FONTS } from '../constants/theme';
import {
  createMcpToken, listMcpTokens, revokeMcpTokens, type McpToken, type McpTokenInfo,
} from '../services/LumiServer';

function ago(ts?: number | null): string {
  if (!ts) return 'never used';
  const d = new Date(ts * 1000);
  const same = d.toDateString() === new Date().toDateString();
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return `used ${same ? hm : `${d.getDate()}.${d.getMonth() + 1} ${hm}`}`;
}

export function connectInstructions(t: McpToken): string {
  return [
    'Meira — connect your AI assistant',
    '',
    `Server (MCP, Streamable HTTP): ${t.url}`,
    `Header: Authorization: Bearer ${t.token}`,
    '',
    'Claude Code:',
    `claude mcp add --transport http meira ${t.url} --header "Authorization: Bearer ${t.token}"`,
    '',
    'Claude Desktop / Cursor (config JSON):',
    JSON.stringify({ mcpServers: { meira: { command: 'npx', args: ['-y', 'mcp-remote', t.url, '--header', `Authorization: Bearer ${t.token}`] } } }, null, 2),
    '',
    'Keep it private: it can read and change your day. Revoke it in Meira → Menu → AI assistants.',
  ].join('\n');
}

export default function AiAssistants() {
  const [tokens, setTokens] = useState<McpTokenInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fresh, setFresh] = useState<McpToken | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const r = await listMcpTokens();
    if (r.ok) { setTokens(r.data.tokens); setError(null); } else { setTokens(null); setError(r.reason); }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const connect = async () => {
    setBusy(true);
    const r = await createMcpToken('AI assistant');
    setBusy(false);
    if (!r.ok) { Alert.alert('AI assistants', r.reason); return; }
    setFresh(r.data);
    refresh();
  };

  const revokeAll = () => {
    Alert.alert('Disconnect every assistant?', 'Claude, ChatGPT or anything else using a Meira token loses access now.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Disconnect', style: 'destructive', onPress: async () => {
          const r = await revokeMcpTokens();
          if (!r.ok) Alert.alert('AI assistants', r.reason);
          else Alert.alert('AI assistants', `${r.data.revoked} token(s) revoked.`);
          setFresh(null);
          refresh();
        },
      },
    ]);
  };

  const live = tokens?.length ?? 0;
  const lastUsed = tokens?.reduce((m, t) => Math.max(m, t.last_used || 0), 0) || 0;
  const status = error
    ? error
    : tokens === null
      ? 'Checking…'
      : live
        ? `${live} connected · ${ago(lastUsed)}`
        : 'Let Claude or ChatGPT ask about your day, check if something fits, and add meetings';

  return (
    <View>
      <TouchableOpacity style={styles.row} onPress={connect} disabled={busy} activeOpacity={0.7}>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>🤖 Connect Claude, ChatGPT or Cursor</Text>
          <Text style={[styles.status, error && { color: BRAND.danger }]} numberOfLines={3}>{status}</Text>
        </View>
        {busy ? <ActivityIndicator color={BRAND.sunGold} /> : <Text style={styles.arrow}>›</Text>}
      </TouchableOpacity>

      {fresh && (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Your Meira key — shown once</Text>
          <Text style={styles.label}>Server</Text>
          <Text selectable style={styles.mono}>{fresh.url}</Text>
          <Text style={styles.label}>Key</Text>
          <Text selectable style={styles.mono}>{fresh.token}</Text>
          <Text style={styles.hint}>
            Paste both into your assistant's MCP settings, or share the ready-made setup.
            Anyone with this key can read and change your day.
          </Text>
          <View style={styles.actions}>
            <TouchableOpacity style={styles.primary} onPress={() => Share.share({ message: connectInstructions(fresh) })}>
              <Text style={styles.primaryText}>Share setup</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => setFresh(null)}>
              <Text style={styles.link}>Done</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      {live > 0 && (
        <TouchableOpacity style={styles.row} onPress={revokeAll} activeOpacity={0.7}>
          <Text style={[styles.title, { color: BRAND.danger }]}>Disconnect all assistants</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row', alignItems: 'center', paddingVertical: 12,
    borderBottomWidth: 1, borderBottomColor: BRAND.line,
  },
  title: { fontSize: 14, fontFamily: FONTS.bodySemi, color: BRAND.warmInk },
  status: { fontSize: 12, fontFamily: FONTS.body, color: BRAND.inkSoft, marginTop: 2 },
  arrow: { fontSize: 20, color: BRAND.inkSoft, marginLeft: 8 },
  card: {
    backgroundColor: BRAND.creamCard, borderRadius: 16, padding: 14, marginVertical: 10,
    borderWidth: 1, borderColor: BRAND.line,
  },
  cardTitle: { fontSize: 14, fontFamily: FONTS.bodyBold, color: BRAND.warmInk, marginBottom: 6 },
  label: { fontSize: 11, fontFamily: FONTS.bodySemi, color: BRAND.inkSoft, marginTop: 6 },
  mono: { fontSize: 12, fontFamily: 'monospace', color: BRAND.warmInk, marginTop: 2 },
  hint: { fontSize: 12, fontFamily: FONTS.body, color: BRAND.inkSoft, marginTop: 10 },
  actions: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 12 },
  primary: { backgroundColor: BRAND.sunGold, borderRadius: 12, paddingVertical: 8, paddingHorizontal: 16 },
  primaryText: { fontSize: 13, fontFamily: FONTS.bodyBold, color: BRAND.onGold },
  link: { fontSize: 13, fontFamily: FONTS.bodyBold, color: BRAND.goldInk },
});
