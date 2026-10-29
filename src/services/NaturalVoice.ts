/**
 * NaturalVoice — Meira speaks in her own voice (8.10, Koral: the first meeting
 * "MUST sound native").
 *
 * The phone's engine (expo-speech) reads Hebrew like a timetable. This plays a
 * clip from the server (Google Chirp 3 HD, LumiServer.voiceClip) and resolves
 * when she has FINISHED speaking — the first meeting opens the mic only then,
 * or it records her own question. When the clip cannot be had (TTS off on the
 * Google project, offline, signed out) it says why in the log and falls back
 * to the phone's voice: a robotic question beats a silent one.
 */
import { AudioPlayer, createAudioPlayer } from 'expo-audio';
import { AppLanguage } from '../types/index';
import { voiceClip } from './LumiServer';
import { speakDevice as deviceSpeak, stopDeviceSpeech as stopDevice } from './SpeechService';

let current: { player: AudioPlayer; done: () => void } | null = null;
/** Longest a line may take before we stop waiting for "finished". */
const MAX_LINE_MS = 30_000;

export function stopNatural(): void {
  if (current) {
    const c = current;
    current = null;
    try { c.player.pause(); c.player.remove(); } catch (e) { console.warn('[NaturalVoice] stop failed', e); }
    c.done();
  }
  stopDevice();
}

/** Say one short line; resolves when it has been said. 'device' = the fallback voice. */
export async function sayNatural(text: string, language: AppLanguage): Promise<'natural' | 'device'> {
  stopNatural();
  const clip = await voiceClip(text, language);
  if (!clip.ok) {
    console.warn('[NaturalVoice] phone voice instead:', clip.reason);
    // speakDevice resolves when the phone has FINISHED (onDone) — no extra
    // wait on top, which only added a dead pause after every fallback line.
    await deviceSpeak(text, language);
    return 'device';
  }
  return new Promise((resolve) => {
    let settled = false;
    const player = createAudioPlayer({ uri: clip.data.url, headers: clip.data.headers });
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sub.remove();
      try { player.remove(); } catch { /* already released by stopNatural */ }
      if (current?.player === player) current = null;
      resolve('natural');
    };
    const sub = player.addListener('playbackStatusUpdate', (st) => {
      if (st.didJustFinish) finish();
    });
    const timer = setTimeout(() => {
      console.warn('[NaturalVoice] no "finished" after', MAX_LINE_MS, 'ms — moving on');
      finish();
    }, MAX_LINE_MS);
    current = { player, done: finish };
    player.play();
  });
}
