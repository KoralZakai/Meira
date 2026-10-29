/* @ds-bundle: {"format":4,"namespace":"LumiAIDesignSystem_1a858d","components":[{"name":"MeiraCoin","sourcePath":"components/brand/MeiraCoin.jsx"},{"name":"MeiraWordmark","sourcePath":"components/brand/MeiraWordmark.jsx"},{"name":"Avatar","sourcePath":"components/core/Avatar.jsx"},{"name":"Button","sourcePath":"components/core/Button.jsx"},{"name":"Card","sourcePath":"components/core/Card.jsx"},{"name":"Checkbox","sourcePath":"components/core/Checkbox.jsx"},{"name":"FilterChip","sourcePath":"components/core/FilterChip.jsx"},{"name":"IconButton","sourcePath":"components/core/IconButton.jsx"},{"name":"SearchField","sourcePath":"components/core/SearchField.jsx"},{"name":"SectionLabel","sourcePath":"components/core/SectionLabel.jsx"},{"name":"TimeChip","sourcePath":"components/core/TimeChip.jsx"},{"name":"RewardToast","sourcePath":"components/feedback/RewardToast.jsx"},{"name":"Waveform","sourcePath":"components/feedback/Waveform.jsx"},{"name":"ChatBubble","sourcePath":"components/navigation/ChatBubble.jsx"},{"name":"TabBar","sourcePath":"components/navigation/TabBar.jsx"},{"name":"AttentionBanner","sourcePath":"components/overlays/AttentionBanner.jsx"},{"name":"MapPinConfirm","sourcePath":"components/overlays/MapPinConfirm.jsx"},{"name":"DayTimeline","sourcePath":"components/schedule/DayTimeline.jsx"},{"name":"GapSuggestionCard","sourcePath":"components/schedule/GapSuggestionCard.jsx"},{"name":"NextUpCard","sourcePath":"components/schedule/NextUpCard.jsx"},{"name":"TravelChainCard","sourcePath":"components/schedule/TravelChainCard.jsx"},{"name":"WakeAlertBanner","sourcePath":"components/schedule/WakeAlertBanner.jsx"},{"name":"YesterdayCard","sourcePath":"components/schedule/YesterdayCard.jsx"},{"name":"CategoryBadge","sourcePath":"components/tasks/CategoryBadge.jsx"},{"name":"DayTaskCard","sourcePath":"components/tasks/DayTaskCard.jsx"},{"name":"EmptyState","sourcePath":"components/tasks/EmptyState.jsx"},{"name":"PriorityGroup","sourcePath":"components/tasks/PriorityGroup.jsx"},{"name":"StickyNote","sourcePath":"components/tasks/StickyNote.jsx"},{"name":"SubtaskList","sourcePath":"components/tasks/SubtaskList.jsx"},{"name":"TaskCard","sourcePath":"components/tasks/TaskCard.jsx"},{"name":"TaskRow","sourcePath":"components/tasks/TaskRow.jsx"}],"sourceHashes":{"components/brand/MeiraCoin.jsx":"9feb7dae6729","components/brand/MeiraWordmark.jsx":"2b985a259d7b","components/core/Avatar.jsx":"c005a6d6f243","components/core/Button.jsx":"8dfdbc0d74be","components/core/Card.jsx":"29fb19549cc4","components/core/Checkbox.jsx":"164e8c22c79f","components/core/FilterChip.jsx":"c5eb3f098156","components/core/IconButton.jsx":"8f073f2bca12","components/core/SearchField.jsx":"582000177389","components/core/SectionLabel.jsx":"55a146ec28c8","components/core/TimeChip.jsx":"4768c83eeafc","components/feedback/RewardToast.jsx":"0acb1af321fc","components/feedback/Waveform.jsx":"a4bac1922bf1","components/navigation/ChatBubble.jsx":"116dd0377c5d","components/navigation/TabBar.jsx":"6225db5becbc","components/overlays/AttentionBanner.jsx":"fbaf04b09247","components/overlays/MapPinConfirm.jsx":"27a3b3fd1922","components/schedule/DayTimeline.jsx":"6743b478e546","components/schedule/GapSuggestionCard.jsx":"311cf7e2b589","components/schedule/NextUpCard.jsx":"ee13405f7e61","components/schedule/TravelChainCard.jsx":"f61d42f3222d","components/schedule/WakeAlertBanner.jsx":"548f2da04a31","components/schedule/YesterdayCard.jsx":"9a9c648fd7b9","components/tasks/CategoryBadge.jsx":"f5f440861f47","components/tasks/DayTaskCard.jsx":"c186a3c76b11","components/tasks/EmptyState.jsx":"ae8a4cdc809e","components/tasks/PriorityGroup.jsx":"38fe837356fe","components/tasks/StickyNote.jsx":"d3c4e0a13e53","components/tasks/SubtaskList.jsx":"50b94e45a284","components/tasks/TaskCard.jsx":"5c3ae66b2dba","components/tasks/TaskRow.jsx":"ab76b8a1ba57","meira-demo.js":"67f8f2bf8f80","ui_kits/lumi-app/AppShell.jsx":"6dcff87b5f12","ui_kits/lumi-app/TodayScreen.jsx":"9f5fd15d58fc"},"inlinedExternals":[],"unexposedExports":[{"name":"categoryMeta","sourcePath":"components/tasks/CategoryBadge.jsx"},{"name":"metaFor","sourcePath":"components/tasks/CategoryBadge.jsx"},{"name":"priorityMeta","sourcePath":"components/tasks/CategoryBadge.jsx"}]} */

(() => {

const __ds_ns = (window.LumiAIDesignSystem_1a858d = window.LumiAIDesignSystem_1a858d || {});

const __ds_scope = {};

(__ds_ns.__errors = __ds_ns.__errors || []);

// components/brand/MeiraCoin.jsx
try { (() => {
/**
 * MeiraCoin — the gold clock-coin brand mark (MeiraOrb in the app). A disc, a
 * white outer ring, and an "L"-shaped hand pointing 12 -> 3 o'clock. It is
 * both the logo's "i" dot and Meira's avatar everywhere in the product.
 * Built from divs so it stays crisp at any size — never a raster.
 */
function MeiraCoin({
  size = 64,
  invert = false,
  glow = false,
  style
}) {
  const ring = invert ? 'var(--lumi-amber)' : 'var(--lumi-white)';
  const hand = ring;
  const thick = Math.max(2, size * 0.07);
  const arm = size * 0.26;
  const c = size / 2;
  const bar = {
    position: 'absolute',
    background: hand,
    borderRadius: thick,
    pointerEvents: 'none'
  };
  return /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'relative',
      width: size,
      height: size,
      flex: 'none',
      borderRadius: '50%',
      background: invert ? 'var(--lumi-white)' : 'var(--lumi-sun-gold)',
      boxShadow: glow ? 'var(--shadow-orb)' : 'none',
      ...style
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      top: size * 0.08,
      left: size * 0.08,
      width: size * 0.84,
      height: size * 0.84,
      borderRadius: '50%',
      border: `${Math.max(1.5, size * 0.05)}px solid ${ring}`,
      opacity: invert ? 1 : 0.95,
      pointerEvents: 'none'
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      ...bar,
      left: c - thick / 2,
      top: c - arm,
      width: thick,
      height: arm
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      ...bar,
      left: c,
      top: c - thick / 2,
      width: arm,
      height: thick
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      ...bar,
      left: c - thick * 0.7,
      top: c - thick * 0.7,
      width: thick * 1.4,
      height: thick * 1.4
    }
  }));
}
Object.assign(__ds_scope, { MeiraCoin });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/brand/MeiraCoin.jsx", error: String((e && e.message) || e) }); }

// components/brand/MeiraWordmark.jsx
try { (() => {
/**
 * MeiraWordmark — "Meira" in Fredoka 700 with the puffy 3D candy treatment:
 * a gold gradient fill clipped to the text, a white top bevel, a soft gold
 * drop shadow, the clock coin sitting on the "i" as its tittle, and a small
 * "AI" at the lower right. The word is rendered whole — "Me", a real "i",
 * "ra" — so the letterform survives even if the coin doesn't paint; the coin
 * is overlaid on the i's dot rather than replacing the letter.
 * Vector/CSS only — the raster wordmark in the repo is reference material.
 */
function MeiraWordmark({
  size = 44,
  showAI = true,
  tone = 'gold',
  style
}) {
  const coin = size * 0.34;
  const onGold = tone === 'light';
  const ink = {
    fontFamily: 'var(--font-display)',
    fontWeight: 'var(--weight-display)',
    fontSize: size,
    lineHeight: 1.1,
    letterSpacing: 'var(--tracking-wordmark)',
    background: onGold ? 'linear-gradient(180deg,#FFFFFF,#FFF3C4)' : 'var(--gradient-gold-puff)',
    WebkitBackgroundClip: 'text',
    backgroundClip: 'text',
    color: 'transparent',
    WebkitTextFillColor: 'transparent',
    filter: onGold ? 'drop-shadow(0 1px 0 rgba(255,255,255,.6)) drop-shadow(0 3px 6px rgba(122,90,24,.35))' : 'drop-shadow(0 -1px 0 rgba(255,255,255,.85)) drop-shadow(0 4px 8px rgba(214,165,55,.45))'
  };
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'flex-end',
      ...style
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      ...ink,
      display: 'inline-block',
      whiteSpace: 'nowrap'
    }
  }, "Me", /*#__PURE__*/React.createElement("span", {
    style: {
      position: 'relative',
      display: 'inline-block'
    }
  }, "i", /*#__PURE__*/React.createElement("span", {
    style: {
      position: 'absolute',
      left: '50%',
      top: -coin * 0.12,
      transform: 'translateX(-50%)',
      WebkitTextFillColor: 'initial',
      filter: 'none'
    }
  }, /*#__PURE__*/React.createElement(__ds_scope.MeiraCoin, {
    size: coin,
    invert: onGold,
    glow: true
  }))), "ra"), showAI && /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: 'var(--font-body)',
      fontWeight: 'var(--weight-body-heavy)',
      fontSize: size * 0.3,
      letterSpacing: '1px',
      marginLeft: size * 0.08,
      marginBottom: size * 0.12,
      color: onGold ? 'rgba(255,255,255,.9)' : 'var(--text-secondary)'
    }
  }, "AI"));
}
Object.assign(__ds_scope, { MeiraWordmark });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/brand/MeiraWordmark.jsx", error: String((e && e.message) || e) }); }

// components/core/Avatar.jsx
try { (() => {
/** Avatar — the user's initial on honey. Lumi's own avatar is LumiCoin, never this. */
function Avatar({
  initial = 'L',
  size = 36,
  style
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      width: size,
      height: size,
      borderRadius: '50%',
      flex: 'none',
      background: 'var(--accent-soft)',
      color: 'var(--text-heading)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontFamily: 'var(--font-display)',
      fontWeight: 'var(--weight-display-semi)',
      fontSize: size * 0.45,
      ...style
    }
  }, initial);
}
Object.assign(__ds_scope, { Avatar });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Avatar.jsx", error: String((e && e.message) || e) }); }

// components/core/Button.jsx
try { (() => {
const base = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 'var(--space-4)',
  border: 'none',
  textAlign: 'center',
  fontFamily: 'var(--font-body)',
  fontWeight: 'var(--weight-body-heavy)',
  cursor: 'pointer',
  transition: 'opacity var(--duration-fast) var(--ease-standard)'
};
const sizes = {
  sm: {
    padding: '6px 12px',
    fontSize: 'var(--text-meta-sm)',
    borderRadius: 'var(--radius-chip)'
  },
  md: {
    padding: '10px 20px',
    fontSize: 'var(--text-meta)',
    borderRadius: 'var(--radius-row)'
  },
  lg: {
    padding: '13px 24px',
    fontSize: 'var(--text-body)',
    borderRadius: 'var(--radius-row)'
  }
};
const tones = {
  primary: {
    background: 'var(--accent-primary)',
    color: 'var(--text-on-gold)',
    boxShadow: 'var(--shadow-button)'
  },
  gradient: {
    background: 'var(--gradient-primary)',
    color: 'var(--text-on-gold)',
    boxShadow: 'var(--shadow-button)'
  },
  ghost: {
    background: 'var(--surface-card)',
    color: 'var(--text-secondary)',
    border: '1px solid var(--border-hairline)'
  },
  dark: {
    background: 'var(--surface-inverse)',
    color: 'var(--text-on-inverse)',
    boxShadow: 'var(--shadow-button)'
  },
  quiet: {
    background: 'transparent',
    color: 'var(--text-tertiary)',
    fontWeight: 'var(--weight-body-bold)'
  },
  danger: {
    background: 'var(--prio-must)',
    color: 'var(--lumi-white)'
  }
};

/** Button — Lumi's action pill. Gold is the primary action; everything else steps back. */
function Button({
  children,
  tone = 'primary',
  size = 'md',
  block = false,
  disabled = false,
  icon,
  onClick,
  style,
  type = 'button'
}) {
  return /*#__PURE__*/React.createElement("button", {
    type: type,
    onClick: onClick,
    disabled: disabled,
    style: {
      ...base,
      ...sizes[size],
      ...tones[tone],
      width: block ? '100%' : 'auto',
      opacity: disabled ? 'var(--disabled-opacity)' : 1,
      ...style
    }
  }, icon ? /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: '1.15em',
      lineHeight: 1
    }
  }, icon) : null, children);
}
Object.assign(__ds_scope, { Button });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Button.jsx", error: String((e && e.message) || e) }); }

// components/core/Card.jsx
try { (() => {
/**
 * Card — the cream surface every Lumi panel is built on: 20px radius, soft
 * gold-tinted shadow, optional hairline border. Accent variant is the "this
 * is the next one" treatment (gold border).
 */
function Card({
  children,
  tone = 'card',
  bordered = false,
  padding = 'var(--card-padding)',
  style,
  onClick
}) {
  const tones = {
    card: {
      background: 'var(--surface-card)'
    },
    soft: {
      background: 'var(--accent-soft)',
      border: '1px solid var(--accent-primary)'
    },
    accent: {
      background: 'var(--surface-card)',
      border: '1.5px solid var(--accent-primary)'
    },
    gold: {
      background: 'var(--accent-pressed)',
      color: 'var(--lumi-white)',
      boxShadow: 'var(--shadow-button)'
    },
    gradient: {
      background: 'var(--gradient-primary)',
      color: 'var(--lumi-white)',
      boxShadow: 'var(--shadow-button)'
    }
  };
  return /*#__PURE__*/React.createElement("div", {
    onClick: onClick,
    style: {
      borderRadius: 'var(--radius-card)',
      padding,
      boxShadow: 'var(--shadow-card)',
      border: bordered ? '1px solid var(--border-hairline)' : undefined,
      ...tones[tone],
      ...style
    }
  }, children);
}
Object.assign(__ds_scope, { Card });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Card.jsx", error: String((e && e.message) || e) }); }

// components/core/Checkbox.jsx
try { (() => {
/**
 * Checkbox — the completion control. Round on task rows (gold when done),
 * square-ish on subtasks (green when done). Completing something is the one
 * moment Lumi celebrates, so the checked state is a filled brand colour.
 */
function Checkbox({
  checked = false,
  shape = 'round',
  tone = 'gold',
  size = 22,
  onChange,
  style
}) {
  const fill = tone === 'success' ? 'var(--state-success)' : 'var(--accent-primary)';
  return /*#__PURE__*/React.createElement("button", {
    onClick: onChange,
    "aria-pressed": checked,
    style: {
      width: size,
      height: size,
      flex: 'none',
      cursor: 'pointer',
      borderRadius: shape === 'round' ? '50%' : 6,
      border: `2px solid ${checked ? fill : '#E6D9BC'}`,
      background: checked ? fill : 'var(--lumi-white)',
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      color: 'var(--lumi-white)',
      fontSize: size * 0.6,
      fontFamily: 'var(--font-body)',
      fontWeight: 'var(--weight-body-heavy)',
      padding: 0,
      ...style
    }
  }, checked ? '✓' : '');
}
Object.assign(__ds_scope, { Checkbox });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Checkbox.jsx", error: String((e && e.message) || e) }); }

// components/core/FilterChip.jsx
try { (() => {
/** FilterChip — the pill filter/suggestion chip. Active fills with warm ink. */
function FilterChip({
  children,
  active = false,
  tone = 'outline',
  onClick,
  style
}) {
  const looks = {
    outline: {
      background: 'var(--surface-card)',
      color: 'var(--text-secondary)',
      border: '1px solid var(--border-hairline)'
    },
    honey: {
      background: 'var(--accent-soft)',
      color: 'var(--text-heading)',
      border: '1px solid transparent'
    }
  };
  const on = {
    background: 'var(--surface-inverse)',
    color: 'var(--lumi-white)',
    border: '1px solid var(--surface-inverse)'
  };
  return /*#__PURE__*/React.createElement("button", {
    onClick: onClick,
    style: {
      padding: '8px 14px',
      borderRadius: 'var(--radius-full)',
      fontFamily: 'var(--font-body)',
      fontWeight: 'var(--weight-body-bold)',
      fontSize: 'var(--text-meta)',
      whiteSpace: 'nowrap',
      cursor: 'pointer',
      ...(active ? on : looks[tone]),
      ...style
    }
  }, children);
}
Object.assign(__ds_scope, { FilterChip });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/FilterChip.jsx", error: String((e && e.message) || e) }); }

// components/core/IconButton.jsx
try { (() => {
/** IconButton — the round 36px cream disc used for header utilities (🔊, ☑️, ✕). */
function IconButton({
  icon,
  tone = 'card',
  size = 36,
  onClick,
  label,
  style
}) {
  const tones = {
    card: {
      background: 'var(--surface-card)',
      boxShadow: 'var(--shadow-card)'
    },
    gold: {
      background: 'var(--accent-primary)',
      boxShadow: 'var(--shadow-button)'
    },
    soft: {
      background: 'var(--accent-soft)'
    },
    line: {
      background: 'var(--border-hairline)'
    }
  };
  return /*#__PURE__*/React.createElement("button", {
    onClick: onClick,
    "aria-label": label,
    style: {
      width: size,
      height: size,
      borderRadius: '50%',
      border: 'none',
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontSize: size * 0.45,
      lineHeight: 1,
      flex: 'none',
      color: 'var(--text-heading)',
      ...tones[tone],
      ...style
    }
  }, icon);
}
Object.assign(__ds_scope, { IconButton });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/IconButton.jsx", error: String((e && e.message) || e) }); }

// components/core/SearchField.jsx
try { (() => {
/** SearchField — the cream search row on the Tasks board. */
function SearchField({
  value = '',
  placeholder = 'Search tasks, places, people…',
  onChange,
  onClear,
  style
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 'var(--space-4)',
      background: 'var(--surface-card)',
      border: '1px solid var(--border-hairline)',
      borderRadius: 'var(--radius-chip)',
      padding: '8px 12px',
      ...style
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 14
    }
  }, "\uD83D\uDD0D"), /*#__PURE__*/React.createElement("input", {
    value: value,
    placeholder: placeholder,
    onChange: e => onChange && onChange(e.target.value),
    style: {
      flex: 1,
      minWidth: 0,
      border: 'none',
      outline: 'none',
      background: 'transparent',
      fontFamily: 'var(--font-body)',
      fontSize: 'var(--text-body-sm)',
      color: 'var(--text-body)'
    }
  }), value ? /*#__PURE__*/React.createElement("button", {
    onClick: onClear,
    style: {
      border: 'none',
      background: 'transparent',
      color: 'var(--text-secondary)',
      fontSize: 15
    }
  }, "\u2715") : null);
}
Object.assign(__ds_scope, { SearchField });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/SearchField.jsx", error: String((e && e.message) || e) }); }

// components/core/SectionLabel.jsx
try { (() => {
/** SectionLabel — the small tracked eyebrow above a list ("UP NEXT", "NEXT UP", "MY GOALS"). */
function SectionLabel({
  children,
  tone = 'secondary',
  style
}) {
  const colors = {
    secondary: 'var(--text-secondary)',
    time: 'var(--text-time)',
    faint: 'var(--text-tertiary)',
    onGold: 'rgba(255,255,255,0.7)'
  };
  return /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: 'var(--font-body)',
      fontWeight: 'var(--weight-body-heavy)',
      fontSize: 'var(--text-caption)',
      letterSpacing: 'var(--tracking-eyebrow)',
      textTransform: 'uppercase',
      color: colors[tone],
      ...style
    }
  }, children);
}
Object.assign(__ds_scope, { SectionLabel });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/SectionLabel.jsx", error: String((e && e.message) || e) }); }

// components/core/TimeChip.jsx
try { (() => {
/** TimeChip — a clock time (or "Tomorrow · 10:00") on the warm chip fill. */
function TimeChip({
  children,
  tone = 'chip',
  style
}) {
  const tones = {
    chip: {
      background: 'var(--surface-chip)',
      color: 'var(--text-time)'
    },
    soft: {
      background: 'var(--accent-soft)',
      color: 'var(--lumi-label-on-gold)'
    },
    plain: {
      background: 'transparent',
      color: 'var(--text-time)',
      padding: 0
    }
  };
  return /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      padding: '5px 9px',
      borderRadius: 'var(--radius-chip)',
      fontFamily: 'var(--font-body)',
      fontWeight: 'var(--weight-body-heavy)',
      fontSize: 'var(--text-meta-sm)',
      whiteSpace: 'nowrap',
      ...tones[tone],
      ...style
    }
  }, children);
}
Object.assign(__ds_scope, { TimeChip });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/TimeChip.jsx", error: String((e && e.message) || e) }); }

// components/feedback/RewardToast.jsx
try { (() => {
/**
 * RewardToast — the "+N pts" toast on completions. Fades in over 200ms, sits
 * for ~2s, fades out. Lumi's only celebratory chrome.
 */
function RewardToast({
  icon = '⭐',
  message,
  points,
  visible = true,
  style
}) {
  if (!visible) return null;
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      background: 'var(--accent-primary)',
      borderRadius: 'var(--radius-chip)',
      padding: '12px 16px',
      boxShadow: '0 6px 14px rgba(214,165,55,0.2)',
      animation: 'none',
      fontFamily: 'var(--font-body)',
      ...style
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 20
    }
  }, icon), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 'var(--text-body-sm)',
      fontWeight: 'var(--weight-body-semi)',
      color: 'var(--lumi-white)'
    }
  }, message), points != null ? /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 'var(--text-meta-sm)',
      fontWeight: 'var(--weight-body-bold)',
      color: 'var(--text-on-gold)'
    }
  }, "+", points, " pts") : null));
}
Object.assign(__ds_scope, { RewardToast });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/feedback/RewardToast.jsx", error: String((e && e.message) || e) }); }

// components/feedback/Waveform.jsx
try { (() => {
/** Waveform — the 18-bar gold waveform shown while Meira is listening (STT). */
function Waveform({
  active = true,
  level = 0.6,
  style
}) {
  const bars = Array.from({
    length: 18
  });
  return /*#__PURE__*/React.createElement("div", {
    style: {
      height: 64,
      display: 'flex',
      alignItems: 'flex-end',
      justifyContent: 'center',
      gap: 5,
      margin: '12px 0',
      ...style
    }
  }, bars.map((_, i) => {
    const scale = active ? Math.max(0.35, Math.min(1, level + (i % 3 * 0.15 + 0.1))) : 0.2;
    return /*#__PURE__*/React.createElement("div", {
      key: i,
      style: {
        width: 6,
        height: 56,
        borderRadius: 5,
        background: 'var(--accent-primary)',
        transform: `scaleY(${scale})`,
        transformOrigin: 'bottom',
        opacity: active ? 0.95 : 0.4,
        transition: `transform ${180 + i * 15}ms var(--ease-standard)`
      }
    });
  }));
}
Object.assign(__ds_scope, { Waveform });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/feedback/Waveform.jsx", error: String((e && e.message) || e) }); }

// components/navigation/ChatBubble.jsx
try { (() => {
/**
 * ChatBubble — a Coach chat message. Lumi: cream card, tail bottom-left.
 * User: gold fill, white text, tail bottom-right.
 */
function ChatBubble({
  from = 'lumi',
  children,
  stamp,
  style
}) {
  const lumi = from === 'lumi';
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      justifyContent: lumi ? 'flex-start' : 'flex-end'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      maxWidth: '78%',
      padding: '10px 14px',
      borderRadius: 'var(--radius-bubble)',
      borderBottomLeftRadius: lumi ? 'var(--radius-bubble-tail)' : 'var(--radius-bubble)',
      borderBottomRightRadius: lumi ? 'var(--radius-bubble)' : 'var(--radius-bubble-tail)',
      background: lumi ? 'var(--surface-card)' : 'var(--accent-primary)',
      color: lumi ? 'var(--text-heading)' : 'var(--lumi-white)',
      boxShadow: lumi ? 'var(--shadow-card)' : 'var(--shadow-button)',
      fontFamily: 'var(--font-body)',
      fontSize: 'var(--text-body-sm)',
      lineHeight: 1.43,
      ...style
    }
  }, /*#__PURE__*/React.createElement("div", null, children), stamp ? /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 'var(--text-caption-sm)',
      marginTop: 3,
      textAlign: 'right',
      color: lumi ? 'var(--text-tertiary)' : 'rgba(255,255,255,0.75)'
    }
  }, stamp) : null));
}
Object.assign(__ds_scope, { ChatBubble });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/navigation/ChatBubble.jsx", error: String((e && e.message) || e) }); }

// components/navigation/TabBar.jsx
try { (() => {
/**
 * TabBar — the app's bottom navigation: four labelled tabs (Today · Tasks ·
 * Trips · Profile) with a raised gold chat button lifted 30px above the bar.
 * The centre button used to be a Meira orb; it is a chat button, so it looks
 * like one.
 */
const defaultTabs = [{
  icon: '☀️',
  label: 'Today'
}, {
  icon: '☑️',
  label: 'Tasks'
}, {
  icon: '🗺️',
  label: 'Trips'
}, {
  icon: '👤',
  label: 'Profile'
}];
function TabBar({
  tabs = defaultTabs,
  active = 0,
  onSelect,
  onChat,
  style
}) {
  const left = tabs.slice(0, 2);
  const right = tabs.slice(2);
  const tab = (t, i) => {
    const on = active === i;
    return /*#__PURE__*/React.createElement("button", {
      key: t.label,
      onClick: () => onSelect && onSelect(i),
      style: {
        flex: 1,
        border: 'none',
        background: 'transparent',
        padding: 0,
        display: 'grid',
        justifyItems: 'center',
        gap: 2
      }
    }, /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: 22,
        opacity: on ? 1 : 0.4
      }
    }, t.icon), /*#__PURE__*/React.createElement("span", {
      style: {
        fontFamily: 'var(--font-body)',
        fontSize: 'var(--text-caption-sm)',
        fontWeight: on ? 'var(--weight-body-heavy)' : 'var(--weight-body-bold)',
        color: on ? 'var(--accent-primary)' : 'var(--text-tertiary)'
      }
    }, t.label), on ? /*#__PURE__*/React.createElement("span", {
      style: {
        width: 4,
        height: 4,
        borderRadius: 2,
        background: 'var(--accent-primary)',
        marginTop: 2
      }
    }) : null);
  };
  return /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'relative',
      background: 'var(--surface-card)',
      borderTop: '1px solid var(--border-hairline)',
      boxShadow: '0 -4px 18px rgba(214,165,55,0.10)',
      ...style
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      top: -30,
      left: 0,
      right: 0,
      display: 'flex',
      justifyContent: 'center',
      zIndex: 10
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: onChat,
    style: {
      width: 56,
      height: 56,
      borderRadius: 28,
      border: 'none',
      background: 'var(--accent-primary)',
      boxShadow: 'var(--shadow-orb)',
      fontSize: 24,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center'
    }
  }, "\uD83D\uDCAC")), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      height: 'var(--tabbar-height)',
      alignItems: 'flex-start',
      paddingTop: 10
    }
  }, left.map((t, i) => tab(t, i)), /*#__PURE__*/React.createElement("div", {
    style: {
      width: 72,
      flex: 'none'
    }
  }), right.map((t, i) => tab(t, i + 2))));
}
Object.assign(__ds_scope, { TabBar });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/navigation/TabBar.jsx", error: String((e && e.message) || e) }); }

// components/overlays/AttentionBanner.jsx
try { (() => {
/**
 * AttentionBanner — the row Meira uses to state a problem plainly, above
 * everything else: not signed in, clashes today, old tasks to clear, or the
 * spoken-briefing offer. Never a full gold fill (that is reserved for wake/leave).
 */
function AttentionBanner({
  tone = 'clash',
  children,
  action,
  onAction,
  onDismiss,
  style
}) {
  const tones = {
    offline: {
      background: 'var(--banner-offline-bg)',
      border: '1px solid var(--banner-offline-border)',
      color: 'var(--banner-offline-text)'
    },
    clash: {
      background: 'var(--banner-clash-bg)',
      border: '1px solid var(--banner-clash-border)',
      color: 'var(--banner-clash-text)'
    },
    note: {
      background: 'var(--note-1-tint)',
      border: '1px solid var(--note-1-border)',
      color: 'var(--text-heading)'
    },
    card: {
      background: 'var(--surface-card)',
      border: '1px solid var(--border-hairline)',
      color: 'var(--text-heading)'
    }
  };
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      minWidth: 0,
      borderRadius: 'var(--radius-card)',
      padding: '10px 14px',
      fontFamily: 'var(--font-body)',
      fontWeight: 'var(--weight-body-bold)',
      fontSize: 'var(--text-meta)',
      ...tones[tone],
      ...style
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      minWidth: 0
    }
  }, children), action ? /*#__PURE__*/React.createElement("button", {
    onClick: onAction,
    style: {
      border: 'none',
      background: 'var(--accent-primary)',
      color: 'var(--text-on-gold)',
      borderRadius: 'var(--radius-chip)',
      padding: '6px 16px',
      flex: 'none',
      whiteSpace: 'nowrap',
      fontFamily: 'var(--font-body)',
      fontWeight: 'var(--weight-body-bold)',
      fontSize: 'var(--text-meta)'
    }
  }, action) : null, onDismiss ? /*#__PURE__*/React.createElement("button", {
    onClick: onDismiss,
    style: {
      border: 'none',
      background: 'transparent',
      color: 'inherit',
      fontSize: 14,
      fontWeight: 700,
      flex: 'none'
    }
  }, "\u2715") : null);
}
Object.assign(__ds_scope, { AttentionBanner });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/overlays/AttentionBanner.jsx", error: String((e && e.message) || e) }); }

// components/overlays/MapPinConfirm.jsx
try { (() => {
/** MapPinConfirm — "is this the right place?" — pick one location candidate. */
function MapPinConfirm({
  title = 'Is this the right place?',
  options = [],
  onSelect,
  onCancel,
  style
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      background: 'var(--surface-app)',
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      ...style
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: '12px 16px',
      borderBottom: '1px solid var(--border-hairline)'
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: onCancel,
    style: {
      width: 36,
      height: 36,
      border: 'none',
      background: 'transparent',
      fontSize: 20,
      color: 'var(--text-heading)'
    }
  }, "\u2715"), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      textAlign: 'center',
      fontFamily: 'var(--font-body)',
      fontWeight: 'var(--weight-body-bold)',
      fontSize: 'var(--text-body-lg)',
      color: 'var(--text-heading)'
    }
  }, title), /*#__PURE__*/React.createElement("div", {
    style: {
      width: 36
    }
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      padding: '12px 16px 0',
      display: 'grid',
      gap: 10,
      alignContent: 'start'
    }
  }, options.map((o, i) => /*#__PURE__*/React.createElement("button", {
    key: i,
    onClick: () => onSelect && onSelect(o),
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 12,
      textAlign: 'left',
      padding: 12,
      border: 'none',
      background: 'var(--surface-card)',
      borderRadius: 'var(--radius-chip)'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      width: 40,
      height: 40,
      flex: 'none',
      borderRadius: 'var(--radius-card)',
      background: 'var(--accent-primary)',
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontSize: 20
    }
  }, "\uD83D\uDCCD"), /*#__PURE__*/React.createElement("span", {
    style: {
      flex: 1,
      minWidth: 0
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'block',
      fontFamily: 'var(--font-body)',
      fontWeight: 'var(--weight-body-semi)',
      fontSize: 'var(--text-body-sm)',
      color: 'var(--text-heading)'
    }
  }, o.displayName), /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'block',
      fontSize: 'var(--text-meta-sm)',
      color: 'var(--text-secondary)',
      marginTop: 2
    }
  }, o.address))))), /*#__PURE__*/React.createElement("div", {
    style: {
      padding: 16
    }
  }, /*#__PURE__*/React.createElement(__ds_scope.Button, {
    tone: "ghost",
    block: true,
    onClick: onCancel,
    style: {
      borderRadius: 'var(--radius-chip)',
      color: 'var(--text-heading)'
    }
  }, "Cancel")));
}
Object.assign(__ds_scope, { MapPinConfirm });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/overlays/MapPinConfirm.jsx", error: String((e && e.message) || e) }); }

// components/schedule/GapSuggestionCard.jsx
try { (() => {
/** GapSuggestionCard — Meira's offer for a free slot. Accept or not now; never applied silently. */
function GapSuggestionCard({
  gapStart,
  gapEnd,
  reason,
  onAccept,
  onReject,
  style
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      background: 'var(--surface-card)',
      borderRadius: 'var(--radius-chip)',
      borderLeft: '4px solid var(--accent-primary)',
      padding: 14,
      ...style
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 10,
      marginBottom: 10
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 20
    }
  }, "\uD83D\uDCA1"), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: 'var(--font-body)',
      fontWeight: 'var(--weight-body-bold)',
      fontSize: 'var(--text-meta)',
      color: 'var(--text-heading)'
    }
  }, "Meira suggests"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 'var(--text-caption)',
      color: 'var(--text-secondary)',
      marginTop: 2
    }
  }, gapStart, " - ", gapEnd))), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 'var(--text-meta)',
      color: 'var(--text-heading)',
      lineHeight: 'var(--leading-body)',
      marginBottom: 12
    }
  }, reason), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 10
    }
  }, /*#__PURE__*/React.createElement(__ds_scope.Button, {
    tone: "ghost",
    size: "sm",
    block: true,
    onClick: onReject,
    style: {
      padding: '10px 12px',
      borderRadius: 'var(--radius-chip)',
      color: 'var(--text-heading)'
    }
  }, "Not now"), /*#__PURE__*/React.createElement(__ds_scope.Button, {
    size: "sm",
    block: true,
    onClick: onAccept,
    style: {
      padding: '10px 12px',
      borderRadius: 'var(--radius-chip)',
      boxShadow: 'none'
    }
  }, "Add it")));
}
Object.assign(__ds_scope, { GapSuggestionCard });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/schedule/GapSuggestionCard.jsx", error: String((e && e.message) || e) }); }

// components/schedule/NextUpCard.jsx
try { (() => {
/**
 * NextUpCard — "what is actually next", with the whole chain that gets you
 * there: wake → leave → starts, then the route line. Gold-bordered because it
 * is the one card meant to be seen from across the room.
 */
function NextUpCard({
  day = 'today',
  title,
  place,
  steps = [],
  route,
  pending = false,
  onStart,
  onClick,
  style
}) {
  return /*#__PURE__*/React.createElement("div", {
    onClick: onClick,
    style: {
      background: 'var(--surface-card)',
      border: '1px solid var(--accent-primary)',
      borderRadius: 'var(--radius-card)',
      padding: 16,
      boxShadow: 'var(--shadow-card)',
      ...style
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between'
    }
  }, /*#__PURE__*/React.createElement(__ds_scope.SectionLabel, {
    tone: "time"
  }, "Next up"), /*#__PURE__*/React.createElement(__ds_scope.TimeChip, {
    style: {
      borderRadius: 'var(--radius-full)',
      padding: '3px 10px',
      color: 'var(--text-heading)'
    }
  }, day)), /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: 'var(--font-display)',
      fontWeight: 'var(--weight-display-semi)',
      fontSize: 19,
      color: 'var(--text-heading)',
      marginTop: 8
    }
  }, title), place ? /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 'var(--text-meta)',
      color: 'var(--text-secondary)',
      marginTop: 3
    }
  }, "\uD83D\uDCCD ", place) : null, steps.length ? /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      flexWrap: 'wrap',
      marginTop: 12,
      paddingTop: 12,
      borderTop: '1px solid var(--border-hairline)'
    }
  }, steps.map((s, i) => /*#__PURE__*/React.createElement(React.Fragment, {
    key: s.label
  }, i > 0 ? /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 14,
      color: 'var(--text-tertiary)',
      margin: '0 8px'
    }
  }, "\u2192") : null, /*#__PURE__*/React.createElement("div", {
    style: {
      minWidth: 68,
      textAlign: 'center'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: 'var(--font-body)',
      fontWeight: 'var(--weight-body-bold)',
      fontSize: 'var(--text-body)',
      color: 'var(--text-heading)',
      whiteSpace: 'nowrap'
    }
  }, s.icon, " ", s.time), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 'var(--text-caption)',
      color: 'var(--text-tertiary)',
      marginTop: 1
    }
  }, s.label))))) : null, route ? /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 'var(--text-meta-sm)',
      color: 'var(--text-secondary)',
      marginTop: 10
    }
  }, route) : pending ? /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 'var(--text-meta-sm)',
      color: 'var(--text-tertiary)',
      marginTop: 10
    }
  }, "\uD83E\uDDED Working out the route and leave time\u2026") : null, onStart ? /*#__PURE__*/React.createElement(__ds_scope.Button, {
    block: true,
    onClick: onStart,
    style: {
      marginTop: 12,
      boxShadow: 'none'
    }
  }, "Start now") : null);
}
Object.assign(__ds_scope, { NextUpCard });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/schedule/NextUpCard.jsx", error: String((e && e.message) || e) }); }

// components/schedule/TravelChainCard.jsx
try { (() => {
const modes = [{
  id: 'bus',
  icon: '🚌'
}, {
  id: 'train',
  icon: '🚆'
}, {
  id: 'car',
  icon: '🚗'
}, {
  id: 'walk',
  icon: '🚶'
}, {
  id: 'bike',
  icon: '🚴'
}];

/**
 * TravelChainCard — a task row that opens into its road plan: wake → get
 * ready → leave → ride → arrive, with transport chips that recalculate the
 * times. Only the closest pending task is expanded by default.
 */
function TravelChainCard({
  time,
  title,
  sub,
  done = false,
  expanded = false,
  direction = 'there',
  mode = 'bus',
  steps = [],
  routing = false,
  onToggleExpand,
  onComplete,
  onModeChange,
  style
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      background: done ? 'var(--border-hairline)' : 'var(--surface-card)',
      border: '1px solid var(--border-hairline)',
      borderRadius: 'var(--radius-note)',
      overflow: 'hidden',
      boxShadow: 'var(--shadow-card)',
      ...style
    }
  }, /*#__PURE__*/React.createElement("div", {
    onClick: onToggleExpand,
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      padding: 13,
      cursor: 'pointer'
    }
  }, /*#__PURE__*/React.createElement(__ds_scope.Checkbox, {
    checked: done,
    shape: "square",
    tone: "success",
    size: 20,
    onChange: onComplete,
    style: {
      borderColor: done ? 'var(--state-success)' : 'var(--accent-pressed)'
    }
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      width: 44,
      flex: 'none',
      fontFamily: 'var(--font-body)',
      fontWeight: 'var(--weight-body-heavy)',
      fontSize: 'var(--text-meta)',
      color: 'var(--text-time)'
    }
  }, time), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      minWidth: 0
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: 'var(--font-body)',
      fontWeight: 'var(--weight-body-heavy)',
      fontSize: 'var(--text-body)',
      color: done ? 'var(--text-secondary)' : 'var(--text-heading)',
      textDecoration: done ? 'line-through' : 'none',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap'
    }
  }, title), sub ? /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: 'var(--font-body)',
      fontWeight: 'var(--weight-body-semi)',
      fontSize: 'var(--text-meta-sm)',
      color: 'var(--text-secondary)',
      marginTop: 1
    }
  }, sub) : null), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 14,
      fontWeight: 800,
      color: 'var(--text-time)'
    }
  }, expanded ? '▾' : '▸')), expanded ? /*#__PURE__*/React.createElement("div", {
    style: {
      borderTop: '1px dashed var(--border-hairline)',
      padding: '10px 14px 14px'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginBottom: 8
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: 'var(--font-body)',
      fontWeight: 'var(--weight-body-heavy)',
      fontSize: 'var(--text-meta-sm)',
      letterSpacing: '0.8px',
      color: 'var(--text-tertiary)'
    }
  }, direction === 'home' ? 'THE WAY HOME' : 'THE WAY THERE', routing ? ' · routing…' : ''), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 5
    }
  }, modes.map(m => /*#__PURE__*/React.createElement("button", {
    key: m.id,
    onClick: () => onModeChange && onModeChange(m.id),
    style: {
      padding: '4px 8px',
      borderRadius: 10,
      fontSize: 13,
      background: mode === m.id ? 'var(--surface-inverse)' : 'var(--surface-app)',
      border: `1px solid ${mode === m.id ? 'var(--surface-inverse)' : 'var(--border-hairline)'}`
    }
  }, m.icon)))), steps.map((s, i) => /*#__PURE__*/React.createElement("div", {
    key: i
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      padding: '5px 8px',
      borderRadius: 10,
      background: s.kind === 'highlight' ? 'var(--surface-chip)' : 'transparent'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      width: 44,
      flex: 'none',
      fontFamily: 'var(--font-body)',
      fontWeight: 'var(--weight-body-heavy)',
      fontSize: 'var(--text-meta)',
      color: s.kind === 'success' ? 'var(--state-success)' : 'var(--text-time)'
    }
  }, s.time), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 15
    }
  }, s.icon), /*#__PURE__*/React.createElement("span", {
    style: {
      flex: 1,
      minWidth: 0,
      fontFamily: 'var(--font-body)',
      fontWeight: s.kind === 'plain' ? 'var(--weight-body-bold)' : 'var(--weight-body-heavy)',
      fontSize: 'var(--text-body-sm)',
      color: s.kind === 'success' ? 'var(--state-success)' : 'var(--text-heading)',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap'
    }
  }, s.label), s.note ? /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 'var(--text-caption)',
      fontWeight: 'var(--weight-body-heavy)',
      color: s.kind === 'highlight' ? 'var(--text-time)' : s.kind === 'success' ? 'var(--state-success)' : 'var(--text-tertiary)'
    }
  }, s.note) : null), i < steps.length - 1 ? /*#__PURE__*/React.createElement("div", {
    style: {
      width: 2,
      height: 8,
      background: 'var(--border-hairline)',
      marginLeft: 64
    }
  }) : null))) : null);
}
Object.assign(__ds_scope, { TravelChainCard });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/schedule/TravelChainCard.jsx", error: String((e && e.message) || e) }); }

// components/schedule/WakeAlertBanner.jsx
try { (() => {
/** WakeAlertBanner — the gold "wake up at / leave home at" banner. */
function WakeAlertBanner({
  wakeTime,
  leaveTime,
  onDismiss,
  style
}) {
  const item = (icon, label, time) => /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      flex: 1
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 24,
      marginRight: 10
    }
  }, icon), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 'var(--text-caption)',
      fontWeight: 'var(--weight-body-semi)',
      color: 'rgba(255,255,255,0.8)'
    }
  }, label), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 'var(--text-body-lg)',
      fontWeight: 'var(--weight-body-bold)',
      color: 'var(--lumi-white)'
    }
  }, time)));
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      background: 'var(--accent-primary)',
      borderRadius: 'var(--radius-chip)',
      padding: 14,
      boxShadow: '0 4px 8px rgba(241,194,78,0.2)',
      fontFamily: 'var(--font-body)',
      ...style
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      display: 'flex',
      alignItems: 'center'
    }
  }, item('⏰', 'Wake up at:', wakeTime), /*#__PURE__*/React.createElement("div", {
    style: {
      width: 1,
      height: 40,
      background: 'rgba(255,255,255,0.3)',
      margin: '0 12px'
    }
  }), item('🚪', 'Leave home at:', leaveTime)), onDismiss ? /*#__PURE__*/React.createElement("button", {
    onClick: onDismiss,
    style: {
      border: 'none',
      background: 'transparent',
      padding: 8,
      color: 'var(--lumi-white)',
      fontSize: 18,
      fontWeight: 700
    }
  }, "\u2715") : null);
}
Object.assign(__ds_scope, { WakeAlertBanner });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/schedule/WakeAlertBanner.jsx", error: String((e && e.message) || e) }); }

// components/schedule/YesterdayCard.jsx
try { (() => {
/**
 * YesterdayCard — unfinished tasks, resurfaced without a pile-on. Collapsed by
 * default, capped at five rows, and "Let them go" is offered as plainly as
 * "Reschedule all". No guilt copy on either.
 */
function YesterdayCard({
  title,
  items = [],
  extra = 0,
  open = false,
  onToggle,
  onRescheduleAll,
  onLetGo,
  style
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      background: 'var(--surface-card)',
      border: '1px solid var(--border-hairline)',
      borderRadius: 'var(--radius-card)',
      padding: '10px 14px',
      boxShadow: 'var(--shadow-card)',
      ...style
    }
  }, /*#__PURE__*/React.createElement("div", {
    onClick: onToggle,
    style: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      cursor: 'pointer'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: 'var(--font-body)',
      fontWeight: 'var(--weight-body-bold)',
      fontSize: 'var(--text-body-sm)',
      color: 'var(--text-secondary)'
    }
  }, title), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 11,
      color: 'var(--text-tertiary)'
    }
  }, open ? '▲' : '▼')), open ? /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 10,
      display: 'grid',
      gap: 6
    }
  }, items.map((it, i) => /*#__PURE__*/React.createElement("div", {
    key: i,
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 8
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 14
    }
  }, it.icon), /*#__PURE__*/React.createElement("span", {
    style: {
      flex: 1,
      minWidth: 0,
      fontSize: 'var(--text-meta)',
      color: 'var(--text-heading)',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap'
    }
  }, it.text), /*#__PURE__*/React.createElement("span", {
    style: {
      background: 'var(--state-success)',
      color: 'var(--surface-card)',
      borderRadius: 'var(--radius-chip)',
      padding: '4px 8px',
      fontSize: 'var(--text-meta-sm)',
      fontWeight: 'var(--weight-body-bold)'
    }
  }, "\u2713 Done"), /*#__PURE__*/React.createElement("span", {
    style: {
      background: 'var(--surface-chip)',
      color: 'var(--text-time)',
      borderRadius: 'var(--radius-full)',
      padding: '3px 10px',
      fontSize: 'var(--text-caption)',
      fontWeight: 'var(--weight-body-heavy)'
    }
  }, "\u21BB Reschedule"), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 13,
      color: 'var(--text-tertiary)',
      padding: '0 4px'
    }
  }, "\uD83D\uDDD1"))), extra > 0 ? /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 'var(--text-meta-sm)',
      color: 'var(--text-tertiary)',
      marginTop: 2
    }
  }, "+", extra, " more") : null, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      marginTop: 8,
      paddingTop: 8,
      borderTop: '1px solid var(--border-hairline)'
    }
  }, /*#__PURE__*/React.createElement(__ds_scope.Button, {
    block: true,
    size: "sm",
    onClick: onRescheduleAll,
    style: {
      padding: '9px 12px',
      fontSize: 'var(--text-meta)',
      boxShadow: 'none',
      borderRadius: 'var(--radius-row)'
    }
  }, "\u21BB Reschedule all"), /*#__PURE__*/React.createElement(__ds_scope.Button, {
    tone: "quiet",
    size: "sm",
    onClick: onLetGo,
    style: {
      padding: '9px 12px',
      fontSize: 'var(--text-meta)'
    }
  }, "Let them go"))) : null);
}
Object.assign(__ds_scope, { YesterdayCard });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/schedule/YesterdayCard.jsx", error: String((e && e.message) || e) }); }

// components/tasks/CategoryBadge.jsx
try { (() => {
/**
 * Category metadata, mirroring CATEGORY_META in src/constants/theme.ts.
 * Emoji IS the icon system in Meira — there is no icon font or SVG set.
 */
const categoryMeta = {
  interview: {
    color: 'var(--cat-interview)',
    icon: '🎯',
    label: 'Interview'
  },
  course: {
    color: 'var(--cat-course)',
    icon: '📚',
    label: 'Course'
  },
  conference: {
    color: 'var(--cat-conference)',
    icon: '🎪',
    label: 'Conference'
  },
  class: {
    color: 'var(--cat-class)',
    icon: '✏️',
    label: 'Class'
  },
  work: {
    color: 'var(--cat-work)',
    icon: '💼',
    label: 'Work'
  },
  meeting: {
    color: 'var(--cat-meeting)',
    icon: '🤝',
    label: 'Meeting'
  },
  call: {
    color: 'var(--cat-call)',
    icon: '📞',
    label: 'Call'
  },
  doctor: {
    color: 'var(--cat-doctor)',
    icon: '⚕️',
    label: 'Doctor'
  },
  gym: {
    color: 'var(--cat-gym)',
    icon: '💪',
    label: 'Gym'
  },
  aspiration: {
    color: 'var(--cat-aspiration)',
    icon: '⭐',
    label: 'Aspiration'
  },
  leisure: {
    color: 'var(--cat-leisure)',
    icon: '🎮',
    label: 'Leisure'
  },
  general: {
    color: 'var(--cat-general)',
    icon: '📌',
    label: 'General'
  },
  zoom: {
    color: 'var(--cat-zoom)',
    icon: '💻',
    label: 'Zoom'
  },
  hobby_class: {
    color: 'var(--cat-hobby-class)',
    icon: '🎨',
    label: 'Hobby'
  }
};
const priorityMeta = {
  must: {
    color: 'var(--prio-must)',
    label: 'Must Do',
    dot: '🔴'
  },
  have_to: {
    color: 'var(--prio-have-to)',
    label: 'Have To',
    dot: '🟠'
  },
  need_to: {
    color: 'var(--prio-need-to)',
    label: 'Need To',
    dot: '🟡'
  },
  nice_to_do: {
    color: 'var(--prio-nice-to-do)',
    label: 'Nice To Do',
    dot: '🟢'
  }
};
const metaFor = key => categoryMeta[key] || categoryMeta.general;
const pads = {
  small: {
    padding: '2px 8px',
    fontSize: 'var(--text-caption)',
    icon: 12
  },
  medium: {
    padding: '4px 10px',
    fontSize: 'var(--text-meta-sm)',
    icon: 16
  },
  large: {
    padding: '6px 12px',
    fontSize: 'var(--text-body-sm)',
    icon: 20
  }
};

/** CategoryBadge — icon + label chip filled with the category colour. */
function CategoryBadge({
  category = 'general',
  size = 'medium',
  iconOnly = false,
  style
}) {
  const meta = metaFor(category);
  const p = pads[size];
  if (iconOnly) {
    return /*#__PURE__*/React.createElement("span", {
      style: {
        width: 28,
        height: 28,
        borderRadius: 'var(--radius-chip)',
        background: meta.color,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: 14,
        flex: 'none',
        ...style
      }
    }, meta.icon);
  }
  return /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 6,
      background: meta.color,
      borderRadius: 'var(--radius-card)',
      padding: p.padding,
      color: 'var(--text-heading)',
      fontFamily: 'var(--font-body)',
      fontWeight: 'var(--weight-body-semi)',
      fontSize: p.fontSize,
      ...style
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: p.icon,
      lineHeight: 1
    }
  }, meta.icon), meta.label);
}
Object.assign(__ds_scope, { categoryMeta, priorityMeta, metaFor, CategoryBadge });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/tasks/CategoryBadge.jsx", error: String((e && e.message) || e) }); }

// components/schedule/DayTimeline.jsx
try { (() => {
/**
 * DayTimeline — one day, in clock order: task rows with a time column and
 * tappable "45m free ＋" gaps between them, then anything with no time set.
 */
function DayTimeline({
  rows = [],
  unscheduled = [],
  onAddAtTime,
  onTaskTap,
  style
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      ...style
    }
  }, rows.map((row, idx) => {
    if (row.kind === 'gap') {
      return /*#__PURE__*/React.createElement("div", {
        key: `gap-${idx}`,
        onClick: () => onAddAtTime && onAddAtTime(row.from),
        style: {
          display: 'flex',
          alignItems: 'center',
          padding: '4px 0',
          marginBottom: 6,
          cursor: 'pointer'
        }
      }, /*#__PURE__*/React.createElement("span", {
        style: {
          width: 48,
          flex: 'none',
          textAlign: 'right',
          paddingRight: 8,
          fontSize: 'var(--text-caption)',
          color: 'var(--text-secondary)'
        }
      }, row.from), /*#__PURE__*/React.createElement("span", {
        style: {
          flex: 1,
          borderTop: '1px solid var(--border-hairline)',
          marginRight: 8
        }
      }), /*#__PURE__*/React.createElement("span", {
        style: {
          fontSize: 'var(--text-caption)',
          fontWeight: 'var(--weight-body-semi)',
          color: 'var(--text-secondary)'
        }
      }, row.label, " \uFF0B"));
    }
    const meta = __ds_scope.metaFor(row.category);
    return /*#__PURE__*/React.createElement("div", {
      key: idx,
      onClick: () => onTaskTap && onTaskTap(row),
      style: {
        display: 'flex',
        marginBottom: 6,
        opacity: row.done ? 'var(--done-opacity)' : 1,
        cursor: 'pointer'
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        width: 48,
        flex: 'none',
        paddingRight: 8,
        paddingTop: 4,
        textAlign: 'right'
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 'var(--text-meta-sm)',
        fontWeight: 'var(--weight-body-bold)',
        color: 'var(--text-heading)'
      }
    }, row.start), /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 'var(--text-caption)',
        color: 'var(--text-secondary)',
        marginTop: 2
      }
    }, row.end)), /*#__PURE__*/React.createElement("div", {
      style: {
        flex: 1,
        minWidth: 0,
        background: 'var(--surface-card)',
        borderRadius: 'var(--radius-chip)',
        borderLeft: `4px solid ${meta.color}`,
        padding: '10px 12px',
        boxShadow: 'var(--shadow-row)'
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        fontFamily: 'var(--font-body)',
        fontWeight: 'var(--weight-body-bold)',
        fontSize: 'var(--text-body-sm)',
        color: 'var(--text-heading)',
        textDecoration: row.done ? 'line-through' : 'none',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap'
      }
    }, meta.icon, "  ", row.title), /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 'var(--text-meta-sm)',
        color: 'var(--text-secondary)',
        marginTop: 3
      }
    }, row.duration, row.place ? `  ·  📍 ${row.place}` : '')));
  }), unscheduled.length ? /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 12,
      paddingTop: 12,
      borderTop: '1px solid var(--border-hairline)'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 'var(--text-meta-sm)',
      fontWeight: 'var(--weight-body-bold)',
      color: 'var(--text-secondary)',
      marginBottom: 8,
      paddingLeft: 48
    }
  }, "\uD83D\uDD53 No time set"), unscheduled.map((t, i) => {
    const meta = __ds_scope.metaFor(t.category);
    return /*#__PURE__*/React.createElement("div", {
      key: i,
      onClick: () => onTaskTap && onTaskTap(t),
      style: {
        marginLeft: 48,
        marginBottom: 6,
        background: 'var(--surface-card)',
        borderRadius: 'var(--radius-chip)',
        borderLeft: `4px solid ${meta.color}`,
        padding: '10px 12px',
        cursor: 'pointer'
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        fontFamily: 'var(--font-body)',
        fontWeight: 'var(--weight-body-bold)',
        fontSize: 'var(--text-body-sm)',
        color: 'var(--text-heading)'
      }
    }, meta.icon, "  ", t.title), /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 'var(--text-meta-sm)',
        color: 'var(--text-secondary)',
        marginTop: 3
      }
    }, t.duration, "  \xB7  tap to schedule"));
  })) : null);
}
Object.assign(__ds_scope, { DayTimeline });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/schedule/DayTimeline.jsx", error: String((e && e.message) || e) }); }

// components/tasks/DayTaskCard.jsx
try { (() => {
/**
 * DayTaskCard — the timeline row: a right-aligned time gutter (date, start,
 * end) and a block whose height grows with the task's duration, like a real
 * day planner. Left rail carries the category colour.
 */
function DayTaskCard({
  date,
  start,
  end,
  title,
  category = 'general',
  priority = 'need_to',
  duration,
  location,
  durationMinutes = 30,
  done = false,
  missed = false,
  onToggle,
  onClick,
  style
}) {
  const cat = __ds_scope.metaFor(category);
  const prio = __ds_scope.priorityMeta[priority] || __ds_scope.priorityMeta.need_to;
  const height = Math.max(58, Math.min(200, Math.round(durationMinutes)));
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      margin: '4px 0',
      ...style
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: 52,
      flex: 'none',
      textAlign: 'right',
      paddingRight: 8,
      paddingTop: 6
    }
  }, date ? /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 'var(--text-caption-sm)',
      fontWeight: 'var(--weight-body-semi)',
      color: 'var(--text-secondary)'
    }
  }, date) : null, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 'var(--text-meta)',
      fontWeight: 'var(--weight-body-heavy)',
      color: cat.color
    }
  }, start || '—'), end ? /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 'var(--text-caption)',
      color: 'var(--text-secondary)',
      marginTop: 2
    }
  }, end) : null), /*#__PURE__*/React.createElement("div", {
    onClick: onClick,
    style: {
      flex: 1,
      minWidth: 0,
      minHeight: height,
      background: done ? 'var(--border-hairline)' : 'var(--surface-card)',
      opacity: done ? 0.6 : 1,
      borderRadius: 'var(--radius-chip)',
      borderLeft: `4px solid ${cat.color}`,
      padding: '8px 12px',
      display: 'flex',
      flexDirection: 'column',
      justifyContent: 'center',
      boxShadow: 'var(--shadow-row)'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 6
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 16
    }
  }, cat.icon), /*#__PURE__*/React.createElement("span", {
    style: {
      flex: 1,
      fontFamily: 'var(--font-body)',
      fontWeight: 'var(--weight-body-semi)',
      fontSize: 'var(--text-body)',
      color: done ? 'var(--text-secondary)' : 'var(--text-heading)',
      textDecoration: done ? 'line-through' : 'none'
    }
  }, title), onToggle ? /*#__PURE__*/React.createElement("button", {
    onClick: onToggle,
    style: {
      width: 26,
      height: 26,
      flex: 'none',
      borderRadius: 'var(--radius-chip)',
      border: `2px solid ${done ? 'var(--state-success)' : missed ? 'var(--prio-must)' : 'var(--border-hairline)'}`,
      background: done ? 'var(--state-success)' : 'transparent',
      color: done ? 'var(--lumi-white)' : 'var(--prio-must)',
      fontFamily: 'var(--font-body)',
      fontWeight: 'var(--weight-body-bold)',
      fontSize: 13
    }
  }, done ? '✓' : missed ? '✕' : '') : null), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 5,
      marginTop: 5,
      fontSize: 'var(--text-caption)',
      color: 'var(--text-secondary)'
    }
  }, duration ? /*#__PURE__*/React.createElement("span", {
    style: {
      marginRight: 3
    }
  }, "\u23F1\uFE0F ", duration) : null, /*#__PURE__*/React.createElement("span", {
    style: {
      width: 7,
      height: 7,
      borderRadius: 4,
      background: prio.color,
      flex: 'none'
    }
  }), /*#__PURE__*/React.createElement("span", null, prio.label), location ? /*#__PURE__*/React.createElement("span", {
    style: {
      flex: 1,
      minWidth: 0,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap'
    }
  }, "\uD83D\uDCCD ", location) : null)));
}
Object.assign(__ds_scope, { DayTaskCard });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/tasks/DayTaskCard.jsx", error: String((e && e.message) || e) }); }

// components/tasks/EmptyState.jsx
try { (() => {
/** EmptyState — Lumi's empty list: one emoji, one warm line, no illustration. */
function EmptyState({
  icon = '☑️',
  text = 'All clear here. Nice work.',
  children,
  style
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      justifyItems: 'center',
      gap: 12,
      padding: '28px 30px',
      textAlign: 'center',
      ...style
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 40
    }
  }, icon), /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: 'var(--font-body)',
      fontWeight: 'var(--weight-body-semi)',
      fontSize: 'var(--text-body-sm)',
      color: 'var(--text-secondary)',
      lineHeight: 'var(--leading-relaxed)',
      whiteSpace: 'pre-line'
    }
  }, text), children);
}
Object.assign(__ds_scope, { EmptyState });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/tasks/EmptyState.jsx", error: String((e && e.message) || e) }); }

// components/tasks/PriorityGroup.jsx
try { (() => {
/** PriorityGroup — a MUST / HAVE-TO / NEED-TO / NICE-TO-DO section header + its cards. */
function PriorityGroup({
  priority = 'must',
  children,
  style
}) {
  const meta = __ds_scope.priorityMeta[priority] || __ds_scope.priorityMeta.must;
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gap: 8,
      ...style
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 8
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 16
    }
  }, meta.dot), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: 'var(--font-body)',
      fontWeight: 'var(--weight-body-bold)',
      fontSize: 'var(--text-meta)',
      letterSpacing: 'var(--tracking-label)',
      color: 'var(--text-heading)',
      textTransform: 'uppercase'
    }
  }, meta.label)), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gap: 8
    }
  }, children));
}
Object.assign(__ds_scope, { PriorityGroup });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/tasks/PriorityGroup.jsx", error: String((e && e.message) || e) }); }

// components/tasks/StickyNote.jsx
try { (() => {
/**
 * StickyNote — the subject group on the Tasks board: a pastel note with a
 * strip of tape, tilted slightly, holding TaskRows. The palette cycles by
 * group index (5 tints) and the tilt alternates, giving the hand-placed feel.
 */
const palette = [{
  tint: 'var(--note-1-tint)',
  border: 'var(--note-1-border)',
  tape: 'var(--note-1-tape)'
}, {
  tint: 'var(--note-2-tint)',
  border: 'var(--note-2-border)',
  tape: 'var(--note-2-tape)'
}, {
  tint: 'var(--note-3-tint)',
  border: 'var(--note-3-border)',
  tape: 'var(--note-3-tape)'
}, {
  tint: 'var(--note-4-tint)',
  border: 'var(--note-4-border)',
  tape: 'var(--note-4-tape)'
}, {
  tint: 'var(--note-5-tint)',
  border: 'var(--note-5-border)',
  tape: 'var(--note-5-tape)'
}];
function StickyNote({
  index = 0,
  icon = '📌',
  title,
  count,
  children,
  style
}) {
  const p = palette[index % palette.length];
  const rotate = index % 2 === 0 ? '-0.6deg' : '0.5deg';
  const tapeRotate = index % 2 === 0 ? '-3deg' : '2deg';
  return /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'relative',
      background: p.tint,
      border: `1px solid ${p.border}`,
      borderRadius: 'var(--radius-card)',
      padding: '16px 15px 15px',
      boxShadow: 'var(--shadow-note)',
      transform: `rotate(${rotate})`,
      ...style
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      left: 26,
      top: -9,
      width: 54,
      height: 18,
      borderRadius: 3,
      background: p.tape,
      opacity: 0.85,
      transform: `rotate(${tapeRotate})`,
      boxShadow: 'var(--shadow-tape)'
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 9
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 16
    }
  }, icon), /*#__PURE__*/React.createElement("span", {
    style: {
      flex: 1,
      fontFamily: 'var(--font-display)',
      fontWeight: 'var(--weight-display-semi)',
      fontSize: 'var(--text-display-xs)',
      color: 'var(--text-heading)'
    }
  }, title), count != null ? /*#__PURE__*/React.createElement("span", {
    style: {
      background: 'var(--surface-card)',
      color: 'var(--text-secondary)',
      borderRadius: 'var(--radius-full)',
      padding: '2px 9px',
      fontFamily: 'var(--font-body)',
      fontWeight: 'var(--weight-body-bold)',
      fontSize: 'var(--text-meta-sm)'
    }
  }, count) : null), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gap: 8,
      marginTop: 11
    }
  }, children));
}
Object.assign(__ds_scope, { StickyNote });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/tasks/StickyNote.jsx", error: String((e && e.message) || e) }); }

// components/tasks/SubtaskList.jsx
try { (() => {
/** SubtaskList — checkable ordered subtasks on cream rows, green when done. */
function SubtaskList({
  title = 'Subtasks',
  items = [],
  onToggle,
  style
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gap: 10,
      ...style
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: 'var(--font-body)',
      fontWeight: 'var(--weight-body-bold)',
      fontSize: 'var(--text-body-sm)',
      color: 'var(--text-heading)'
    }
  }, title), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gap: 8
    }
  }, items.map((item, i) => /*#__PURE__*/React.createElement("div", {
    key: i,
    onClick: () => onToggle && onToggle(i),
    style: {
      display: 'flex',
      alignItems: 'flex-start',
      gap: 10,
      background: 'var(--surface-app)',
      borderRadius: 'var(--radius-chip)',
      padding: '10px 12px'
    }
  }, /*#__PURE__*/React.createElement(__ds_scope.Checkbox, {
    checked: !!item.done,
    shape: "square",
    tone: "success",
    size: 20,
    style: {
      marginTop: 2
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      display: 'grid',
      gap: 4
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: 'var(--font-body)',
      fontWeight: 'var(--weight-body-semi)',
      fontSize: 'var(--text-meta)',
      color: item.done ? 'var(--text-secondary)' : 'var(--text-heading)',
      textDecoration: item.done ? 'line-through' : 'none'
    }
  }, item.text), item.durationMinutes ? /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 'var(--text-meta-sm)',
      color: 'var(--text-secondary)'
    }
  }, "~", item.durationMinutes, " min") : null)))));
}
Object.assign(__ds_scope, { SubtaskList });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/tasks/SubtaskList.jsx", error: String((e && e.message) || e) }); }

// components/tasks/TaskCard.jsx
try { (() => {
/**
 * TaskCard — the main task card: a 4px priority bar down the left, the date +
 * hour line, the category tile, the title, duration, detail line and subtask
 * progress. Swipe right in the app reveals postpone (📅) and complete (✓).
 */
function TaskCard({
  time,
  title,
  category = 'general',
  priority = 'nice_to_do',
  durationMinutes,
  details = [],
  subtasksDone,
  subtasksTotal,
  done = false,
  onClick,
  style
}) {
  const cat = __ds_scope.metaFor(category);
  const prio = __ds_scope.priorityMeta[priority] || __ds_scope.priorityMeta.nice_to_do;
  return /*#__PURE__*/React.createElement("div", {
    onClick: onClick,
    style: {
      display: 'flex',
      background: 'var(--surface-card)',
      borderRadius: 'var(--radius-card)',
      overflow: 'hidden',
      boxShadow: 'var(--shadow-row)',
      ...style
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: 'var(--border-width-priority)',
      background: prio.color,
      flex: 'none'
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      minWidth: 0,
      padding: 14
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      marginBottom: 8
    }
  }, time ? /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: 'var(--font-body)',
      fontWeight: 'var(--weight-body-semi)',
      fontSize: 'var(--text-body-sm)',
      color: 'var(--text-heading)'
    }
  }, time) : null, /*#__PURE__*/React.createElement("span", {
    style: {
      width: 28,
      height: 28,
      borderRadius: 'var(--radius-chip)',
      background: cat.color,
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontSize: 14
    }
  }, cat.icon)), /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: 'var(--font-body)',
      fontWeight: 'var(--weight-body-semi)',
      fontSize: 'var(--text-body)',
      color: done ? 'var(--text-secondary)' : 'var(--text-heading)',
      textDecoration: done ? 'line-through' : 'none',
      marginBottom: 6
    }
  }, title), durationMinutes ? /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 'var(--text-meta)',
      color: 'var(--text-secondary)',
      marginBottom: 8
    }
  }, "~", durationMinutes, " min") : null, details.length ? /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexWrap: 'wrap',
      gap: 8,
      marginBottom: 8
    }
  }, details.map((d, i) => /*#__PURE__*/React.createElement("span", {
    key: i,
    style: {
      fontSize: 'var(--text-meta-sm)',
      color: 'var(--text-secondary)'
    }
  }, d))) : null, subtasksTotal ? /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gap: 4
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      height: 4,
      background: 'var(--border-hairline)',
      borderRadius: 2,
      overflow: 'hidden'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      height: '100%',
      width: `${subtasksDone / subtasksTotal * 100}%`,
      background: 'var(--accent-primary)'
    }
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 'var(--text-caption)',
      color: 'var(--text-secondary)'
    }
  }, subtasksDone, "/", subtasksTotal, " subtasks")) : null));
}
Object.assign(__ds_scope, { TaskCard });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/tasks/TaskCard.jsx", error: String((e && e.message) || e) }); }

// components/tasks/TaskRow.jsx
try { (() => {
/**
 * TaskRow — the compact row that lives inside a StickyNote: checkbox, title,
 * duration sub-line, and the date/hour chip on the right. Ticking it plays the
 * success moment (bounce + floating "+10 ✨").
 */
function TaskRow({
  title,
  duration,
  time,
  done = false,
  points = false,
  onToggle,
  onClick,
  indent = false,
  style
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      marginLeft: indent ? 14 : 0,
      paddingLeft: indent ? 10 : 0,
      borderLeft: indent ? '2px solid var(--border-hairline)' : 'none'
    }
  }, /*#__PURE__*/React.createElement("div", {
    onClick: onClick,
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 11,
      background: 'var(--surface-card)',
      border: '1px solid var(--border-hairline)',
      borderRadius: 'var(--radius-row)',
      padding: 12,
      opacity: done ? 'var(--done-opacity)' : 1,
      ...style
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'relative'
    }
  }, /*#__PURE__*/React.createElement(__ds_scope.Checkbox, {
    checked: done,
    onChange: onToggle
  }), points ? /*#__PURE__*/React.createElement("span", {
    style: {
      position: 'absolute',
      left: 26,
      top: -6,
      whiteSpace: 'nowrap',
      fontFamily: 'var(--font-body)',
      fontWeight: 'var(--weight-body-heavy)',
      fontSize: 'var(--text-meta-sm)',
      color: 'var(--lumi-amber)'
    }
  }, "+10 \u2728") : null), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      minWidth: 0
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: 'var(--font-body)',
      fontWeight: 'var(--weight-body-bold)',
      fontSize: 'var(--text-body-sm)',
      color: done ? 'var(--text-tertiary)' : 'var(--text-heading)',
      textDecoration: done ? 'line-through' : 'none'
    }
  }, title), duration ? /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11.5,
      color: 'var(--text-tertiary)',
      marginTop: 3
    }
  }, duration) : null), time ? /*#__PURE__*/React.createElement(__ds_scope.TimeChip, {
    style: {
      borderRadius: 10
    }
  }, time) : null));
}
Object.assign(__ds_scope, { TaskRow });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/tasks/TaskRow.jsx", error: String((e && e.message) || e) }); }

// meira-demo.js
try { (() => {
/* Meira site — demo engine. Data and behaviour lifted from the real app:
   src/components/TransitOptionsList.tsx, TimelineTravelLeg.tsx, ClashCard.tsx,
   NextUpCard.tsx, GapSuggestionCard.tsx, services/MultiModalPlanner.ts,
   services/GapFillService.ts, utils/departureOptions.ts */

/* Anchor navigation. Smooth scrolling is non-functional in this host — both
   behavior:'smooth' and the CSS scroll-behavior property drop the scroll
   entirely — so the offset is measured and applied instantly. */
window.jump = (id, label) => {
  const el = document.getElementById(id);
  if (!el) return;
  if (window.MA) MA.ev('cta_click', {
    section: label,
    target: id
  });
  const top = el.getBoundingClientRect().top + window.scrollY - 64; // sticky header
  window.scrollTo({
    top: Math.max(0, top),
    behavior: 'instant'
  });
};

/* ---------- scene player ---------- */
const SCENES = [{
  id: 'sync',
  label: 'Sync',
  ms: 7200
}, {
  id: 'backward',
  label: 'Alarm',
  ms: 7600
}, {
  id: 'depart',
  label: 'Departure',
  ms: 7600
}, {
  id: 'clash',
  label: 'Conflict',
  ms: 8400
}, {
  id: 'learn',
  label: 'Learning',
  ms: 7200
}, {
  id: 'gap',
  label: 'Free time',
  ms: 8000
}];
let cur = 0,
  playing = true,
  timer = null,
  raf = null,
  startedAt = 0;
const stage = document.getElementById('stage');
const rail = document.getElementById('rail');
const bar = document.getElementById('bar');
const playBtn = document.getElementById('playBtn');
SCENES.forEach((s, i) => {
  const b = document.createElement('button');
  b.className = 'chap';
  b.type = 'button';
  b.innerHTML = `<span class="chap-n">${i + 1}</span><span class="chap-l">${s.label}</span>`;
  b.addEventListener('click', () => {
    go(i);
    pause();
  });
  rail.appendChild(b);
});
const chaps = [...rail.querySelectorAll('.chap')];
function paintScene(i) {
  stage.querySelectorAll('.scene').forEach((el, n) => {
    const on = n === i;
    el.classList.toggle('on', on);
    // Re-trigger the staggered reveal every time a scene comes back.
    if (on) {
      el.querySelectorAll('[data-b]').forEach(c => {
        c.style.animation = 'none';
        void c.offsetWidth;
        c.style.animation = '';
      });
    }
  });
  chaps.forEach((c, n) => c.classList.toggle('on', n === i));
}
function tickBar() {
  const s = SCENES[cur];
  const p = playing ? Math.min(1, (performance.now() - startedAt) / s.ms) : 1;
  bar.style.transform = `scaleX(${p})`;
  raf = requestAnimationFrame(tickBar);
}
function go(i, persist = true) {
  cur = (i + SCENES.length) % SCENES.length;
  paintScene(cur);
  startedAt = performance.now();
  clearTimeout(timer);
  if (playing) timer = setTimeout(() => go(cur + 1), SCENES[cur].ms);
  if (persist) {
    try {
      localStorage.setItem('meira_site_scene', String(cur));
    } catch (e) {}
  }
  if (window.MA) MA.ev('demo_scene', {
    scene: SCENES[cur].id
  });
}
function pause() {
  playing = false;
  clearTimeout(timer);
  playBtn.textContent = '▶';
  playBtn.setAttribute('aria-label', 'Play the walkthrough');
  bar.style.transform = 'scaleX(1)';
}
function play() {
  playing = true;
  playBtn.textContent = '⏸';
  playBtn.setAttribute('aria-label', 'Pause the walkthrough');
  go(cur);
}
playBtn.addEventListener('click', () => playing ? pause() : play());
document.getElementById('prevBtn').addEventListener('click', () => {
  go(cur - 1);
  pause();
});
document.getElementById('nextBtn').addEventListener('click', () => {
  go(cur + 1);
  pause();
});
let restored = 0;
try {
  restored = Math.min(SCENES.length - 1, Math.max(0, parseInt(localStorage.getItem('meira_site_scene') || '0', 10) || 0));
} catch (e) {}
go(restored, false);
tickBar();

/* Don't animate off-screen: an autoplaying demo the user cannot see is just
   work the phone is doing for nothing. */
const io = new IntersectionObserver(([e]) => {
  if (!e.isIntersecting && playing) {
    pause();
    stage.dataset.autopaused = '1';
  } else if (e.isIntersecting && stage.dataset.autopaused === '1') {
    delete stage.dataset.autopaused;
    play();
  }
}, {
  threshold: 0.25
});
io.observe(stage);

/* ---------- transport picker ----------
   Real behaviour from TravelChainCard + TimelineTravelLeg: the mode is a
   per-task choice, every mode re-prices the whole chain, and a mode with no
   service says so instead of quietly showing another mode's route.
   The train case is the MultiModalPlanner story: the long leg by rail, the
   last mile by something that actually goes there. */
const TRIP = {
  bus: {
    icon: '🚌',
    head: 'Line 176 · direct · 32 min',
    leave: '09:15',
    arrive: '10:05',
    slack: '7 min early',
    board: 'walk 4 min to Allenby/Rothschild · board 09:19',
    legs: [['🚶', 'Walk to Allenby/Rothschild', 'Allenby/Rothschild', '09:15→09:19'], ['🚌', '176 · Arlozorov Terminal', 'Allenby/Rothschild', '09:19→09:51'], ['🚶', 'Walk to the office', '', '09:51→10:05']],
    options: [['09:15', '10:05', '🚌 176 · direct · 32 min · 7 min early', 'walk 4 min to Allenby/Rothschild · leave in 6 min', 'current'], ['09:35', '10:25', '🚌 176 · direct · 32 min · 13 min late', 'walk 4 min to Allenby/Rothschild', 'late'], ['09:41', '10:22', '🚌 18 + 66 · 1 change · 41 min · 10 min late', 'walk 6 min to Rothschild/Sheinkin', 'late']]
  },
  train: {
    icon: '🚆',
    head: 'Train + 12 min by car for the last mile',
    leave: '08:56',
    arrive: '10:03',
    slack: '9 min early',
    board: 'Savidor Center → Hadera West · car from the station',
    multimodal: 'No bus serves the last mile. Asked for transit alone, the route finishes on foot and the leave time becomes 06:00 — so the long leg goes by rail and the last 12 minutes by car.',
    legs: [['🚶', 'Walk to Savidor Center', 'Tel Aviv Savidor Center', '08:56→09:08'], ['🚆', 'Train to Hadera West', 'Savidor Center', '09:14→09:45'], ['🚗', 'Car from the station', 'Hadera West', '09:51→10:03']],
    options: [['08:56', '10:03', '🚆 Train + car · 1 change · 67 min · 9 min early', 'Savidor Center 09:14 · car waiting at Hadera West', 'current'], ['09:26', '10:33', '🚆 Train + car · 1 change · 67 min · 21 min late', 'Savidor Center 09:44', 'late']]
  },
  car: {
    icon: '🚗',
    head: 'Door to door · 38 min · parking included',
    leave: '09:26',
    arrive: '10:09',
    slack: '3 min early',
    board: 'traffic on Ayalon is 9 min heavier than usual',
    legs: [['🚗', 'Drive · Ayalon South', '', '09:26→10:04'], ['🅿️', 'Park and walk in', '', '10:04→10:09']],
    options: [['09:26', '10:09', '🚗 Drive · 38 min · 3 min early', 'traffic re-checked 2 min ago', 'current'], ['09:18', '09:58', '🚗 Drive · 34 min · 14 min early', 'leaving 8 min earlier clears the Ayalon merge', '']]
  },
  walk: {
    icon: '🚶',
    head: 'No walking route in the time you have',
    noRoute: 'On foot this is 1 h 52 m — you would have to leave at 08:20, before the school run.',
    options: []
  },
  bike: {
    icon: '🚴',
    head: 'Bike · 41 min · one hill',
    leave: '09:21',
    arrive: '10:06',
    slack: '6 min early',
    board: 'shower at the office · 41 min riding',
    legs: [['🚴', 'Ride · Rothschild → Menachem Begin', '', '09:21→10:02'], ['🚶', 'Lock up and walk in', '', '10:02→10:06']],
    options: [['09:21', '10:06', '🚴 Bike · 41 min · 6 min early', 'one hill on Menachem Begin', 'current']]
  }
};
const chainBox = document.getElementById('chain');
const optsBox = document.getElementById('opts');
const modeRow = document.getElementById('modeRow');
function renderTrip(mode) {
  const t = TRIP[mode];
  modeRow.querySelectorAll('.mode').forEach(b => b.classList.toggle('on', b.dataset.mode === mode));
  if (t.noRoute) {
    chainBox.innerHTML = `<p class="noroute">${t.icon} ${t.head}</p><p class="noroute-why">${t.noRoute}</p>`;
    optsBox.innerHTML = `<p class="opt-empty">Nothing to catch on this mode — try 🚌 or 🚗.</p>`;
    return;
  }
  chainBox.innerHTML = `
    <div class="ends"><div class="end"><span class="end-k">FROM</span><span class="end-v">Home · Rothschild 14</span></div><span class="end-a">→</span><div class="end"><span class="end-k">TO</span><span class="end-v">Strategy review · Menachem Begin 132</span></div></div>
    ${t.multimodal ? `<p class="mm">⚠️ ${t.multimodal}</p>` : ''}
    <div class="leg leg-wake"><span class="leg-i">⏰</span><span class="leg-t"><b>Wake up</b><i>before getting ready</i></span><span class="leg-c">06:47</span></div>
    <div class="leg"><span class="leg-i">🚿</span><span class="leg-t"><b>Get ready</b><i>45 min · learned from 12 mornings</i></span><span class="leg-c">${t.leave}</span></div>
    <div class="leg leg-leave"><span class="leg-i">🚪</span><span class="leg-t"><b>Leave home</b><i>don't miss it</i></span><span class="leg-c">${t.leave}</span></div>
    ${t.legs.map(([i, ttl, stop, time]) => `<div class="leg"><span class="leg-i">${i}</span><span class="leg-t"><b>${ttl}</b>${stop ? `<i>${stop}</i>` : ''}</span><span class="leg-c">${time}</span></div>`).join('')}
    <div class="leg leg-arrive"><span class="leg-i">🎯</span><span class="leg-t"><b>Arrive</b><i>${t.head} · ${t.slack}</i></span><span class="leg-c">${t.arrive}</span></div>`;
  optsBox.innerHTML = `<p class="opt-origin">measured from home, for 09:00 traffic</p>` + t.options.map(([d, a, detail, board, state]) => `
    <div class="opt ${state === 'current' ? 'opt-cur' : ''} ${state === 'late' ? 'opt-late' : ''}">
      <div class="opt-times"><span class="opt-d">${d}</span><span class="opt-arrow">→</span><span class="opt-a ${state === 'late' ? 'is-late' : ''}">${a}</span><span class="opt-sp"></span>${state === 'current' ? '<span class="opt-pill">current</span>' : '<button class="opt-take" type="button">Take it</button>'}</div>
      <p class="opt-detail">${detail}</p>
      <p class="opt-board">${board}</p>
    </div>`).join('');
  optsBox.querySelectorAll('.opt-take').forEach(b => b.addEventListener('click', () => {
    if (window.MA) MA.ev('departure_taken', {
      mode
    });
    b.closest('.opt').querySelectorAll('.opt-take').forEach(x => x.remove());
    b.closest('.opt').classList.add('opt-cur');
  }));
}
modeRow.addEventListener('click', e => {
  const b = e.target.closest('.mode');
  if (!b) return;
  renderTrip(b.dataset.mode);
  if (window.MA) MA.ev('mode_picked', {
    mode: b.dataset.mode
  });
});
renderTrip('bus');

/* ---------- conflict toggle ---------- */
const clashView = document.getElementById('clashView');
const CLASH = {
  calendar: `<div class="cal-only">
    <div class="cal-row"><span class="cal-t">14:30 – 16:00</span><span class="cal-x">Strategy review</span><span class="cal-p">Tel Aviv</span></div>
    <div class="cal-row"><span class="cal-t">16:00 – 17:00</span><span class="cal-x">Client meeting</span><span class="cal-p">Holon</span></div>
    <p class="cal-verdict">No overlap. Nothing flags. You find out at 16:06, driving.</p>
  </div>`,
  meira: null
};
document.getElementById('clashTabs').addEventListener('click', e => {
  const b = e.target.closest('button');
  if (!b) return;
  document.querySelectorAll('#clashTabs button').forEach(x => x.classList.toggle('on', x === b));
  clashView.querySelectorAll('[data-view]').forEach(v => v.classList.toggle('on', v.dataset.view === b.dataset.view));
  if (window.MA) MA.ev('clash_view', {
    view: b.dataset.view
  });
});

/* ---------- signup ---------- */
const okEmail = v => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v);
document.getElementById('submitBtn').addEventListener('click', () => {
  let good = true;
  [['fn', v => v.length > 0], ['ln', v => v.length > 0], ['ph', v => v.replace(/\D/g, '').length >= 7], ['em', okEmail]].forEach(([id, test]) => {
    const el = document.getElementById(id);
    const pass = test(el.value.trim());
    el.parentElement.classList.toggle('bad', !pass);
    if (!pass) good = false;
  });
  if (!good) {
    if (window.MA) MA.ev('signup_invalid');
    return;
  }
  const rec = {
    firstName: fn.value.trim(),
    lastName: ln.value.trim(),
    phone: ph.value.trim(),
    email: em.value.trim(),
    ts: new Date().toISOString()
  };
  try {
    const k = 'meira_signups',
      a = JSON.parse(localStorage.getItem(k) || '[]');
    a.push(rec);
    localStorage.setItem(k, JSON.stringify(a));
  } catch (e) {}
  document.getElementById('form').style.display = 'none';
  document.getElementById('ok').style.display = 'block';
  if (window.MA) MA.ev('signup_success');
});
})(); } catch (e) { __ds_ns.__errors.push({ path: "meira-demo.js", error: String((e && e.message) || e) }); }

// ui_kits/lumi-app/AppShell.jsx
try { (() => {
const {
  useState
} = React;

/** Phone frame + tab bar. Four tabs + chat — Timeline is folded into Today. */
function AppShell({
  tab,
  onTab,
  children
}) {
  const {
    TabBar
  } = window.MeiraAIDesignSystem_1a858d;
  return /*#__PURE__*/React.createElement("div", {
    style: {
      width: 390,
      height: 844,
      background: 'var(--surface-app)',
      borderRadius: 'var(--radius-screen)',
      overflow: 'hidden',
      display: 'flex',
      flexDirection: 'column',
      position: 'relative',
      boxShadow: '0 24px 60px rgba(214,165,55,.22)'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      minHeight: 0,
      overflowY: 'auto',
      paddingBottom: 96
    }
  }, children), /*#__PURE__*/React.createElement(TabBar, {
    active: tab,
    onSelect: onTab,
    tabs: [{
      icon: '☀️',
      label: 'Today'
    }, {
      icon: '☑️',
      label: 'Tasks'
    }, {
      icon: '🗺️',
      label: 'Trips'
    }, {
      icon: '👤',
      label: 'Profile'
    }],
    style: {
      position: 'absolute',
      left: 0,
      right: 0,
      bottom: 0
    }
  }));
}

/** The greeting header. Fredoka, never a serif. */
function AppHeader({
  initial = 'K',
  onRead,
  onTasks
}) {
  const {
    IconButton,
    Avatar
  } = window.MeiraAIDesignSystem_1a858d;
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'flex-end',
      justifyContent: 'space-between',
      gap: 10,
      padding: '52px 16px 14px',
      borderBottom: '1px solid var(--border-hairline)',
      background: 'var(--surface-app)'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      minWidth: 0
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      fontFamily: 'var(--font-body)',
      fontWeight: 'var(--weight-body-bold)',
      fontSize: 'var(--text-body-lg)',
      color: 'var(--text-secondary)',
      whiteSpace: 'nowrap'
    }
  }, "\u2600\uFE0F Good afternoon"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: 'var(--font-display)',
      fontWeight: 'var(--weight-display)',
      fontSize: 30,
      lineHeight: 1.15,
      color: 'var(--text-heading)',
      marginTop: 2
    }
  }, "Meira")), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      flex: 'none'
    }
  }, /*#__PURE__*/React.createElement(IconButton, {
    icon: "\uD83D\uDD0A",
    label: "Read my day",
    onClick: onRead
  }), /*#__PURE__*/React.createElement(IconButton, {
    icon: "\u2611\uFE0F",
    label: "Tasks",
    onClick: onTasks
  }), /*#__PURE__*/React.createElement(Avatar, {
    initial: initial
  })));
}
Object.assign(window, {
  AppShell,
  AppHeader
});
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/lumi-app/AppShell.jsx", error: String((e && e.message) || e) }); }

// ui_kits/lumi-app/TodayScreen.jsx
try { (() => {
const {
  useState
} = React;

// CATEGORY_META, inlined — the bundle only exposes PascalCase names.
const LUMI_CATS = {
  general: {
    color: 'var(--cat-general)',
    icon: '📌'
  },
  work: {
    color: 'var(--cat-work)',
    icon: '💼'
  },
  zoom: {
    color: 'var(--cat-zoom)',
    icon: '💻'
  }
};
const catFor = k => LUMI_CATS[k] || LUMI_CATS.general;

/**
 * Today — one screen. The Timeline tab is folded in below the fold as
 * "Today's plan", so there is a single place the day lives.
 *
 * Fixes against the current build: gold instead of terracotta, Fredoka
 * instead of the serif, a 1.5px gold border on the next card, round gold
 * checkboxes, warm category rails, and clashing tasks stacked at full
 * width instead of squeezed into ~90px columns.
 */
function TodayScreen() {
  const {
    NextUpCard,
    YesterdayCard,
    AttentionBanner,
    Card,
    SectionLabel,
    FilterChip,
    TaskRow,
    Checkbox
  } = window.LumiAIDesignSystem_1a858d;
  const [offer, setOffer] = useState(true);
  const [backlog, setBacklog] = useState(true);
  const [done, setDone] = useState({
    0: true,
    1: true
  });
  const toggle = i => setDone(d => ({
    ...d,
    [i]: !d[i]
  }));
  const rows = [{
    start: '10:30',
    end: '12:54',
    title: 'בבוקר לנסוע לחתום אבטלה בפעם האחרונה',
    category: 'general',
    duration: '2h 24m',
    place: '28, Gaaton, Nahariyya, N…',
    rtl: true
  }, {
    start: '13:00',
    end: '16:32',
    title: 'לעשות את המצגת',
    category: 'work',
    duration: '3h 32m',
    rtl: true
  }, {
    start: '13:10',
    end: '13:40',
    title: 'לעשות lean canvas model',
    category: 'work',
    duration: '30 min',
    rtl: true,
    clash: true
  }, {
    start: '16:00',
    end: '21:00',
    title: 'משמרת',
    category: 'work',
    duration: '5h',
    remaining: '4h 13m left',
    rtl: true
  }, {
    start: '17:00',
    end: '18:00',
    title: 'Your R&D Bottleneck Has Moved: How to Get More R&D',
    category: 'zoom',
    duration: '1h'
  }];
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gap: 12,
      gridTemplateColumns: 'minmax(0,1fr)',
      padding: '14px 16px 0'
    }
  }, offer ? /*#__PURE__*/React.createElement(AttentionBanner, {
    tone: "card",
    action: "Play \u25B6",
    onDismiss: () => setOffer(false)
  }, "\uD83D\uDD0A Want to hear your day?") : null, /*#__PURE__*/React.createElement(NextUpCard, {
    day: "today",
    title: "Your R&D Bottleneck Has Moved: How to Get More R&D \u2026",
    steps: [{
      icon: '📍',
      time: '17:00',
      label: 'starts'
    }],
    onStart: () => {}
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      fontFamily: 'var(--font-body)',
      fontWeight: 'var(--weight-body-bold)',
      fontSize: 'var(--text-meta)',
      color: 'var(--text-secondary)',
      padding: '0 2px'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      whiteSpace: 'nowrap'
    }
  }, "4/7 tasks today"), /*#__PURE__*/React.createElement("span", {
    style: {
      color: 'var(--text-tertiary)'
    }
  }, "\xB7"), /*#__PURE__*/React.createElement("span", {
    style: {
      color: 'var(--text-time)',
      whiteSpace: 'nowrap'
    }
  }, "\uD83D\uDEAA 08:52"), /*#__PURE__*/React.createElement("span", {
    style: {
      color: 'var(--text-tertiary)'
    }
  }, "\xB7"), /*#__PURE__*/React.createElement("span", {
    style: {
      flex: 1,
      minWidth: 0,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap'
    }
  }, "\uD83C\uDFAF Your R&D Bottleneck Has Move")), /*#__PURE__*/React.createElement(YesterdayCard, {
    title: 'Have you done "לעשות lean canvas model"?',
    open: backlog,
    onToggle: () => setBacklog(!backlog),
    items: [{
      icon: '💼',
      text: 'לעשות lean canvas model'
    }]
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 8
    }
  }, /*#__PURE__*/React.createElement(FilterChip, null, "\uD83D\uDE8A In transit")), /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 4,
      display: 'grid',
      gap: 10,
      gridTemplateColumns: 'minmax(0,1fr)'
    }
  }, /*#__PURE__*/React.createElement(SectionLabel, null, "Today's plan"), /*#__PURE__*/React.createElement(AttentionBanner, {
    tone: "clash"
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 10
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      background: 'var(--state-danger)',
      color: 'var(--lumi-white)',
      borderRadius: 'var(--radius-full)',
      padding: '3px 10px',
      fontSize: 'var(--text-caption)',
      fontWeight: 'var(--weight-body-heavy)',
      letterSpacing: '0.6px',
      flex: 'none'
    }
  }, "MISSED"), /*#__PURE__*/React.createElement("span", {
    style: {
      flex: 1,
      minWidth: 0
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      textDecoration: 'line-through',
      color: 'var(--state-danger)'
    }
  }, "Leave 08:52"), /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'block',
      fontWeight: 'var(--weight-body-semi)',
      fontSize: 'var(--text-meta-sm)',
      marginTop: 1
    }
  }, "Departure gone \xB7 tap for the next ones")), /*#__PURE__*/React.createElement("span", {
    style: {
      color: 'var(--text-tertiary)',
      flex: 'none'
    }
  }, "\u203A"))), rows.map((r, i) => {
    const meta = catFor(r.category);
    const isDone = !!done[i];
    return /*#__PURE__*/React.createElement(React.Fragment, {
      key: i
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        display: 'flex',
        gap: 10,
        opacity: isDone ? 'var(--done-opacity)' : 1
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        width: 46,
        flex: 'none',
        textAlign: 'right',
        paddingTop: 12
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        fontFamily: 'var(--font-body)',
        fontWeight: 'var(--weight-body-heavy)',
        fontSize: 'var(--text-meta)',
        color: 'var(--text-heading)',
        fontVariantNumeric: 'tabular-nums'
      }
    }, r.start), /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 'var(--text-caption)',
        color: 'var(--text-tertiary)',
        marginTop: 2,
        fontVariantNumeric: 'tabular-nums'
      }
    }, r.end)), /*#__PURE__*/React.createElement("div", {
      style: {
        flex: 1,
        minWidth: 0,
        background: 'var(--surface-card)',
        borderRadius: 'var(--radius-note)',
        borderLeft: `4px solid ${meta.color}`,
        padding: '11px 13px',
        boxShadow: 'var(--shadow-card)'
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        display: 'flex',
        alignItems: 'flex-start',
        gap: 10
      }
    }, /*#__PURE__*/React.createElement(Checkbox, {
      checked: isDone,
      onChange: () => toggle(i),
      style: {
        marginTop: 1
      }
    }), /*#__PURE__*/React.createElement("div", {
      style: {
        flex: 1,
        minWidth: 0
      }
    }, /*#__PURE__*/React.createElement("div", {
      dir: r.rtl ? 'rtl' : 'ltr',
      style: {
        fontFamily: 'var(--font-body)',
        fontWeight: 'var(--weight-body-bold)',
        fontSize: 'var(--text-body-sm)',
        lineHeight: 'var(--leading-snug)',
        color: isDone ? 'var(--text-tertiary)' : 'var(--text-heading)',
        textDecoration: isDone ? 'line-through' : 'none'
      }
    }, meta.icon, " ", r.title), /*#__PURE__*/React.createElement("div", {
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        marginTop: 5,
        fontSize: 'var(--text-meta-sm)',
        color: 'var(--text-secondary)'
      }
    }, /*#__PURE__*/React.createElement("span", {
      style: {
        fontWeight: 'var(--weight-body-bold)',
        whiteSpace: 'nowrap'
      }
    }, r.duration), r.remaining ? /*#__PURE__*/React.createElement("span", {
      style: {
        color: 'var(--text-time)',
        fontWeight: 'var(--weight-body-heavy)',
        whiteSpace: 'nowrap'
      }
    }, "\xB7 ", r.remaining) : null, r.place ? /*#__PURE__*/React.createElement("span", {
      style: {
        flex: 1,
        minWidth: 0,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap'
      }
    }, "\xB7 \uD83D\uDCCD ", r.place) : null))))), r.clash ? /*#__PURE__*/React.createElement("div", {
      style: {
        marginLeft: 56
      }
    }, /*#__PURE__*/React.createElement(AttentionBanner, {
      tone: "clash",
      style: {
        borderRadius: 'var(--radius-chip)',
        padding: '8px 12px',
        fontSize: 'var(--text-meta-sm)'
      }
    }, "\u26A0\uFE0F Both in the same place \u2014 30 min double-booked")) : null);
  })));
}
window.TodayScreen = TodayScreen;
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/lumi-app/TodayScreen.jsx", error: String((e && e.message) || e) }); }

__ds_ns.MeiraCoin = __ds_scope.MeiraCoin;

__ds_ns.MeiraWordmark = __ds_scope.MeiraWordmark;

__ds_ns.Avatar = __ds_scope.Avatar;

__ds_ns.Button = __ds_scope.Button;

__ds_ns.Card = __ds_scope.Card;

__ds_ns.Checkbox = __ds_scope.Checkbox;

__ds_ns.FilterChip = __ds_scope.FilterChip;

__ds_ns.IconButton = __ds_scope.IconButton;

__ds_ns.SearchField = __ds_scope.SearchField;

__ds_ns.SectionLabel = __ds_scope.SectionLabel;

__ds_ns.TimeChip = __ds_scope.TimeChip;

__ds_ns.RewardToast = __ds_scope.RewardToast;

__ds_ns.Waveform = __ds_scope.Waveform;

__ds_ns.ChatBubble = __ds_scope.ChatBubble;

__ds_ns.TabBar = __ds_scope.TabBar;

__ds_ns.AttentionBanner = __ds_scope.AttentionBanner;

__ds_ns.MapPinConfirm = __ds_scope.MapPinConfirm;

__ds_ns.DayTimeline = __ds_scope.DayTimeline;

__ds_ns.GapSuggestionCard = __ds_scope.GapSuggestionCard;

__ds_ns.NextUpCard = __ds_scope.NextUpCard;

__ds_ns.TravelChainCard = __ds_scope.TravelChainCard;

__ds_ns.WakeAlertBanner = __ds_scope.WakeAlertBanner;

__ds_ns.YesterdayCard = __ds_scope.YesterdayCard;

__ds_ns.CategoryBadge = __ds_scope.CategoryBadge;

__ds_ns.DayTaskCard = __ds_scope.DayTaskCard;

__ds_ns.EmptyState = __ds_scope.EmptyState;

__ds_ns.PriorityGroup = __ds_scope.PriorityGroup;

__ds_ns.StickyNote = __ds_scope.StickyNote;

__ds_ns.SubtaskList = __ds_scope.SubtaskList;

__ds_ns.TaskCard = __ds_scope.TaskCard;

__ds_ns.TaskRow = __ds_scope.TaskRow;

})();
