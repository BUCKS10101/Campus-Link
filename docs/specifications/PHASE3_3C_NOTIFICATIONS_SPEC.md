# 3C — Notifications Spec (architecture proposal, pending approval)

**Status: ARCHITECTURE ONLY. No table, trigger, RLS policy, hook, or UI
component has been implemented yet.** This document is the source of
truth for 3C once approved, and will be updated if implementation
decisions change.

## 1. Product goal

Answer "what happened that I actually need to know about?" — without
becoming a noisy activity feed. Every notification must be backed by a
real, legally-possible event; nothing is invented to make the feature
look more complete than the backend actually supports.

## 2. What the real order lifecycle actually supports

Read directly from `src/lib/orderStatus.ts` (mirrored server-side by the
`enforce_order_status_transition` trigger, confirmed in
`20260824120100_order_status_integrity.sql`):

```
pending → accepted → picked_up → out_for_delivery → delivered
   ↓         ↓            ↓              ↓
cancelled  cancelled   cancelled     cancelled
```

**Critical finding**: `cancelled` is a *legal* transition from every
non-terminal state (the DB trigger permits it), but **no UI anywhere in
the app ever produces it** — there is no Cancel button in `PostRequest.tsx`
or `MyOrders.tsx`, no call to `updateOrderStatus(..., 'cancelled', ...)`
anywhere. It's the same class of gap as the `friendships` table (schema-
correct, functionally dead). Implementing `order_cancelled` notification
logic now would be dead code with no trigger path — **deferred until a
real cancel action exists** (§16).

The four transitions that **do** actually fire today, and how:
- `pending → accepted`: `useOrders.ts`'s `acceptOrder()` — a plain client
  `.update()`, not an RPC.
- `accepted → picked_up`, `picked_up → out_for_delivery`:
  `updateOrderStatus()` — also a plain client `.update()`.
- `out_for_delivery → delivered`: **only** via the `verify_delivery_otp()`
  RPC (the existing trigger explicitly blocks any direct `.update()` to
  `delivered` — `campuslink.otp_verified` session flag required). This
  RPC does a normal `update orders set status = 'delivered' ...`
  internally (confirmed in `20260824120300_otp_verification.sql`), so it
  still fires the same `AFTER UPDATE` trigger as the other three — no
  special-casing needed.

## 3. Exact notification events (final list)

| Event | Recipient | Persisted? |
|---|---|---|
| `order_accepted` | requester | Yes |
| `order_picked_up` | requester | Yes |
| `order_out_for_delivery` | requester | Yes |
| `order_delivered` | requester | Yes |
| `new_chat_message` | the other participant (not the sender) | Yes, deduplicated (§7) |

**Deliberately excluded, with reasons:**
- **Deliverer notified of their own acceptance** — they already get
  instant feedback (a toast + navigation to `/my-orders` in
  `Home.tsx`'s `handleAcceptOrder`). Notifying someone about the action
  they just took themselves has no product value here (task's own rule).
- **"Important requester changes"** — audited the whole app; a requester
  has no post-creation action that affects an in-progress order at all
  (no edit, no message-only-them affordance beyond chat, which is already
  covered). Nothing exists to notify about.
- **"Order ready for next action"** — already fully derived client-side,
  deterministically, from `order.status` via `NEXT_DELIVERER_ACTION` in
  `MyOrders.tsx`. No separate event needed; the right button already
  appears.
- **Deliverer notified of `delivered`** — they're the one who just typed
  the OTP code in; same self-action exclusion as acceptance.
- **`order_cancelled`** — see §2, no reachable trigger path yet.
- **Discovery/nearby-opportunity alerts** — explicitly deferred per the
  task; no trustworthy preference/eligibility model exists (3B's own
  finding: no reliable "where is this student" signal — see
  PHASE3_3B_NEARBY_DISCOVERY_SPEC.md §2).

## 4. Persistent vs. realtime — reasoning per class

- **All four order-lifecycle events → persistent.** Each can legitimately
  happen while the recipient's app is closed or backgrounded (someone
  accepts your post at 2am; you open the app the next morning). If it
  isn't stored, it's lost forever the moment it's missed live. This is
  the textbook case the task describes for "persistent."
- **`new_chat_message` → persistent, but deliberately not one row per
  message** (§7) — the same "might be offline" reasoning applies (a
  message sent while you're not in the app must still be discoverable
  later), but persisting every single message as its own notification row
  would violate "must not become a noisy activity feed" the moment a
  conversation has more than a couple of messages.
- **Nothing is realtime-only-with-no-persistence** in this milestone.
  There's no event in the current lifecycle that's simultaneously
  "worth surfacing" and "fine to lose if you're not currently looking at
  the screen" — every candidate is either dead (§2/§3) or matters enough
  to survive being closed. Realtime here is purely a *delivery
  mechanism* for already-persisted rows (§10), not a separate class of
  ephemeral event.

## 5. Where does the notification bell actually live?

Checked the real shell. `DesktopNav.tsx` says outright: *"No search, no
notification bell (both were dead in the previous build — unbound state,
a static dot with no notifications model behind it)."* `MobileNav.tsx`
is a fixed 4-slot tab bar (Home / Activity / Post / Profile) with no
persistent header on mobile at all — confirmed `AccountMenu` (and even
Log out) currently only renders on desktop, inside `DesktopNav`. So
mobile genuinely has nothing above the tab bar today; adding a 5th
persistent icon there would break the bar's designed symmetry.

**Proposed placement** (flagged as an open decision — see §17):
- **Desktop**: a small bell + unread-count button added to `DesktopNav`'s
  right-hand cluster (next to `CreateAction`/`AccountMenu`), opening a
  compact Popover panel.
- **Mobile**: a small unread-dot badge overlaid on the existing
  **Activity** tab icon in `MobileNav` (Activity/`MyOrders` is where
  order-lifecycle state already lives, so it's the natural home for "an
  order of yours changed") — plus a bell button at the top of the
  Activity page itself that opens the same panel as a bottom Sheet.
- Both panels are the same underlying component, split via the existing
  `useIsMobile()` hook — the exact Popover/Sheet pattern already proven
  this session by `WhereFilter`. No new dependency.

## 6. Proposed schema (trimmed from the task's suggested shape)

```sql
create table notifications (
  id uuid primary key default gen_random_uuid(),
  recipient_id uuid not null references profiles(id) on delete cascade,
  type text not null check (type in (
    'order_accepted', 'order_picked_up', 'order_out_for_delivery',
    'order_delivered', 'new_chat_message'
  )),
  order_id uuid not null references orders(id) on delete cascade,
  read_at timestamptz,
  created_at timestamptz not null default now(),
  unique (recipient_id, order_id, type)
);
create index notifications_recipient_unread_idx
  on notifications (recipient_id, read_at);
```

**Deliberately dropped from the task's suggested field list, with
reasons:**
- **`actor_id`** — not needed. Every notification type here is
  order-scoped, and the recipient is already an order participant with
  full RLS-permitted read access to that order's `deliverer_profile`/
  `requester_profile`. "Who did this" is always resolvable by joining
  through `order_id`, which the client already has to fetch to render
  anything useful anyway — storing it again on the notification row is
  pure redundancy.
- **Title / structured text payload** — not needed either. This
  codebase already has a strict, consistent pattern of deriving display
  strings from real columns rather than storing pre-rendered text
  (`formatOrderItems`, `formatDeliveryLocation`, `formatOrderDistance` —
  all in `orderContent.ts`). With only 5 fixed types, the exact sentence
  ("Your order from One Food World was accepted") is fully derivable
  client-side from `type` + the order row the client already has RLS
  access to. A stored title would just be a second, driftable source of
  truth for the same information.
- **jsonb payload** — same reasoning; nothing here needs unstructured
  extra data.
- **`order_id` nullable** — kept `NOT NULL`. Every type in this
  milestone is order-scoped; nothing needs a notification with no order.
  If a future milestone (e.g. 3E friend requests) needs a
  non-order-scoped type, that's the moment to relax this column — not
  now, per "prefer the smallest maintainable model."
- **Archival/deletion** — deferred (§16). No delete UI in v1; the table
  stays small enough (bounded by real order/message volume, capped
  further by the chat dedup in §7) that this isn't an immediate need.

The `unique (recipient_id, order_id, type)` constraint **is** the
deduplication mechanism (§7) — not a separate feature bolted on after.

## 7. Notification creation mechanism (server-side, not React)

**Order lifecycle**: a new `AFTER UPDATE ... WHEN (old.status IS
DISTINCT FROM new.status)` trigger on `orders`, sitting alongside (not
replacing) the existing `orders_enforce_status_transition` `BEFORE
UPDATE` trigger. Because it's `AFTER`, it only ever runs once the
transition has already been validated as legal by the existing trigger —
it can trust `new.status` completely and just map it to a notification
`type`, inserting one row for `new.requester_id`:

```sql
insert into notifications (recipient_id, type, order_id)
values (new.requester_id, <mapped type>, new.id)
on conflict (recipient_id, order_id, type) do nothing;
```

`on conflict do nothing` means even if something somehow re-fires the
same transition twice (shouldn't be possible given the state machine
only allows each edge once), no duplicate row or error results.

**Chat**: an `AFTER INSERT` trigger on `chat_messages`. Recipient is
derived from the order row itself — `case when new.sender_id =
orders.requester_id then orders.deliverer_id else orders.requester_id
end` — never trusted from client input. Upserts instead of plain
inserting:

```sql
insert into notifications (recipient_id, type, order_id, created_at, read_at)
values (v_recipient, 'new_chat_message', new.order_id, now(), null)
on conflict (recipient_id, order_id, type)
do update set created_at = now(), read_at = null;
```

This caps chat noise to **at most one active unread "new message" row
per order per recipient** — a 10-message reply flurry produces one
notification, not ten, directly satisfying "must not become a noisy
activity feed." A new message after the previous chat notification was
already read correctly creates a fresh unread signal (the `do update`
resets `read_at` to null and bumps recency).

**Both trigger functions are `SECURITY DEFINER`.** This is the load-
bearing security decision (§8): it means `authenticated`/`anon` never
need (and never get) `INSERT` privilege on `notifications` at all — only
the trigger, running as its owner, can write. A client cannot create a
notification for themselves or anyone else by any direct table call,
which is exactly the task's authorization requirement ("creation should
not depend on trusting a browser-supplied recipient_id").

**Why triggers over an RPC or client-side write**: two of the four
lifecycle transitions happen through plain client `.update()` calls
(`acceptOrder`, `updateOrderStatus`), not RPCs — there's no single choke
point in application code to hang notification creation off of. A
trigger is the only mechanism that's guaranteed to run regardless of
which code path performed the write, can't be skipped by a buggy/malicious
client, and doesn't require React effects or component lifecycle to ever
be involved in creating data (the task's explicit warning against
"notifications simply because Home/Activity fetched an order in a new
state").

## 8. RLS

```sql
alter table notifications enable row level security;

create policy notifications_select_own on notifications
  for select using (auth.uid() = recipient_id);

create policy notifications_update_own on notifications
  for update using (auth.uid() = recipient_id)
  with check (auth.uid() = recipient_id);

grant select, update on notifications to authenticated;
-- Deliberately no insert/delete grant to authenticated or anon at all -
-- only the SECURITY DEFINER trigger functions can write (§7).
```

No `insert` policy exists for any client role — not because it's
unnecessary, but because it must not exist. A user can read only their
own rows, can update only their own rows (used to mark read — the
`with check` stops them from ever reassigning a row to someone else),
and cannot create a row through any path except the two triggers above.

## 9. Read/unread behavior

- **Mark one read**: `update notifications set read_at = now() where id
  = :id` (RLS already scopes this to the caller's own rows) — fired when
  the user clicks a notification (which also navigates to the relevant
  order/chat).
- **Mark all read**: same shape, no `id` filter, just `read_at is null`.
- **Never** marked read merely because the list rendered (task's explicit
  rule) — with one deliberate exception: if the recipient has the
  relevant order's `ChatThread` **already open** when a
  `new_chat_message` notification would otherwise appear (or arrives via
  realtime while it's open), it's marked read immediately. Opening the
  chat *is* the explicit act of handling that specific notification —
  distinct from the general "don't mark-read on render" rule, which
  still applies to the notification list itself.

## 10. Realtime subscription model

**One** channel, scoped to the signed-in user:
`notifications:recipient_id=eq.<uid>` (`postgres_changes` on
`INSERT`/`UPDATE`, `table: notifications`, `filter: recipient_id=eq.<uid>`)
— the same idiom `useChat.ts` already uses per-order, just scoped to a
user instead. Lives in **one** new provider (`NotificationsProvider`,
mounted once in `App.tsx`, the same pattern `AuthProvider` already
establishes), not per-page and not per-order — every page that needs
`unreadCount`/`notifications` reads from this one shared context instead
of subscribing again. Subscribed only while `user` is truthy;
unsubscribed on logout, unmount, or account switch (mirrors
`AuthProvider`'s own auth-state-driven lifecycle exactly).

## 11. Chat integration — avoiding double notifications

Two suppression layers, matching §9's exception:
1. **Server-side**: the recipient is always the *other* participant,
   never the sender — a user can never generate a notification for
   their own message (derived from the order row, not trusted client
   input).
2. **Client-side**: `ChatThread` (already the only place a user reads
   messages for a specific order) marks that order's `new_chat_message`
   notification read on mount and whenever a new message arrives while
   it's still mounted. Because the unique-key upsert (§7) means there's
   at most one row to mark, this is a single cheap, targeted update, not
   a broad "mark everything read" side effect.

## 12. UI architecture

- `NotificationBell` — icon + unread-count badge, in `DesktopNav` (§5).
- `NotificationsPanel` — Popover (desktop) / Sheet (mobile), same
  component internally, split via `useIsMobile()`. Contents: a short,
  capped list (§13), each row showing a derived sentence (§6), a
  relative timestamp, unread state as a filled dot **plus** bold text
  (never color alone), and a "Mark all read" action. Empty state: plain
  text, no illustration/decoration invented for the occasion.
- Clicking a row: marks it read, navigates to `/my-orders` (order
  notifications) or the specific order's chat (chat notifications).
- A small badge dot on the **Activity** `NavItem` in `MobileNav` (§5) —
  the one small addition to an existing shared component, needed because
  mobile has no persistent header to hang a bell off of.

No giant SaaS dropdown, no infinite feed, no reviving the old dead bell
UI referenced in `DesktopNav.tsx`'s own comment.

## 13. Query/performance plan

- **One** capped query on mount:
  `select * from notifications where recipient_id = auth.uid() order by
  created_at desc limit 20` — a simple "load more" (offset/keyset by
  `created_at`) if the list is ever opened further, not built as
  infinite scroll in v1.
- **Unread count**: a single lightweight indexed
  `select count(*) from notifications where recipient_id = auth.uid()
  and read_at is null` on mount, then maintained incrementally in
  client state via the realtime subscription (+1 on a new unread
  INSERT/UPDATE, -1 on a read UPDATE) — never re-queried just to
  redisplay the badge.
- **Home is never blocked**: `NotificationsProvider`'s fetch/subscribe
  happens in its own effect, independent of `useOrders()`'s fetch — no
  await chain connects them, so a slow notifications query can never
  delay Home's render (task's explicit requirement).
- Total added network footprint per session: one query, one count
  query, one realtime channel — regardless of how many pages are
  visited, since the provider is mounted once at the app root.

## 14. Migration requirements (staging only)

1. `create table notifications (...)` + the two indexes/unique
   constraint (§6).
2. `alter table notifications enable row level security;` + the two
   policies + the two grants (§8) — no insert/delete grant to any client
   role.
3. `notify_order_status_change()` (`SECURITY DEFINER`) + its `AFTER
   UPDATE` trigger on `orders`.
4. `notify_new_chat_message()` (`SECURITY DEFINER`) + its `AFTER INSERT`
   trigger on `chat_messages`.

Applied to `wemjskpbulebxgyhyhmk` only, never production
(`kjsseqlmnmiuqepfmldh`), matching every migration so far this project.

## 15. Test strategy

- **SQL/behavioral** (via `supabase db query` against staging, same
  method used for 3A/3B verification): confirm the lifecycle trigger
  fires exactly once per real transition and produces the correct
  `type`/`recipient_id`; confirm the chat trigger upserts (second message
  before the first is read → still one row, `created_at` bumped);
  confirm a plain `insert into notifications (...)` as an authenticated
  client fails (no insert grant); confirm cross-user `select`/`update`
  is blocked by RLS.
- **Unit**: a pure "derive display sentence from type + order" function,
  covering all 5 types; `NotificationsProvider`'s reducer logic (unread
  count increment/decrement) with a mocked Supabase client, verifying
  exactly one subscribe/unsubscribe per auth transition.
- **Component**: `NotificationBell` badge count rendering,
  `NotificationsPanel` empty state, read/unread visual distinction
  (text-based, not color-only), click-through marking read, "Mark all
  read"; `ChatThread`'s open-suppresses-notification behavior.
- **Staging E2E**: two disposable test accounts (requester + deliverer),
  drive one real order through `pending → accepted → picked_up →
  out_for_delivery → delivered`, confirm exactly one notification per
  transition appears for the requester and none for the deliverer;
  exchange a couple of chat messages and confirm exactly one chat
  notification exists, is read the moment `ChatThread` is opened, and a
  follow-up message after reading creates a fresh unread one. Clean up
  disposable data afterward, per `PHASE3_MASTER_PLAN.md` §15.

## 16. Accessibility

- `NotificationBell`: `aria-label` includes the live unread count (e.g.
  "Notifications, 3 unread"), not just an icon.
- `NotificationsPanel`: inherits proper dialog/landmark semantics for
  free from the same Radix Popover/Sheet primitives already verified
  accessible this session (`WhereFilter`).
- Read/unread is never color-only — paired with real text (a visually-
  present "Unread" state or equivalent, not just a colored dot) and bold
  weight.
- Full keyboard operability inherited from the existing primitives; no
  custom key handling needed.

## 17. Mobile behavior

- Sheet-based panel (same split as `WhereFilter`), reachable via the
  Activity page's own header (§5) since mobile has no persistent top bar.
- A small unread-dot badge added to `MobileNav`'s Activity `NavItem` —
  the one shared-component change this milestone needs on mobile, kept
  minimal (a dot, not a number, to avoid crowding the fixed-width tab).

## 18. Explicitly deferred

- `order_cancelled` — no reachable UI trigger path exists yet (§2);
  revisit once a real cancel flow is built.
- Deliverer-side lifecycle notifications — every candidate was either a
  self-action (excluded on principle) or has no real signal to notify
  about (§3).
- Discovery/nearby-opportunity alerts — no trustworthy preference/
  eligibility model exists (3B's own finding).
- Any external channel — push notifications, email, SMS. This milestone
  is in-app only, $0 recurring cost, using only existing Supabase
  infrastructure (no Twilio/OneSignal/Firebase/etc.).
- Notification deletion/archival.
- Presence-based suppression beyond the specific "ChatThread already
  open" case (§11) — no broader "is the user actively looking at the
  app right now" tracking.
- Pagination beyond a simple capped list + "load more" — true infinite
  scroll, if ever needed, is a later refinement.

## 19. Reuse vs. duplication

- The lifecycle trigger reuses the **exact same transition vocabulary**
  already enforced by `enforce_order_status_transition` — it doesn't
  re-derive or duplicate the legal-transition map; it trusts that trigger
  already ran (as a `BEFORE` trigger) and simply reacts to whatever
  `new.status` it validated.
- `useIsMobile()`, Popover/Command/Sheet primitives, and the desktop-vs-
  mobile split pattern are all reused verbatim from `WhereFilter` (3B) —
  no new dependency, no new responsive-detection mechanism invented.
- Display-string derivation follows the exact same discipline as
  `orderContent.ts`'s existing `formatOrderItems`/`formatDeliveryLocation`/
  `formatOrderDistance` — one more function in that same file, not a new
  pattern.

## 20. Open product decisions (need your call before implementation)

1. **Bell placement** (§5) — is Activity-tab-badge + Activity-page-bell
   the right mobile entry point, or would you rather see it somewhere
   else (e.g. a small persistent icon added to a new thin mobile header)?
2. **Unread-count semantics** — should the visible count badge cap at
   some display maximum (e.g. "9+") once it's large, or always show the
   exact number?
3. Confirm the exact 5-type list (§3) and the "no `order_cancelled` yet"
   deferral are acceptable, given it's a real gap in the current lifecycle
   rather than an oversight in this design.
4. Confirm dropping `actor_id`/title/payload (§6) is acceptable — the
   trade-off is that the client must always look up the order to render
   a sentence, rather than reading pre-rendered text off the
   notification row itself (a very small, already-necessary lookup, since
   the client needs the order to navigate to it anyway).
