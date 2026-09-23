# 3C — Notifications Implementation Plan

Tracks execution once `PHASE3_3C_NOTIFICATIONS_SPEC.md` is approved.
**Nothing below has been done yet — no migration, no code, no commit.**
Do not start any step until the user has signed off on the spec's §20
open decisions.

## Step 0 — Wait for approval
- [ ] User confirms §20 decisions (bell placement, unread-count display,
      5-type list + `order_cancelled` deferral, dropped `actor_id`/payload).
- [ ] Update the spec if any decision changes the design.

## Step 1 — Migration (staging only, `wemjskpbulebxgyhyhmk`)
- [ ] `notifications` table + indexes + unique constraint (spec §6).
- [ ] RLS enable + `notifications_select_own` + `notifications_update_own`
      + explicit `grant select, update` to `authenticated` only (spec §8).
- [ ] `notify_order_status_change()` (`SECURITY DEFINER`) + `AFTER UPDATE`
      trigger on `orders` (spec §7).
- [ ] `notify_new_chat_message()` (`SECURITY DEFINER`) + `AFTER INSERT`
      trigger on `chat_messages` (spec §7).
- [ ] Verify via `supabase db query` against staging:
  - a real `pending→accepted` update produces exactly one row.
  - a second chat message before the first is read upserts, not inserts.
  - a raw `insert into notifications (...)` as `authenticated` fails (no grant).
  - selecting another user's notifications returns zero rows.

## Step 2 — Display-string derivation
- [ ] Add one function to `src/lib/orderContent.ts` (or a small sibling
      file) that maps `(type, order)` → the sentence shown in the UI.
      No stored text, per spec §6/§19.
- [ ] Unit tests covering all 5 types.

## Step 3 — `NotificationsProvider`
- [ ] New context mirroring `AuthProvider`'s lifecycle: fetch capped list
      + unread count on mount when `user` is truthy, subscribe to the
      single user-scoped realtime channel, unsubscribe on logout/unmount/
      account switch (spec §10).
- [ ] Exposes: `notifications`, `unreadCount`, `markRead(id)`,
      `markAllRead()`, `loadMore()`.
- [ ] Mounted once in `App.tsx`, alongside `AuthProvider` — verify it
      never blocks Home's own render (spec §13).
- [ ] Unit tests: reducer increments/decrements on realtime events, exactly
      one subscribe/unsubscribe per auth transition.

## Step 4 — UI
- [ ] `NotificationBell` (icon + count badge) added to `DesktopNav`.
- [ ] `NotificationsPanel` (Popover desktop / Sheet mobile via
      `useIsMobile()`), capped list, empty state, unread shown via text +
      bold (not color-only), "Mark all read", click-through navigates and
      marks read.
- [ ] Small unread-dot badge on the Activity `NavItem` in `MobileNav`.
- [ ] Bell entry point added to the Activity page header for mobile.
- [ ] Component tests: badge count, empty state, read/unread distinction,
      click-through, mark-all-read.

## Step 5 — Chat integration
- [ ] `ChatThread` marks that order's `new_chat_message` notification read
      on mount and on any new message while still mounted (spec §11).
- [ ] Test: opening a chat with a pending chat notification clears it;
      a message arriving while the thread is open never creates a visible
      unread badge.

## Step 6 — Staging E2E (two disposable accounts)
- [ ] Drive one real order through all four transitions; confirm exactly
      one notification per transition for the requester, none for the
      deliverer.
- [ ] Exchange chat messages; confirm one notification, read-on-open,
      fresh-unread-after-read-then-new-message.
- [ ] Clean up disposable test data afterward.

## Step 7 — Wrap-up
- [ ] Full test suite green.
- [ ] Update `PHASE3_3C_NOTIFICATIONS_SPEC.md` if anything changed during
      implementation.
- [ ] Present summary, screenshots/CDP verification, open items (if any)
      for review before commit.
- [ ] Only after explicit approval: commit, push, open PR — same as
      3A/3B. Do not start 3D.
