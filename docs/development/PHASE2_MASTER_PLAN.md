# CampusLink — Phase 2 Master Plan

## Status

Phase 2 active.

**Approved direction:** Counter

**Approved milestones**
- 2A — Design system + primitives + code splitting
- 2B — Application shell + navigation
- Login/Auth refinement
- 2C — Home visual benchmark + auth performance fix

**Next milestone:** 2D — Post Request

## 1. Phase 2 Goal

Phase 2 is a complete product UI/UX transformation.

Treat the Phase 1 frontend as the functional baseline, not as a visual constraint.

The target is a product that feels:

- premium
- distinctive
- sophisticated
- youthful
- human
- editorial
- memorable
- fast
- highly intentional
- unmistakably CampusLink

Avoid:

- generic SaaS/dashboard aesthetics
- AI-generated UI aesthetics
- food-delivery clones
- excessive cards
- excessive rounded rectangles
- generic gradients
- glassmorphism
- decoration without product purpose
- animation spam

Preserve real functionality and the verified backend/security model.

## 2. Product Positioning

CampusLink is not a conventional delivery company.

There is no anonymous fleet.

The product is: **Students helping students nearby.**

One student is already going somewhere and can carry something for another student on the way.

The experience should communicate:

- proximity
- opportunity
- trust
- movement
- clarity
- immediacy
- campus-native behavior

## 3. Final Visual Direction — Counter

Earlier directions were discarded.

Counter is a typographic board of postings inspired by:

- contemporary campus publications
- editorial layouts
- premium lifestyle products
- classified/notice-board structures
- strong typography
- ruled separators
- selective accent color

**Core visual principles**

- Typography is a primary visual tool.
- Ruled separators are preferred to heavy card borders.
- Scale contrast creates hierarchy.
- Color is selective and meaningful.
- Asymmetry is allowed when it strengthens composition.
- Whitespace is structural, not accidental.
- Not everything should be a card.
- Not every section should look identical.
- Important information should have visual weight.
- Interaction should be obvious without visual noise.

## 4. Typography

Approved stack:

- **Instrument Serif** — display/editorial
- **Instrument Sans** — UI/body
- **IBM Plex Mono** — data, status, OTP, utility information

Display typography should create identity. Body typography should maximize readability. Mono should make useful data feel deliberate and legible.

## 5. Color Direction

The earlier Dusk Wayfinding orange/teal direction is discarded.

Counter uses:

- warm paper/neutral ground
- deep ink
- deep wine/amaranth signal
- restrained supporting neutrals

The wine/amaranth accent must be rare, meaningful, high-impact. Do not turn every element into the accent.

## 6. Motion Philosophy

Motion comes after visual composition.

Use:

- CSS transitions
- lightweight React presence/layout transitions
- GSAP only where multi-element timelines add meaningful product value

Potential signature moments:

- OTP reveal
- meaningful order-state transition
- delivery completion

Motion should communicate progress, state, causality, feedback, continuity.

All motion must:

- respect `prefers-reduced-motion`
- avoid layout instability
- avoid delaying interaction
- remain performant

## 7. Information Architecture

The product recognizes that one student can simultaneously:

- request food
- carry another student's order
- chat about an active order
- complete another order

Approved navigation direction: **Home / Activity / Create / Profile**

Activity is conceptually split into:

- You asked for
- You're carrying

Chat is contextual to an order rather than a top-level navigation destination.

Do not invent functionality just to match an IA diagram.

## 8. Real Data Constraints

Do not invent unsupported backend data.

Known constraints:

- no `orders.price`
- `orders.distance_km` cannot be trusted as a random UI value
- no real notification system
- no working friend graph
- no `is_deliverer`
- no real avatar URL field
- no reliable per-state timestamps
- no real ratings system
- no real notifications table
- SupportChat was a mock
- profile history/achievements previously contained fake data

Product decisions should be honest about these constraints.

## 9. Authentication / Performance Baseline

A major auth performance/deadlock issue was found and fixed during Phase 2.

**Root cause:** Supabase initialization held an auth lock while an async auth-state callback awaited profile work. Profile access re-entered session initialization and created a self-referential wait/deadlock.

**Fix:**

- auth callback profile work is deferred so initialization can finish
- `useAuth` became a shared `AuthProvider` + `AuthContext`
- one auth listener and one profile fetch are used app-wide
- same-user duplicate auth/profile events are deduplicated

**Measured improvement on real staging:**

- fresh reload with persisted session: 15s+ / never → ~910ms
- duplicate profile requests: 6 → 1
- rendered content: never → <1 second

This auth architecture/performance fix is part of the Phase 2 baseline.

## 10. Milestone Roadmap

### 2A — Design system + primitives + code splitting ✅

Completed: Counter tokens, color system, typography, spacing, radii, elevation, focus states, reduced-motion foundation, reusable primitives, route-level code splitting.

### 2B — Application shell + navigation ✅

Completed: one AppShell, shared desktop/mobile navigation, navigation source of truth, Activity mapped onto existing functionality, Create action, account menu, page framing, mobile safe-area handling, dead search/notification UI removed, mock SupportChat removed from shell.

Accessibility: `aria-current`, navigation landmarks, accessible icon labels, visible focus, 44px+ interaction targets.

### Login/Auth refinement ✅

Completed: Counter Login composition, editorial login structure, underline-based fields, responsive/mobile composition, loading state treatment, auth navigation race fixed, regression tests added.

The auth flow must remain deterministic: sign-in begins → auth succeeds/fails → loading resolves → authenticated state propagates → route navigation occurs from auth state.

### 2C — Home ✅

Home is the visual benchmark for the rest of Phase 2.

**Why the old Home failed:** weak hierarchy, no display-serif focal point, repetitive feed structure, generic CRUD/table feeling, filters competed with primary content, insufficient scale contrast, dead empty viewport, no distinctive CampusLink statement.

**New Home composition:** editorial opening statement, real-data-driven headline, oversized aggregate tip/reward when real and > 0, utility filter row, featured opportunity, compact opportunity list, designed closing/empty state, purpose-built loading skeleton.

**Core visual pattern — Featured vs compact:** the most important opportunity gets larger reward, larger typography, larger CTA treatment, stronger visual hierarchy. Remaining opportunities stay dense and scannable.

**Home behavior — preserve:** real order query behavior, accept/take action, existing filters, RLS/security, real fields only.

**Do not fabricate:** prices, order counts, notifications, distances, social proof, ratings.

**Home responsive behavior — verified:** desktop, tablet, mobile, no overflow, no console errors, filter interactions work, zero-tip state handles the focal reward correctly.

## 11. Next — 2D Post Request

The next milestone is Post Request.

Redesign the creation flow from first principles while preserving the real four-step behavior and database contract.

**Goals:**

- premium guided creation flow
- low cognitive load
- progressive disclosure
- strong typography
- editorial structure
- real-time preview
- strong completion state
- mobile-first interaction
- clear validation
- obvious progress
- no fake backend fields

Do not begin Activity/Profile/Chat during 2D.

## 12. 2E — Activity

Redesign Activity around the real dual role of the student:

- **You asked for** — requests the user created.
- **You're carrying** — requests the user accepted / is delivering.

Activity should make simultaneous roles understandable.

Core concerns: active vs completed, status, next action, delivery context, OTP, chat, order timeline, clean separation between requesting and carrying.

## 13. 2F — Chat + Profile

**Chat** should be contextual to the order.

Goals: participant identity, message hierarchy, timestamps where available, order context, contextual actions, eventual slide-out/sheet behavior.

Do not invent unsupported presence/typing features.

**Profile** should become a useful account hub.

Remove: fake order history, fake achievements, dead switches. Only show supported data. Theme controls may be surfaced because they are now actually wired.

## 14. 2G — Signature Motion

Only after static UI is strong.

Potential signature moments: OTP reveal, meaningful order-state transitions, delivery completion, selected navigation continuity, request creation completion.

GSAP must earn its place. Do not use GSAP for simple hover, basic button feedback, trivial transitions.

## 15. 2H — Final Polish

Final pass includes: responsive polish, accessibility, performance, bundle review, asset optimization if introduced, route/chunk review, interaction consistency, loading/error/empty states, reduced-motion verification, cross-page visual consistency.

This is where remaining performance warnings should be addressed.

## 16. Performance Rules

Do not trade performance for visual effects.

**Known concern:** entry JS remains around the 500–565 KB range depending on milestone.

**Rules:**

- preserve route-level splitting
- avoid unnecessary dependencies
- do not add GSAP before 2G
- do not add large UI packages for small interactions
- measure before optimizing
- fix duplicate requests at the source
- avoid request waterfalls
- avoid indefinite global loading states

## 17. Engineering Rules

**Preserve:** database schema, RLS, OTP security, Supabase contracts, existing order state model, explicit column selection, validated JSONB handling, auth/security model.

**Do not:** invent fields, weaken security, bypass RLS, modify production auth casually, introduce unnecessary backend architecture, add services not required by the current product.

## 18. Quality Gate for Every Milestone

Every milestone must finish with:

- `npm test`
- `npx tsc --noEmit`
- `npm run build`
- `npm run lint`

Also verify actual rendered UI where practical: desktop, tablet, mobile, no console errors, no overflow, no broken interactions.

Do not commit or push automatically.

Stop at the defined milestone and report: what changed, why, files changed, visual decisions, tests, typecheck, build, lint, remaining weaknesses.

## 19. Current Approval State

**Approved:** Counter direction, 2A, 2B, Login/Auth refinement, 2C Home.

**Next:** 2D Post Request.

Do not start later milestones automatically.

## 20. Review Rule

Judge the rendered product by: visual quality, composition, hierarchy, usability, performance, real product behavior.

Not by: number of components, amount of animation, number of gradients, amount of decorative detail.

A page is not finished because the code is clean. It is finished when:

- the experience is strong
- the hierarchy is obvious
- the product feels distinctive
- behavior is correct
- real data is respected
- performance is acceptable
- the page looks intentional at major viewport sizes
