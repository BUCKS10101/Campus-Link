# 3F — Smart Matching Spec

**Status: IMPLEMENTED and verified against staging**
(`wemjskpbulebxgyhyhmk`), including a real logged-in browser session
exercising the actual Recommended tab. This document has been updated
to describe the system as built (see §10 for the one refinement made
during implementation - the Recommended tab does not get a separate
"featured" panel, unlike originally sketched). Source of truth for 3F.

## 0. What already exists (read before designing anything new)

- **`ranking.ts` (3B)** is pure, client-side, deterministic. `getTrustTier`
  classifies an order's own `distance_km`/`distance_source` into
  `routed`/`fallback`/`unresolved` (a tier is decided first, never
  blended into a score). `rewardDensity` = tip ÷ distance, the single
  dimensionally-meaningful ratio 3B chose over an arbitrary weighted sum.
  `rankQuickErrands`/`rankHighReward`/`rankFeatured` are the three
  existing views. None of this compares across orders using anything but
  the order's own two columns plus `tip_amount`/`created_at`.
- **`Home.tsx`** fetches the whole pending-order board **once** (client-
  side realtime-refreshed, no per-filter re-fetch), then ranks entirely
  in memory. Its own top comment is explicit and load-bearing: *"'Nearby'
  is deliberately not a filter name here: nothing in the app knows where
  the viewing student actually is."* `distance_km` on an order is the
  **errand's own pickup→delivery distance**, never the viewer's distance
  to anything — 3F must preserve this exact honesty, not quietly
  conflate the two.
- **`useOrders.ts`'s board query** already embeds
  `requester_profile`/`deliverer_profile` via
  `profiles!orders_requester_id_fkey(*)` — every order on the board
  already carries its `requester_id` for free, no extra query needed to
  know who posted it.
- **3D's `get_profile_reputation(uuid)`** is a `SECURITY DEFINER` RPC,
  already granted to any `authenticated` user, already the intended
  mechanism for "can I trust this person" — it's simply never been
  batched for a whole feed. Individual rating comments are never
  returned by it.
- **3E's `friendships`** table + `friendships_select_participant` RLS
  already let a signed-in user read every friendship row they're
  personally part of (accepted or pending, either direction) with one
  plain `SELECT` — no RPC needed to know "who are my accepted friends."
- **Live delivery-location tracking (3A revision)** exists, but only for
  an *already-accepted* order's deliverer, broadcast-only (never
  persisted), gated on explicit consent, active only during
  `picked_up`/`out_for_delivery`. It has nothing to do with where a
  student browsing Home physically is right now. **Confirms: there is
  no live-location signal anywhere in this app for the viewer.**
- **Notifications (3C)** has no "recommendation" event type and none is
  proposed — a recommendation is a Home-only view, never pushed.

## 1. What "match" can honestly mean today

Given the above, "match" cannot mean "near you" — that claim requires
knowing the viewer's physical location, which this app has never
collected and 3F will not start collecting (see §8). "Match" instead
means: **among the real, already-computed signals on an order (its own
trip effort/reward, the requester's real reputation, whether the
requester is your friend), rank the board the same honest way a careful
student would scan it themselves — shortest/best-value real errand
first, informed by who's asking.** This is a *smarter sort of the
existing feed*, not a claim about the viewer's proximity, availability,
or preferences (none of which exist as data).

## 2. Eligibility rules

Only one new eligibility rule, scoped to the new "Recommended" view
specifically (§10) — **exclude the viewer's own posted orders**.
Recommending someone their own errand to fulfill is incoherent, and
unlike "All"/"Quick errands"/"High reward" (generic board-wide views,
never framed as being "for" anyone), "Recommended for you" makes a
personal claim that a self-authored result would falsify. This mirrors
what already happens implicitly (a requester can't `acceptOrder` their
own post — `useOrders.ts`'s `acceptOrder` already rejects it server-
side) — 3F just also declines to *show* it as a recommendation. The
existing tabs are untouched; this rule lives only inside the new ranking
function, not as a change to the board query.

No other new eligibility rule is needed: everything on the board is
already `status = 'pending'` (the existing query), already excludes
anything the viewer can't legally accept once eligibility above is
applied.

## 3. Signals actually usable today

| Signal | Usable? | Source |
|---|---|---|
| Distance/effort of the errand itself | Yes | `distance_km`/`distance_source` (existing) |
| Reward | Yes | `tip_amount` (existing) |
| Reward density | Yes | `rewardDensity()` (existing, reused) |
| Route compatibility (viewer's own route) | **No** | no concept of "the viewer's route" exists anywhere - not inferred from proximity, not built here |
| Trust/reputation | Yes, as a tie-break only | `get_profile_reputation` (3D), batched (§11) |
| Friendship | Yes, as a tie-break only | `friendships` (3E), one query (§11) |
| Live viewer location | **No** | doesn't exist (§0); documented as future enhancement (§8) |

## 4. Deterministic ranking model — a strict hierarchy, never a weighted sum

A new `rankRecommended()` in `ranking.ts`, a **lexicographic comparator**
(each level only breaks ties left by the level above it — exactly the
"prefer a hierarchy" instruction, and exactly how 3B already refused a
weighted sum):

```
1. Eligibility        - exclude the viewer's own posted orders (§2)
2. Trust tier          - routed < fallback < unresolved (reused verbatim from 3B - getTrustTier)
3. Reward density       - within the SAME tier only: higher rewardDensity() first
                          (routed/fallback tiers); for the unresolved tier,
                          higher raw tip_amount first (exactly rankHighReward's
                          existing two-group logic, reused, not reinvented)
4. Reputation tie-break - ONLY when BOTH orders' requesters have rating_count > 0:
                          higher avg_rating first. If either side is unrated,
                          this level is skipped entirely (yields no difference,
                          falls through) - an unrated user is never penalized
                          NOR boosted, simply neutral at this level.
5. Friendship tie-break - the order whose requester is an accepted friend of
                          the viewer sorts first. Never overrides tier or
                          reward density - only ever decides between two
                          orders already tied through level 4.
6. Recency tie-break    - newest created_at first (same convention every
                          other ranking function in this file already uses)
```

**Explicit answers to the task's required questions:**
- *Routed vs fallback?* Routed always outranks fallback, unconditionally
  — a real measured route is more trustworthy than a straight-line
  guess, before reward is even considered. This is tier-first, exactly
  3B's existing rule, unchanged.
- *Unresolved distance?* Never hidden, never placed above a real tier —
  ranked last by tier, and within that tier by raw tip (no
  fabricated distance-based number). Same as `rankHighReward` already
  does.
- *Reputation's influence?* Tie-break only, gated on both sides actually
  having ratings — it can reorder two otherwise-identical-value orders,
  it can never make a worse-value order outrank a better one.
- *Friendship's influence?* Tie-break only, one level below reputation —
  it can nudge between equals, never override effort/reward/trust.
- *New/unrated users?* Structurally invisible to level 4 (the comparator
  returns 0/no-difference whenever either side lacks a real rating) —
  neither boosted nor penalized, exactly the required behavior.
- *Ties?* Recency, the same fallback every other ranking function here
  already uses.

## 5. Routed/fallback/unresolved — reused, not reinvented

`rankRecommended` calls the existing exported `getTrustTier`,
`hasUsableDistance`, and `rewardDensity` directly — there is exactly one
definition of these three concepts in the whole app, and 3F does not
duplicate or shadow it.

## 6. Reputation treatment — normalized how

No normalization math is applied to `avg_rating` itself (it's already a
1–5 scale from 3D, directly comparable). "Normalization" here means the
**gating rule**: the comparator only ever consults reputation when
`rating_count > 0` on **both** sides being compared. There is no numeric
substitute for "no rating" (not 0, not the campus average, not a
fabricated neutral score) — the comparison is simply skipped, which is
the only way to guarantee a new user is never quantitatively penalized
for something that hasn't happened to them yet.

## 7. Friendship treatment — exact influence, nothing more

- Only `order.requester_id` is checked against the viewer's accepted-
  friend-id set (deliverer_id is always null on the public pending
  board — a pending order has no deliverer yet).
- Purely a same-tier, same-reward-density, same-reputation tie-break —
  never a filter, never a boost large enough to move an order across
  tiers or past a meaningfully better reward_density.
- Surfaced to the UI only as a reason chip on the viewer's *own* screen,
  computed only from friendship rows the viewer is already personally
  entitled to see (§13) — never shown to, or inferable by, anyone else.

## 8. Live user location — explicitly deferred

3F does not request, store, or infer the viewer's physical location.
`profiles.hostel_block` is not treated as "where they are right now"
(it's a stored, possibly-stale profile field, not a live position — the
same distinction 3B's spec already drew and 3F preserves). If genuine
personalized "near you right now" matching is ever wanted, it requires
a real, consented, purpose-built live-location feature — a dedicated
future milestone, not a repurposing of the deliverer-only broadcast
channel that already exists for a completely different purpose (§0).

## 9. Explanation / reason-chip logic

Exactly one reason chip per card (matching `OrderCard`'s existing
single-line caption slot — no new UI slot invented), chosen by priority,
and **only** shown for the top `REASON_CHIP_COUNT` (3, matching the
existing constant) cards of the Recommended list:

```
1. "Friend involved"              - only if requester is an accepted friend
2. "Strong reward" / "Good reward - only if the order actually has a
    for the distance"               computable rewardDensity (routed/fallback)
                                     or a genuinely high raw tip (unresolved)
3. "Short run"                     - only if the order is in the routed/
                                     fallback tier with a short distance_km
```

Never shown: "Perfect match," "Best for you," "Nearby you" — none of
these claims are supportable by real data (§8), and the task explicitly
forbids them.

## 10. Home integration (as built)

A **fourth filter chip**, `Recommended`, alongside the existing
All/Quick errands/High reward — not a Home redesign, not a new page
section replacing anything. It behaves exactly like Quick errands/High
reward already do architecturally: its own full ranked list under its
own header label ("Recommended"), no separate "Best on the board"
featured panel (that treatment stays unique to the `all` tab, reusing
`rankFeatured`/`rankHighReward` exactly as before, untouched by 3F).
Giving Recommended a second, different "featured" pattern would be a
new UI concept for one tab only — the simpler, more consistent choice
that's actually implemented is: one more list tab, same shape as the
other two.

One small addition beneath the filter chip row, visible only while
Recommended is active: a single caption line — *"Based on reward, route
quality, trust and connections."* — the plain-language explanation of
what the tab does, never a numeric score.

No conditional hiding of the tab: because every level of the hierarchy
degrades gracefully (unresolved orders still rank last-but-present,
unrated requesters just skip the reputation level, non-friends just
skip the friendship level), `rankRecommended` is **always** well-defined
and never degenerates to "nothing to show" any more than `rankHighReward`
already does — so there's no scenario where showing the tab would be
dishonest. The one honest empty case is reachable and handled with its
own message ("Nothing to recommend right now — everything left on the
board is yours.") — when eligibility (§2) has excluded every remaining
order because they're all the viewer's own posts.

**Reason-chip priority, as implemented**: for each of the top 3
Recommended results, exactly one reason is shown, checked in this order:
`Friend involved` → `Good reward for the distance` (routed/fallback tier,
reusing the existing High Reward top-N set) → `Strong reward`
(unresolved tier, the new without-distance top-N set, §9) → `Short run`
(reusing the existing Quick Errands top-N set) → no chip at all if none
apply. This deliberately reuses the three other tabs' own already-
computed "top of this list" sets rather than deriving a fourth,
separate sub-ranking just for chip purposes.

## 11. Schema changes — none. One new batched RPC.

**No table, no column, no `match_score`, no cache/recommendation-history
table.** Per the task's own instruction, schema is added only on a
concrete, demonstrated requirement — and the only real gap is
performance: `get_profile_reputation(uuid)` takes one id at a time,
which would be an N+1 query against a feed of, say, 30 pending orders.

**One new function**, not a table:

```sql
create or replace function public.get_profiles_reputation(p_profile_ids uuid[])
returns table(id uuid, avg_rating numeric, rating_count integer)
language sql
security definer
set search_path = public, pg_temp
stable
as $$
  select p.id,
    (select round(avg(r.score), 1) from ratings r where r.reviewee_id = p.id),
    (select count(*)::int from ratings r where r.reviewee_id = p.id)
  from unnest(p_profile_ids) as p(id);
$$;

revoke all on function public.get_profiles_reputation(uuid[]) from public, anon;
grant execute on function public.get_profiles_reputation(uuid[]) to authenticated;
```

Same privacy posture as the existing single-id version — returns only
the two aggregate numbers per id, never a row, never a comment. Called
once per Home load with the deduplicated list of `requester_id`s
actually visible on the current board (not "every profile in the
system").

Friendship data needs **no new function at all** — a single plain
`select requester_id, addressee_id from friendships where status =
'accepted' and (requester_id = eq.viewerId or addressee_id = eq.viewerId)`
already works under existing 3E RLS.

## 12. Query strategy

Per Home load (not per render, not per filter switch):
1. The existing single board query (`fetchOrders`) — unchanged.
2. One `friendships` query, scoped to the viewer, `status = 'accepted'`
   only (pending requests aren't "friends" yet for this purpose) —
   reduced to a plain `Set<string>` of friend ids client-side.
3. One `get_profiles_reputation(uuid[])` call with the deduplicated
   `requester_id`s from the current board — reduced to a `Map<string,
   {avg_rating, rating_count}>` client-side.

All three run once, in parallel, whenever `orders` changes (mount, or
the existing realtime-triggered refetch) — never per filter-chip click
(switching to the Recommended tab re-sorts already-fetched, already-
joined data, exactly like switching to Quick errands/High reward does
today), never per card render.

## 13. Performance impact

- **Zero new routing calls** — `rankRecommended` only ever reads
  `distance_km`/`distance_source` already sitting on each order row; no
  `compute_walking_route`/`compute_walking_route_custom` RPC is invoked
  by this milestone at all.
- **Zero N+1** — one friendship query, one batched reputation call,
  total, regardless of how many orders are on the board.
- **Zero new realtime subscriptions** — no per-order channel, no
  friendship-specific subscription; the existing board-wide `orders`
  realtime channel already triggers the one refetch that recomputes
  everything.
- **Zero MapLibre on Home** — nothing in this milestone touches the map
  bundle; `CampusMap` stays lazy-loaded only where it already is
  (`MyOrders`, `PostRequest`).
- **No polling** anywhere in this design.

## 14. Privacy / security implications

- Reputation: `get_profiles_reputation` is exactly as public as the
  existing per-id version already is (any authenticated user, aggregate
  numbers only, no comments) — batching changes performance, not the
  privacy boundary.
- Friendship: the ranking logic only ever asks "is this order's
  requester one of **my own** accepted friends" — a question the viewer
  is already entitled to answer via `friendships_select_participant`
  RLS. It never asks about, exposes, or infers any other pair's
  relationship, never reveals to the requester (or anyone else) that
  they were friend-boosted, and never lets a friendship substitute for
  an order permission (accepting still goes through the exact same
  `acceptOrder` path with the exact same server-side checks as today).
- No private phone/chat/live-location/rating-comment/hidden-order-detail
  is read, joined, or exposed by anything in this milestone.

## 15. Test strategy

**Ranking (pure function tests, `ranking.test.ts`):**
- deterministic ordering — same input always produces the same output.
- routed beats fallback beats unresolved, unconditionally, even when the
  lower tier has a much better raw reward_density/tip.
- within a tier, higher reward density (or, for unresolved, higher tip)
  wins.
- reputation only decides between two orders already tied through tier
  + reward; a real 5.0-rated requester's order does not outrank a
  meaningfully-better-value order from an unrated requester.
- an unrated requester (`rating_count = 0`) is never treated as worse
  than a rated one — two orders differing only in one side being
  unrated stay tied at that level and fall through to friendship/recency.
- friendship only decides between two orders already tied through tier
  + reward + reputation.
- exact ties at every level fall through correctly to recency, newest
  first.
- the viewer's own posted order never appears in `rankRecommended`'s
  output, even if it would otherwise rank first.

**Privacy:**
- the reason-chip logic never fabricates "Friend involved" for a non-
  friend, and never fabricates a reward/distance chip when the
  underlying signal isn't real (mirrors the existing `reasonFor` tests'
  discipline).
- friendship data used in ranking is never rendered as a raw relationship
  list anywhere on Home — only ever collapses to a single per-order
  boolean-driven reason chip on the viewer's own screen.

**Performance (component-level, mocked hooks — matching this project's
existing test depth):**
- exactly one friendship query and one batched reputation call per
  Home mount, not per order, not per filter switch.
- switching to the Recommended tab triggers no new network call.

**UX:**
- "Recommended" never shows "Perfect match"/"Best for you"/"Nearby you."
- empty board / all-own-orders-excluded shows the existing empty-state
  pattern, not a new invented one.
- a legacy order with `distance_source = null` (pre-3B) is handled
  identically to any other `unresolved` order — no crash, no special
  case.

## 16. Staging verification plan

Minimum disposable dataset (two accounts — a viewer and a friend/
non-friend mix of requesters — cleaned up after):
1. a short **routed** opportunity (real graph-connected pickup/delivery).
2. a longer **fallback** opportunity (straight-line only).
3. a high-**reward** opportunity (large tip, any tier).
4. a **friend-involved** opportunity (requester is an accepted friend of
   the viewer).
5. an **unrated/new-user** opportunity (requester with zero ratings).
6. an **unresolved** legacy-shaped order (`distance_source = null`,
   `distance_km = null`).

Verify: the batched reputation RPC returns correct aggregates for a
mixed id list including an unrated id (null/0, not fabricated); the
friendship query returns exactly the viewer's real accepted friends;
`rankRecommended` (exercised as a pure function, or via the rendered
Home page) produces the exact order the hierarchy predicts for this
fixed dataset. Clean up all six disposable orders/relationships and any
test accounts afterward.

## 17. Explicitly deferred

- **Live/continuous location-based matching** — no data exists; would
  need its own consented, purpose-built milestone (§8).
- **Route-overlap / "this is on your way" matching** — no concept of
  "the viewer's own route" exists; not inferred from proximity per the
  task's explicit instruction.
- **Any weighted-sum or opaque score** — rejected outright in favor of
  the strict hierarchy (§4).
- **Recommendation notifications** — Recommended is a Home-only view;
  no new notification type, no push-style surfacing, per the task's
  explicit instruction.
- **A `match_score` column, cache table, or recommendation history** —
  no concrete requirement found; everything is computed live from
  already-fetched data plus two small queries (§11/§12).
- **Splitting reputation by role (as-deliverer vs as-requester)** — 3D
  already deferred this; 3F doesn't reopen it, and the tie-break here
  uses the same single blended average Profile already shows.
- **Any AI/ML/embedding-based ranking** — explicitly out of scope per
  the task; nothing in this design uses one.
