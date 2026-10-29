/** The night palette's raw colours — pure, so tests can measure them (constants/nightTone has the styles). */
export const NIGHT_COLORS = {
  /** Option A, her pick 28.10 ("like WhatsApp"): flat #0B141A ground, #111B21
   *  surfaces, hairlines instead of boxes, colour only on what is happening now. */
  card: '#111B21',
  glass: '#111B21',
  cardBorder: '#1F2C34',
  /** A done / past row — no surface, just the line. */
  cardDim: 'rgba(17,27,33,0.5)',
  chip: '#1A252C',
  chipBorder: '#26343D',
  bar: '#111B21',
  /** The hairline between rows. */
  line: '#1F2C34',
  ink: '#E9EDEF',
  inkSoft: '#8696A0',
  /** The gold accent as TEXT on the night surfaces. */
  goldInk: '#FFD166',
  /** A purple caption (Meira's own voice) on the night surfaces. */
  purpleInk: '#B9B2FF',
  goldSoft: 'rgba(255,209,102,0.14)',
  input: '#1A252C',
} as const;
