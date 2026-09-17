'use client';

import { useEffect, useRef, useState } from 'react';

// Live address autocomplete. Uses the Photon geocoder (komoot) — no API key,
// CORS-enabled, returns coordinates. Picking a suggestion reports the formatted
// address plus lat/lng so the profile can store homeLat/homeLng too.

export interface AddressResult {
  label: string;
  lat: number;
  lng: number;
}

interface PhotonFeature {
  geometry?: { coordinates?: [number, number] };
  properties?: {
    name?: string;
    housenumber?: string;
    street?: string;
    city?: string;
    state?: string;
    postcode?: string;
    country?: string;
  };
}

function toResult(f: PhotonFeature): AddressResult | null {
  const p = f.properties ?? {};
  const coords = f.geometry?.coordinates;
  if (!coords) return null;
  const line1 = [p.street, p.housenumber].filter(Boolean).join(' ') || p.name;
  const rest = [p.city, p.state, p.postcode, p.country].filter(Boolean).join(', ');
  const label = [line1, rest].filter(Boolean).join(', ');
  if (!label) return null;
  return { label, lat: coords[1], lng: coords[0] };
}

export default function AddressAutocomplete({
  value,
  placeholder,
  onChange,
  onSelect,
}: {
  value: string;
  placeholder?: string;
  onChange: (text: string) => void;
  onSelect?: (result: AddressResult) => void;
}) {
  const [query, setQuery] = useState(value ?? '');
  const [results, setResults] = useState<AddressResult[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const skipNextFetch = useRef(false);

  // Keep in sync when the parent value changes from outside.
  useEffect(() => setQuery(value ?? ''), [value]);

  // Debounced geocode lookup.
  useEffect(() => {
    if (skipNextFetch.current) {
      skipNextFetch.current = false;
      return;
    }
    const q = query.trim();
    if (q.length < 3) {
      setResults([]);
      setOpen(false);
      return;
    }
    const ctrl = new AbortController();
    const id = setTimeout(async () => {
      try {
        setLoading(true);
        const res = await fetch(
          `https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=5`,
          { signal: ctrl.signal },
        );
        const json = await res.json();
        const mapped = ((json.features ?? []) as PhotonFeature[])
          .map(toResult)
          .filter((r): r is AddressResult => r !== null);
        setResults(mapped);
        setOpen(mapped.length > 0);
      } catch {
        /* aborted or network error — ignore */
      } finally {
        setLoading(false);
      }
    }, 300);
    return () => {
      clearTimeout(id);
      ctrl.abort();
    };
  }, [query]);

  // Close on outside click.
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  const pick = (r: AddressResult) => {
    skipNextFetch.current = true; // don't re-search the value we just set
    setQuery(r.label);
    setResults([]);
    setOpen(false);
    onChange(r.label);
    onSelect?.(r);
  };

  return (
    <div className="addr-autocomplete" ref={boxRef}>
      <input
        value={query}
        placeholder={placeholder}
        onChange={(e) => {
          setQuery(e.target.value);
          onChange(e.target.value);
        }}
        onFocus={() => results.length > 0 && setOpen(true)}
        autoComplete="off"
      />
      {loading && <span className="addr-spinner">…</span>}
      {open && results.length > 0 && (
        <ul className="addr-list">
          {results.map((r, i) => (
            <li key={i}>
              <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => pick(r)}>
                📍 {r.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
