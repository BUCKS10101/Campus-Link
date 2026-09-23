# CampusLink — Phase 3 Master Plan

## Status

Phase 2 is complete.

Phase 3 is the product capability expansion phase.

Phase 2 established:

- the production/security foundation
- the Counter visual system
- the complete UI/UX redesign
- auth architecture/performance fixes
- OTP security
- Home
- Post Request
- Activity
- Chat
- Profile
- signature motion
- final responsive/accessibility/performance polish

Phase 3 should make CampusLink substantially more capable while preserving the
Phase 2 product language and engineering discipline.

## 1. Phase 3 Goal

Phase 3 is about building the capabilities that Phase 1/2 intentionally did
not invent because the real data/backend model did not support them yet.

The goal is to introduce:

- real campus location
- real distance/proximity
- smarter opportunity discovery
- real notifications
- trust/reputation
- social relationships
- better matching
- richer delivery lifecycle
- personalization
- product analytics

Phase 3 is NOT another visual reset.

The approved Phase 2 Counter visual direction remains the design foundation.

## 2. Core Product Principle

CampusLink is:

Students helping students nearby.

A student is already going somewhere and can carry something for another
student on the way.

The strongest future product loop is:

Location → Opportunity → Suggested Reward → Accept → Buy → Deliver → OTP → Complete

The product should make the value of proximity obvious.

## 3. Critical Future Payment Decision

Real payments are DEFERRED.

Do NOT implement real payment APIs during the early Phase 3 work.

Do NOT introduce Stripe, Razorpay, PayPal, or other payment services merely
because future payments are planned.

Real payment integration will be considered later because:

- this project is not currently intended for major public deployment
- payment providers add cost and operational complexity
- real payouts/refunds/webhooks/reconciliation introduce substantial backend
  and compliance requirements
- the product can validate the underlying flow without moving real money

### Intended eventual payment model

The future desired model is an escrow-style flow:

Requester → pays CampusLink → funds are held → collector/deliverer buys the
item → collector delivers the item → requester gives/verifies OTP → order
becomes delivered → funds are released → collector receives payout

Important:

- this is a future product architecture, not current implementation
- do not add payment columns/tables solely for hypothetical future needs
- do not create fake "Balance" or "Payment complete" UI
- when payment is eventually implemented, security, webhooks, refunds,
  payout handling and reconciliation must be designed as a dedicated milestone

Real payment work belongs in a later phase after Phase 3's location/product
foundations are established.

## 4. Distance + Tip Relationship

This is a major Phase 3 product decision.

### Current state

The current application uses a manually selected tip/reward.

Do not change this prematurely.

The current `distance_km` value is not trustworthy for product decisions and
must not be presented as real distance.

### Future state

Once real map/location infrastructure exists:

Pickup location + Delivery location → Routing/map calculation → Real distance
and/or travel time → Suggested reward → Requester confirms or changes reward

Example concept only:

- short run → lower suggested reward
- medium run → medium suggested reward
- longer/more effortful run → higher suggested reward

Do NOT hard-code the example amounts above.

The actual formula must be designed after:

- campus geometry is known
- pickup/delivery points are known
- walking/route times are known
- typical student behavior is understood

The reward remains a suggested incentive, not necessarily a mandatory
delivery price.

## 5. Phase 3 Roadmap

### 3A — Location + Campus Map

Foundation milestone. Build the real spatial model first.

Goals: campus map, hostel/block locations, pickup locations, delivery
locations, real distance calculation, campus zones, proximity representation.

Key requirement: replace fake/random distance assumptions with trustworthy
spatial data. This milestone should establish the location model before
matching, notifications, or personalization depend on it.

**Architecture questions to resolve before implementation**

- What coordinates represent campus blocks?
- Are restaurant/pickup points fixed campus POIs?
- Are hostel blocks fixed POIs?
- What routing provider is practical?
- Can a simple campus-specific distance graph be used instead of an external
  routing API?
- How should location privacy work?
- Do we need continuous GPS, or are fixed campus destinations sufficient?

Prefer the simplest reliable architecture. Do not introduce a paid mapping
API unless genuinely necessary.

### 3B — Nearby Discovery

Use real location to improve Home and opportunity discovery.

Move from "Here are some orders." toward "Here are the requests you can
realistically help with."

Potential signals: pickup proximity, destination proximity, route overlap,
distance, travel effort, reward, relevant campus zone.

Do not invent urgency or route overlap without real data. This milestone can
improve ranking without requiring a full AI/ML matching system.

### 3C — Notifications

Build a real notification system.

Potential notifications: request accepted, order picked up, order out for
delivery, delivery completed, contextual chat message, nearby opportunity
that matches user preferences.

Required architecture: notifications data model, RLS, read/unread state,
notification types, delivery strategy, UI notification center, realtime
behavior where useful.

Do not recreate the old fake notification bell. Every notification shown
must be backed by real data.

### 3D — Ratings + Trust

Build the trust layer.

Potential capabilities: requester rates deliverer, deliverer rates requester
where appropriate, optional feedback, rating history, meaningful reputation
signals.

Surface reputation only where it improves decisions: Profile, Activity,
opportunity/order context where appropriate.

Do not create decorative reputation numbers. This milestone can finally make
previously meaningless profile statistics real.

### 3E — Social Graph

Build the real student network.

Potential capabilities: friend request, accept/reject, friends list, remove
friend, friend-specific discovery, trusted contacts, privacy/access rules.

This is where the old "Friends" filter can become real. Do not reintroduce
the filter until the underlying relationship model exists.

### 3F — Smart Matching

Connect the earlier foundations.

Inputs may include: location, distance, route overlap, reward, availability,
trust/reputation, friend relationships, order characteristics.

Use these to rank or surface opportunities. The first implementation should
be deterministic and explainable.

Example: high reward + nearby + route-compatible → ranks higher.

Do NOT introduce opaque ML before deterministic rules are understood.

### 3G — Richer Delivery Lifecycle

Expand the order lifecycle where real product value requires it.

Potential additions: state timestamps, ETA, pickup confirmation,
delivery-location confirmation, richer progress history, cancellation flows,
dispute/recovery handling.

All new states must have: explicit backend representation, valid transition
rules, RLS/security, tests, UI handling.

Do not add timestamps simply to make the interface look more sophisticated.

### 3H — Preferences + Personalization

Allow CampusLink to adapt to each student.

Potential: preferred campus blocks, favorite pickup areas, notification
preferences, quiet hours, discovery radius, friend visibility, opportunity
preferences.

Only build settings that have real behavior. No dead toggles.

### 3I — Analytics + Product Intelligence

Only after the core capabilities work.

Track useful product behavior such as: request completion rate, time to
acceptance, delivery completion time, active campus zones, cancellations,
notification engagement, matching effectiveness.

Analytics should be: privacy-conscious, purpose-driven, minimal, useful for
product improvement. Do not build surveillance-style tracking.

## 6. Recommended Dependency Order

Follow this order unless implementation evidence strongly suggests otherwise:

3A Location + Map → 3B Nearby Discovery → 3C Notifications → 3D Ratings +
Trust → 3E Social Graph → 3F Smart Matching → 3G Richer Delivery Lifecycle →
3H Preferences + Personalization → 3I Analytics

Payments are deliberately outside this early Phase 3 chain.

## 7. Phase 3 Engineering Rules

Every milestone should follow:

Schema/backend → RLS/security → API/data → UI → tests → staging E2E →
performance → final report

Do not implement UI against imaginary backend fields. Do not create frontend
assumptions that the backend cannot support. Do not make production changes
during development milestones. Do not introduce unnecessary paid services.

Prefer simple, deterministic, explainable, maintainable over complex,
opaque, expensive, over-engineered.

## 8. Mapping / Location Cost Discipline

The project is not currently targeting major public deployment. Before
adding any paid external map/routing service:

1. Determine whether campus-specific fixed coordinates are sufficient.
2. Determine whether a simple graph/table of campus points can calculate
   useful distance.
3. Determine whether client-side geometry can solve the use case.
4. Only then consider a third-party routing API.

Do not incur recurring service costs without a clear product need. If an
external provider is eventually chosen, isolate the integration behind a
small service boundary so it can be replaced later.

## 9. Privacy / Location Rules

Location is sensitive product data. Do not collect continuous precise GPS
unless the product genuinely requires it. Prefer fixed campus POIs or coarse
campus zones where possible.

The first map experience should likely know: pickup point, destination
point, campus zone — before it needs continuous user tracking.

Any live-location feature must have: explicit user awareness, clear
purpose, minimum necessary precision, appropriate retention/deletion rules.

## 10. Security Rules

Every Phase 3 data feature must include security design.

Never: expose service-role credentials to the browser, bypass RLS, trust
client-provided authorization fields, trust client-provided payment/payout
status, allow client-side order transitions without server enforcement,
expose private chat/social/location data without authorization.

For sensitive operations use: RLS, RPCs, server-side verification, explicit
allowed transitions.

## 11. Product Economics

Until real payments exist: keep tip/reward as a normal order value, do not
create fake wallet balances, do not show fake payout statuses, do not imply
funds are held by CampusLink, do not imply real payment protection exists.

When payments eventually arrive: Requester → payment held → collector buys
→ delivery → OTP → release → payout. That entire system should be a
dedicated payment milestone rather than being partially implemented across
unrelated Phase 3 work.

## 12. Phase 3 Visual Continuity

Phase 2 is the visual foundation. Do NOT create a new visual identity for
Phase 3.

Use: Counter typography, forest + ivory + restrained berry, editorial
hierarchy, ruled structures, selective visual fields, existing motion
language, existing accessibility system.

New maps, notifications, ratings, and social UI must feel like natural
extensions of the Phase 2 product.

## 13. Performance Rules

Phase 3 features must not destroy the performance work from Phase 2.

Preserve: AuthProvider architecture, route-level splitting, lazy GSAP chunk,
deduplicated profile fetch, scoped loading states.

For map/location features: lazy-load mapping code, avoid shipping heavy map
libraries to unrelated routes, do not block Home rendering on map assets
when the map is not visible, measure bundle and network impact.

For realtime: subscribe only where necessary, unsubscribe cleanly, avoid one
subscription per inactive order.

## 14. Testing Rules

Every milestone must add tests for: new backend contracts, RLS,
authorization, state transitions, edge cases, loading/error states,
responsive behavior where practical.

Every milestone should run: `npm test`, `npx tsc --noEmit`, `npm run build`,
`npm run lint`. And use real staging E2E where practical.

Production must remain untouched unless a deployment milestone explicitly
requires it.

## 15. Staging Data Discipline

Phase 2 accumulated disposable test orders/accounts/messages.

For Phase 3: identify test data before creating more, create the minimum
necessary disposable data, never create fake production data, clean
disposable staging data after a milestone where practical, report exactly
what was created/removed.

Do not let staging data become an unstructured test dump.

## 16. Definition of Done

A Phase 3 milestone is complete only when: real backend/data behavior
works, security is verified, UI reflects actual data, errors are
recoverable, loading does not hang, tests pass, typecheck passes, build
passes, lint passes, staging works, performance is measured, no unrelated
feature was silently added.

## 17. Current Phase 3 Approval State

Phase 3 roadmap approved conceptually.

**Next milestone: 3A — Location + Campus Map.**

Do not start 3B+ automatically.

Before implementing 3A, produce a short architecture proposal covering:

- location data model
- pickup/drop-off representation
- campus POIs
- distance calculation strategy
- routing strategy
- privacy model
- expected costs
- whether an external map API is actually necessary
- how suggested reward/tip will eventually consume distance
- migration/RLS implications

Only after that proposal is reviewed should implementation begin.

## 18. Future Payment Milestone

Payments are intentionally deferred. Do not implement them during 3A–3I
unless the project direction changes.

When the project is genuinely ready for real payments, create a dedicated
payment milestone covering: provider selection, payment intent/order
creation, secure server/webhook handling, escrow/hold model, payment
status, delivery completion, OTP-triggered release, payout, refunds,
cancellation, reconciliation, failure recovery, fraud/abuse considerations,
production security review.

The eventual target flow is: Requester pays CampusLink → funds held →
collector buys item → collector delivers → OTP verified → funds released →
collector paid.

Do not fake this flow in the product before real payment infrastructure
exists.

## 19. Phase 3 Success Criterion

At the end of Phase 3, CampusLink should no longer feel like: a polished
board where students post delivery requests.

It should feel like: a real campus network that intelligently connects
students who need something with students already moving nearby.

The core loop should become: Discover → Understand distance/effort → See a
fair suggested reward → Accept → Coordinate → Deliver → Verify → Build
trust.

That is the product Phase 3 is responsible for creating.

## 20. Phase Boundary

- **Phase 2** — Make the product feel exceptional. ✅
- **Phase 3** — Make the product substantially more capable. 🚧
- **Future payment/launch phase** — Make real-money and public-scale
  operation production-ready. ⏳
