/**
 * LineIcon — the v3 line icons (canvas v4, round 2: "line icons in tinted tiles").
 *
 * Two dozen glyphs, drawn on the react-native-svg the app already ships — no
 * icon package for the sake of ~20 paths. Shapes from Lucide (ISC licence,
 * https://lucide.dev): 24×24, 2px round strokes, no fill.
 */
import React from 'react';
import Svg, { Circle, Path, Rect } from 'react-native-svg';

type Shape =
  | { p: string }
  | { c: [number, number, number] }
  | { r: [number, number, number, number, number] };   // x, y, w, h, rx

const ICONS = {
  chat: [{ p: 'M7.9 20A9 9 0 1 0 4 16.1L2 22Z' }],
  sun: [
    { c: [12, 12, 4] }, { p: 'M12 2v2' }, { p: 'M12 20v2' }, { p: 'm4.93 4.93 1.41 1.41' },
    { p: 'm17.66 17.66 1.41 1.41' }, { p: 'M2 12h2' }, { p: 'M20 12h2' }, { p: 'm6.34 17.66-1.41 1.41' },
    { p: 'm19.07 4.93-1.41 1.41' },
  ],
  moon: [{ p: 'M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z' }],
  tasks: [{ p: 'm3 17 2 2 4-4' }, { p: 'm3 7 2 2 4-4' }, { p: 'M13 6h8' }, { p: 'M13 12h8' }, { p: 'M13 18h8' }],
  map: [
    { p: 'M14.106 5.553a2 2 0 0 0 1.788 0l3.659-1.83A1 1 0 0 1 21 4.619v12.764a1 1 0 0 1-.553.894l-4.553 2.277a2 2 0 0 1-1.788 0l-4.212-2.106a2 2 0 0 0-1.788 0l-3.659 1.83A1 1 0 0 1 3 19.381V6.618a1 1 0 0 1 .553-.894l4.553-2.277a2 2 0 0 1 1.788 0z' },
    { p: 'M15 5.764v15' }, { p: 'M9 3.236v15' },
  ],
  bell: [
    { p: 'M10.268 21a2 2 0 0 0 3.464 0' },
    { p: 'M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326' },
  ],
  menu: [{ p: 'M4 6h16' }, { p: 'M4 12h16' }, { p: 'M4 18h16' }],
  home: [
    { p: 'M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8' },
    { p: 'M3 10a2 2 0 0 1 .709-1.528l7-5.999a2 2 0 0 1 2.582 0l7 5.999A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z' },
  ],
  work: [{ p: 'M16 20V4a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16' }, { r: [2, 6, 20, 14, 2] }],
  bus: [
    { p: 'M8 6v6' }, { p: 'M15 6v6' }, { p: 'M2 12h19.6' },
    { p: 'M18 18h3s.5-1.7.8-2.8c.1-.4.2-.8.2-1.2 0-.4-.1-.8-.2-1.2l-1.4-5C20.1 6.8 19.1 6 18 6H4a2 2 0 0 0-2 2v10h3' },
    { c: [7, 18, 2] }, { p: 'M9 18h5' }, { c: [16, 18, 2] },
  ],
  car: [
    { p: 'M19 17h2c.6 0 1-.4 1-1v-3c0-.9-.7-1.7-1.5-1.9C18.7 10.6 16 10 16 10s-1.3-1.4-2.2-2.3c-.5-.4-1.1-.7-1.8-.7H5c-.6 0-1.1.4-1.4.9l-1.4 2.9A3.7 3.7 0 0 0 2 12v4c0 .6.4 1 1 1h2' },
    { c: [7, 17, 2] }, { p: 'M9 17h6' }, { c: [17, 17, 2] },
  ],
  train: [
    { p: 'M8 3.1V7a4 4 0 0 0 8 0V3.1' }, { p: 'm9 15-1-1' }, { p: 'm15 15 1-1' },
    { p: 'M9 19c-2.8 0-5-2.2-5-5v-4a8 8 0 0 1 16 0v4c0 2.8-2.2 5-5 5Z' }, { p: 'm8 19-2 3' }, { p: 'm16 19 2 3' },
  ],
  phone: [{ p: 'M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z' }],
  pin: [{ p: 'M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0' }, { c: [12, 10, 3] }],
  bike: [{ c: [18.5, 17.5, 3.5] }, { c: [5.5, 17.5, 3.5] }, { c: [15, 5, 1] }, { p: 'M12 17.5V14l-3-3 4-3 2 3h2' }],
  walk: [
    { p: 'M4 16v-2.38C4 11.5 2.97 10.5 3 8c.03-2.72 1.49-6 4.5-6C9.37 2 10 3.8 10 5.5c0 3.11-2 5.66-2 8.68V16a2 2 0 1 1-4 0Z' },
    { p: 'M20 20v-2.38c0-2.12 1.03-3.12 1-5.62-.03-2.72-1.49-6-4.5-6C14.63 6 14 7.8 14 9.5c0 3.11 2 5.66 2 8.68V20a2 2 0 1 0 4 0Z' },
    { p: 'M16 17h4' }, { p: 'M4 13h4' },
  ],
  alarm: [
    { c: [12, 13, 8] }, { p: 'M12 9v4l2 2' }, { p: 'M5 3 2 6' }, { p: 'm22 6-3-3' },
    { p: 'M6.38 18.7 4 21' }, { p: 'M17.64 18.67 20 21' },
  ],
  coffee: [
    { p: 'M10 2v2' }, { p: 'M14 2v2' }, { p: 'M6 2v2' },
    { p: 'M16 8a1 1 0 0 1 1 1v8a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4V9a1 1 0 0 1 1-1h14a4 4 0 1 1 0 8h-1' },
  ],
  timer: [{ p: 'M10 2h4' }, { p: 'm12 14 3-3' }, { c: [12, 14, 8] }],
  user: [{ p: 'M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2' }, { c: [12, 7, 4] }],
  mic: [{ p: 'M12 19v3' }, { p: 'M19 10v2a7 7 0 0 1-14 0v-2' }, { r: [9, 2, 6, 13, 3] }],
  calendar: [{ p: 'M8 2v4' }, { p: 'M16 2v4' }, { r: [3, 4, 18, 18, 2] }, { p: 'M3 10h18' }],
  bot: [
    { p: 'M12 8V4H8' }, { r: [4, 8, 16, 12, 2] }, { p: 'M2 14h2' }, { p: 'M20 14h2' },
    { p: 'M15 13v2' }, { p: 'M9 13v2' },
  ],
} satisfies Record<string, Shape[]>;

export type LineIconName = keyof typeof ICONS;

interface Props {
  name: LineIconName;
  size?: number;
  color: string;
  strokeWidth?: number;
}

export default function LineIcon({ name, size = 22, color, strokeWidth = 2 }: Props) {
  const common = { stroke: color, strokeWidth, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, fill: 'none' };
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      {(ICONS[name] as Shape[]).map((s, i) =>
        'p' in s ? <Path key={i} d={s.p} {...common} />
          : 'c' in s ? <Circle key={i} cx={s.c[0]} cy={s.c[1]} r={s.c[2]} {...common} />
            : <Rect key={i} x={s.r[0]} y={s.r[1]} width={s.r[2]} height={s.r[3]} rx={s.r[4]} {...common} />,
      )}
    </Svg>
  );
}
