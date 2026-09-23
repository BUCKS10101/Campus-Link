# 3I — Analytics + Product Intelligence Spec (architecture proposal, pending approval)

**Status: ARCHITECTURE ONLY. No table, RPC, trigger, RLS policy, hook, or
UI component has been implemented.** Branch: `feat/phase-3-analytics-intelligence`,
branched from `main` at `0ca04f9` (post-Activity, post-3H). Everything
below was traced directly from the current repo — every migration file,
`src/hooks/useOrders.ts`, `src/lib/database-types.ts`, the Activity pages,
`usePreferences.tsx`, `useNotifications.tsx`, `useRatings.ts` — nothing
here is assumed.

---

## A. Current data audit

### `orders` (the only table with real lifecycle signal)

Full column list, traced across every migration that touches it
(`20260824115900_baseline_schema.sql` → `20260901100000_...`):

```
id, requester_id, deliverer_id, restaurant_name, items, tip_amount,
delivery_location, status, otp, distance_km, created_at,
delivery_point_id, pickup_point_id, custom_delivery_lat,
custom_delivery_lng, custom_delivery_note, distance_source,
cancelled_at, cancelled_by
```

**Critical finding: `orders` has exactly two timestamps** — `created_at`
(always) and `cancelled_at` (only on cancelled orders, added in 3G). There
is no `accepted_at`, `picked_up_at`, `out_for_delivery_at`, or
`delivered_at`. `status` is mutated in place (`UPDATE orders SET status =
...`), not appended to a log — once an order reaches `delivered`, the
fact that it was ever `picked_up` still holds (the transition graph in
`src/lib/orderStatus.ts` guarantees `delivered` is only reachable via
`out_for_delivery` ← `picked_up` ← `accepted`), but the *time* it spent in
each of those states is not recorded anywhere on the row itself.

**Non-obvious secondary source: `notifications`.** `notify_order_status_change()`
(`20260827200000_notifications.sql`) inserts one row into `notifications`
for each of `order_accepted` / `order_picked_up` / `order_out_for_delivery`
/ `order_delivered`, to the requester, at the exact moment that
transition happens — `on conflict (recipient_id, order_id, type) do
nothing`, so each type is written exactly once per order (the status
graph is monotonic; there's no path back to re-trigger the same type).
This means **`notifications.created_at`, filtered by `order_id` and
`type`, is a real, already-existing proxy for per-transition timing** —
not designed for analytics, never persisted on `orders` itself, but
genuinely present and reliable for any order whose requester received
that notification. Confirmed unsuppressible: the 3H
`notify_chat_messages`/`notify_friend_events` preference guards
explicitly do not touch this function — order-lifecycle notifications
are never gated by a preference (per `PHASE3_3H_..._SPEC.md`'s §6
decision, verified against the migration body directly).

Caveat on this source: it only exists for orders where the trigger has
fired since `20260827200000_notifications.sql` was applied and where the
row was actually reached (an order cancelled while `pending` will have
no `order_accepted` row at all — correctly, since it never was accepted).
It's a derived signal from a table built for a different purpose, not a
first-class analytics source — the spec's recommended scope (§C) treats
it as optional/secondary for exactly this reason.

**`status` as a snapshot, not a running total.** A live `count(*) where
status = 'accepted'` undercounts "how many orders were ever accepted" —
an order that progressed to `delivered` no longer shows `'accepted'`.
The reliable proxy for "was ever accepted" is `deliverer_id is not null`
(set once at acceptance via `orders_update_accept`'s `with check
(deliverer_id = auth.uid())`, never cleared — confirmed: no migration
ever nulls `deliverer_id` back out, including on cancellation).

**Cancellation is bounded by 3G, which matters for interpretation.** Per
`enforce_order_status_transition()` (`20260830100000`/`20260830200000`),
a deliverer can only cancel while `status = 'accepted'`, and a requester
only while `pending`/`accepted`. **Every cancelled order was therefore
cancelled before `picked_up`** — a cancelled order never represents a
picked-up-then-abandoned delivery. This is a real, DB-enforced guarantee
worth stating explicitly in any cancellation-rate metric.

### `profiles`

`id, name, email, phone, hostel_block, hostel_type, rating,
successful_deliveries, balance, created_at`. **`rating`,
`successful_deliveries`, and `balance` are dead columns** — 3D's
`get_profile_reputation()` computes reputation live from `ratings`/`orders`
and explicitly does not read or write any of the three (confirmed in
`20260827300000_ratings.sql`'s own header comment). No `role`/`is_admin`
column exists anywhere — **there is no admin/staff concept in this
schema at all**. This directly bears on §E (who can see aggregate data).

### `ratings`

`id, order_id, reviewer_id, reviewee_id, score, comment, created_at`.
`get_profile_reputation(p_profile_id)` is the existing precedent for
exactly the architecture 3I should reuse: a `SECURITY DEFINER`, `stable`
SQL function that returns only aggregate numbers (avg/count), computed
live, no cache table, explicitly reasoned about as safe to bypass RLS
because "it never returns anything beyond three aggregate numbers, so
there is no exposure risk." 3I's own RPCs should follow this exact
pattern.

### `campus_points`

`id, key, label, kind ('restaurant'|'hostel_block'|'campus_landmark'),
lat, lng, active`. Small (≈40-60 rows), stable reference data, not
per-user. `orders.pickup_point_id`/`delivery_point_id` FK into it.
"Popular pickup/delivery locations" is a `group by` + `join` away, and
because the grouping key is a shared physical place (not a person), it
carries much lower privacy risk than the raw `delivery_location` jsonb
— *except* that `delivery_location`/`custom_delivery_note` can carry a
specific hostel block + free-text note, which is more sensitive at low
volume (see §E).

### `notifications`

`id, recipient_id, type, order_id, friendship_id, read_at, created_at`
(the `friendship_id`/`type` set was extended by 3E/3H — full `type` CHECK
list is now `order_accepted, order_picked_up, order_out_for_delivery,
order_delivered, new_chat_message, friend_request_received,
friend_request_accepted, order_cancelled`). Participant-scoped RLS only
(`recipient_id = auth.uid()`) — no existing aggregate RPC over this
table. Read volume/engagement (e.g. "how many notifications go unread")
is computable but not requested in this phase's brief.

### `friendships`, `chat_messages`, `user_preferences`/`user_preferred_points`

`friendships` (3E): `requester_id, addressee_id, status`. `chat_messages`:
`order_id, sender_id, message, created_at` — message *content* must never
be aggregated or surfaced (private communication). `user_preferences`
(3H): scalar booleans/radius, strictly owner-scoped, no coordinate ever
stored (already audited exhaustively in the 3H spec). None of these
change anything about 3I's design; they're confirmed out of scope for
this phase (§K).

### RLS — the actual constraint on "aggregate" analytics

`orders_select_participant` (own orders) + `orders_select_pending_feed`
(any signed-in user, but *only* `status = 'pending'` rows) are the only
SELECT policies on `orders`. **A client-side `select` for a true
campus-wide aggregate (e.g. total orders ever placed) is not possible
under current RLS** — an ordinary authenticated user querying `orders`
directly only ever sees their own participant rows plus whatever is
currently pending. Any aggregate/campus-wide metric requires a
`SECURITY DEFINER` RPC (exactly the `get_profile_reputation()` pattern),
returning only aggregate numbers — never raw rows — or the feature must
be scoped to personal-only data (which the existing RLS already serves
correctly with zero new grants).

### Existing test infrastructure

Vitest + `@testing-library/react`, with a shared `createSupabaseMock()`
(`src/test/supabaseMock.ts`) exposing a jest-mock-style query builder
(`.select/.eq/.in/.limit/.order/.single/.maybeSingle`) and a mocked
`.rpc()`. The established RPC-hook test pattern
(`src/hooks/useRatings.test.ts`): mock `supabaseMock.rpc`, assert the
exact function name + params the hook calls it with. 3I's own hook(s)
should follow this identically — no new test infrastructure needed.

---

## B. Metric feasibility matrix

| Metric | Available now? | Source | Accuracy | Additional data required? |
|---|---|---|---|---|
| Orders posted (total/by period) | ✅ Yes | `orders.created_at` | Exact | No |
| Orders accepted (ever, not just currently) | ✅ Yes | `orders.deliverer_id is not null` | Exact | No |
| Orders completed (delivered) | ✅ Yes | `orders.status = 'delivered'` | Exact (terminal state) | No |
| Orders cancelled | ✅ Yes | `orders.status = 'cancelled'` | Exact (terminal state) | No |
| Completion rate | ✅ Yes | `delivered / (delivered + cancelled)`, or `/ total` | Exact, but see note below | No |
| Cancellation rate | ✅ Yes | `cancelled / total` | Exact | No |
| Cancellation split (requester- vs deliverer-initiated) | ✅ Yes | `cancelled_by = requester_id` vs `= deliverer_id` | Exact (3G-stamped, server-side) | No |
| Time from posted → accepted | ⚠️ Partial | `orders.created_at` → matching `notifications` row (`type='order_accepted'`, same `order_id`).`created_at` | Good for orders where the notification fired (should be ~all `accepted`+ orders since 3C shipped); pre-3C orders have no such row | No new column, but requires a join, not a first-class field |
| Time from accepted → picked_up, picked_up → out_for_delivery, out_for_delivery → delivered | ⚠️ Partial | Same `notifications` join, per type | Same caveat as above, plus depends on `notify_order_status_change()` having been live for the order's whole lifetime | No new column; derived only |
| Time from posted → cancelled | ✅ Yes | `cancelled_at - created_at` | Exact, direct column | No |
| Requester vs deliverer activity (personal) | ✅ Yes | `count(*) where requester_id/deliverer_id = viewer` | Exact | No |
| Popular pickup/delivery locations (aggregate) | ✅ Yes | `group by pickup_point_id`/`delivery_point_id`, joined to `campus_points.label` | Exact for orders using a real campus point; silently excludes custom-pin/legacy-null orders (see §A backfill note — most pre-3A orders in *staging* had null pickup, now backfilled there only) | No |
| Demand by campus area/hostel block | ✅ Yes | Same, or `campus_points.kind`/hostel grouping | Same caveat | No |
| Busy periods / time-of-day demand | ✅ Yes | `date_trunc('hour', created_at)` bucketing | Exact | No |
| Delivery success rate by deliverer | ✅ Yes | `get_profile_reputation()`'s own `completed_deliveries`, or a parallel query | Exact, existing precedent | No |
| Personal "orders I've placed/delivered/rated" summary | ✅ Yes | Existing participant-scoped queries, already partially built (Activity History pages) | Exact | No |
| Average tip amount (personal or aggregate) | ✅ Yes | `avg(tip_amount)` | Exact | No |
| Friend-network size / social-graph stats | ⚠️ Partial | `friendships` table exists, but per the Phase-1B RLS review "no accept/decline UI exists anywhere in the app's history" and only `requester_id = auth.uid()` is readable | Feature itself may be more schema-than-behavior; any friend-count metric would reflect an incomplete/unused feature, not real usage | Not recommended for V1 (see §K) |
| Discovery-preference adoption (e.g., % of users with live location on) | ❌ Not appropriate | `user_preferences` | N/A | This is *personal privacy configuration data* — aggregating it, even anonymized, crosses into "surveilling opt-in choices," which conflicts with 3H's whole privacy model. Explicitly excluded, not just deferred. |
| Chat volume/response time | ⚠️ Technically possible, not recommended | `chat_messages.created_at`, never `.message` | Message *content* must never be touched; even volume/response-time metrics on private 1:1 conversations are a privacy-sensitive choice, not a pure feasibility one | Deferred — needs an explicit privacy decision, not an engineering one |
| Real-time/live dashboards | ❌ No | N/A | Nothing in this schema is event-sourced; every "real-time" feature elsewhere (Home's board, notifications) uses `postgres_changes` on a mutable table, not an append-only stream | Would need new instrumentation if genuinely required |

**Note on completion rate's denominator**: "completed / total" and
"completed / (completed + cancelled)" are both defensible and answer
different questions (the former includes orders still in-flight as
"not yet completed," which understates a healthy pipeline; the latter
only compares *resolved* orders). This is a product decision for §C/§L,
not an engineering ambiguity.

---

## C. Recommended 3I V1 scope

### Must-have (personal, always safe under existing RLS, zero new privacy surface)

1. **A personal Activity summary** — "You've posted N requests, delivered
   M orders, N delivered / M cancelled" — computed from data the viewer
   can *already* see under existing RLS (their own `orders` rows). No new
   RPC even strictly required for this tier; could be pure client-side
   aggregation over what `OrderingHistory`/`DeliveringHistory` already
   fetch, though a small RPC (see §D) is still recommended for one round
   trip instead of pulling full row data just to count/sum it.
2. **Personal average tip given/earned, personal completion rate.**
   Same reasoning — own data only.

### Should-have (aggregate, requires a `SECURITY DEFINER` RPC, no per-user identity ever returned)

3. **Campus-wide order volume over time** (daily/weekly counts by
   status) — genuinely useful "is CampusLink being used" signal, safe
   because it returns only counts bucketed by time, never a row a
   specific user could be identified from.
4. **Popular pickup/delivery locations** (top N `campus_points` by order
   count) — same safety shape: a location + a count, never a requester.
5. **Busy periods** (hour-of-day / day-of-week demand histogram) —
   same shape.

### Deferred (not V1 — explicit reasons, not just "later")

- **Per-deliverer leaderboards or rankings** — turns an aggregate
  metric into an identifiable one; needs an explicit product decision
  on whether any user should be nameable in an analytics context at all
  (today, nothing is — `get_profile_reputation` is queried per-viewed-profile,
  never listed/ranked).
- **Lifecycle-timing metrics (posted→accepted, accepted→picked_up, etc.)**
  — feasible only via the `notifications` join described in §B, which is
  a secondary-purpose signal, not a first-class one. Recommend building
  this only after V1 ships and only if product genuinely needs it,
  at which point it may be worth *promoting* to real `orders` timestamp
  columns rather than continuing to lean on `notifications` as a proxy.
- **Discovery-preference adoption stats** — excluded on privacy grounds
  (§B), not deferred on feasibility grounds.
- **Chat volume/engagement metrics** — deferred pending an explicit
  privacy decision (§B), separate from whether it's technically easy.
- **Friend-network stats** — deferred; the underlying feature
  (friend requests) has no working UI yet (per the Phase-1B RLS audit),
  so any metric here would describe near-zero real usage, not a real
  signal.
- **Admin dashboard / role-gated views** — there is no admin/role
  concept anywhere in this schema. Building one is a real, separate
  product decision (a new `profiles.role` or equivalent, new RLS), not
  something 3I should introduce as a side effect of "someone needs to
  see aggregate stats." Flagged explicitly for your approval in the
  final report below.
- **New analytics/event table** — not justified for V1. Every must-have
  and should-have metric above is computable from existing `orders`
  data. An event table would be justified the moment a metric needs
  something `orders`/`notifications` genuinely cannot express (e.g. true
  per-transition timestamps, or funnel drop-off with re-entrant states)
  — not before.

---

## D. Architecture

**Computation happens in Postgres, via `SECURITY DEFINER` SQL/plpgsql
functions, not client-side aggregation and not a materialized view — for
V1.** Reasoning:

- Client-side aggregation over `orders` is a non-starter for any
  aggregate/campus-wide metric, since RLS only exposes participant +
  pending rows to an ordinary client (§A). It would also mean pulling
  full row data over the wire just to count/sum it — wasteful and, for
  personal metrics, unnecessary when a one-row RPC result does the same
  job.
- A plain `stable security definer` SQL function (exactly
  `get_profile_reputation`'s shape) is sufcient at this data volume — a
  campus errand app's `orders` table is not going to be large enough
  that a live `count(*) group by status` needs a materialized view.
  Materialized views add refresh-staleness and refresh-scheduling
  complexity (a `pg_cron` job or manual refresh trigger) that nothing in
  this phase's scope justifies yet. Revisit only if a specific query is
  measured to be slow (§H).
- A `view` (non-materialized) would only reduce SQL duplication, not
  solve the RLS problem — a view still runs under the querying user's
  RLS by default (`security invoker` semantics for views), so the actual
  bypass still has to happen at the function/RPC layer, exactly as
  `get_profile_reputation` already does. A view is not the right tool
  here.
- Each metric group becomes one `SECURITY DEFINER` function (mirroring
  `get_profile_reputation`'s naming/shape convention, e.g.
  `get_my_activity_summary()`, `get_campus_order_volume(p_days int)`,
  `get_popular_locations(p_limit int)`, `get_busy_periods()`) — small,
  single-purpose, each independently revocable/auditable, not one
  monolithic "analytics" function.
- Frontend: one new hook (e.g. `useAnalytics.ts`), following the
  existing `useRatings.ts` shape exactly — thin wrappers around
  `supabase.rpc(...)`, no client-side business logic, no new global
  state/provider needed (this is read-only, on-demand data, not
  something Home/Settings need to share live like 3H's preferences).

---

## E. Privacy/security model

- **Personal metrics**: exactly as private as the user's own order data
  already is today — no new exposure, since the underlying rows were
  already visible to that user under existing RLS.
- **Aggregate/campus-wide metrics**: must be genuinely aggregate — a
  count, a sum, an average, grouped only by *time bucket* or *campus
  point*, never by `requester_id`/`deliverer_id`/any user identifier.
  This is the same bar `get_profile_reputation` already sets and clears.
  A `SECURITY DEFINER` function returning per-user rows (e.g. "top 10
  deliverers by volume, with names") would cross this line and needs a
  separate, explicit decision — not assumed as part of V1.
- **No admin-only tier in V1**, because no admin/role concept exists.
  Aggregate metrics, if built, are visible to *any authenticated user*
  (same trust tier `get_profile_reputation` already grants — every
  signed-in user can already look up any other profile's reputation).
  If you want an actual admin-restricted tier, that's a real product
  decision requiring a new privilege model — flagged for your approval.
- **Location data**: aggregate counts by `campus_points` are safe (shared
  physical places, not personal). Raw `delivery_location`/`custom_delivery_note`
  must never be aggregated verbatim into anything visible beyond the
  order's own participants — a hostel-block-level count is fine; a
  "custom pin near X" note is not, since a free-text note can
  incidentally contain identifying detail.
- **Chat content**: never touched by any 3I metric, full stop — not even
  volume, pending an explicit decision (§B/§C).
- **Retention**: no new retention requirement — 3I proposes zero new
  storage. All computation is live over existing rows; there is nothing
  new to retain or purge. If a future event table is ever justified
  (§C), retention policy becomes a real question at that point, not now.
- **Test/staging data**: staging and production are separate Supabase
  projects (confirmed throughout every prior migration's own
  "STATUS: ... never production" footer) — a production deployment of
  3I's RPCs will not see any of this session's disposable
  `e2e-*@vitstudent.ac.in` test accounts or `Trial N`/`Integ Order`
  restaurant names, because those only ever existed in the staging
  project. There is no schema-level "is this a test order" flag, and
  none is needed for production correctness. If staging itself is ever
  used to demo these metrics, a manual `restaurant_name`/email-pattern
  filter (the same convention used for cleanup throughout this whole
  project) is sufficient — not worth a schema change.

---

## F. Database/migration requirements

**No schema changes required for the must-have/should-have scope in
§C.** Every proposed metric reads existing columns. The only new
objects would be the `SECURITY DEFINER` functions themselves (§D) —
additive, revoke-before-grant, following the `get_profile_reputation`
migration's exact template:

```sql
revoke all on function public.get_my_activity_summary() from public, anon;
grant execute on function public.get_my_activity_summary() to authenticated;
```

No new table. No new column. No new index *required* by the queries
themselves at current data volume (§H covers when that might change).

---

## G. UI/product experience

Not designed in this pass (architecture-only per your instruction), but
the natural, minimal-surface-area placements, consistent with existing
patterns:

- **Personal summary**: a compact section on `Profile.tsx` (which
  already has an "Activity" row linking out) or as a small stat strip
  at the top of `OrderingHistory.tsx`/`DeliveringHistory.tsx` — both
  already show a "history" framing; a few summary numbers above the
  list is a natural, low-complexity extension, not a new page.
- **Aggregate/campus metrics**: if approved, a new lightweight page
  (e.g. `/insights` or similar) is more honest than bolting campus-wide
  numbers onto a personal page — but this is exactly the kind of
  addition that should wait for your explicit go-ahead on scope, not be
  assumed here.
- Reuse `Text`/`Skeleton`/`Alert` primitives and the loading/error/empty
  state conventions already established (Activity's own
  `ActivitySkeleton`/error-alert pattern is a direct template).

---

## H. Performance/indexing

At current, real data volume (staging has low tens of orders; even a
mature single-campus deployment is unlikely to reach a scale where
`count(*)`/`group by` over `orders` is slow), **no new index is
required**. Existing indexes already cover the relevant filters:
`orders_status_idx`, `orders_created_at_idx`, `orders_requester_id_idx`,
`orders_deliverer_id_idx` (all from `20260824120000_rls_policies_and_indexes.sql`).
A `group by pickup_point_id`/`delivery_point_id` for the "popular
locations" metric is the one query without a dedicated index today —
worth adding `orders_pickup_point_id_idx`/`orders_delivery_point_id_idx`
*only if* an `EXPLAIN ANALYZE` against real data shows a sequential
scan actually costs something meaningful; premature to add speculatively
in this same migration. Every proposed RPC should be `stable` (never
`volatile`), matching `get_profile_reputation`'s own declaration, so
Postgres can cache the plan appropriately within a transaction.

---

## I. Test strategy

Follow `useRatings.test.ts`'s established shape exactly: mock
`supabaseMock.rpc`, assert each new hook function calls the correct RPC
name with the correct parameters, and assert the hook's return shape
matches what the UI needs. No new test infrastructure. Specific cases
per metric group:

- **Personal summary**: correct RPC name/args called with the viewer's
  own `userId`; correct handling of a brand-new user with zero orders
  (all counts zero, no error); loading/error states surfaced correctly.
- **Aggregate metrics**: correct bucketing parameters passed (e.g. a
  `p_days` window); a metric returning zero rows (no data yet) renders
  an honest empty state, not a fabricated zero-implying-nothing-happened
  chart.
- **Regression** (see §L): every existing Activity/3H/3G/ratings/
  notifications test must continue passing unmodified — 3I adds new
  files, it does not touch any existing hook/component's behavior.

---

## J. Staging verification plan

Mirroring every prior phase's own convention in this project:

1. Apply the new migration(s) to staging only.
2. Verify grants directly: `has_function_privilege('anon', ..., 'EXECUTE')`
   expected `false`; `has_function_privilege('authenticated', ..., 'EXECUTE')`
   expected `true` — same template as every prior migration's own
   "VERIFY AFTER APPLYING" footer.
3. Create a small set of disposable test orders (same
   `e2e-3i-*@vitstudent.ac.in` convention as every prior phase) spanning
   pending/accepted/delivered/cancelled, at known times and known
   `pickup_point_id`s, and confirm each RPC's returned numbers match
   hand-computed expected values exactly — the same rigor applied to
   3H's radius-matrix verification earlier in this project.
4. Confirm a stranger account (not a participant on any test order)
   still gets correct aggregate numbers (proving the `SECURITY DEFINER`
   bypass is scoped to aggregates only, not raw row leakage) but cannot
   query the underlying `orders` rows directly beyond what
   `orders_select_participant`/`orders_select_pending_feed` already
   allow.
5. Clean up every disposable account/row afterward, confirmed at zero,
   same as every prior phase.

---

## K. Explicitly deferred features

- Lifecycle-timing metrics beyond "time to cancel" (§B/§C) — deferred,
  not infeasible; revisit only with a real product need, and consider
  promoting `notifications`-derived timing into first-class `orders`
  timestamp columns at that point rather than continuing to lean on a
  secondary-purpose join.
- Per-deliverer/per-requester leaderboards or named rankings — deferred,
  needs an explicit identity-exposure decision.
- Discovery-preference adoption analytics — excluded on privacy grounds,
  not merely deferred.
- Chat volume/engagement metrics — deferred pending an explicit privacy
  decision.
- Friend-network statistics — deferred; underlying feature has no real
  usage yet.
- Admin-only dashboard/role-gated analytics tier — deferred; requires a
  new privilege model that does not exist in this schema today.
- New analytics/event table, materialized views, `pg_cron` refresh jobs
  — deferred; not justified by any must-have/should-have metric in this
  scope.
- Real-time/live-updating analytics (e.g. a `postgres_changes`-subscribed
  dashboard) — deferred; every proposed metric is a point-in-time query,
  not a stream.

---

## L. Regression checklist for 3G/3H/Activity

3I, as scoped, touches **zero existing files** — it is purely additive
(new migration, new hook, optionally new UI surfaces). Concretely
verify, before merge, that none of the following changed:

- `enforce_order_status_transition()` / cancellation RLS — untouched;
  3I reads `cancelled_at`/`cancelled_by`/`status`, never writes to
  `orders` at all.
- `orders_select_participant`/`orders_select_pending_feed` — untouched;
  3I's aggregate RPCs are additive `SECURITY DEFINER` functions, not
  changes to existing policies.
- `notify_order_status_change()` and the other three 3H-guarded
  notification triggers — untouched; 3I only *reads* `notifications`
  for the optional lifecycle-timing feature (deferred anyway per §C),
  never writes to it.
- `user_preferences`/discovery filtering/`PreferencesProvider` — entirely
  unrelated; 3I does not read or write any preferences data.
- Activity's Ordering/Delivering/History pages, `useOrders.fetchOrders`'s
  `statusIn`/`limit` filters — unrelated; 3I introduces its own RPC-based
  hook rather than reusing or modifying `useOrders`.
- Full validation gate (`npm test`, `npx tsc --noEmit`, `npm run build`,
  `npm run lint`) must show the exact same pass count baseline as the
  current `main` (501/501 tests, clean tsc, clean build, lint at the
  established baseline) plus only new tests added by 3I — zero existing
  tests modified or removed.

---

## Summary of product decisions needed before implementation

1. **Scope**: approve/adjust the must-have + should-have list in §C —
   personal summary (posted/delivered/cancelled counts, tip averages) +
   three aggregate RPCs (campus order volume over time, popular
   locations, busy periods)? Or narrower (personal-only for V1)?
2. **Completion-rate denominator**: `delivered / total` vs.
   `delivered / (delivered + cancelled)` — a real product framing
   choice, not an engineering ambiguity (§B note).
3. **Aggregate visibility tier**: any signed-in user (matching
   `get_profile_reputation`'s existing precedent), since there is no
   admin/role concept in this schema at all? Building an admin-only tier
   is a separate, larger decision this spec deliberately does not assume.
4. **UI placement**: personal summary folded into `Profile.tsx`/Activity
   History pages (minimal) vs. a new dedicated page for aggregate
   metrics, if approved at all this phase.
5. **Lifecycle-timing via the `notifications` join**: build now as a
   "best-effort, secondary-source" metric, or explicitly defer to a
   future phase with real `orders` timestamp columns?
