# 3G — Richer Delivery Lifecycle Spec (implemented, staging-verified)

**Status: IMPLEMENTED and verified against staging** (`wemjskpbulebxgyhyhmk`),
including two disposable real accounts exercising every matrix row through
real authenticated Supabase calls (not just DB introspection), plus a
repeated live concurrency test. See §16 for the as-shipped record — the
architecture below was approved and implemented exactly as specified, with
no changes to the design during implementation. Source of truth for 3G.
Everything below was traced directly from the current repo
(`src/lib/orderStatus.ts`, `src/hooks/useOrders.ts`, `src/pages/MyOrders.tsx`,
`src/hooks/useDeliveryLocation.ts`, `src/components/chat/ChatThread.tsx`,
`src/components/primitives/statusPresentation.ts`, and every `orders`/
`notifications`/`ratings` migration) — nothing here is assumed.

## 1. Current lifecycle (as it actually exists today)

**Status vocabulary** (`orders_status_check`, `src/lib/orderStatus.ts`):
`pending → accepted → picked_up → out_for_delivery → delivered`, with
`cancelled` reachable from every one of the first four states. `delivered`
and `cancelled` are both terminal — `ORDER_STATUS_TRANSITIONS` maps both to
`[]`.

**Enforcement layers** (two, independent):
1. `enforce_order_status_transition()` (`BEFORE UPDATE ... WHEN (old.status
   IS DISTINCT FROM new.status)`, plain trigger, not `SECURITY DEFINER`) —
   the single DB-level source of truth for which transitions are legal.
   `delivered` additionally requires a session-local flag
   (`campuslink.otp_verified`) that only `verify_delivery_otp()` sets — a
   direct client `UPDATE` can never set `delivered` even if RLS allowed it.
2. RLS on `orders` (`20260824120000_rls_policies_and_indexes.sql`) —
   governs *who* can attempt a write at all:
   - `orders_update_accept`: an unassigned deliverer claiming a `pending`
     order (`deliverer_id IS NULL` → sets `deliverer_id = auth.uid()`).
   - `orders_update_assigned_deliverer`: `auth.uid() = deliverer_id`, no
     status restriction in the policy itself — the trigger is what limits
     which transitions that deliverer may then make.
   - **There is no UPDATE policy for the requester at all.** A requester
     cannot write to their own order's `status` today, for any reason,
     including cancellation.

**Column-level privilege** (`20260825090000_fix_otp_column_privileges.sql`):
`GRANT UPDATE (deliverer_id, status) ON orders TO authenticated` — this is
already narrower than "every column," pre-dating 3G. Any new column this
spec adds must get its own explicit grant (SELECT only, per §9).

**The concrete, load-bearing finding**: because of the RLS gap above, **a
deliverer can already legally cancel an order today** (RLS + trigger both
permit it, from `accepted`, `picked_up`, or `out_for_delivery`) — nothing
in the UI calls it, and no notification exists for it. **A requester cannot
cancel under any circumstance** — not a missing button, a missing
authorization path. This asymmetry, not a general "add a cancel feature,"
is the actual gap 3G closes.

**Client-side lifecycle** (`useOrders.ts`):
- `acceptOrder` — atomic compare-and-swap (`.eq('status','pending')`),
  already race-safe.
- `updateOrderStatus` — deliverer-only (reads current status scoped to
  `deliverer_id = auth.uid()`, then writes with `.eq('status', current.status)`
  as its own compare-and-swap), explicitly blocks a direct `delivered` write.
  It does **not** special-case `cancelled` — a deliverer calling
  `updateOrderStatus(id, 'cancelled', delivererId)` today would already
  succeed against the current schema; only the UI never calls it.
- `getMyOrderOtp` / `verifyDeliveryOtp` — both `SECURITY DEFINER` RPCs,
  identity/state resolved server-side from the trusted row, never from a
  client-supplied ID. `verify_delivery_otp` rejects unless
  `status IN ('picked_up','out_for_delivery')`.

**UI** (`MyOrders.tsx`):
- `OrderTimeline` renders `StatusBadge status="cancelled"` for a cancelled
  order already — `STATUS_PRESENTATION.cancelled` (destructive tone, `XCircle`
  icon, label "Cancelled") has existed since 3B/3C-era work and needs no
  change.
- `TERMINAL_STATUSES = ['delivered', 'cancelled']` — a cancelled order
  already falls out of the two active lanes ("You asked for" / "You're
  carrying") into the "Earlier" section automatically, exactly like a
  delivered one. No lane restructuring needed.
- `NEXT_DELIVERER_ACTION` only maps `accepted→picked_up` and
  `picked_up→out_for_delivery` — no cancel action wired anywhere, for
  either role.
- `OtpPanel` gates on `otpEligible = status IN ('picked_up','out_for_delivery')`.
- `DeliveryTrackingSection` gates on the same two statuses
  (`trackingEligible`), and separately requires a resolved pickup/delivery
  point (`routable`).

**Live tracking** (`useDeliveryLocation.ts`): both
`usePublishDeliveryLocation` (deliverer publish) and `useDeliveryLocation`
(requester subscribe) are no-ops unless their own `enabled` argument is
true, and `MyOrders.tsx` only passes `enabled: true` while
`trackingEligible`. Position data is never persisted (Realtime Broadcast
only) — there is no history to clean up, only a live channel to stop
subscribing to.

**Chat** (`ChatThread.tsx` + `chat_messages` RLS): access is scoped to
"you're a participant on this order" with **no status condition at all** —
a cancelled order's chat thread stays exactly as readable/writable as any
other order's, today and after 3G (see §7 for why this is a deliberate,
not-changed, decision).

**Ratings** (`ratings.sql`): `submit_rating()` already hard-rejects unless
`v_order.status = 'delivered'`; `get_profile_reputation()`'s
`completed_deliveries` already counts `status = 'delivered'` only. A
cancelled order can never reach `delivered` (terminal), so **rating/
reputation correctness already holds with zero code change** — this was
verified, not assumed.

**Notifications** (`notifications.sql`): `notify_order_status_change()`'s
`case` maps `accepted/picked_up/out_for_delivery/delivered` to a
notification type, always recipient = `new.requester_id`. **`cancelled` has
no branch — nothing fires today**, for either party. The `notifications`
table already supports a nullable `order_id` alongside `friendship_id` (3E)
and its own `notifications_type_check`/`notifications_exactly_one_subject`
constraints — the exact `DROP CONSTRAINT IF EXISTS ... ADD CONSTRAINT`
pattern for extending the type list is already an established migration
idiom (used identically in `20260828100000_social_graph.sql`).

## 2. What currently happens in each traced scenario

- **Requester needs to cancel** → cannot, at any status. No RLS path, no
  UI, no client function.
- **Deliverer can no longer complete** → can already legally cancel via a
  direct `updateOrderStatus` call from `accepted`/`picked_up`/
  `out_for_delivery` (RLS + trigger both permit it) — but no UI button
  exists to do so, and no one gets notified if it happened.
- **OTP fails** → `verify_delivery_otp` returns `false` (wrong code), order
  stays exactly where it was; the deliverer sees "Incorrect code" and can
  retry. No cancellation path from here today beyond the general
  deliverer-cancel gap above.
- **Order reaches a terminal state** → `enforce_order_status_transition`'s
  `allowed` array is `[]` for both `delivered` and `cancelled`; any further
  UPDATE attempting to change `status` is rejected at the trigger, for
  anyone, unconditionally.
- **Order is already cancelled** → same as above; also, `verify_delivery_otp`
  independently re-checks `status IN ('picked_up','out_for_delivery')` and
  would reject on its own even without the transition trigger.
- **Order is already delivered** → `submit_rating` allows it (as designed);
  everything else (OTP, tracking, cancel) is already excluded by their own
  status gates.

## 3. 3G v1 scope

1. Requester-facing cancellation (the actual missing capability).
2. Deliverer-facing cancellation **UI** (the capability already exists at
   the data layer; 3G surfaces it deliberately instead of leaving it as an
   unused, un-notified back door).
3. `cancelled_at` + `cancelled_by` — the two timestamp/audit columns that
   are *materially* useful (see §5 for why the other four candidates —
   `accepted_at`, `picked_up_at`, `out_for_delivery_at`, `delivered_at` —
   are deliberately **not** proposed).
4. One new notification type (`order_cancelled`), routed to whichever
   party did *not* initiate the cancellation.
5. Confirming (not rebuilding) that tracking/OTP/ratings already fall out
   correctly — they do, per §1/§7/§8, with zero code change required there.

## 4. Cancellation rules

**Corrected per real-UI review** (the original architecture proposal had
allowed the deliverer to keep cancelling through `picked_up`/
`out_for_delivery`; that was revised before/during implementation — see
below and §16). **Who may cancel, from which state:**

| Status | Requester can cancel? | Deliverer can cancel? | Reasoning |
|---|---|---|---|
| `pending` (unassigned) | **Yes** | N/A — not assigned yet | Nothing has happened in the physical world yet; free to withdraw. |
| `accepted` | **Yes** | **Yes** | Deliverer hasn't bought/collected anything yet — either side backing out costs nothing but the DB row. |
| `picked_up` | **No** | **No** | The deliverer already physically has the item. Neither side gets a normal-cancellation exit from here — the honest fix for "requester wants out" or "deliverer can't complete" at this point is a refund/recovery flow, which needs real payment infrastructure the master plan explicitly defers. `cancelled` stays reachable from `picked_up` at the transition-vocabulary level (unchanged, still used for delivered/cancelled-terminal bookkeeping semantics), but no *authorization path* - neither RLS nor the trigger - grants either participant permission to actually invoke it from here. |
| `out_for_delivery` | **No** | **No** | Same reasoning, one step further along. |
| `delivered` | No (terminal) | No (terminal) | Already enforced today — trigger's `allowed = []`. |
| `cancelled` | No (terminal) | No (terminal) | Already enforced today. |

This is a genuine product boundary, not a technical one: 3G intentionally
stops short of solving "the item is already in the deliverer's hands and
something goes wrong anyway," because that problem's honest answer is a
refund/recovery flow, and both require infrastructure the master plan
explicitly defers. Restricting cancellation to pre-pickup for **both**
roles keeps 3G's promise ("cancellable") honest without pretending to
solve a problem it can't actually solve yet - once picked up, the only
paths forward are completion (OTP) or a future, dedicated
recovery/dispute milestone, not a plain `cancelled`.

**Race condition — the concrete example from the brief:**
*Requester clicks cancel while the deliverer simultaneously advances the
order.* Both writes target the same row's `status` column. Whichever
transaction's `UPDATE` commits first wins; Postgres's row-level locking
(implicit in any `UPDATE ... WHERE`) serializes the second writer behind
the first. The loser's own `WHERE`/RLS `USING` clause is then evaluated
against the *already-committed* new status, so:
- If the deliverer's advance commits first (order is now e.g.
  `picked_up`), the requester's cancel `UPDATE` matches zero rows (RLS
  `USING` requires status IN `pending`/`accepted`) → PostgREST reports 0
  rows affected → client shows "This order has moved on — refresh to see
  its current status," never a corrupted write.
- If the requester's cancel commits first, the deliverer's advance
  `UPDATE` is scoped by `updateOrderStatus`'s existing
  `.eq('status', current.status)` compare-and-swap → also 0 rows affected
  → same clean, already-existing "someone else changed it" error path
  (`updateOrderStatus` already throws exactly this message today).

No new locking primitive, advisory lock, or `SELECT ... FOR UPDATE` is
needed — the combination of RLS re-evaluated per-statement and the
existing compare-and-swap pattern already used by `acceptOrder`/
`updateOrderStatus` is sufficient. This is the same class of guarantee
those two already rely on; 3G's new policy just needs to participate in
it, not invent a new mechanism.

**What happens to tracking, chat, ratings when cancelled** — see §7/§8.

## 5. Timestamp model — smallest useful set

Evaluated against the master plan's own test ("materially improve
correctness/auditability/user-facing progress/notification timing" — not
"looks sophisticated"):

| Column | Proposed? | Why |
|---|---|---|
| `accepted_at` | **No** | Nothing reads "how long ago accepted" anywhere; no UI, notification, or ranking signal consumes it. |
| `picked_up_at` | **No** | Same — no current consumer. |
| `out_for_delivery_at` | **No** | Same. |
| `delivered_at` | **No** | 3F's recency tie-break already uses `created_at`; nothing needs delivery-completion time distinct from creation time yet. |
| **`cancelled_at`** | **Yes** | The one terminal state 3G gives real user-facing meaning to. Activity's "Earlier" list currently shows `created_at` next to every past order regardless of outcome — for a cancelled order, "when it was cancelled" is the materially correct date to show, and it's the natural anchor for any future 3I cancellation-rate analytics. |
| **`cancelled_by`** | **Yes** | Needed for correct UI copy ("You cancelled this" vs. "The other person cancelled this") — not decoration, a real distinction the requester/deliverer will want to see in their own history. |

**For each proposed column:**

- **`cancelled_at timestamptz null`**
  - *Why*: date to show for a cancelled order in Activity/history.
  - *Who writes it*: the existing `enforce_order_status_transition()`
    trigger function, extended (not replaced) — when it lets a transition
    to `cancelled` through, it also sets `new.cancelled_at := now()`
    inside the same `BEFORE UPDATE` row, before the write lands.
  - *When*: the instant `status` becomes `cancelled` (same trigger firing
    point already used for the `delivered`/OTP special case).
  - *Mutable?* No — `cancelled` is terminal, no further transition into or
    out of it exists, so nothing ever revisits this column after it's set.
  - *Index?* No — no query filters or sorts by it yet; add one later only
    if 3I actually needs it.
  - *Read access*: same as every other order column — `orders_select_participant`
    (both participants), via a new explicit `GRANT SELECT (cancelled_at)`.
- **`cancelled_by uuid null references profiles(id)`**
  - *Why*: lets the client render "You cancelled" vs. "They cancelled"
    without an extra lookup (`cancelled_by = auth.uid()` client-side
    comparison against the already-known `requester_id`/`deliverer_id`).
  - *Who writes it*: same trigger, same moment — `new.cancelled_by :=
    auth.uid()`. `auth.uid()` inside a row-level `BEFORE UPDATE` trigger
    reflects the session that issued the statement, exactly the same
    trust boundary `verify_delivery_otp` already relies on for
    `auth.uid()`-scoped lookups; nothing client-supplied is trusted.
  - *When*: same as `cancelled_at`.
  - *Mutable?* No, same terminal-state reasoning.
  - *Index?* No — read only ever by primary key (the order itself), never
    filtered/searched on.
  - *Read access*: `GRANT SELECT (cancelled_by)`, same as above.

**Critically: the client never writes either column.** The new
`cancelOrder()` client call sends only `{ status: 'cancelled' }` — matching
`acceptOrder`/`updateOrderStatus`'s existing minimal-payload style — and
`cancelled_at`/`cancelled_by` are **not** added to the
`GRANT UPDATE (deliverer_id, status)` privilege at all, only to `SELECT`.
A trigger's `NEW.column := value` assignment inside its own row-level
logic doesn't require additional UPDATE privilege on that column (it isn't
a client-issued `UPDATE ... SET cancelled_at = ...`); this is the same
reason `enforce_order_status_transition` needs no extra grant today to
read `old`/`new`.

## 6. Transition model — what actually changes

**No change to `ORDER_STATUS_TRANSITIONS` or the DB `allowed` array** — both
already include `cancelled` as reachable from `pending`/`accepted`/
`picked_up`/`out_for_delivery`, and map `delivered`/`cancelled` to `[]`.
3G adds **authorization**, not new transition edges.

**Terminal states — explicit, unchanged:** `delivered` and `cancelled`.
After either: no further status transition (trigger-enforced, unchanged),
no OTP verification (`verify_delivery_otp`'s own status check, unchanged),
no tracking (`trackingEligible`'s gate, unchanged), and — new in 3G — no
further cancellation attempt (the new requester policy's `USING` clause
naturally excludes both terminal states by only listing `pending`/
`accepted`).

## 7. Notification integration

Extend `notify_order_status_change()` — same function, same trigger,
additive branch only; the existing four-type behavior is untouched
byte-for-byte:

- If `new.status = 'cancelled'` and `new.deliverer_id IS NOT NULL`:
  recipient is *the other participant*, determined by comparing
  `auth.uid()` (the session that performed the write) against
  `new.requester_id`/`new.deliverer_id` — not a client-supplied value.
  - Requester cancelled → notify the deliverer.
  - Deliverer cancelled → notify the requester.
- If `new.status = 'cancelled'` and `deliverer_id IS NULL` (a `pending`
  order cancelled before anyone accepted it): no notification — there is
  no one to tell.

Requires one new enum value in `notifications_type_check`
(`'order_cancelled'`), added via the exact `DROP CONSTRAINT IF EXISTS /
ADD CONSTRAINT` pattern 3E already used for `friendship_id` support — no
new infrastructure, no new table, no push/SMS.

`formatNotificationText` (`notificationContent.ts`) gets one new `case
'order_cancelled'` arm; TypeScript's exhaustive switch over `NotificationType`
already forces this — the union type gains `'order_cancelled'`, the
compiler will refuse to build until every switch over it is handled.

## 8. Tracking implications

**No code change required.** `usePublishDeliveryLocation`/
`useDeliveryLocation` are already gated on `enabled`, which `MyOrders.tsx`
already derives from `trackingEligible = status IN ('picked_up',
'out_for_delivery')`. The instant a cancellation lands, the next re-render
(driven by the existing `subscribeToOrders` realtime `postgres_changes`
channel already open on `orders`, or the explicit `refetch()` already
called after every other status-changing action) recomputes
`trackingEligible` to `false`, which flips `enabled` to `false` on both
hooks, whose own `useEffect` cleanup (`navigator.geolocation.clearWatch`,
`supabase.removeChannel`) already runs unconditionally on that
transition. This is the same mechanism that already correctly stops
tracking the instant an order reaches `delivered` today — cancellation
falls out of an existing, already-correct gate, not a new one.

No RLS change either: the Realtime Broadcast channel
(`order-location-{orderId}`) is scoped by its own private-channel RLS,
untouched by this spec, and stops being subscribed to for the reason
above regardless of what that RLS says.

## 9. Ratings/reputation implications

**No code change required**, verified in §1: `submit_rating()` already
requires `status = 'delivered'`; a cancelled order can never satisfy that
(terminal, never transitions to `delivered`). `get_profile_reputation()`'s
`completed_deliveries` count already filters on `status = 'delivered'`
too. 3F's ranking (`ranking.ts`) only ever operates on `pending` orders
(the visible board) — a cancelled order disappears from the board
entirely (it's no longer `pending`), so it was never a ranking input to
begin with.

## 10. Security / RLS changes

**Exactly one new policy, additive, on `orders`:**

```sql
create policy "orders_update_requester_cancel"
  on orders for update
  using (auth.uid() = requester_id and status in ('pending', 'accepted'))
  with check (auth.uid() = requester_id and status = 'cancelled');
```

- **Deliverer-side cancellation, corrected**: `orders_update_assigned_deliverer`
  (pre-existing, unchanged, still needed for every legitimate deliverer
  advance) technically permits a cancelling write from `accepted`/
  `picked_up`/`out_for_delivery` alike — RLS alone can't distinguish
  "the deliverer is advancing the order" from "the deliverer is
  cancelling it" without duplicating that policy into a narrower one and
  risking drift between the two. Instead, `enforce_order_status_transition()`
  (the same trigger 3G already extends for `cancelled_at`/`cancelled_by`)
  gained one more actor-aware branch: if the write's target is
  `cancelled`, the row's `deliverer_id` is set, and `auth.uid()` matches
  that `deliverer_id`, the trigger raises unless `old.status = 'accepted'`.
  This fires regardless of which RLS policy let the raw `UPDATE` through,
  so it's a real DB-enforced authorization boundary, not client/UI
  hiding — proven live: a raw deliverer cancel attempt against a
  `picked_up` order, issued with **no client-side status filter at all**,
  was rejected by the trigger itself (staging E2E, §16). The requester's
  own policy (below) is untouched and needs no revision — a requester's
  cancel attempt from `picked_up`/`out_for_delivery` is already rejected
  by `orders_update_requester_cancel`'s own `USING` clause before this
  trigger branch is ever reached.
- **Why a plain RLS policy, not an RPC/`SECURITY DEFINER` function**: the
  master plan's own rule ("use invoker-rights functions where sufficient")
  applies cleanly here. Unlike OTP verification (which must compare a
  secret server-side and never let the client see the comparison) or
  rating submission (which must resolve the reviewee from a trusted row
  the client could lie about), cancellation needs no secret, no derived
  value the client could forge, and no cross-row aggregation — it's a
  straightforward "is this the requester, and is the current state
  cancellable" check, which RLS's `USING`/`WITH CHECK` already expresses
  completely. Adding a `SECURITY DEFINER` function here would bypass
  table-level grants for no actual security benefit.
- **Column-level privilege**: no change to `GRANT UPDATE (deliverer_id,
  status) ON orders` — cancellation only ever writes `status`, already
  covered. New `GRANT SELECT (cancelled_at, cancelled_by) ON orders TO
  authenticated` (both participants already covered by
  `orders_select_participant`/`orders_select_pending_feed`).
- **OTP protections**: untouched. `verify_delivery_otp` already
  independently rejects a cancelled order via its own status check —
  doubly defended, not weakened.
- **No `SECURITY DEFINER` added anywhere in this spec.**

## 11. Concurrency — summary

Covered in full in §4; restated briefly: no new locking primitive. Postgres's
per-statement RLS re-evaluation plus the existing compare-and-swap idiom
(`acceptOrder`, `updateOrderStatus`) already guarantees the losing side of
a race sees zero affected rows rather than a corrupted write, for both the
new requester-cancel path and the existing deliverer paths.

## 12. UI flow

**Requester side** (`ActiveOrderDetail`, role === 'requester', status
`pending` or `accepted` only): a small secondary (ghost/destructive-tone)
text action — "Cancel this request" — placed below the existing status/
counterpart block, not competing with any primary action (there is no
primary requester action today at this stage). Clicking opens the
existing `Dialog` primitive (same component already used by
`EditProfileDialog`/`ChangePasswordDialog` — no new interaction pattern):
title "Cancel this request?", one line of consequence-specific body copy
("Whoever accepted it will be notified." when `deliverer_id` is set;
"This request hasn't been accepted yet." when not), Cancel/"Cancel request"
buttons, loading state on the confirm button, toast on success, inline
error (with the race-condition copy from §4) on failure. One dialog, one
step — no wizard.

**Deliverer side** (`ActiveOrderDetail`, role === 'deliverer', status
`accepted`/`picked_up`/`out_for_delivery`): a matching small secondary
action — "Can't complete this" — next to the existing `NEXT_DELIVERER_ACTION`
button, same `Dialog` confirmation pattern, copy oriented to the deliverer
("The requester will be notified and can look for someone else.").

**Past orders / "Earlier" list**: for a cancelled row, show `cancelled_at`
(falling back to `created_at` for any pre-3G cancelled row, since that
column will be `null` on historical data) and, if `cancelled_by` is
present, "You cancelled" or "They cancelled" instead of the current plain
"Asked · <date>" / "Carried · <date>" line. `StatusBadge` itself needs no
change.

**Chat**: deliberately left exactly as-is — no "locked thread" state, no
banner. RLS already allows both participants to keep reading/writing after
cancellation (§1); adding a lock would be new complexity not required by
anything in the brief, and a short "sorry, cancelling because X" message
is a legitimate, harmless use of an already-open thread.

## 13. Migration plan

One additive migration file (staging only, `wemjskpbulebxgyhyhmk`):

1. `alter table orders add column if not exists cancelled_at timestamptz;`
2. `alter table orders add column if not exists cancelled_by uuid references profiles(id);`
3. `grant select (cancelled_at, cancelled_by) on orders to authenticated;`
   (no `anon` — matches the existing pattern for every other participant-only
   column; the `orders_select_pending_feed` policy already only exposes
   `pending` rows publicly, which by definition never have these two
   columns set).
4. `create or replace function enforce_order_status_transition()` —
   extended to also set `new.cancelled_at`/`new.cancelled_by` when the
   transition target is `cancelled`; the existing `delivered`/OTP branch
   and the `allowed` transition array are otherwise byte-identical.
5. New RLS policy `orders_update_requester_cancel` (§10).
6. `alter table notifications drop constraint if exists notifications_type_check;`
   `alter table notifications add constraint notifications_type_check check (type in (...existing 5..., 'order_cancelled'));`
   — same pattern 3E already used.
7. `create or replace function notify_order_status_change()` — additive
   branch for `cancelled` (§7); existing four-type logic untouched.
8. Verification block (mirroring every prior migration's own convention):
   confirm `has_column_privilege`/`has_table_privilege` results for the
   new columns and policy, confirm a manual test cancellation from each
   role/state combination in the matrix produces the expected
   accept/reject result.

No new table. No new index (per §5). No change to `orders_status_check`
(the value `'cancelled'` already exists in it).

## 14. Testing strategy

**Unit** (`src/lib/orderStatus.ts`): no change needed — already covers
`cancelled` as a valid target from every non-terminal state; no new test
required there specifically, though the existing transition tests remain
the regression guard.

**Unit** (`src/hooks/useOrders.test.ts`, new `describe('cancelOrder')`
block, mirroring the existing `updateOrderStatus`/`acceptOrder` test
style with the mocked Supabase client):
- rejects (client-side, before any network call) attempting to cancel a
  `delivered`/`cancelled` order.
- rejects (client-side) a requester attempting to cancel a `picked_up`/
  `out_for_delivery` order.
- allows a requester to cancel `pending`/`accepted`.
- allows a deliverer to cancel `accepted`/`picked_up`/`out_for_delivery`.
- propagates a DB-level rejection (0 rows affected) as the existing
  "someone else changed it" style error, not a silent success.

**Component** (`src/pages/MyOrders.test.tsx`):
- Cancel action renders only for the requester at `pending`/`accepted`,
  and only for the deliverer at `accepted`/`picked_up`/`out_for_delivery`.
- Confirmation dialog blocks an accidental single-click cancel (button
  click opens the dialog; only the dialog's own confirm button calls the
  mocked cancel function).
- Successful cancel toasts and the order leaves the active lane (already
  covered by the existing `TERMINAL_STATUSES` filter — a regression test
  here just confirms cancellation feeds into that existing mechanism).
- Cancelled row in "Earlier" shows the new copy from §12.

**Component** (`src/lib/notificationContent.test.ts`): new case for
`order_cancelled` text.

**Staging E2E** (real Supabase project, disposable accounts, cleaned up
after — same discipline as every prior 3-phase milestone):
- Requester cancels a `pending` order they posted → order disappears from
  the public board, appears in their own "Earlier" list as cancelled.
- Requester cancels an `accepted` order → the assigned deliverer receives
  an `order_cancelled` notification; the order leaves the deliverer's
  "You're carrying" lane.
- Attempted requester cancel of a `picked_up` order → rejected (RLS), UI
  shows the appropriate error, order state unchanged.
- Deliverer cancels a `picked_up` order → requester notified, order
  leaves both active lanes, any open tracking view for that order stops
  showing a live location on next poll/subscription event.
- Attempt to cancel an already-`delivered` or already-`cancelled` order
  (direct API call, bypassing the UI) → rejected by the trigger
  regardless of RLS.
- Race test: two near-simultaneous writes (a scripted direct cancel +
  advance against the same staging order) → exactly one succeeds, the
  other observes zero rows affected, final DB state is single-valued and
  consistent with whichever committed first.
- Confirm ratings/OTP/tracking remain fully unaffected for a normally
  `delivered` order in the same staging pass (regression, not a new
  behavior).

## 15. Explicitly deferred (not part of 3G v1)

- `accepted_at` / `picked_up_at` / `out_for_delivery_at` / `delivered_at`
  timestamps — no current consumer justifies them (§5); revisit if 3I
  analytics or a future UI need materializes.
- Any dispute/recovery/refund system, support tickets, or penalties for
  frequent cancellation — explicitly out of scope per the brief and the
  master plan's payment deferral.
- Locking or otherwise altering the chat thread on cancellation (§12) —
  no behavior change, a deliberate decision not a gap.
- Requester cancellation after `picked_up` — a genuine, currently-unsolved
  product problem (the deliverer already spent effort/money) that needs a
  refund/reimbursement model to solve honestly; belongs with the future
  payments milestone, not 3G.
- Any push/SMS delivery for the new notification type.
- A dedicated `orders_status_history` audit table — `cancelled_at`/
  `cancelled_by` on the row itself is judged sufficient for v1; a full
  history table is deferred until/unless multiple state timestamps are
  ever justified together.
- Rate-limiting or throttling repeated cancellations by the same user —
  no evidence of abuse potential serious enough to justify it yet; the
  existing RLS/trigger stack already prevents any *incorrect* state, only
  not "too many correct cancellations."

## 16. Implementation record (as shipped)

The architecture in §1–§15 was implemented exactly as specified, **with
one correction made after real-UI testing**: the original proposal let the
deliverer keep cancelling through `picked_up`/`out_for_delivery` (reasoning:
they hold all the remaining risk, so they should keep an exit). Testing
the real UI surfaced the more correct product rule — once the deliverer
has physically picked up the item, cancellation isn't a clean exit for
*either* side anymore (the item is already out of the requester's hands),
so it was removed for the deliverer too, symmetrically with the
requester's existing pre-pickup-only restriction. The matrix in §4 and the
RLS/trigger description in §10 reflect the corrected, as-shipped rule; this
section records what changed to get there and how it was verified.

**Correction migration**:
`supabase/migrations/20260830200000_restrict_deliverer_cancellation.sql`,
additive follow-up to the original cancellation migration. Re-defines
`enforce_order_status_transition()` with one more actor-aware branch (see
§10) — no column, policy, or grant changes; `orders_update_requester_cancel`
and `orders_update_assigned_deliverer` are both untouched.

Verified live on staging (two disposable accounts, real authenticated
Supabase calls, not DB introspection alone):
- Deliverer cancel of their own `accepted` order — still succeeds,
  unchanged.
- Deliverer cancel attempt on `picked_up` via the app's own client filter
  (`cancelOrder`'s `.in('status', ['accepted'])`) — zero rows, clean
  rejection, matching real UI behavior.
- **Deliverer cancel attempt on `picked_up`, issued with no client-side
  status filter at all** (a raw `.update({status:'cancelled'}).eq('id',
  ...).eq('deliverer_id', ...)`, deliberately bypassing the app's own
  convenience filter to prove the real boundary) — rejected by the
  trigger itself: `"A deliverer can only cancel while the order is still
  accepted, before pickup"` (Postgres error code `42501`,
  `insufficient_privilege`). Same proof repeated for `out_for_delivery`.
  This is the concrete evidence the authorization lives in the database,
  not the UI.
- Normal `accepted → picked_up → out_for_delivery` deliverer advancement —
  unaffected; the new trigger branch only ever evaluates when the write's
  target is `cancelled`.
- Requester-side rules (pending/accepted cancellable, blocked after
  pickup) — fully unaffected, re-verified as a regression check.

**Test suite updated**: `MyOrders.test.tsx`'s deliverer-cancellation cases
now assert the cancel action is offered only while `accepted`, and
explicitly assert its absence for `picked_up`/`out_for_delivery` (and for
`delivered`); `useOrders.test.ts`'s `cancelOrder` deliverer test now
asserts the `.in('status', ...)` filter is `['accepted']` only. The
DB/trigger-level proof (raw-update rejection) is staging-only — it
exercises live Postgres RLS/trigger behavior no jsdom/mocked unit test can
substitute for.

**Validation after the correction**: `npm test` 412/412, `npx tsc --noEmit`
clean, `npm run build` succeeds, `npm run lint` 20 problems (9 errors/11
warnings) — identical baseline, zero new.

**Migration**: one file,
`supabase/migrations/20260830100000_order_cancellation.sql`, applied to
staging and verified live (privilege/policy introspection queries, not
assumed). Confirmed on staging:
- `authenticated` has `SELECT` but **not** `UPDATE` on `cancelled_at`/
  `cancelled_by` — the client genuinely cannot forge either value; only
  `enforce_order_status_transition()`'s `NEW.column := ...` assignment
  ever sets them.
- `anon` has no access to either column.
- Pre-existing privileges are byte-for-byte unchanged: `authenticated`
  can still `UPDATE (deliverer_id, status)` and nothing else on `orders`
  (`tip_amount` update-privilege check still returns `false`), and
  `authenticated` still cannot `SELECT` `otp` — OTP protection untouched.
- `orders` now carries exactly three `UPDATE` policies —
  `orders_update_accept`, `orders_update_assigned_deliverer` (both
  pre-existing, unchanged), and the one new
  `orders_update_requester_cancel`.
- `notifications_type_check` now includes `order_cancelled` alongside all
  seven pre-existing values.

**Atomicity**: implemented as specified in §10/§11 — a single conditional
`UPDATE` per role (`useOrders.ts`'s `cancelOrder()`), not a read-then-write,
and not a `SECURITY DEFINER` RPC. No service-role path exists anywhere in
this change. The DB-level guarantee (RLS `USING` re-evaluated per-statement
+ the transition trigger's terminal-state check) was proven live, not just
argued: a repeated real race test (8 independent trials, two authenticated
Supabase sessions issuing genuinely concurrent `UPDATE`s against the same
staging row) produced **3 cancel-wins and 5 advance-wins, zero corrupted or
dual-state results** — both possible outcomes occur naturally, and in every
case exactly one write affected a row and the other affected zero.

**Ratings/reputation regression check**: a real order was carried through
the full OTP flow to `delivered` and successfully rated (`submit_rating`
still works exactly as before); a cancelled order's `submit_rating` attempt
was rejected with the pre-existing "order has not been delivered yet"
message (no new rejection logic was written — this is the original 3D
guard, exercised, not modified). `get_profile_reputation`'s
`completed_deliveries` count matched the true delivered-order count exactly,
un-inflated by the four cancelled orders the same test run created.

**Tracking**: verified by code inspection, not a live two-browser GPS
session (see §8's reasoning — the mechanism is unchanged, already-existing
code) — confirmed the `trackingEligible`/`otpEligible` gates in
`MyOrders.tsx` are unmodified and still key off `status IN ('picked_up',
'out_for_delivery')`, so a cancelled order (whose status is no longer
either) already falls outside both gates the moment the client re-reads
the row.

**One pre-existing issue found, not fixed (out of scope for 3G)**: while
building the staging E2E script, `verify_delivery_otp()` was found to
accept OTP submission while `status = 'picked_up'` (its own guard is
`status NOT IN ('picked_up', 'out_for_delivery')`), but
`enforce_order_status_transition()`'s `allowed` map only permits
`picked_up → out_for_delivery`/`cancelled`, **not** `picked_up →
delivered`. Attempting OTP verification directly from `picked_up` (skipping
the `out_for_delivery` step) fails with "Invalid order status transition:
picked_up -> delivered" — a latent inconsistency between two 3A/1B-era
functions, not something 3G introduced or touched. The real product UI
never hits this path (a deliverer must click through "Mark picked up" then
"Mark out for delivery" before OTP entry ever becomes relevant in
`MyOrders.tsx`), so it has no user-facing impact today, but it's worth a
dedicated follow-up ticket rather than silent tolerance. **Not fixed here**,
per "do not modify unrelated code."

**Files changed**:
- `supabase/migrations/20260830100000_order_cancellation.sql` (new)
- `supabase/migrations/20260830200000_restrict_deliverer_cancellation.sql`
  (new) — the correction in this section.
- `src/lib/database-types.ts` — `cancelled_at`/`cancelled_by` on `Order`;
  `order_cancelled` added to `NotificationType`.
- `src/hooks/useOrders.ts` — `cancelled_at`/`cancelled_by` added to
  `ORDER_COLUMNS`; new `cancelOrder()`.
- `src/lib/notificationContent.ts` — new `order_cancelled` case.
- `src/components/orders/CancelOrderDialog.tsx` (new) — the confirmation
  dialog, shared by both roles.
- `src/pages/MyOrders.tsx` — cancel action wired into `ActiveOrderDetail`/
  `ActiveOrderRow`/`Lane`; "Earlier" list shows `cancelled_at` + "You
  cancelled"/"They cancelled" for cancelled rows.
- `src/test/supabaseMock.ts` — added `.in()` to the shared query-builder
  mock (needed by `cancelOrder`'s filter chain; no other test's behavior
  changed by this addition).
- Tests: `src/hooks/useOrders.test.ts`, `src/pages/MyOrders.test.tsx`,
  `src/lib/notificationContent.test.ts` — all extended, none rewritten.

**Validation**: `npm test` 412/412, `npx tsc --noEmit` clean,
`npm run build` succeeds, `npm run lint` 20 problems (9 errors/11
warnings) — identical to the pre-3G baseline, zero new.

**Staging discipline**: two disposable accounts per test run
(`e2e-3g-*@vitstudent.ac.in` / `e2e-3g-race-*@vitstudent.ac.in`), all
created orders/notifications/ratings/profile rows deleted after each run
via a direct Postgres connection (confirmed zero rows remaining). As with
every prior disposable-account cleanup in this project, the underlying
`auth.users` rows themselves cannot be deleted without a service-role key
(not available in this environment) and remain as stray auth-only
accounts — the same known, pre-existing limitation flagged in earlier
sessions' staging cleanups, not new to 3G.
