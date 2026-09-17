/**
 * LumiCharacter — the illustrated Lumi avatar (ported from the
 * `lumi avsha/lumi_app.html` prototype SVG) with animation states:
 *   idle      — periodic blink
 *   talking   — gentle bob + mouth open/close (auto-driven by SpeechService)
 *   wave      — hand wave (greeting)
 *   celebrate — quick scale pop
 * Theme: the app's purple (#6C63FF) shirt + gold hair. RN Animated for
 * bob/wave/pop; blink + mouth are timer-driven re-renders (SVG swaps).
 *
 * Dependencies: react-native-svg, SpeechService.subscribeSpeaking (when
 * autoTalk). Consumed via the LumiOrb shim (TodaySchedule) and directly.
 */
import React, { useEffect, useRef, useState } from 'react';
import { Animated, Easing, ViewStyle } from 'react-native';
import Svg, {
  Circle,
  Defs,
  Ellipse,
  G,
  LinearGradient,
  Path,
  Rect,
  Stop,
} from 'react-native-svg';
import { useReduceMotion } from '../hooks/useReduceMotion';
import { subscribeSpeaking } from '../services/SpeechService';

export type LumiState = 'idle' | 'talking' | 'wave' | 'celebrate';

export interface LumiCharacterProps {
  size?: number;
  /** Explicit state; omit + autoTalk to follow TTS automatically. */
  state?: LumiState;
  /** Follow SpeechService TTS: talking while Lumi speaks (default true). */
  autoTalk?: boolean;
  style?: ViewStyle;
}

const PURPLE = '#6C63FF';
const PURPLE_DARK = '#5850DB';

export default function LumiCharacter({
  size = 160,
  state,
  autoTalk = true,
  style,
}: LumiCharacterProps) {
  const [ttsTalking, setTtsTalking] = useState(false);
  const blink = false;       // was a 3.8 s blink timer
  const mouthOpen = false;   // was a 260 ms toggle while talking

  const reduceMotion = useReduceMotion();
  const effective: LumiState = state ?? (ttsTalking ? 'talking' : 'idle');
  const talking = effective === 'talking';

  // Follow TTS.
  useEffect(() => {
    if (!autoTalk) return;
    return subscribeSpeaking(setTtsTalking);
  }, [autoTalk]);

  // The blink timer, the mouth timer, the bob loop and the wave loop are all
  // gone. They ran forever, next to the task the user was trying to act on,
  // and unrelated ambient motion is the single most-cited barrier in ADHD
  // interface research. Lumi is a still mark now; `blink` and `mouthOpen` stay
  // as constants so the face geometry below is untouched.


  // Bob (talking), pop (celebrate), wave rotation.
  const bobY = useRef(new Animated.Value(0)).current;
  const popScale = useRef(new Animated.Value(1)).current;
  const waveRot = useRef(new Animated.Value(0)).current;


  // The one animation kept: a single pop when a task completes. That is
  // feedback confirming an action worked, not ambient decoration — the
  // research asks for the former and warns against the latter. Skipped
  // entirely when the OS asks for reduced motion.
  useEffect(() => {
    if (effective !== 'celebrate' || reduceMotion) return;
    popScale.setValue(1);
    Animated.sequence([
      Animated.timing(popScale, { toValue: 1.12, duration: 180, easing: Easing.out(Easing.quad), useNativeDriver: true }),
      Animated.timing(popScale, { toValue: 1, duration: 260, easing: Easing.in(Easing.quad), useNativeDriver: true }),
    ]).start();
  }, [effective, popScale, reduceMotion]);


  const waveDeg = waveRot.interpolate({ inputRange: [-1, 1], outputRange: ['-18deg', '18deg'] });

  return (
    <Animated.View
      style={[
        { width: size, height: size * (640 / 600), transform: [{ translateY: bobY }, { scale: popScale }] },
        style,
      ]}
    >
      <Svg width="100%" height="100%" viewBox="0 0 600 640">
        <Defs>
          <LinearGradient id="lumiHair" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0%" stopColor="#F7DE8B" />
            <Stop offset="100%" stopColor="#EEC65A" />
          </LinearGradient>
          <LinearGradient id="lumiHairShade" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0%" stopColor="#EEC65A" />
            <Stop offset="100%" stopColor="#E0B142" />
          </LinearGradient>
          <LinearGradient id="lumiSkin" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0%" stopColor="#FBD9BE" />
            <Stop offset="100%" stopColor="#F6C9A6" />
          </LinearGradient>
          <LinearGradient id="lumiShirt" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0%" stopColor={PURPLE} />
            <Stop offset="100%" stopColor={PURPLE_DARK} />
          </LinearGradient>
        </Defs>

        {/* shirt (app purple) + collar */}
        <Path d="M150 640 Q150 500 300 500 Q450 500 450 640 Z" fill="url(#lumiShirt)" />
        <Path d="M262 505 Q300 540 338 505 L322 500 Q300 522 278 500 Z" fill={PURPLE_DARK} />
        {/* neck */}
        <Path d="M262 430 Q262 490 300 500 Q338 490 338 430 Z" fill="url(#lumiSkin)" />
        {/* back hair */}
        <Path d="M150 300 Q150 120 300 118 Q450 120 450 300 Q470 470 405 500 Q430 330 390 250 L210 250 Q170 330 195 500 Q130 470 150 300 Z" fill="url(#lumiHairShade)" />
        {/* face + ears + cheeks */}
        <Ellipse cx="300" cy="300" rx="120" ry="140" fill="url(#lumiSkin)" />
        <Ellipse cx="182" cy="305" rx="20" ry="28" fill="url(#lumiSkin)" />
        <Ellipse cx="418" cy="305" rx="20" ry="28" fill="url(#lumiSkin)" />
        <Ellipse cx="232" cy="330" rx="30" ry="18" fill="#F7A9BE" opacity={0.55} />
        <Ellipse cx="368" cy="330" rx="30" ry="18" fill="#F7A9BE" opacity={0.55} />
        {/* front hair */}
        <Path d="M181 300 Q160 140 300 128 Q440 140 419 300 Q430 220 400 195 Q360 150 300 152 Q240 150 200 195 Q170 220 181 300 Z" fill="url(#lumiHair)" />
        <Path d="M300 128 Q210 132 196 250 Q250 175 300 178 Q300 150 300 128 Z" fill="url(#lumiHair)" />
        <Path d="M300 128 Q390 132 404 250 Q350 175 300 178 Q300 150 300 128 Z" fill="url(#lumiHairShade)" />
        <Path d="M188 235 Q168 360 205 470 Q185 340 210 250 Z" fill="url(#lumiHair)" />
        <Path d="M412 235 Q432 360 395 470 Q415 340 390 250 Z" fill="url(#lumiHairShade)" />
        {/* brows */}
        <Path d="M228 258 Q252 246 278 256" stroke="#D9A94A" strokeWidth={7} fill="none" strokeLinecap="round" />
        <Path d="M322 256 Q348 246 372 258" stroke="#D9A94A" strokeWidth={7} fill="none" strokeLinecap="round" />
        {/* eyes */}
        <Ellipse cx="253" cy="292" rx="27" ry="22" fill="#FFFFFF" />
        <Ellipse cx="347" cy="292" rx="27" ry="22" fill="#FFFFFF" />
        <Circle cx="256" cy="293" r="15" fill="#4FA96B" />
        <Circle cx="344" cy="293" r="15" fill="#4FA96B" />
        <Circle cx="256" cy="293" r="12" fill="#3E8F57" />
        <Circle cx="344" cy="293" r="12" fill="#3E8F57" />
        <Circle cx="256" cy="293" r="6.5" fill="#22331F" />
        <Circle cx="344" cy="293" r="6.5" fill="#22331F" />
        <Circle cx="261" cy="287" r="4" fill="#FFFFFF" />
        <Circle cx="349" cy="287" r="4" fill="#FFFFFF" />
        {/* eyelids (blink) */}
        {blink && (
          <>
            <Ellipse cx="253" cy="292" rx="28" ry="23" fill="url(#lumiSkin)" />
            <Ellipse cx="347" cy="292" rx="28" ry="23" fill="url(#lumiSkin)" />
          </>
        )}
        {/* glasses */}
        <G fill="none" stroke="#3A4A52" strokeWidth={6}>
          <Path d="M216 296 Q214 268 250 266 Q292 266 288 292 Q288 316 250 318 Q220 318 216 296 Z" />
          <Path d="M384 296 Q386 268 350 266 Q308 266 312 292 Q312 316 350 318 Q380 318 384 296 Z" />
          <Path d="M288 288 Q300 282 312 288" />
          <Path d="M216 286 L186 292" />
          <Path d="M384 286 L414 292" />
        </G>
        {/* nose */}
        <Path d="M296 306 Q290 330 302 336 Q312 332 306 306" fill="none" stroke="#E3A985" strokeWidth={4} strokeLinecap="round" />
        {/* freckles */}
        <G fill="#D79A6E" opacity={0.8}>
          <Circle cx="228" cy="322" r="3" />
          <Circle cx="242" cy="332" r="2.6" />
          <Circle cx="254" cy="326" r="2.4" />
          <Circle cx="372" cy="322" r="3" />
          <Circle cx="358" cy="332" r="2.6" />
          <Circle cx="346" cy="326" r="2.4" />
          <Circle cx="292" cy="330" r="2.2" />
          <Circle cx="308" cy="330" r="2.2" />
        </G>
        {/* mouth: open (talking) alternates with smile */}
        {talking && mouthOpen ? (
          <Ellipse cx="300" cy="366" rx="30" ry="22" fill="#7A2E37" />
        ) : (
          <>
            <Path d="M256 356 Q300 402 344 356 Q322 372 300 372 Q278 372 256 356 Z" fill="#7A2E37" />
            <Path d="M266 360 Q300 384 334 360 Q300 372 266 360 Z" fill="#FFFFFF" />
          </>
        )}
        {/* sparkles (gold) */}
        <G fill="#FFC24B">
          <Path d="M470 150 l6 16 16 6 -16 6 -6 16 -6 -16 -16 -6 16 -6 Z" />
          <Path d="M120 420 l4 11 11 4 -11 4 -4 11 -4 -11 -11 -4 11 -4 Z" />
        </G>
      </Svg>

      {/* wave hand — its own layer so RN Animated can rotate it */}
      {effective === 'wave' && (
        <Animated.View
          style={{
            position: 'absolute',
            right: -size * 0.02,
            bottom: size * 0.12,
            width: size * 0.22,
            height: size * 0.28,
            transform: [{ rotate: waveDeg }],
          }}
        >
          <Svg width="100%" height="100%" viewBox="420 415 80 95">
            <Ellipse cx="452" cy="470" rx="26" ry="34" fill="#F9D2B2" />
            <Rect x="438" y="430" width="10" height="34" rx="5" fill="#F9D2B2" />
            <Rect x="450" y="424" width="10" height="40" rx="5" fill="#F9D2B2" />
            <Rect x="462" y="430" width="10" height="34" rx="5" fill="#F9D2B2" />
          </Svg>
        </Animated.View>
      )}
    </Animated.View>
  );
}
