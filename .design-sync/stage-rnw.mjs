/**
 * Builds the staging tree the design-sync converter bundles Lumi against.
 *
 * WHY THIS EXISTS
 * Lumi is a React Native app, not a DOM component library. The converter's
 * esbuild call (lib/bundle.mjs sharedBuildOptions) passes no `alias`, no
 * `resolveExtensions` — so Metro's `.web.js` platform resolution never
 * happens — and defines only NODE_ENV. lib/bundle.mjs is explicitly not
 * forkable: it defines the output contract with the app's self-check.
 *
 * The decisive constraint: `nodePaths` is a FALLBACK, not an override. While
 * the sources sit inside the repo, esbuild's ordinary node_modules walk finds
 * the repo's real, Flow-typed `react-native` first and dies on `Unexpected
 * "typeof"`. No converter flag can beat that.
 *
 * So the sources are staged OUTSIDE the repo, beside a node_modules whose
 * `react-native` IS react-native-web. Resolution then finds the shim first by
 * ordinary rules, and the converter needs no special support at all.
 *
 * TRUTHFULNESS
 * Only wrappers are substituted, never a component being previewed:
 * Swipeable/RectButton render their children (their resting state IS the web
 * render), SafeAreaProvider renders its children with zero insets, AsyncStorage
 * keeps a Map. Every Lumi component in the bundle is the real compiled source.
 * react-native-maps has no truthful web build and is left inert — RouteMap is
 * expected to show an empty frame rather than a fake map. See NOTES.md.
 *
 * Usage:  node .design-sync/stage-rnw.mjs <repo> <stageDir>
 */
import fs from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(process.argv[2] || process.cwd());
const STAGE = path.resolve(process.argv[3] || '/tmp/lumi-ds-stage');
const NM = path.join(STAGE, 'node_modules');
const REPO_NM = path.join(REPO, 'node_modules');

fs.rmSync(STAGE, { recursive: true, force: true });
fs.mkdirSync(NM, { recursive: true });

const log = (...a) => console.log('  ', ...a);

/** Copy a package and, recursively, everything it depends on. Copies rather
 *  than symlinks: a symlink would let nested resolution walk back into the
 *  repo and rediscover the real react-native. */
const copyClosure = (name, seen = new Set()) => {
  if (seen.has(name)) return;
  seen.add(name);
  const src = path.join(REPO_NM, name);
  if (!fs.existsSync(src)) return log('! missing, skipped:', name);
  const dst = path.join(NM, name);
  if (!fs.existsSync(dst)) {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.cpSync(src, dst, { recursive: true });
    log('copy  ', name);
  }
  try {
    const j = JSON.parse(fs.readFileSync(path.join(src, 'package.json'), 'utf8'));
    Object.keys(j.dependencies || {}).forEach((d) => copyClosure(d, seen));
  } catch { /* no manifest, no deps to follow */ }
};

const shim = (name, body, extra = {}) => {
  const dir = path.join(NM, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'),
    JSON.stringify({ name, version: '0.0.0-rnw', main: 'index.js' }, null, 2));
  fs.writeFileSync(path.join(dir, 'index.js'), body);
  for (const [f, src] of Object.entries(extra)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), src);
  }
  log('shim  ', name);
};

// ── 1. Sources ────────────────────────────────────────────────────────────
fs.cpSync(path.join(REPO, 'src'), path.join(STAGE, 'src'), { recursive: true });
for (const f of ['tsconfig.json']) {
  if (fs.existsSync(path.join(REPO, f))) fs.cpSync(path.join(REPO, f), path.join(STAGE, f));
}
fs.writeFileSync(path.join(STAGE, 'package.json'),
  JSON.stringify({ name: 'lumi-ds', version: '0.0.0', main: 'src/index.ts' }, null, 2));
log('sources staged:',
  fs.readdirSync(path.join(STAGE, 'src/components')).filter((f) => f.endsWith('.tsx')).length,
  'components');

// ── 2. Real libraries (with their dependency closures) ────────────────────
['react', 'react-dom', 'react-native-web', '@supabase/supabase-js',
 'openai', 'compromise', 'warn-once'].forEach((p) => copyClosure(p));

// ── 3. react-native → react-native-web, plus the one internal svg reaches ──
shim('react-native', `module.exports = require('react-native-web');\n`, {
  'Libraries/Utilities/codegenNativeComponent.js':
    'module.exports = () => null;\nmodule.exports.default = module.exports;\n',
});

// ── 4. react-native-svg: real web build, main repointed so no platform
//       resolution is needed and nested imports stay inside the stage.
if (fs.existsSync(path.join(REPO_NM, 'react-native-svg'))) {
  copyClosure('react-native-svg');
  const pj = path.join(NM, 'react-native-svg/package.json');
  const j = JSON.parse(fs.readFileSync(pj, 'utf8'));
  j.main = 'lib/commonjs/ReactNativeSVG.web.js';
  delete j.module; delete j.exports; delete j['react-native'];
  fs.writeFileSync(pj, JSON.stringify(j, null, 2));
  log('repoint react-native-svg main →', j.main);
}

// ── 5. Passthrough wrappers ───────────────────────────────────────────────
shim('react-native-safe-area-context', `
const React = require('react');
const { View } = require('react-native-web');
const zero = { top: 0, right: 0, bottom: 0, left: 0 };
const frame = { x: 0, y: 0, width: 0, height: 0 };
const pass = (p) => React.createElement(View, { style: p && p.style }, p && p.children);
module.exports = {
  SafeAreaProvider: pass, SafeAreaView: pass,
  SafeAreaInsetsContext: React.createContext(zero),
  SafeAreaFrameContext: React.createContext(frame),
  useSafeAreaInsets: () => zero, useSafeAreaFrame: () => frame,
  initialWindowMetrics: { insets: zero, frame },
  withSafeAreaInsets: (C) => (p) => React.createElement(C, { ...p, insets: zero }),
};
`);

shim('react-native-gesture-handler', `
const React = require('react');
const RNW = require('react-native-web');
const { View, TouchableOpacity } = RNW;
const pass = (p) => React.createElement(View, { style: p && p.style }, p && p.children);
const press = (p) => React.createElement(TouchableOpacity, p, p && p.children);
module.exports = new Proxy({
  Swipeable: pass, RectButton: press, BorderlessButton: press, BaseButton: press,
  RawButton: press, TouchableOpacity: press, TouchableHighlight: press,
  TouchableWithoutFeedback: press, ScrollView: RNW.ScrollView, FlatList: RNW.FlatList,
  GestureHandlerRootView: pass, PanGestureHandler: pass, TapGestureHandler: pass,
  LongPressGestureHandler: pass, GestureDetector: pass, State: {}, Directions: {},
  Gesture: new Proxy({}, { get: () => () => ({}) }),
}, { get: (t, k) => (k in t ? t[k] : pass) });
`);

shim('@react-native-community/datetimepicker', `
const React = require('react');
const { View } = require('react-native-web');
const P = (p) => React.createElement(View, { style: p && p.style });
module.exports = P; module.exports.default = P;
`);

// No truthful web build. Left inert deliberately — see header.
shim('react-native-maps', `
const React = require('react');
const { View } = require('react-native-web');
const box = (p) => React.createElement(View, { style: p && p.style }, p && p.children);
module.exports = new Proxy(
  { default: box, Marker: () => null, Polyline: () => null, PROVIDER_GOOGLE: 'google' },
  { get: (t, k) => (k in t ? t[k] : box) });
`);

// Browsers have URL natively; /auto is side-effect only.
shim('react-native-url-polyfill', 'module.exports = {};\n', { 'auto.js': 'module.exports = {};\n' });

shim('@react-native-async-storage/async-storage', `
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
module.exports = api; module.exports.default = api;
`);

// ── 6. Native modules with no visual role: inert, never throwing ──────────
const inert = `
const noop = () => undefined;
const handler = {
  get: (t, k) => {
    if (k === '__esModule') return true;
    if (k === 'then') return undefined;      // must never look thenable to await
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
].forEach((n) => shim(n, inert));

console.log('\nstage:', STAGE);
console.log('node_modules:', NM);
