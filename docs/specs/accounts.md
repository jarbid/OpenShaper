# Accounts & Entitlements

Phase 4 monetization. This first pass ships **auth + the single entitlement seam**.
Stripe billing and any server (`services/api`) are **deferred to a later PR**.

## The single seam (CLAUDE.md principle 5)

All tier gating funnels through one place — never scattered `if (isPro)` checks:

- `useEntitlements()` → `{ tier, can(feature) }`
- `<RequireTier feature="export.stl">…</RequireTier>` for declarative gating

Pure logic lives in `packages/accounts/src/tiers.ts` (`resolveTier`, `tierAllows`,
`FEATURE_MIN_TIER`) and is unit-tested independently of React/Supabase.

### Tier resolution precedence

1. `VITE_DEV_TIER` dev override (test gates without Stripe/Supabase),
2. signed-in account tier (`user.app_metadata.tier`; later the `subscriptions` table),
3. `free`.

### Feature gating policy

| Feature            | Min tier |
| ------------------ | -------- |
| native save / open | free     |
| `export.pdf`       | free     |
| `export.stl`       | pro      |
| `export.dxf`       | pro      |
| `cloud.sync`       | pro      |
| `boards.unlimited` | pro      |

Free stays genuinely useful (full editor, 3D, PDF, local save) to drive conversion.

## Auth

Supabase Auth via `@supabase/supabase-js`. `AuthProvider` subscribes to
`onAuthStateChange`; `useSession()` exposes `{ user, signInWithPassword, signInWithOtp,
signOut, configured, loading }`. When `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY`
are absent the client is `null` and the app runs **local-first** (signed out, free tier,
no network).

## Data model (planned)

```sql
-- Source of truth for entitlement once billing lands.
create table subscriptions (
  user_id              uuid primary key references auth.users (id) on delete cascade,
  tier                 text not null default 'free',   -- free | pro | team
  status               text not null,                  -- active | past_due | canceled
  stripe_customer_id   text,
  current_period_end   timestamptz
);
```

`boards`, `shared_links`, and Storage blobs come with cloud sync (later).

## Deferred to later PRs

- Stripe Checkout + Customer Portal + webhook → `subscriptions` sync (`services/api`).
- Cloud board library / sync / sharing.
- Desktop deep-link auth + offline entitlement grace period.
