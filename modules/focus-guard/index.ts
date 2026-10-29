/**
 * FocusGuard — JS side of the learning-session blocker (the Kotlin lives in ./android).
 *
 * The native module exists only in an EAS / dev-client build. In Expo Go, in a node test, or in a
 * build made before this module was added, there is no `FocusGuard` native module — and that must
 * never read as "nothing to report". Every call here therefore returns a typed result:
 *
 *     { ok: true, ... }                    it happened
 *     { ok: false, reason: 'native_unavailable' | 'no_usage_access' | ... }   it did not, and why
 *
 * (CLAUDE.md, THE SILENT-STATE RULE, rules 1-3.) Nothing here throws.
 *
 * The native functions return JSON strings so a nested result crosses the bridge as one value;
 * this wrapper parses them and turns any parse or bridge failure into a typed reason.
 */

/** Why a call did not happen. The prefixed forms carry the platform exception's name. */
export type FocusFailReason =
  | 'native_unavailable'
  | 'no_usage_access'
  | 'no_overlay'
  | 'bad_window'
  | 'nothing_to_block'
  | 'bad_entry'
  | 'window_over'
  | `service_start_refused:${string}`
  | `alarm_refused:${string}`
  | `settings_refused:${string}`
  | `native_error:${string}`;

export type FocusResult<T extends object = object> =
  | ({ ok: true } & T)
  | { ok: false; reason: FocusFailReason };

export interface SessionSnapshot {
  id: string;
  title: string;
  lang: 'he' | 'en';
  blocked: string[];
  startedAtMs: number;
  endsAtMs: number;
  taskId: string | null;
}

export interface SessionInfo {
  active: boolean;
  session?: SessionSnapshot;
  /** False while a session is active = nothing is running it (killed / force-stopped). */
  serviceRunning?: boolean;
  lastBeatMs?: number;
  /** What is wrong with the running session right now, if anything. */
  warn?: 'usage' | 'overlay' | 'block_failed' | null;
}

export interface UsageEntry { pkg: string; ms: number }

export type NativeIncidentKind =
  | 'permission_revoked' | 'block_failed' | 'killed' | 'ended_early' | 'slipped';

/** A bypass the native side noticed while JS may not have been running. */
export interface NativeIncident {
  kind: NativeIncidentKind;
  atMs: number;
  session: SessionSnapshot;
  permission?: 'usage' | 'overlay';
  minutesLeft?: number;
  usage?: UsageEntry[];
  blockedMs?: number;
  package?: string;
}

export interface ScheduledEntry {
  id: string;
  startAtMs: number;
  endsAtMs: number;
  blocked: string[];
  title: string;
  lang: 'he' | 'en';
  startTitle: string;
  startBody: string;
  sig: string;
  taskId?: string | null;
  /** The alarm went off (or its window passed). Kept so the next sync does not start it twice. */
  fired?: boolean;
  /** Why starting it failed, when it did. */
  error?: string;
}

export interface LastSession extends SessionSnapshot {
  reason: 'completed' | 'early' | 'stopped' | 'killed';
  endedAtMs: number;
  blockedMs: number;
  /** False: usage access was off at the end, so slips were NOT measured ("no slips" would be a lie). */
  measured: boolean;
}

export type ReconcileState = 'none' | 'running' | 'resumed' | 'killed_resumed' | 'finalized';

/** What the Kotlin module exposes, before this wrapper types it. */
interface RawNative {
  hasUsageAccess(): boolean;
  canDrawOverlays(): boolean;
  areNotificationsEnabled(): boolean;
  openUsageAccessSettings(): string;
  openOverlaySettings(): string;
  installedPackages(packages: string[]): string;
  startSession(
    endsAtMs: number, blocked: string[], title: string, lang: string,
    taskId: string | null, sessionId: string | null,
  ): string;
  stopSession(): string;
  endSessionEarly(): string;
  getSession(): string;
  lastSession(): string;
  scheduleSession(entryJson: string): string;
  cancelScheduled(id: string): string;
  listScheduled(): string;
  drainIncidents(): string;
  reconcile(): string;
  usageSummary(fromMs: number, toMs: number): Promise<string>;
}

let cached: RawNative | null | undefined;
let loadDetail: string | null = null;

function loadNative(): RawNative | null {
  if (cached !== undefined) return cached;
  cached = null;
  // Only the React Native runtime can have the module. A node test run has no `navigator.product`.
  const nav = (globalThis as { navigator?: { product?: string } }).navigator;
  if (!nav || nav.product !== 'ReactNative') {
    loadDetail = 'not_react_native';
    return cached;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const core = require('expo-modules-core') as {
      requireOptionalNativeModule?: <T>(name: string) => T | null;
    };
    const mod = core.requireOptionalNativeModule?.<RawNative>('FocusGuard') ?? null;
    if (mod) cached = mod;
    else loadDetail = 'module_not_linked'; // Expo Go, or a build made before this module existed
  } catch (e) {
    loadDetail = `load_failed:${String((e as Error)?.message ?? e).slice(0, 120)}`;
    console.warn('[FocusGuard] native module could not be loaded:', loadDetail);
  }
  return cached;
}

function fail(reason: FocusFailReason): { ok: false; reason: FocusFailReason } {
  return { ok: false, reason };
}

function errReason(e: unknown): FocusFailReason {
  const msg = String((e as Error)?.message ?? e).slice(0, 120);
  console.warn('[FocusGuard] native call failed:', msg);
  return `native_error:${msg}`;
}

function parse<T>(raw: string): T {
  return JSON.parse(raw) as T;
}

function call<T extends object>(fn: (n: RawNative) => string): FocusResult<T> {
  const n = loadNative();
  if (!n) return fail('native_unavailable');
  try {
    return parse<FocusResult<T>>(fn(n));
  } catch (e) {
    return fail(errReason(e));
  }
}

export interface PermissionStatus {
  /** The native module is present at all (false in Expo Go and in older builds). */
  native: boolean;
  usageAccess: boolean;
  overlay: boolean;
  notifications: boolean;
  /** Set when `native` is false: why. */
  reason?: FocusFailReason;
}

export const FocusGuard = {
  /** True when the native module is linked into this build. */
  isAvailable(): boolean {
    return loadNative() !== null;
  },

  /** Why the module is missing (for logs and the diagnostics line), or null when it is there. */
  unavailableDetail(): string | null {
    loadNative();
    return loadDetail;
  },

  permissions(): PermissionStatus {
    const n = loadNative();
    if (!n) {
      return { native: false, usageAccess: false, overlay: false, notifications: false, reason: 'native_unavailable' };
    }
    try {
      return {
        native: true,
        usageAccess: n.hasUsageAccess(),
        overlay: n.canDrawOverlays(),
        notifications: n.areNotificationsEnabled(),
      };
    } catch (e) {
      return { native: true, usageAccess: false, overlay: false, notifications: false, reason: errReason(e) };
    }
  },

  openUsageAccessSettings: (): FocusResult => call((n) => n.openUsageAccessSettings()),
  openOverlaySettings: (): FocusResult => call((n) => n.openOverlaySettings()),

  /** Packages (of those asked about) that are installed. [] with ok:true means none are. */
  installedPackages(packages: string[]): FocusResult<{ installed: string[] }> {
    const n = loadNative();
    if (!n) return fail('native_unavailable');
    try {
      return { ok: true, installed: parse<string[]>(n.installedPackages(packages)) };
    } catch (e) {
      return fail(errReason(e));
    }
  },

  startSession(opts: {
    endsAtMs: number; blocked: string[]; title: string; lang: 'he' | 'en';
    taskId?: string | null; sessionId?: string | null;
  }): FocusResult<{ id: string; endsAtMs: number }> {
    return call((n) => n.startSession(
      opts.endsAtMs, opts.blocked, opts.title, opts.lang, opts.taskId ?? null, opts.sessionId ?? null,
    ));
  },

  /** Stop without it counting as a bypass. */
  stopSession: (): FocusResult => call((n) => n.stopSession()),

  /** End early — the caller has already shown the 10-second wait. Recorded as ended_early. */
  endSessionEarly: (): FocusResult => call((n) => n.endSessionEarly()),

  getSession(): FocusResult<SessionInfo> {
    return call<SessionInfo>((n) => {
      const s = parse<SessionInfo>(n.getSession());
      return JSON.stringify({ ok: true, ...s });
    });
  },

  lastSession(): FocusResult<{ last: LastSession | null }> {
    const n = loadNative();
    if (!n) return fail('native_unavailable');
    try {
      return { ok: true, last: parse<LastSession | null>(n.lastSession()) };
    } catch (e) {
      return fail(errReason(e));
    }
  },

  scheduleSession(entry: Omit<ScheduledEntry, 'fired' | 'error'>):
    FocusResult<{ already?: boolean; fired?: boolean; startedNow?: boolean }> {
    return call((n) => n.scheduleSession(JSON.stringify(entry)));
  },

  cancelScheduled: (id: string): FocusResult => call((n) => n.cancelScheduled(id)),

  listScheduled(): FocusResult<{ entries: ScheduledEntry[] }> {
    const n = loadNative();
    if (!n) return fail('native_unavailable');
    try {
      return { ok: true, entries: parse<ScheduledEntry[]>(n.listScheduled()) };
    } catch (e) {
      return fail(errReason(e));
    }
  },

  /** Bypasses noticed natively since the last call. They are removed from the native list. */
  drainIncidents(): FocusResult<{ incidents: NativeIncident[] }> {
    const n = loadNative();
    if (!n) return fail('native_unavailable');
    try {
      return { ok: true, incidents: parse<NativeIncident[]>(n.drainIncidents()) };
    } catch (e) {
      return fail(errReason(e));
    }
  },

  /** A session that should be running but is not is finished or resumed, and the gap recorded. */
  reconcile(): FocusResult<{ state: ReconcileState; blockedMs?: number; error?: string }> {
    return call((n) => {
      const r = parse<{ state: ReconcileState; blockedMs?: number; error?: string }>(n.reconcile());
      return JSON.stringify({ ok: true, ...r });
    });
  },

  /** Foreground time per package inside a window. */
  async usageSummary(fromMs: number, toMs: number): Promise<FocusResult<{ apps: UsageEntry[] }>> {
    const n = loadNative();
    if (!n) return fail('native_unavailable');
    try {
      return parse<FocusResult<{ apps: UsageEntry[] }>>(await n.usageSummary(fromMs, toMs));
    } catch (e) {
      return fail(errReason(e));
    }
  },
};

export default FocusGuard;
