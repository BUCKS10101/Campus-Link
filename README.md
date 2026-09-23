# Campus-Link

Campus-Link is a campus-focused peer-to-peer delivery platform for VIT Vellore. Students post requests for items from campus outlets (food courts, stores, laundry), and other students on their way can accept and deliver them for a tip.

Live deployment: https://campslink.shop/

## Tech stack

| Layer | Technology |
| --- | --- |
| Frontend | React 18, TypeScript, Vite |
| UI | Tailwind CSS, shadcn/ui (Radix UI primitives), GSAP for motion |
| Data fetching | TanStack Query, supabase-js |
| Forms and validation | React Hook Form, Zod |
| Maps | MapLibre GL, campus GeoJSON |
| Charts | Recharts |
| Backend | Supabase (PostgreSQL, Auth, Realtime) |
| Transactional email | Resend (SMTP provider for Supabase Auth) |
| Testing | Vitest, Testing Library, jsdom |
| Hosting | Vercel |

## Features

### Delivery workflow

- Requesters post an order with a pickup point, drop-off point, item details and tip.
- Deliverers browse open requests and accept one; the order then moves through a fixed lifecycle:
  `pending -> accepted -> picked_up -> out_for_delivery -> delivered`, with `cancelled` reachable from any non-terminal state.
- Status transitions are validated on the client (`src/lib/orderStatus.ts`) and enforced in the database by a trigger, so an invalid transition is rejected even if the client is bypassed. Cancellation rules for deliverers are restricted server-side.
- The Activity area separates active and historical orders for both roles (ordering and delivering).
- Per-order chat between requester and deliverer.

### Location and discovery

- A curated catalog of campus points (hostel blocks, academic blocks, outlets) with coordinates.
- A campus path graph in PostgreSQL used to compute walking distances between points, with a straight-line fallback when no route exists. Each distance records its source so the UI can indicate how it was derived.
- A map view built on MapLibre GL.
- Deterministic, explainable ranking of open requests (`src/lib/ranking.ts`): requests are grouped by distance trust tier and then ordered by tip per distance. No opaque scoring.

### Notifications

- In-app notifications for order events, ratings and friend requests, stored in a `notifications` table.
- Delivered in real time with Supabase Realtime (`postgres_changes` subscriptions), which also drive live order and chat updates.

### Ratings and reputation

- After a delivery completes, each party can rate the other once.
- Profiles show aggregated reputation, computed in batched database functions rather than per-row client queries.

### Social features

- Friend requests and a friends list (`friendships` table).
- User blocking and reporting, with blocks enforced in the database so blocked users cannot see or interact with each other's orders and messages.

### Analytics

- An Insights page showing a user's own activity summary, campus-wide order volume over time and popular locations. Data is served by aggregate RPC functions that expose only summarized results.

### Preferences

- Per-user discovery preferences and preferred campus points (`user_preferences`, `user_preferred_points`).

## Authentication and security

- **Supabase Auth** handles sign-up, sign-in and sessions.
- **Email verification**: new accounts must confirm their email before they can post, accept or message. Unverified users are routed to a verification page with a resend option.
- **VIT email restriction**: `src/lib/validation.ts` defines a rule limiting accounts to `@vitstudent.ac.in` addresses. The rule is currently disabled so any valid email can sign up; re-enable it there to enforce VIT-only accounts.
- **Password recovery**: a forgot-password flow sends a reset link, and `/reset-password` lets the user set a new password.
- **Transactional email**: verification and password-reset emails are sent through Resend, configured as the custom SMTP provider in Supabase Auth.
- **Row Level Security** is enabled on application tables. Policies restrict each user to the rows they are allowed to see or modify, and column-level grants limit which fields are writable.
- Privileged operations are implemented as `SECURITY DEFINER` functions with restricted `EXECUTE` grants.
- Server-side rate limiting on sensitive actions (`rate_limit_events`).
- The client only ever uses the public anon key. No service-role key is used by or shipped with the frontend.

## Architecture overview

```
Browser (React SPA on Vercel)
  |-- supabase-js (anon key + user session)
  |
Supabase
  |-- Auth         sign-up, verification, password reset (emails via Resend SMTP)
  |-- PostgreSQL   tables, RLS policies, triggers, RPC functions
  |-- Realtime     postgres_changes streams for orders, chat, notifications
```

The application is a single-page app with no custom backend server. All authorization is enforced in the database through RLS, grants, triggers and `SECURITY DEFINER` functions, so the client is treated as untrusted.

```
src/
  components/   UI components (shell, orders, chat, map, ratings, trust, ui primitives)
  hooks/        data hooks wrapping Supabase queries, mutations and subscriptions
  lib/          pure logic: validation, order status rules, ranking, content helpers
  pages/        route-level screens
  test/         test setup and Supabase mock
supabase/
  migrations/   versioned SQL schema, policies and functions
scripts/        staging end-to-end verification script
docs/           design documents and feature specifications
```

## Database overview

Schema changes are managed as timestamped SQL migrations in `supabase/migrations/`.

| Table | Purpose |
| --- | --- |
| `profiles` | User profile linked to `auth.users` |
| `orders` | Delivery requests, status, pickup/drop-off points, distance and source |
| `chat_messages` | Per-order messages |
| `campus_points` | Named campus locations with coordinates |
| `campus_path_nodes`, `campus_path_edges` | Walking graph used for distance calculation |
| `notifications` | In-app notifications |
| `ratings` | Post-delivery ratings |
| `friendships` | Friend requests and connections |
| `blocks`, `reports` | Trust and safety |
| `user_preferences`, `user_preferred_points` | Discovery preferences |
| `rate_limit_events` | Server-side rate limiting |

`supabase/SETUP.sql` is an early standalone setup script kept for history. It is superseded by the migrations and should not be run against a migrated project.

## Getting started

Prerequisites: Node.js 18+ and npm, and a Supabase project.

```bash
git clone https://github.com/BUCKS10101/Campus-Link.git
cd Campus-Link
npm install
cp .env.example .env
```

Fill in `.env` with your Supabase project URL and anon key (Project Settings -> API). If either value is missing, the app shows a configuration screen instead of starting.

Apply the migrations to your Supabase project (for example with the Supabase CLI):

```bash
supabase link --project-ref <your-project-ref>
supabase db push
```

Start the development server:

```bash
npm run dev
```

## Testing

```bash
npm test          # run the test suite once
npm run test:watch
npm run lint
```

Unit and component tests use Vitest and Testing Library with a mocked Supabase client (`src/test/supabaseMock.ts`), so they run without network access.

`scripts/e2e-staging.mjs` runs API-level end-to-end checks of RLS, grants and status transitions against a staging Supabase project using ordinary user sessions. It refuses to run against the production project and reads credentials from a git-ignored `.env.staging.local`.

## Deployment

The app is deployed on Vercel as a static build:

```bash
npm run build     # outputs to dist/
```

`vercel.json` rewrites all routes to `index.html` for client-side routing. Set `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` as environment variables in the Vercel project.

## Documentation

Design documents and per-feature specifications written during development are in [`docs/`](docs/README.md).

## Author

**Govind Nair**

B.Tech Computer Science and Engineering — Cyber Security  
VIT Vellore

[GitHub](https://github.com/BUCKS10101)
