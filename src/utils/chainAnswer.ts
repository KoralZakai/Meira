/**
 * chainAnswer — the bike/car-elsewhere plans the server works out
 * (server/vehicle_chain.py), read and worded for ChainCard.
 *
 * Koral, 19.10: "show a map with the route options — 1: bus to Florentin,
 * bike to Baot … 2: bus to Baot, bus to Florentin, bike home". Her pick of
 * the two mockups: B, one option at a time, its legs drawn in colour.
 *
 * The server sends these under `chain`, never `answer`: the route/places
 * AnswerCard reads `answer.results`, which a chain does not have.
 */

export interface ChainPoint { lat: number; lng: number }

export interface ChainStep {
  mode: string;
  minutes: number;
  to: string;               // 'vehicle' | 'event' | 'home' | 'stop'
  stop?: string;
  line?: string;
  board_at?: string;
  leave_at?: string;
  after?: boolean;
  polyline?: string;
  from_pt?: ChainPoint;
  to_pt?: ChainPoint;
}

export interface ChainOption {
  kind: string;
  leave_at?: string;
  arrive_at?: string;
  home_at?: string;
  total_min?: number;
  travel_min?: number;
  extra_min?: number;
  event?: string;
  event_start?: string;
  pickup?: string | null;
  wish_at?: string;
  leave_event_at?: string | null;
  on_time?: boolean | null;
  late_by?: number;
  fits?: boolean;
  steps: ChainStep[];
}

export interface ChainAnswer {
  ok: true;
  kind: 'vehicle_chain' | 'vehicle_pickup' | 'vehicle_evening';
  vehicle?: string;
  start?: string;
  wish?: string;
  wish_place?: string;
  /** The named event a plan was made for (its name, as on her day). */
  event?: string;
  clash?: { with: string; start: string; end?: string } | null;
  options: ChainOption[];
}

const KINDS = new Set(['vehicle_chain', 'vehicle_pickup', 'vehicle_evening']);

/** A chain the card can draw, or null (nothing drawn, the text still shows). */
export function asChainAnswer(raw: unknown): ChainAnswer | null {
  const a = raw as ChainAnswer | null;
  if (!a || a.ok !== true || !KINDS.has(a.kind)) return null;
  if (!Array.isArray(a.options) || !a.options.length) return null;
  if (!a.options.every((o) => o && Array.isArray(o.steps) && o.steps.length)) return null;
  return a;
}

export const MODE_ICON: Record<string, string> = {
  walk: '🚶', bus: '🚌', train: '🚆', bike: '🚴', car: '🚗',
};

/** Bus purple, bike gold, walk grey — the same in the legend and on the map. */
export const MODE_COLOR: Record<string, string> = {
  bus: '#7F77DD', train: '#7F77DD', bike: '#E9AE3C', walk: '#8A8A9A', car: '#118AB2',
};

const VEHICLE: Record<string, [string, string]> = { bike: ['bike', 'אופניים'], car: ['car', 'אוטו'] };

/** The chip above the map: "1 · after Baot · +12". */
export function chipTitle(o: ChainOption, i: number, he: boolean, vehicle = 'bike'): string {
  const [ven, vhe] = VEHICLE[vehicle] ?? VEHICLE.bike;
  const short: Record<string, [string, string]> = {
    fetch_first: [`${ven} first`, `${vhe} קודם`],
    fetch_after: [o.event ? `after ${o.event}` : 'after', o.event ? `אחרי ${o.event}` : 'אחרי'],
    leave_it: [`leave the ${ven}`, `להשאיר את ה${vhe}`],
    on_its_own: ['a trip now', 'נסיעה עכשיו'],
    leave_early: ['leave early', 'לצאת מוקדם'],
    after: ['train after', 'אימון אחרי'],
    as_is: ['as planned', 'כמתוכנן'],
  };
  const [en, hw] = short[o.kind] ?? [o.kind, o.kind];
  const tail = typeof o.extra_min === 'number' ? `+${o.extra_min}` : (o.leave_at ?? '');
  return `${i + 1} · ${he ? hw : en}${tail ? ` · ${tail}` : ''}`;
}

/** Where a leg goes, in words. */
function placeOf(st: ChainStep, he: boolean, vehicle: string, eventName: string): string {
  const [ven, vhe] = VEHICLE[vehicle] ?? VEHICLE.bike;
  switch (st.to) {
    case 'vehicle': return he ? `ה${vhe}` : `the ${ven}`;
    case 'home': return he ? 'הביתה' : 'home';
    case 'event': return eventName || (he ? 'האירוע' : 'the event');
    default: return st.stop ?? '';
  }
}

/** One leg: "🚌 50 at 17:38 → Baot (20 min)" — the bus NUMBER first (18.10). */
export function stepLine(st: ChainStep, he: boolean, vehicle = 'bike', eventName = ''): string {
  const icon = MODE_ICON[st.mode] ?? '🧭';
  const to = placeOf(st, he, vehicle, eventName);
  const mins = he ? `${st.minutes} דק׳` : `${st.minutes} min`;
  const arrow = he ? '←' : '→';
  const head = st.line
    ? `${icon} ${st.line}${st.board_at ? (he ? ` ב-${st.board_at}` : ` at ${st.board_at}`) : ''}`
    : icon;
  const after = st.after ? (he ? 'אחרי: ' : 'after: ') : '';
  return `${after}${head} ${arrow} ${to} (${mins})`;
}

/** Every point the selected option touches — the map frames them all. */
export function framePoints(o: ChainOption): ChainPoint[] {
  const out: ChainPoint[] = [];
  for (const st of o.steps) {
    for (const p of [st.from_pt, st.to_pt]) {
      if (p && typeof p.lat === 'number' && typeof p.lng === 'number' && (p.lat !== 0 || p.lng !== 0)) out.push(p);
    }
  }
  return out;
}
