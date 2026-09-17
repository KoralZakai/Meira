/**
 * Builds the resolution root the design-sync converter bundles against.
 *
 * Lumi is a React Native app, not a DOM component library, so the converter's
 * esbuild call cannot resolve it as-is: sharedBuildOptions sets no `alias`, no
 * `resolveExtensions` (so Metro's `.web.js` platform resolution never happens)
 * and defines only NODE_ENV. lib/bundle.mjs is explicitly not forkable — it
 * defines the output contract with the app's self-check — so every one of those
 * gaps is closed here instead, through ordinary package resolution:
 *
 *   - `react-native` is a real package whose main re-exports react-native-web
 *   - packages that ship a web build get a main pointing straight at it
 *   - native-only modules get honest passthrough stubs
 *
 * Stubs are behavioural substitutes for wrappers, never for the components
 * being previewed: Swipeable renders its children, SafeAreaProvider renders its
 * children, AsyncStorage keeps a Map. The Lumi component under test is always
 * the real compiled one — see NOTES.md "Native stubs".
 */
import fs from 'node:fs';
import path from 'node:path';

const REPO = process.argv[2];
const OUT = process.argv[3];
const NM = path.join(OUT, 'node_modules');

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(NM, { recursive: true });

const link = (name) => {
  const src = path.join(REPO, 'node_modules', name);
  if (!fs.existsSync(src)) return console.log('  ! missing, skipped:', name);
  const dst = path.join(NM, name);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.symlinkSync(src, dst);
  console.log('  link  ', name);
};

const pkg = (name, mainSrc, { version = '0.0.0-rnw' } = {}) => {
  const dir = path.join(NM, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'),
    JSON.stringify({ name, version, main: 'index.js' }, null, 2));
  fs.writeFileSync(path.join(dir, 'index.js'), mainSrc);
  console.log('  pkg   ', name);
};

// ── Real libraries, used as-is ────────────────────────────────────────────
['react', 'react-dom', 'react-native-web', '@supabase/supabase-js',
 '@babel/runtime', 'invariant', 'warning', 'nullthrows', 'memoize-one',
 'postcss-value-parser', 'styleq', 'inline-style-prefixer', 'fbjs'].forEach(link);

// ── react-native → react-native-web ───────────────────────────────────────
pkg('react-native', `module.exports = require('react-native-web');\n`);

// ── react-native-svg: ships a real web build; point main straight at it so
//    no platform-extension resolution is needed. LumiOrb/LumiCharacter draw
//    with this, so a stub would silently blank them.
const svgWeb = path.join(REPO, 'node_modules/react-native-svg/lib/commonjs/ReactNativeSVG.web.js');
if (fs.existsSync(svgWeb)) {
  link('react-native-svg');
  const dir = path.join(NM, 'react-native-svg-web');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'),
    JSON.stringify({ name: 'react-native-svg-web', version: '0.0.0', main: 'index.js' }, null, 2));
  fs.writeFileSync(path.join(dir, 'index.js'),
    `module.exports = require('react-native-svg/lib/commonjs/ReactNativeSVG.web.js');\n`);
  // shadow the symlink with a package whose main is the web entry
  fs.rmSync(path.join(NM, 'react-native-svg'), { recursive: true, force: true });
  pkg('react-native-svg',
    `module.exports = require(${JSON.stringify(svgWeb)});\n`);
} else {
  pkg('react-native-svg', `module.exports = new Proxy({}, { get: () => () => null });\n`);
}

// ── Passthrough wrappers ──────────────────────────────────────────────────
// These wrap content rather than draw it, so rendering the children IS the
// truthful web behaviour — the previewed component's own markup is untouched.
pkg('react-native-safe-area-context', `
const React = require('react');
const { View } = require('react-native-web');
const zero = { top: 0, right: 0, bottom: 0, left: 0 };
const frame = { x: 0, y: 0, width: 0, height: 0 };
const pass = (p) => React.createElement(View, { style: p && p.style }, p && p.children);
module.exports = {
  SafeAreaProvider: pass,
  SafeAreaView: pass,
  SafeAreaInsetsContext: React.createContext(zero),
  SafeAreaFrameContext: React.createContext(frame),
  useSafeAreaInsets: () => zero,
  useSafeAreaFrame: () => frame,
  initialWindowMetrics: { insets: zero, frame },
  withSafeAreaInsets: (C) => (p) => React.createElement(C, { ...p, insets: zero }),
};
`);

pkg('react-native-gesture-handler', `
const React = require('react');
const RNW = require('react-native-web');
const { View, TouchableOpacity } = RNW;
const pass = (p) => React.createElement(View, { style: p && p.style }, p && p.children);
const press = (p) => React.createElement(TouchableOpacity, p, p && p.children);
// Swipeable/RectButton exist to carry gestures; on the web the honest render
// is the resting state, which is the child content.
module.exports = new Proxy({
  Swipeable: pass, RectButton: press, BorderlessButton: press, BaseButton: press,
  RawButton: press, TouchableOpacity: press, TouchableHighlight: press,
  TouchableWithoutFeedback: press, ScrollView: RNW.ScrollView, FlatList: RNW.FlatList,
  GestureHandlerRootView: pass, PanGestureHandler: pass, TapGestureHandler: pass,
  LongPressGestureHandler: pass, State: {}, Directions: {},
  Gesture: new Proxy({}, { get: () => () => ({}) }),
  GestureDetector: pass,
}, { get: (t, k) => (k in t ? t[k] : pass) });
`);

pkg('@react-native-community/datetimepicker', `
const React = require('react');
const { View } = require('react-native-web');
module.exports = (p) => React.createElement(View, { style: p && p.style });
module.exports.default = module.exports;
`);

// react-native-maps has no truthful web build. A stub would put a fake map on
// RouteMap's card; leaving it inert lets that component fall to the floor card,
// which is honest. See NOTES.md.
pkg('react-native-maps', `
const React = require('react');
const { View } = require('react-native-web');
const box = (p) => React.createElement(View, { style: p && p.style }, p && p.children);
module.exports = new Proxy({ default: box, Marker: () => null, Polyline: () => null,
  PROVIDER_GOOGLE: 'google' }, { get: (t, k) => (k in t ? t[k] : box) });
`);

// ── Native modules with no visual role: inert, never throwing ─────────────
const inert = `
const noop = () => undefined;
const handler = {
  get: (t, k) => {
    if (k === '__esModule') return true;
    if (k === 'default') return new Proxy(noop, handler);
    if (k === 'then') return undefined;           // never look thenable to await
    return new Proxy(noop, handler);
  },
  apply: () => undefined,
};
module.exports = new Proxy(noop, handler);
`;
['expo-constants', 'expo-secure-store', 'expo-contacts', 'expo-auth-session',
 'expo-web-browser', 'expo-speech', 'expo-location', 'expo-intent-launcher',
 'expo-notifications', 'expo-linking', 'expo-modules-core', 'expo-device',
 'expo-application', 'expo-file-system', 'expo-haptics', 'expo-clipboard',
 'expo-speech-recognition', 'expo-task-manager', 'expo-av',
 '@react-navigation/native', '@react-navigation/native-stack',
].forEach((n) => pkg(n, inert));

// AsyncStorage: an in-memory Map is the truthful web behaviour, and a few
// components read from it on mount.
pkg('@react-native-async-storage/async-storage', `
const m = new Map();
const api = {
  getItem: async (k) => (m.has(k) ? m.get(k) : null),
  setItem: async (k, v) => { m.set(k, String(v)); },
  removeItem: async (k) => { m.delete(k); },
  multiGet: async (ks) => ks.map((k) => [k, m.has(k) ? m.get(k) : null]),
  multiSet: async (ps) => { ps.forEach(([k, v]) => m.set(k, String(v))); },
  multiRemove: async (ks) => { ks.forEach((k) => m.delete(k)); },
  getAllKeys: async () => [...m.keys()],
  clear: async () => { m.clear(); },
};
module.exports = api;
module.exports.default = api;
`);

console.log('\nresolution root:', NM);
