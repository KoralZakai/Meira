# Fix Review Findings Design

## Purpose
Address 3 MEDIUM-severity findings from the cc10x code review of the Lumi AI Expo diff:
prevent OAuth URL fragment leakage to production log collectors, prevent infinite loading
screen on font-fetch failure, and eliminate dual color conventions in OnboardingScreen.

## Users
Developers shipping the Lumi app to production (Android EAS build).

## Success Criteria
- [ ] No `console.log` calls in `SupabaseAuthService.ts` exist outside a `__DEV__` guard
- [ ] `App.tsx` handles `useFonts` error so app renders with system fonts on CDN failure
- [ ] `OnboardingScreen.tsx` contains zero hardcoded hex values in its StyleSheet — only BRAND.* tokens
- [ ] TypeScript compiles without new errors
- [ ] App starts normally in Expo Go (no visual regressions on the onboarding flow)

## Constraints
- Android-only Expo managed workflow; no iOS consideration needed
- Use existing `BRAND.*` tokens from `src/constants/theme.ts` — no new tokens
- Gate console.log on `__DEV__` (not full removal) so auth debug is available in dev builds
- Do not change any logic — these are cosmetic / safety fixes only

## Out of Scope
- Refactoring any logic in SupabaseAuthService, App, or OnboardingScreen beyond the 3 findings
- Adding new BRAND tokens
- Updating tests or storybook
- Migrating other screens to BRAND tokens (only OnboardingScreen summary card section)

## Approach Chosen
**Direct mechanical edits** — no architectural change. Three independent one-file edits applied sequentially.

## Domain Glossary
- **BRAND tokens** — canonical design-token exports from `src/constants/theme.ts` (`BRAND.sunGold`, `BRAND.warmInk`, etc.); the single source of truth for Lumi's warm claymorphism palette
- **`__DEV__`** — Expo/React Native global boolean; `true` in debug/Expo Go, `false` in release builds

## Decisions (ADR notes)
- **Decision**: Gate `console.log` calls on `__DEV__` rather than remove entirely
  **Rejected**: Full removal
  **Why**: Auth debug logging is valuable during development; `__DEV__` guard is zero-cost in production (dead-code eliminated by Metro bundler) and preserves the dev experience

- **Decision**: Use `BRAND.creamCard` for `#FFF8D9` (summaryCard background)
  **Rejected**: `BRAND.cream` (#FCF7EC) or `BRAND.honey` (#FBE6A0)
  **Why**: `#FFF8D9` is a card surface (nearly white warm), which semantically matches `creamCard`; `honey` is for soft fills/focus highlights; `cream` is the app background

- **Decision**: Use `BRAND.line` for `#EEDC9A` (summaryCard border)
  **Rejected**: `BRAND.honey`
  **Why**: `#EEDC9A` is a divider/border — `BRAND.line` (#F1E8D6) is the canonical border token; `honey` is a fill token

## Architecture
Three independent single-file edits. No cross-file wiring.

## Components
1. **`src/services/SupabaseAuthService.ts`** — wrap 5 `console.log` calls in `if (__DEV__) { ... }`
2. **`App.tsx`** — destructure `fontError` from `useFonts`; change loading gate from `!fontsLoaded` to `!fontsLoaded && !fontError`
3. **`src/screens/OnboardingScreen.tsx`** — replace 10 hardcoded hex values with BRAND tokens

## Data Flow
N/A — no data flow changes.

## Hex-to-Token Mapping (Fix 3)

| File location | Hardcoded hex | BRAND token | Semantic reason |
|---|---|---|---|
| Line 462 (micButton ActivityIndicator) | `#6B4A00` | `BRAND.warmInk` | dark warm ink, primary text color |
| Line 541 (typingLabel color) | `#3B2A00` | `BRAND.warmInk` | headings / primary text |
| Line 553 (dot backgroundColor) | `#6D531D` | `BRAND.inkSoft` | secondary text/decorative |
| Line 563 (summaryCard backgroundColor) | `#FFF8D9` | `BRAND.creamCard` | card / surface background |
| Line 567 (summaryCard borderColor) | `#EEDC9A` | `BRAND.line` | borders / dividers |
| Line 571 (summaryLabel color) | `#7B6021` | `BRAND.inkSoft` | secondary text |
| Line 578 (summaryValue color) | `#3B2A00` | `BRAND.warmInk` | primary text |
| Line 591 (summarySecondaryButton bg) | `#FFF4CF` | `BRAND.honey` | soft fill / secondary action |
| Line 597 (summarySecondaryText color) | `#6B5521` | `BRAND.inkSoft` | secondary text |
| Line 601 (summaryPrimaryButton bg) | `#F5C842` | `BRAND.sunGold` | primary action / accent |
| Line 608 (summaryPrimaryText color) | `#4A3400` | `BRAND.warmInk` | primary text on gold bg |

## Error Handling
- Fix 2: `if (!fontsLoaded && !fontError)` — on error, `fontsLoaded=false` but `fontError` is truthy, so the condition is false and the app renders with system fonts. No crash path.
- Fix 1: `__DEV__` guard is a compile-time constant — no runtime risk.
- Fix 3: Pure style replacement — no runtime risk.

## Testing Strategy
Manual verification in Expo Go after each edit:
1. **Fix 1**: Run app, tap Sign In with Google — confirm no `[AUTH]` lines appear in release log simulation (`__DEV__=false` can be forced via env or checked in release build)
2. **Fix 2**: Verify app loads normally. Edge case (font CDN fail) not easily testable in Expo Go but logic path is provably correct by inspection.
3. **Fix 3**: Navigate to OnboardingScreen / summary card — confirm visual appearance is unchanged (colors are semantically equivalent substitutions).
4. **TypeScript**: `npx tsc --noEmit` must exit 0.

## Questions Resolved
- Q: Remove console.log entirely or gate on `__DEV__`?
  A: Gate on `__DEV__` — preserves dev debugging, zero cost in production
- Q: Which BRAND token for `#FFF8D9` summary card background?
  A: `BRAND.creamCard` — semantically a card surface, not a fill or background
