# 1Glam Booking OS — Codebase Context

## What This Is
A private-code SaaS for luxury makeup artist booking management. Each artist ("workspace") gets their own Google Sheet and Google Calendar. The server handles lead intake, AI enrichment, pricing, PDF generation, messaging, and e-signature contracts.

---

## Tech Stack
- **Runtime**: Node.js + TypeScript (ES2022, NodeNext modules, strict mode)
- **Framework**: Express.js with `express-session`
- **Schema validation**: Zod (all API inputs and config validated)
- **Database**: Dual-mode — JSON file (`data/workspaces.json`) in dev, PostgreSQL (JSONB) in prod
- **Google APIs**: `googleapis` — Sheets, Calendar, Drive, OAuth2
- **AI**: Grok (xAI) via `XAI_API_KEY` — lead enrichment, profile tier, reply suggestions
- **Messaging**: Instagram Graph API + WhatsApp Cloud API (Meta)
- **PDFs**: `pdf-lib` — quotes, invoices, contracts
- **E-signatures**: Leegality API
- **Maps**: Google Maps geocoding + haversine distance fallback
- **IDs**: `nanoid`

---

## Project Layout
```
src/
  index.ts                  # Main Express app (~1470 lines) — all routes here
  config.ts                 # Zod-validated env config (single source of truth for env vars)
  schema.ts                 # WorkspaceConfig Zod schema
  api-schema.ts             # Request payload schemas (lead, decision, payment)
  webhook-schema.ts         # Normalized inbound webhook payload schema
  types.ts                  # TypeScript types (WorkspaceRecord, StoredGoogleTokens, MetaChannelConnection, etc.)
  defaults.ts               # Default config values
  services/
    booking.ts              # Lead/booking creation, pricing, calendar ops (~600 lines)
    workspace.ts            # Workspace provisioning, sheet seeding (~250 lines)
    database.ts             # Dual storage: JSON file or Postgres (~300 lines)
    google.ts               # Google OAuth, token refresh, client creation
    auth-store.ts           # Per-workspace credential retrieval & token refresh
    maps.ts                 # Travel distance/time (Google Maps + haversine fallback)
    grok.ts                 # Grok AI enrichment (~150 lines)
    messaging.ts            # Instagram/WhatsApp message sending
    documents.ts            # PDF generation + Google Drive upload
    contracts.ts            # Leegality e-signature integration
    meta.ts                 # Meta OAuth, Business Login, webhook verification
    integrations.ts         # Webhook normalization, interaction logging, lead signal parsing
    conversation-memory.ts  # Per-lead markdown memory files (data/conversation-memory/)
    channel-adapters.ts     # Payload normalization: Wati → standard, ManyChat → standard
    sheet-definitions.ts    # Column headers for all Google Sheets tabs
public/
  index.html                # Single-page UI (903 lines, embedded CSS+JS, no build step)
data/                       # Runtime storage (gitignored)
  workspaces.json           # Dev workspace DB
  conversation-memory/      # Per-lead markdown memory
```

---

## Core Data Model

### WorkspaceRecord (stored in DB)
```typescript
{
  workspaceId: string           // nanoid(12)
  email: string                 // Owner's Google email (primary key)
  name: string
  spreadsheetId: string
  spreadsheetUrl: string
  spreadsheetName: string       // "1Glam Booking OS - [Name]"
  confirmedCalendarId: string   // Usually "primary"
  tentativeCalendarId: string   // Created on provisioning
  tentativeCalendarName: string
  createdAt: string             // ISO
  updatedAt: string             // ISO
  googleTokens?: StoredGoogleTokens   // access_token, refresh_token, expiry_date
  metaConnections?: {
    instagram?: MetaChannelConnection
    whatsapp?: MetaChannelConnection
  }
  config: WorkspaceConfig       // Pricing rules, business details
}
```

### PostgreSQL Table
```sql
CREATE TABLE workspace_records (
  email TEXT PRIMARY KEY,
  workspace_id TEXT UNIQUE NOT NULL,
  data JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)
```

### Google Sheets Tabs
1. **Config** — Owner business rules, pricing, multipliers
2. **Leads** — 35+ columns: status, pricing, calendar event IDs, travel intel, Grok enrichment
3. **Bookings** — 21 columns: confirmed bookings
4. **Artists** — Team directory (10 columns)
5. **FollowUps** — Scheduled follow-up log
6. **InteractionLog** — All inbound/outbound messages
7. **Reviews** — Review request tracking

---

## API Routes (all in `src/index.ts`)

### Auth
- `GET /auth/google` → initiate Google OAuth
- `GET /auth/google/callback` → OAuth callback, provision workspace
- `GET /auth/meta/start?channel={instagram|whatsapp}&workspaceEmail=` → Meta OAuth start
- `GET /auth/meta/callback` → Meta OAuth callback

### Session & Config
- `GET /api/session` → user profile + workspace
- `POST /api/workspace/config` → update WorkspaceConfig
- `POST /api/logout`

### Leads
- `POST /api/leads` → create lead
- `POST /api/leads/:leadId/decision` → YES/NO/EDIT
- `POST /api/leads/:leadId/confirm` → convert to booking
- `POST /api/leads/:leadId/payment` → payment milestone
- `POST /api/leads/:leadId/quote` → generate PDF quote
- `POST /api/leads/:leadId/send-quote` → send quote via Meta
- `POST /api/leads/:leadId/reply` → send custom message

### Bookings
- `POST /api/bookings/:bookingId/invoice` → generate PDF invoice
- `POST /api/bookings/:bookingId/send-invoice`
- `POST /api/bookings/:bookingId/contract` → create Leegality contract
- `POST /api/bookings/:bookingId/send-contract`
- `POST /api/bookings/:bookingId/contract/sync` → sync signing status
- `POST /api/bookings/:bookingId/send-review`
- `POST /api/bookings/:bookingId/send-collection` → payment reminder

### Meta Connections
- `POST /api/meta/connections/:channel/assets` → select IG account or WA number
- `POST /api/meta/instagram/token` → direct token connect
- `POST /api/meta/whatsapp/test-connect`
- `POST /api/meta/disconnect/:channel`

### Webhooks
- `POST /webhooks/wati` → WhatsApp (Wati)
- `POST /webhooks/manychat` → Instagram (ManyChat/Make)
- `GET /webhooks/meta` → Meta verification
- `POST /webhooks/meta` → Meta direct webhooks
- `POST /webhooks/leegality` → e-signature events
- `POST /compliance/meta/data-deletion`

---

## Key Services — What They Do

### `booking.ts`
- `createLeadForWorkspace(workspace, payload)` — pricing calc, demand count, travel intel, Grok enrichment, write to Leads sheet + tentative calendar
- `applyOwnerDecision(workspace, leadId, decision)` — YES/NO/EDIT, calendar hold management
- `confirmLeadBooking(workspace, leadId)` — move to Bookings sheet + confirmed calendar event
- `updatePaymentStatus(workspace, leadId, status)` — log Advance Paid / Paid in Full
- `getDashboardData(workspace)` — all leads & bookings for UI

**Pricing formula**: base price × season multiplier × profile multiplier + travel cost

### `workspace.ts`
- `provisionWorkspace(tokens, profile)` — create Sheet, tentative calendar, seed all tabs
- `updateWorkspaceConfig(workspace, config)` — persist config back to Config tab
- `persistWorkspaceTokens(email, tokens)` — save refreshed Google tokens
- `upsertMetaConnection(email, channel, connection)` — store Meta credentials

### `database.ts`
- Auto-detects mode from `DATABASE_URL` env var
- File mode: read/write `data/workspaces.json`
- Postgres mode: `workspace_records` table with JSONB
- Auto-migrates file → Postgres on first Postgres connection

### `grok.ts`
- `enrichLeadWithGrok(lead, config)` → `{ profileTier, tags, suggestedReply }`
- `generateConversationReply(lead, history, config)` → draft message string

### `integrations.ts`
- `ingestNormalizedLead(workspace, payload)` — create lead from normalized webhook
- `logInteractionForWorkspace(workspace, entry)` — append to InteractionLog sheet
- `parseInstagramLeadSignalsFromMessage(text)` — extract event type, date, location
- `parseWhatsAppLeadSignalsFromMessage(text)` — same for WhatsApp

### `channel-adapters.ts`
- `normalizeWatiPayload(body)` → `NormalizedWebhookPayload`
- `normalizeManychatPayload(body)` → `NormalizedWebhookPayload`
- `buildOutboundReplyPayload(channel, message, recipient)` → provider-specific shape

### `documents.ts`
- `generateQuoteDocument(workspace, lead)` → Drive URL
- `generateInvoiceDocument(workspace, booking)` → Drive URL
- `generateContractPdfBytes(workspace, booking)` → Buffer

### `auth-store.ts`
- Per-workspace credential resolution; refreshes expired Google tokens transparently

---

## Environment Variables (from `config.ts`)

| Variable | Required | Notes |
|---|---|---|
| `PORT` | No | Default 3000 |
| `APP_BASE_URL` | Yes | e.g., https://yourdomain.com |
| `SESSION_SECRET` | Yes | Min 8 chars |
| `GOOGLE_CLIENT_ID` | Yes | OAuth2 |
| `GOOGLE_CLIENT_SECRET` | Yes | OAuth2 |
| `GOOGLE_REDIRECT_PATH` | No | Default `/auth/google/callback` |
| `GOOGLE_MAPS_API_KEY` | No | Optional travel intel |
| `DATABASE_URL` | No | Postgres; JSON file if omitted |
| `XAI_API_KEY` | Yes | Grok AI |
| `XAI_MODEL` | No | Default `grok-4.20-reasoning` |
| `META_APP_ID` | Yes | Meta app |
| `META_APP_SECRET` | Yes | Meta app |
| `META_REDIRECT_PATH` | No | Default `/auth/meta/callback` |
| `META_WEBHOOK_VERIFY_TOKEN` | Yes | Webhook signature |
| `META_INSTAGRAM_CONFIG_ID` | No | Business Login config |
| `META_WHATSAPP_CONFIG_ID` | No | Business Login config |
| `WA_PHONE_NUMBER_ID` | No | Fallback WA phone |
| `WA_BUSINESS_ACCOUNT_ID` | No | Fallback WABA |
| `WA_ACCESS_TOKEN` | No | Fallback WA token |
| `WATI_WEBHOOK_SECRET` | No | Signed Wati requests |
| `MANYCHAT_WEBHOOK_SECRET` | No | Signed ManyChat requests |
| `LEEGALITY_API_KEY` | No | E-signature |
| `LEEGALITY_CREATE_URL` | No | Default Leegality endpoint |
| `LEEGALITY_DETAILS_URL` | No | Status check endpoint |
| `LEEGALITY_WEBHOOK_SECRET` | No | Webhook verification |

---

## npm Scripts
```bash
npm run dev      # tsx watch src/index.ts — dev with hot reload
npm run build    # tsc — compile to dist/
npm run start    # node dist/index.js — run compiled
npm run check    # tsc --noEmit — type-check only
```

---

## Coding Conventions
- All inputs validated with **Zod** at the route level (parse, not safeParse where failure should throw)
- Services accept a `WorkspaceRecord` object (not individual fields) — always look up workspace first
- Google Sheets reads return string arrays; column positions defined in `sheet-definitions.ts`
- No test framework; verify manually with `npm run dev` + curl/browser
- Single Express app file (`index.ts`) — all routes inline, services imported
- No ORM; raw `pg` queries for Postgres
- `public/index.html` has no build step — vanilla JS, no bundler
- The branch for ongoing development is `claude/stoic-mccarthy-Y5rUa`

---

## Architecture Notes
- **Private-code design**: all business logic stays server-side, client only sees sanitized data
- **Per-workspace Google credentials**: each workspace stores its own OAuth tokens; `auth-store.ts` handles refresh
- **Dual storage**: JSON file (local dev) → auto-migrates to Postgres in prod; same code path
- **Meta connections**: stored per-workspace in `metaConnections.instagram` / `metaConnections.whatsapp`
- **Webhook normalization**: Wati/ManyChat/Meta all normalized to `NormalizedWebhookPayload` before processing
- **Conversation memory**: per-lead markdown files used as context window for Grok replies
