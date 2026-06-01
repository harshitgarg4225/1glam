# Deployment & Environments

1Glam runs in three environments. The app **fails closed** in deployed
environments: it refuses to start in `staging`/`production` unless both a
database and a token-encryption key are configured (see
`assertDeploymentConfig` in `src/config.ts`).

| Environment   | `APP_ENV`     | Branch    | Database            | Token encryption |
| ------------- | ------------- | --------- | ------------------- | ---------------- |
| Development   | `development` | any local | optional (file)     | optional         |
| Staging       | `staging`     | `staging` | **required** (PG)   | **required**     |
| Production    | `production`  | `main`    | **required** (PG)   | **required**     |

## Required environment variables (staging & production)

| Variable               | Notes                                                        |
| ---------------------- | ----------------------------------------------------------- |
| `APP_ENV`              | `staging` or `production`                                    |
| `SESSION_SECRET`       | 32+ random chars (`openssl rand -hex 32`)                    |
| `DATABASE_URL`         | Postgres connection string                                  |
| `TOKEN_ENCRYPTION_KEY` | 32+ random chars; encrypts OAuth tokens at rest             |
| `APP_BASE_URL`         | Public HTTPS URL of the service                             |
| `GOOGLE_CLIENT_ID/SECRET` | OAuth credentials (redirect must match `APP_BASE_URL`)   |

Meta/WhatsApp, Maps, xAI, and Leegality keys are feature-gated — set them to
enable those integrations. See `.env.example` for the full list.

## Setting up staging on Railway

1. Create a second Railway service (e.g. `1glam-staging`) pointing at the same
   repo, with **Deploy branch = `staging`**.
2. Add a separate Postgres plugin to the staging service (never share the
   production database).
3. Set the staging service variables: `APP_ENV=staging`, a **distinct**
   `SESSION_SECRET` and `TOKEN_ENCRYPTION_KEY`, and a staging `APP_BASE_URL`.
4. Add the staging callback URL to the Google/Meta OAuth app's authorised
   redirect list.

Flow: open a PR → CI (`.github/workflows/ci.yml`) runs build + tests → merge to
`staging` to deploy to staging → promote to `production` by merging `staging`
into `main`.

## CI

`.github/workflows/ci.yml` runs on every PR and on pushes to `main`, `staging`,
and `claude/**` branches: it typechecks, builds, and runs the test suite
(`npm test`). Keep `main` green.

## Token encryption & key rotation

OAuth tokens (Google + Meta) are encrypted with `TOKEN_ENCRYPTION_KEY` before
they touch storage and decrypted on read. Existing plaintext rows keep working
and are encrypted the next time they're saved (a value is treated as ciphertext
only when it carries the `enc:v1:` prefix).

**Rotating the key** invalidates stored tokens (they can no longer be
decrypted), which forces users to re-authenticate with Google/Meta. That is the
expected recovery path if the key is ever exposed.

## Backups

The Postgres `workspace_records` table holds each tenant's config and encrypted
tokens — enable automated backups (Railway: Postgres plugin → Backups). Business
data (leads, bookings) lives in each user's own Google Sheet and is owned by
them. Encrypted token backups are useless without `TOKEN_ENCRYPTION_KEY`, so
store that key somewhere separate from the database backups.

## Scaling notes

- The daily reminder/review cron is guarded by a Postgres advisory lock
  (`withDistributedLock`), so running multiple app instances will **not** cause
  duplicate WhatsApp sends — exactly one instance runs each job.
- Per-tenant business data uses the Google Sheets API, which has per-user and
  per-project quotas. This is comfortable for dozens of active artists; a
  high-volume tenant base would need a caching/queueing layer in front of Sheets.
