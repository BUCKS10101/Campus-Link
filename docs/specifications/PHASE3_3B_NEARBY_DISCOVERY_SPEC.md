# 3B — Nearby Discovery Spec (implemented)

**Status: IMPLEMENTED and verified on staging.** Architecture approved
with the product decisions below; this document reflects the final,
shipped design. See §15 for the staging verification record.

## 0. Final approved decisions (read this first)

- `orders.distance_source` (nullable: `'routed' | 'fallback' | 'unresolved'`)
  added, with the required column-level SELECT grant. Legacy orders stay
  `null` - never backfilled/guessed.
- Ranking formula: `tip_amount / max(distance_km, 0.05)` ("reward
  density"), used only for orders with a real distance signal.
- Three trust tiers, never blended into one score: routed > fallback >
  unresolved.
- Home filters are **All / Quick errands / High reward** (not "Nearby" -
  see §2 for why). Quick errands = usable-distance orders only, sorted by
  distance ascending. High reward = usable-distance orders sorted by
  reward density descending, with unresolved orders appended after,
  ranked by raw tip (never excluded from the app, never given a distance
  claim). "Along the way" was not built - no route-overlap signal exists.

## 1. Product goal

Move Home from "here are some delivery requests" to "here are the
requests you can realistically help with" — using real Phase 3A location
data (campus_points, pgRouting distance/geometry) to help a student judge
proximity, effort, and reward at a glance, without inventing signals the
backend doesn't actually have.

## 2. What "nearby" can honestly mean today

**There is currently no reliable signal for where the viewing student
is.** Checked directly:

- `profiles.hostel_block` and `profiles.hostel_type` exist as real
  columns, but **nothing in the app ever writes them** — not signup, not
  Profile editing, nothing. In practice every real user's `hostel_block`
  is `null`. Profile.tsx only *reads* it (`const block =
  profile?.hostel_block`), for display, never collects it.
- 3A deliberately has no continuous GPS and no "current location" concept
  by design (PHASE3_MASTER_PLAN.md §9, PHASE3_3A_LOCATION_SPEC.md).
- There is no "last selected pickup" or similar session-scoped location
  memory anywhere.

**Conclusion**: 3B v1 cannot personalize "nearby" to an individual
student's real position — there is nothing honest to personalize against.
Per the task's own instruction ("start with a campus/location-neutral
ranking and clearly label it"), **"nearby" in this version means "a
short, low-effort errand" (short pickup→delivery distance), not "close to
you."** UI copy must say this plainly (e.g. "Quick nearby errands", not
"Near you") so it's never a false claim about the user's own position.

Personalized proximity (ranking against the student's own hostel/block)
is listed under §13 Deferred — it requires either populating
`hostel_block` through a real UI flow, or a deliberate opt-in
"home base" concept. Neither exists today, and inventing one is out of
scope for a discovery-ranking milestone.

## 3. Signals that can be trusted right now

Verified directly against `useOrders.ts`, `database-types.ts`, and live
staging data:

| Signal | Trustworthy? | Source |
|---|---|---|
| `tip_amount` | Yes | Always set, always real (requester-chosen) |
| `distance_km` | **Conditionally** | Real number, but its trust level depends on how it was computed — see §5 |
| `pickup_point_id` / `delivery_point_id` | Yes when non-null | Real `campus_points` FK, resolved at creation time |
| `custom_delivery_lat/lng` | Yes when non-null | Real coordinate, but always routed live via `compute_walking_route_custom` (may itself be fallback) |
| route geometry / "routed vs fallback" | **Not currently persisted** | Computed transiently in `PostRequest.tsx` at creation time, never saved to the `orders` row — see §5 |
| requester/deliverer identity, live location | N/A for Home | Already correctly RLS-scoped (`profiles_select_order_counterparty`) — Home's board view can't see another user's profile fields anyway; 3B must not try to surface anything from that relation for non-participant viewers |
| campus zone / hostel proximity to viewer | No | See §2 |
| route overlap between two different orders | No | Never computed anywhere in the codebase |
| urgency / availability / live position | No | Nothing in the schema represents these |

## 4. Staging data reality check (done before proposing any formula)

Queried the live `orders` table directly:

- 11 `pending` orders total, 2 `delivered`.
- **0 of the 11** have both `pickup_point_id` and `delivery_point_id` set.
- Only 1 has `pickup_point_id` set at all; 0 have `delivery_point_id`; 1
  has a custom pin.
- All 11 nonetheless have a non-null `distance_km` — these are legacy
  pre-3A test rows (plain-text `restaurant_name` like "One Food"/"Campus
  Store", fabricated/random distance from before the 3A routing work),
  not representative of what an order created through the current
  PostRequest flow produces.
- `tip_amount` ranges ₹20–₹50 across the sample; `distance_km` (legacy,
  untrustworthy) ranges ~0.5–2.3.

**Implication**: the current staging board has essentially zero orders
with a real, 3A-linked location signal. The ranking model must degrade
gracefully for this (today's) majority case — reward-only ranking, no
fabricated distance-based claims — while being correct for orders created
going forward through the real picker/custom-pin flow, which do populate
these fields. Validating the "routed" tier end-to-end will need a small
number of fresh disposable test orders created through the real flow
during implementation (per PHASE3_MASTER_PLAN.md §15 — minimum necessary,
disposable, reported).

## 5. Fallback vs routed — the one real gap found

3A's RPCs (`compute_walking_route`, `compute_walking_route_custom`)
already distinguish a real routed result (populated `LineString`
geometry) from a straight-line fallback (`geometry: null`) — but **that
distinction is only known at the moment `PostRequest.tsx` calls the RPC
during order creation. It is never persisted.** `orders.distance_km` is
just a plain number; nothing on the row says which kind of number it is.

This matters for 3B specifically because the task requires: "a routed
opportunity should be considered more trustworthy than a fallback
estimate," ranked and labeled accordingly on Home. Reconstructing that
after the fact isn't reliably possible from existing columns (the graph's
connectivity can change over time, e.g., between the coalesce-bug fix and
the graph-reconnection pass this session — a re-check today wouldn't
necessarily match what was true when the order's `distance_km` was
actually computed).

**Proposed schema change (the only one this milestone needs)**: add one
additive, nullable column —

```sql
alter table orders add column distance_source text
  check (distance_source in ('routed', 'fallback', 'unresolved'));
```

Set once at creation time, mirroring exactly how `distance_km` itself is
already set once at creation (`resolvedRoute.geometry` is already sitting
in `PostRequest.tsx`'s state at the exact moment `distance_km` is chosen
— this only means also writing whether that state's `geometry` was
non-null). `'unresolved'` (or simply `null`) covers today's majority case
(no point-to-point resolution attempted/possible) so nothing has to guess.

**Required companion, learned directly from this session's earlier
incident**: `orders`' SELECT privilege is column-scoped, not
table-level (see `20260825090000_fix_otp_column_privileges.sql` and the
follow-up `20260826290000_grant_select_new_order_location_columns.sql`
that had to patch this exact gap for `pickup_point_id` etc.). Any new
column **must** ship with an explicit
`grant select (distance_source) on orders to anon, authenticated;` in the
same migration, or Home will 42501 the instant it starts selecting it —
exactly what broke `/my-orders` earlier this session.

This is presented as a proposal, not yet implemented. If you'd rather not
add a column, the only honest alternative is "don't distinguish routed
vs fallback at all, rank everything with a location signal the same way"
— which the task explicitly says not to do. I don't see a way to satisfy
the requirement without persisting *something*.

## 6. Proposed ranking model (deterministic, explainable, no ML)

**Trust tiers, most to least trustworthy** (never blended together into
one number — tier is checked first, ratio only breaks ties within a
tier):

1. **Routed** — `distance_source = 'routed'`. Real path-following
   distance and geometry exist.
2. **Fallback** — `distance_source = 'fallback'`. A real coordinate pair
   exists, but the number is straight-line, not a walked distance.
3. **Unresolved** — no usable distance at all (today's majority case,
   and legacy rows). Ranked last, by reward alone — no distance claim is
   ever shown or implied for these.

**Within tier 1 and 2**, rank by **reward density**:

```
reward_density = tip_amount / max(distance_km, FLOOR_KM)
```

`FLOOR_KM` (proposed: 0.05 km / 50 m) exists only to keep the ratio
sane for the very-short trips 3A's own data already contains (e.g. two
adjacent hostel blocks ~10–50m apart) — without it, a trivial hop would
produce an arbitrarily huge ratio and dominate the board for the wrong
reason. This is the **only** tunable constant in the model, and it's a
floor for numerical stability, not a weight.

This single ratio is deliberately chosen over a weighted sum
(`w1·norm(distance) + w2·norm(tip)`) because a weighted sum requires
picking arbitrary weights — exactly what the task says not to invent.
Reward-per-km is a single, dimensionally meaningful, explainable number:
"how much you're paid for how far you'd walk."

**Tie-breaking**: equal reward_density (rounded to 2 decimals) → most
recent `created_at` first, matching the tie-break rule Home already uses
for its current "highest tip" featured order.

**"Nearby" section** = tier 1/2 orders sorted by raw `distance_km`
ascending (not reward_density) — this section is specifically about
"short errand," independent of reward, per the task's own "Nearby:
requests closest to the student's relevant campus area" framing
(re-labeled per §2 — closest to *a* campus area, not to the student).

**"Best opportunities" section** = tier 1/2 orders sorted by
`reward_density` descending — "strong combination of proximity + reward."

**"Along the way"**: not built. No route-overlap signal exists anywhere
in the codebase (confirmed — nothing computes whether two *different*
orders' paths intersect). Building this would mean inventing the
compatibility signal the task explicitly forbids inventing. Deferred (§13).

**Everything else** (tier 3, or overflow beyond the top-N in each
section) still appears in a plain list — 3B never hides an order, it
only decides *emphasis and section placement*.

## 7. Home changes (visual language unchanged, as implemented)

Reuses the existing Counter primitives (`Text`, `Rule`, existing
`OrderCard`), and the existing single `fetchOrders()` feed. No new visual
system, no new colors, no new motion pattern. `useCampusPoints()`/a
"Near TT" label lookup was **not** added in the end - `delivery_location`
already carries the resolved human label (`formatDeliveryLocation()`
already shows e.g. "TT Block" today), so a separate campus-point lookup
would have been a redundant network call for no new information.

Concretely, as implemented:
- Filter chips are now **All / Quick errands / High reward**, replacing
  the old `nearby`/`high-tips` chips. Selecting a filter no longer
  triggers a re-fetch or a new query - it's a pure client-side re-sort of
  the one already-fetched `orders` array via `ranking.ts`.
- "Best on the board" now uses `rankFeatured()` (best reward_density, or
  best tip if nothing has a usable distance yet) instead of a bare
  highest-tip sort - only shown for the `all` filter, since Quick
  errands/High reward already lead with their own top-ranked item.
- A reason chip ("Quick errand nearby" / "Good reward for the distance")
  is appended into the existing single caption line
  (`{order.distance} · posted {order.timeAgo}`) rather than adding a new
  slot to the shared `OrderCard` component - keeps the IA change
  contained to `Home.tsx`. Only attaches to an order in the top 3 of the
  relevant ranked list, and a reward reason never attaches to an
  unresolved order (no fabricated distance-based praise for an order with
  no distance).
- Per-order distance text now comes from `formatOrderDistance()`
  (`src/lib/orderContent.ts`) - "X km · ~Y min walk" only for
  `distance_source: 'routed'`, "~X km · distance estimate" for anything
  else with a number, `'distance unknown'` (unchanged) when there's none.
- Each filter has its own honest empty-state copy instead of one
  generic message, since "nothing matches Quick errands" and "the whole
  board is empty" are different facts - neither ever renders as a
  decorative empty section.

## 8. Schema change necessity

Only the one column in §5. Everything else (ranking, grouping, labels)
is computable from data already selected by the existing `ORDER_COLUMNS`
query plus the existing `campus_points` fetch. No new table, no new RLS
model, no new RPC.

## 9. Expected query/request count

**Unchanged from today**: one `fetchOrders()` call, one realtime
subscription, one `useCampusPoints()` fetch (already used elsewhere,
e.g. PostRequest — Home doesn't currently call it, so this is the one
net-new network call this milestone adds, and it's a single small
reference-table fetch, not per-order). Ranking/grouping/labeling all run
as a single client-side pass (`useMemo` over the already-fetched arrays)
— no RPC-per-card, no N+1.

## 10. Performance impact

- No MapLibre import anywhere in this milestone — Home's critical path
  stays exactly as light as it is today.
- No additional realtime channel (reuses the existing `orders` channel).
- One added lightweight query (`campus_points`, already small — every
  point ever seeded this project is well under 200 rows).
- All ranking math is O(n log n) sort over the already-in-memory orders
  array (n = current pending-order count, currently 11) — negligible.

## 11. Accessibility

- New per-card reason chips are plain text inside the existing `Text`
  primitive — screen readers get real words ("Good reward for the
  distance"), never an icon-only or color-only signal.
- Section headers use the same `Text variant="label"` pattern Home
  already uses for "Best on the board"/"More on the board" — no new
  heading semantics to get wrong.
- No new color-only distinction between tiers — tier is communicated by
  section placement and text, not color alone.

## 12. Mobile behavior

No new layout primitive — reuses `OrderCard`'s existing responsive grid
(`grid-cols-[64px_1fr_auto]` / `sm:grid-cols-[88px_1fr_auto]`) and
Home's existing single-column stacking. The one new element (a reason
chip) is a `Text variant="caption"` line, same treatment as the existing
distance/time caption it sits beside — no separate mobile-only path
needed.

## 13. Explicitly deferred

- **Personalized proximity** to the student's own hostel/block — blocked
  on `hostel_block` never being populated by any real flow (§2). Future
  enhancement: either add a real "home base" field with a UI to set it,
  or infer nothing and keep this neutral.
- **Live user GPS-based proximity** — explicitly out of scope per the
  task and per PHASE3_MASTER_PLAN.md §9's privacy rules.
- **"Along the way" / route-overlap ranking** — no signal exists to
  compute this honestly (§6).
- **Urgency / availability ranking** — nothing in the schema represents
  either.
- **New permanent filters** (e.g. a persisted "high reward" or "route-
  compatible" filter chip) beyond what real data can back today — Home's
  existing `all`/`nearby`/`high-tips` filter chips are kept, but "nearby"
  is redefined to mean the honest tier-aware distance sort in §6 instead
  of `distance_km < 1` against possibly-fabricated legacy numbers.
- **AI/ML ranking** — explicitly excluded per the task; the model above
  is deterministic and fully explainable from visible fields.

## 14. Testing plan (once approved)

- **Unit**: a new pure ranking module (proposed `src/lib/ranking.ts`)
  covering tier assignment, `reward_density` calculation and its floor,
  tie-breaking, and the "nearby" vs "best opportunities" sort orders —
  table-driven tests across routed/fallback/unresolved combinations.
- **Unit**: a label/formatting helper (mirroring `formatRouteEstimate`'s
  existing pattern) for the reason-chip copy, asserting a fallback or
  unresolved order never gets language implying a walked route (same
  discipline as the prior "route-distance UX fix" milestone).
- **Component**: Home tests asserting a section is never rendered with
  zero real backing data (no decorative empty sections), and that tier-3
  orders never show a distance-derived claim.
- **Migration/RLS**: verify the new `distance_source` column round-trips
  through `createOrder()`/Home's select, and that the companion GRANT
  actually resolves (re-run the same kind of check that caught the
  `pickup_point_id` gap earlier this session — `has_column_privilege`
  for `anon`/`authenticated`).
- **Staging E2E**: create 2–3 disposable test orders through the real
  PostRequest flow (one with two connected catalog points → tier 1, one
  with a custom pin far enough to force fallback → tier 2) to confirm
  Home's sections populate correctly against real, non-legacy data —
  report exactly what was created and clean up afterward per
  PHASE3_MASTER_PLAN.md §15.
- Full suite each pass: `npm test`, `npx tsc --noEmit`, `npm run build`,
  `npm run lint`.

## 15. Staging verification record

Migration `20260827100000_add_orders_distance_source.sql` applied to
staging (`wemjskpbulebxgyhyhmk`) only. Verified directly:

- `has_column_privilege('anon'/'authenticated', 'orders', 'distance_source', 'SELECT')`
  → true/true.
- `otp` SELECT still false/false for both roles - untouched.
- `orders`' 5 RLS policies identical before/after (`orders_insert_own`,
  `orders_select_participant`, `orders_select_pending_feed`,
  `orders_update_accept`, `orders_update_assigned_deliverer`).
- All 13 pre-existing orders kept `distance_source = null` - nothing
  backfilled.

Two disposable test orders were created through the real PostRequest
flow and then deleted after verification (per PHASE3_MASTER_PLAN.md
§15):
- "3B routed test order" — Balaji Store → Technology Tower (TT). Real
  route, `distance_source = 'routed'`, displayed as
  "0.1 km · ~1 min walk".
- "3B fallback test order" — One Food World → PRP (One Food World's own
  path cluster is genuinely isolated from the graph, guaranteeing a
  fallback). `distance_source = 'fallback'`, displayed as
  "~0.9 km · distance estimate" - never "walk".

Confirmed live on Home:
- **Quick errands** showed exactly these 2 orders, sorted by distance,
  each tagged "Quick errand nearby" — zero legacy/unresolved orders
  leaked in despite several having a `distance_km` value from before 3B.
- **High reward** showed all 13 orders: the routed order first (highest
  reward_density), then the fallback order, then every legacy/unresolved
  order ordered by raw tip — confirming tiers are never blended.
- **Best on the board** picked the routed order (highest reward_density
  on the board at the time).
- Switching filters caused zero additional network requests (single
  `fetchOrders()` + single realtime subscription, confirmed via
  `Home.test.tsx`'s dedicated test and observed network activity during
  the live staging check).
- Screenshot-verified: Counter visual language (forest/ivory, ruled
  structure, editorial type) unchanged.

Cleaned up: both disposable test orders deleted from staging after
verification. No production access at any point.

## 16. Follow-up: Where (From/To location filter)

Adds a fourth, compact control to the filter row - **Where** - alongside
All/Quick errands/High reward, letting the student filter opportunities
by pickup and/or delivery campus location. Composes with the existing
ranking filters rather than replacing them (see examples below); does
not touch the schema (`pickup_point_id`/`delivery_point_id` already
exist) and adds no new network requests beyond the one-time
`useCampusPoints()` fetch Home didn't previously need (already used
elsewhere in the app, e.g. PostRequest - not a new query pattern).

**Filtering order**: `filterByLocation()` (in `ranking.ts`) runs first,
before `rankFeatured`/`rankQuickErrands`/`rankHighReward` - all three
ranking filters and the featured slot operate on the already
location-narrowed list, so e.g. "Quick errands + From: Balaji Store"
shows only Balaji-Store-origin orders with a usable distance, sorted by
distance - never a contradictory combination.

**Legacy/unresolved orders**: an order with `pickup_point_id` or
`delivery_point_id` both null can never match a *specific* From/To
selection (null !== a real id) - this falls out of the equality check
in `matchesLocationFilter()` automatically, not a special case. They
remain fully visible under All and under an unset Where filter.

**UI**: `src/components/home/WhereFilter.tsx`. Desktop renders a Popover;
mobile (`useIsMobile()`, an existing hook, already used by Sidebar) gets
a bottom Sheet, confirmed to sit above the fixed mobile nav bar
(Sheet is `z-50`, nav is `z-40`). Both share the same From/To fields -
each a searchable combobox (Popover + Command, both already-existing
shadcn primitives - no new dependency) rather than a native `<select>`
someone has to scroll through. Selecting is a local draft; nothing is
applied to Home's actual filter (or shown in the applied summary) until
Apply; Clear resets and applies immediately.

Applied state is shown two ways: the trigger button's own label changes
from "Where" to the literal requested format ("From: Balaji Store · To:
TT"), and a dedicated empty-state message
("Nothing matches From: Balaji Store right now.") replaces the generic
per-ranking-filter empty states whenever the location filter itself is
what produced zero results - with its own "Clear location filter" button.

**Verified live on staging** (not a full disposable-order QA pass this
time - existing board data was sufficient): opening Where, searching
("Balaji" → filters to "Balaji Store" in the list), selecting, Apply,
the applied-summary label, the honest empty state, Clear (both the
panel's own Clear and the empty-state's "Clear location filter")
restoring the full board, and the mobile Sheet variant sitting above the
bottom nav - all confirmed via screenshots against the real app.

**Testing**: `ranking.test.ts` covers `filterByLocation`/
`matchesLocationFilter`/`isLocationFilterActive` in isolation (From
only, To only, both, clearing, legacy exclusion). `Home.test.tsx` adds
end-to-end coverage for the same cases through the real UI (search →
select → Apply), composition with Quick errands and High reward, and a
dedicated zero-additional-network-requests assertion across the whole
open → search → select → Apply → Clear cycle. jsdom needed two more
polyfills in `src/test/setup.ts` (`matchMedia`, `Element.scrollIntoView`)
for `useIsMobile()`/cmdk to mount at all in tests - same pattern already
used there for `ResizeObserver`.
