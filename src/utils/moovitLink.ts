/**
 * moovitLink — the trip, opened in Moovit with the destination already in.
 *
 * Koral, 1.10: "if it's a bus or public transport, let me open Moovit with the
 * address inside". Moovit knows the live arrivals and the platforms we cannot
 * (Google publishes no Israeli platform numbers — see TransitLeg.platform).
 *
 * The app link plans from where she is now (Moovit's default) and runs at
 * once; the web link is the fallback when Moovit is not installed. A place
 * without coordinates goes by name only — and 0,0 is "unknown", never a point
 * (see lumi-null-island-coords).
 */
export interface MoovitLinks {
  app: string;
  web: string;
}

const hasPoint = (lat?: number, lng?: number): boolean =>
  typeof lat === 'number' && typeof lng === 'number' && !(lat === 0 && lng === 0)
  && Number.isFinite(lat) && Number.isFinite(lng);

export function moovitLinks(place: { lat?: number; lng?: number; name?: string }): MoovitLinks | null {
  const name = String(place.name || '').trim();
  const point = hasPoint(place.lat, place.lng);
  if (!point && !name) return null;
  const q = encodeURIComponent(name);
  const app = point
    ? `moovit://directions?dest_lat=${place.lat}&dest_lon=${place.lng}${name ? `&dest_name=${q}` : ''}&auto_run=true&partner_id=Meira`
    : `moovit://directions?dest_name=${q}&auto_run=true&partner_id=Meira`;
  const web = `https://moovitapp.com/?to=${q}${point ? `&tll=${place.lat}_${place.lng}` : ''}&lang=he`;
  return { app, web };
}
