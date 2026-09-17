# Fix Review Findings Implementation Plan

> **For Claude:** REQUIRED: Follow this plan task-by-task. These are mechanical safety/cosmetic edits — no logic changes.
> **Design:** See `docs/plans/2026-06-24-fix-review-findings-design.md` for full specification (authoritative).

**Goal:** Fix 3 MEDIUM-severity cc10x review findings — gate OAuth debug logs on `__DEV__`, handle `useFonts` error, finish the OnboardingScreen design-token migration.

**Architecture:** Three independent single-file edits. No cross-file wiring, no logic change.

**Tech Stack:** Expo managed workflow, React Native, TypeScript. BRAND.* design tokens from `src/constants/theme.ts`.

**Prerequisites:** None. Files exist and were verified against the design. All BRAND tokens used below exist and are already imported in `OnboardingScreen.tsx`.

**Durable Decisions:**
- Gate `console.log` on `__DEV__` (not removal) — preserves dev debugging, dead-code-eliminated by Metro in release.
- `useFonts` returns `[loaded, error]`; render with system fonts when `error` is truthy rather than blocking forever.
- BRAND.* tokens are the single source of truth for the Lumi palette. Hex-to-token mapping is fixed by the design table — do not improvise substitutions.

---

## Plan: Fix Review Findings

### Human Layer

### Executive Summary
- Apply three mechanical edits exactly as the user-approved design specifies: `__DEV__`-gate 5 auth logs, add a `fontError` escape hatch, and swap 10 hardcoded hex values for their mapped BRAND tokens.
- This fits the codebase as-is: every target line matches the design, every BRAND token exists in `theme.ts` and is already imported in `OnboardingScreen.tsx`. No new dependencies, no new tokens, no logic touched.

### What I Verified vs What Still Needs Confirmation
- **Confident because:** Read all three files at the exact design line numbers — code matches the design verbatim. Confirmed `BRAND.sunGold/warmInk/inkSoft/creamCard/honey/line` all exist in `src/constants/theme.ts` and `BRAND` is imported at `OnboardingScreen.tsx:16`. `__DEV__` is a standard RN global.
- **Still needs confirmation:** None blocking. Visual equivalence of token swaps is asserted by the design's semantic mapping; verify by eye in Expo Go.
- **Key risks:** Only risk is a typo'd token name or missed brace — caught by `npx tsc --noEmit` and a visual check.

### Request Summary
- Resolve the 3 medium findings from REVIEW wf-20260624173437 with no behavior change.

### Requirements Snapshot
- Gate the 5 `console.log` calls in `SupabaseAuthService.ts` on `__DEV__` (not full removal).
- Destructure `fontError` in `App.tsx`; change the loading gate from `!fontsLoaded` to `!fontsLoaded && !fontError`.
- Replace the 10 hardcoded hex values in `OnboardingScreen.tsx` per the design's hex-to-token table.
- `npx tsc --noEmit` exits 0. No logic changes.

### Constraints Snapshot
- Android-only Expo managed workflow.
- Use existing BRAND tokens only — no new tokens.
- Cosmetic/safety fixes only.

### In Scope
- The 3 named edits in the 3 named files.

### Out Of Scope
- Refactoring logic in any of the 3 files.
- Adding BRAND tokens, updating tests/storybook, migrating other screens.

### Planning Mode
- Plan mode: `direct`
- Verification rigor: `standard`

### Open Decisions
- None.

### Differences From Agreement
- None.

### Recommended Defaults
- None required — design resolves all decisions.

### Execution Contract Layer

### Codebase Reality Check
- **Verified files / surfaces:** `src/services/SupabaseAuthService.ts` (lines 20, 29, 34, 40, 45 — all `console.log('[AUTH]...')`), `App.tsx` (lines 147–162 — `useFonts` + `!fontsLoaded` gate), `src/screens/OnboardingScreen.tsx` (lines 462, 541, 553, 563, 567, 571, 578, 591, 597, 601, 608 — hardcoded hex), `src/constants/theme.ts` (BRAND token definitions).
- **Existing patterns / constraints:** `BRAND` already imported at `OnboardingScreen.tsx:16`. StyleSheet section already uses `BRAND.*` for most keys (e.g. lines 475, 487, 516, 521) — the target lines are the migration leftovers.
- **Pressure points / contradictions:** None. Each target line is independent; no shared state.
- **Decision records in scope (treated as SETTLED):** No ADRs found in scope (no `docs/adr/`, `docs/decisions/`, or `docs/rfcs/`). The design doc itself records 3 ADR-style decisions; those are honored.
- **Contradicted decisions (flagged, not silently overridden):** None.

### Plan-vs-Code Gaps
| Current code / behavior | Planned change | Gap / risk | Plan response |
|-------------------------|----------------|------------|---------------|
| 5 unguarded `console.log('[AUTH]...')` leak OAuth URL fragments to prod log collectors | Wrap each in `if (__DEV__) { ... }` | None — `__DEV__` is compile-time constant | Task 1 |
| `const [fontsLoaded] = useFonts(...)` discards error; `if (!fontsLoaded)` blocks forever on CDN fail | Destructure `fontError`; gate `!fontsLoaded && !fontError` | None — error path renders with system fonts | Task 2 |
| 10 hardcoded hex in StyleSheet break single-source-of-truth | Replace per design table | Typo'd token name → tsc/visual catch | Task 3 |

### Assumption Ledger
- **Proven by code:** Target lines match the design verbatim; BRAND tokens exist and are imported; `__DEV__` and `useFonts` error tuple are standard.
- **Inferred:** Token swaps are visually equivalent (design asserts semantic match). Low risk.
- **Needs user confirmation:** None.

### Fresh Review Resolution
- **Accepted findings:** None yet (no fresh review pass run at authoring time).
- **Rejected findings:** None.

### Current State
- Files are in the working tree (uncommitted modifications per git status). All target lines present and verified.

### Alternatives
- N/A for a `direct` plan — design already rejected full-removal of logs and alternative token choices with recorded rationale.

### Drawbacks
- N/A.

### Critical-Path Verification Design
- Behavior contract: Not required (standard rigor). Contract is "no observable behavior change except: prod logs no longer leak auth URLs, and font-CDN failure renders system fonts instead of hanging."
- Edge-case catalog: Font CDN failure → `fontError` truthy → app renders (concise; not easily reproducible in Expo Go, proven by inspection).
- Provable properties: None.
- Purity boundary map: Not required.
- Verification strategy: `npx tsc --noEmit` exit 0 + manual Expo Go smoke (sign-in flow, onboarding summary card visuals).

### Phase Dependency Map
- Phase 1: no dependencies; produces all 3 fixes. Single phase — three independent tasks.

### Phase Plan

## Phase 1: All 3 findings fixed and TypeScript compiles

> **Exit Criteria:** All 5 `console.log` in `SupabaseAuthService.ts` are inside `if (__DEV__)` blocks; `App.tsx` gate reads `!fontsLoaded && !fontError`; zero hardcoded hex remain in `OnboardingScreen.tsx` StyleSheet; `npx tsc --noEmit` exits 0.

- **Objective:** Apply the 3 mechanical edits; prove the tree still type-checks.
- **Repo surfaces:** the 3 files named above.
- **Dependencies:** none.
- **Allowed scope:** only the lines named in the design tables.
- **Out-of-scope drift:** do not touch logic, do not add tokens, do not migrate other screens or files.
- **Expected artifacts:** 3 edited files.
- **Required checks:** `npx tsc --noEmit` exit 0; visual smoke in Expo Go.
- **Checkpoint type:** none (AFK).
- **Exit criteria:** as above.

#### Task 1: Gate auth logs on `__DEV__`

**Files:**
- Modify: `src/services/SupabaseAuthService.ts` (lines 20, 29, 34, 40, 45)

**Step 1:** Wrap each of the 5 `console.log('[AUTH] ...')` calls in `if (__DEV__) { ... }`. Each is a single statement, so:

```typescript
// Line 20
if (__DEV__) console.log('[AUTH] signInWithGoogle start; redirectTo =', redirectTo);

// Line 29
if (__DEV__) console.log('[AUTH] signInWithOAuth →', { hasUrl: !!data?.url, url: data?.url?.slice(0, 90), error: error?.message });

// Line 34
if (__DEV__) console.log('[AUTH] WebBrowser result →', { type: result.type, url: (result as { url?: string }).url?.slice(0, 90) });

// Line 40
if (__DEV__) console.log('[AUTH] redirect code present:', !!code);

// Line 45
if (__DEV__) console.log('[AUTH] exchangeCodeForSession →', { session: !!sessionData?.session, error: exchangeError?.message });
```

Keep the rest of each line (the arguments) byte-for-byte identical — only prepend `if (__DEV__) `.

**Step 2:** Run `npx tsc --noEmit`. Expected: exit 0 (no new errors).

**Step 3:** Commit (only when the user asks).

#### Task 2: Handle `useFonts` error in `App.tsx`

**Files:**
- Modify: `App.tsx` (lines 147, 156)

**Step 1:** Destructure `fontError`:

```typescript
const [fontsLoaded, fontError] = useFonts({
  Fredoka_600SemiBold,
  Fredoka_700Bold,
  Nunito_400Regular,
  Nunito_600SemiBold,
  Nunito_700Bold,
  Nunito_800ExtraBold,
});
```

**Step 2:** Change the loading gate (line 156) from `if (!fontsLoaded) {` to:

```typescript
if (!fontsLoaded && !fontError) {
```

Leave the loading `View`/`ActivityIndicator` body unchanged.

**Step 3:** Run `npx tsc --noEmit`. Expected: exit 0.

**Step 4:** Commit (only when the user asks).

#### Task 3: Finish OnboardingScreen token migration

**Files:**
- Modify: `src/screens/OnboardingScreen.tsx` (lines 462, 541, 553, 563, 567, 571, 578, 591, 597, 601, 608)

**Step 1:** Apply each replacement exactly per the design's hex-to-token table. The 11 edits (10 distinct token swaps across 11 sites — note `#3B2A00` appears at both 541 and 578):

| Line | Current | Replace with |
|---|---|---|
| 462 (micButton ActivityIndicator `color="#6B4A00"`) | `color="#6B4A00"` | `color={BRAND.warmInk}` |
| 541 (typingLabel) | `color: '#3B2A00'` | `color: BRAND.warmInk` |
| 553 (dot) | `backgroundColor: '#6D531D'` | `backgroundColor: BRAND.inkSoft` |
| 563 (summaryCard) | `backgroundColor: '#FFF8D9'` | `backgroundColor: BRAND.creamCard` |
| 567 (summaryCard border) | `borderColor: '#EEDC9A'` | `borderColor: BRAND.line` |
| 571 (summaryLabel) | `color: '#7B6021'` | `color: BRAND.inkSoft` |
| 578 (summaryValue) | `color: '#3B2A00'` | `color: BRAND.warmInk` |
| 591 (summarySecondaryButton) | `backgroundColor: '#FFF4CF'` | `backgroundColor: BRAND.honey` |
| 597 (summarySecondaryText) | `color: '#6B5521'` | `color: BRAND.inkSoft` |
| 601 (summaryPrimaryButton) | `backgroundColor: '#F5C842'` | `backgroundColor: BRAND.sunGold` |
| 608 (summaryPrimaryText) | `color: '#4A3400'` | `color: BRAND.warmInk` |

Note line 462 is a JSX prop (`color="#6B4A00"` → `color={BRAND.warmInk}` — string-attr becomes brace-expression). The other 10 are StyleSheet values (`'#hex'` → `BRAND.token`, no quotes).

**Step 2:** Grep to confirm zero hardcoded hex remain in the StyleSheet. Run: search `OnboardingScreen.tsx` for `#[0-9A-Fa-f]{6}`. Expected: no matches (or only matches that were never in scope — there should be none in this file after the swaps).

**Step 3:** Run `npx tsc --noEmit`. Expected: exit 0.

**Step 4:** Commit (only when the user asks).

  - **Interfaces** (carried verbatim into the builder dispatch for this phase):
    - **Consumes:** `BRAND.warmInk: string`, `BRAND.inkSoft: string`, `BRAND.creamCard: string`, `BRAND.line: string`, `BRAND.honey: string`, `BRAND.sunGold: string` (all from `src/constants/theme.ts`, already imported at `OnboardingScreen.tsx:16`); `__DEV__: boolean` (RN global); `useFonts(...): [boolean, Error | null]`.
    - **Produces:** none (no new exported symbols; later phases — none).

### Phase Autonomy Classification
| Phase | Checkpoint Type | Classification | Reason Category | Reason |
|-------|----------------|----------------|-----------------|--------|
| Phase 1 | none | AFK | — | Mechanical edits with a fixed mapping table and tsc gate; no judgment, no external access, no design choice. |

### Plan Self-Review (Type-Consistency Scan)
- **Cross-phase reference check:** No cross-phase reference drift (single phase; all consumed symbols — BRAND tokens, `__DEV__`, `useFonts` — are pre-existing in the codebase, verified present).
- **Dangling references fixed:** None.
- **Signature drift fixed:** None.
- **"Similar to Task N" placeholders resolved:** None (all 11 edits spelled out verbatim in the table).

### Acceptance Checks
- `npx tsc --noEmit` exits 0.
- Grep `OnboardingScreen.tsx` for `#[0-9A-Fa-f]{6}` → no matches in StyleSheet/JSX.
- All 5 `[AUTH]` logs are inside `if (__DEV__)`.
- `App.tsx` gate reads `!fontsLoaded && !fontError`.
- Manual Expo Go smoke: app launches; onboarding summary card looks unchanged; Google sign-in still flows.

### Risks And Mitigations
| Risk | P | I | Score | Mitigation |
|------|---|---|-------|------------|
| Typo'd BRAND token name | 2 | 2 | 4 | `npx tsc --noEmit` flags unknown property; visual check |
| Missed/extra brace gating a log | 2 | 2 | 4 | tsc compile + the 5 logs are single-statement (no block needed) |
| Visual regression from token swap | 1 | 2 | 2 | Design asserts semantic equivalence; manual Expo Go check |

### Summary
- Plan saved: docs/plans/2026-06-24-fix-review-findings-plan.md
- Phases: 1
- Risks: 3 identified (all score ≤ 4)
- Key decisions: gate-not-remove logs; `fontError` escape hatch; fixed hex-to-token mapping.

### Recommended Skills for BUILD (SKILL_HINTS for Router)
- expo:building-native-ui (RN/UI token work on OnboardingScreen)

### Confidence Score: 95/100
- Every target line read and verified against the design; all BRAND tokens confirmed present and imported; mapping is fully tabulated; tsc gate is deterministic.
- Could only improve with an automated visual snapshot test, which is out of scope (no test infra in project).

**Key Assumptions**:
- Token swaps are visually equivalent (design-asserted, verify by eye).

### Findings
- `#3B2A00` appears at two sites (541, 578) — both map to `BRAND.warmInk`. Confirmed both are listed.

### Success Criteria
- [ ] All 5 auth logs gated on `__DEV__`
- [ ] `App.tsx` renders on font error instead of hanging
- [ ] Zero hardcoded hex in OnboardingScreen StyleSheet/JSX
- [ ] `npx tsc --noEmit` exits 0
- [ ] No visual regression in Expo Go
