type LL = [number, number];

/** Google's polyline encoding, for a leg the phone has no route line for. */
export function encodePolyline(points: LL[]): string {
  const enc = (v: number) => {
    let n = v < 0 ? ~(v << 1) : v << 1;
    let s = '';
    while (n >= 0x20) { s += String.fromCharCode((0x20 | (n & 0x1f)) + 63); n >>= 5; }
    return s + String.fromCharCode(n + 63);
  };
  let out = ''; let pLat = 0; let pLng = 0;
  for (const [lat, lng] of points) {
    const a = Math.round(lat * 1e5); const b = Math.round(lng * 1e5);
    out += enc(a - pLat) + enc(b - pLng); pLat = a; pLng = b;
  }
  return out;
}

