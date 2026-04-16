# 1Glam Booking OS

Private-code booking infrastructure for luxury makeup artists. The app keeps platform code on your side, while provisioning Google Sheets and Google Calendar assets inside the artist's own Google account through OAuth.

## What this MVP includes

- Google OAuth sign-in flow
- Per-user workspace provisioning
- Automatic Google Sheet creation in the owner's Drive
- Automatic tentative calendar creation in the owner's Google Calendar
- One-page luxury config UI
- Config persistence back into the provisioned sheet
- Lead creation API backed by the provisioned Google Sheet
- Owner approval flow with tentative Google Calendar holds
- Booking confirmation flow with confirmed Google Calendar event creation
- Payment status update flow for leads and bookings
- WhatsApp and Instagram webhook intake with interaction logging
- Per-workspace Google token persistence with refresh support
- Grok enrichment for client profiling, owner insight, and suggested luxury replies
- Meta-native connection scaffolding for Instagram and WhatsApp
- Local workspace metadata store in `data/workspaces.json`

## Stack

- Node.js + TypeScript
- Express
- Google APIs (`sheets`, `calendar`, `drive`, `oauth2`)
- Static premium setup page in `public/index.html`

## Local setup

1. Copy `.env.example` to `.env`
2. Create Google OAuth credentials
3. Set the redirect URI to:
   - `http://127.0.0.1:3001/auth/google/callback`
4. Fill these env vars:
   - `SESSION_SECRET`
   - `GOOGLE_CLIENT_ID`
   - `GOOGLE_CLIENT_SECRET`
   - `GOOGLE_MAPS_API_KEY` for automatic travel intelligence
   - `WATI_WEBHOOK_SECRET` and `MANYCHAT_WEBHOOK_SECRET` if you want signed webhooks
   - `XAI_API_KEY` and optional `XAI_MODEL` for Grok enrichment
   - `META_APP_ID`
   - `META_APP_SECRET`
   - `META_REDIRECT_PATH`
   - `META_WEBHOOK_VERIFY_TOKEN`
   - `META_INSTAGRAM_CONFIG_ID`
   - `META_WHATSAPP_CONFIG_ID`
   - `WA_PHONE_NUMBER_ID`
   - `WA_BUSINESS_ACCOUNT_ID`
   - `WA_ACCESS_TOKEN`
   - `LEEGALITY_CREATE_URL`
   - optional `LEEGALITY_DETAILS_URL`
   - `LEEGALITY_API_KEY`
   - optional `LEEGALITY_API_KEY_HEADER`
   - optional `LEEGALITY_WEBHOOK_SECRET`
5. Install dependencies:
   - `npm install`
6. Start the app:
   - `npm run dev`

## Current behavior

- New sign-in provisions one workspace per Google email.
- The app creates:
  - a spreadsheet named `1Glam Booking OS - [Owner Name]`
  - tabs for config, leads, bookings, artists, follow-ups, interaction logs, and reviews
  - a tentative calendar named `1Glam Tentative Bookings`
- The confirmed calendar defaults to the user's `primary` calendar.
- Lead creation can auto-calculate distance and travel time from the owner's configured city to the venue text.
- If `GOOGLE_MAPS_API_KEY` is missing, the app falls back safely to heuristic travel estimation so lead creation still works.

## Current API routes

Authenticated routes use the signed-in owner's Google session and operate on that owner's sheet and calendar.

- `GET /api/session`
- `POST /api/workspace/config`
- `POST /api/leads`
- `POST /api/leads/:leadId/decision`
- `POST /api/leads/:leadId/confirm`
- `POST /api/leads/:leadId/reply`
- `POST /api/leads/:leadId/quote`
- `POST /api/bookings/:bookingId/invoice`
- `POST /api/bookings/:bookingId/contract`
- `POST /api/bookings/:bookingId/contract/sync`
- `POST /api/leads/:leadId/payment`
- `POST /api/leads/:leadId/quote`
- `POST /api/leads/:leadId/reply`
- `POST /api/bookings/:bookingId/invoice`
- `POST /api/bookings/:bookingId/contract`
- `GET /auth/meta/start`
- `GET /auth/meta/callback`
- `POST /api/meta/connections/:channel/assets`
- `POST /api/meta/disconnect/:channel`
- `POST /webhooks/wati`
- `POST /webhooks/manychat`
- `GET /webhooks/meta`
- `POST /webhooks/meta`
- `POST /webhooks/leegality`
- `POST /compliance/meta/data-deletion`
- `GET /legal/privacy`
- `GET /legal/data-deletion`

### Example lead payload

```json
{
  "source": "Instagram",
  "clientName": "Priya Sharma",
  "clientWhatsApp": "919876543210",
  "clientInstagram": "priya.sharma",
  "eventType": "Bridal",
  "eventDate": "2026-11-22",
  "locationText": "ITC Grand Bharat, Gurgaon",
  "distanceKm": 42,
  "travelTimeMin": 95,
  "profileTier": "High",
  "followers": 24000,
  "clientTags": "LUXURY_BRIDE,HIGH_INTENT"
}
```

When `distanceKm` and `travelTimeMin` are omitted or zero, the server attempts to resolve them automatically using Google Maps geocoding.

If `XAI_API_KEY` is configured, lead creation also attempts to:
- infer `profileTier`
- generate `clientTags`
- create an internal `aiInsight`
- draft a polished suggested reply

### Example owner decision payload

```json
{
  "decision": "EDIT",
  "approvedPrice": 42800,
  "ownerNotes": "Approved with premium bridal positioning."
}
```

### Example payment payload

```json
{
  "paymentStatus": "Advance Paid"
}
```

### Example WhatsApp webhook payload

```json
{
  "secret": "wati-secret",
  "workspaceEmail": "owner@example.com",
  "clientName": "Priya Sharma",
  "clientWhatsApp": "919876543210",
  "eventType": "Bridal",
  "eventDate": "2026-11-22",
  "eventTime": "08:00",
  "locationText": "ITC Grand Bharat, Gurgaon",
  "messageText": "Hi, I need bridal makeup for my wedding.",
  "profileTier": "High",
  "followers": 24000,
  "clientTags": "LUXURY_BRIDE,HIGH_INTENT"
}
```

### Example Instagram webhook payload

```json
{
  "secret": "manychat-secret",
  "workspaceEmail": "owner@example.com",
  "clientName": "Priya Sharma",
  "clientWhatsApp": "919876543210",
  "clientInstagram": "priya.sharma",
  "eventType": "Reception",
  "eventDate": "2026-11-24",
  "eventTime": "17:30",
  "locationText": "The Leela Palace, New Delhi",
  "messageText": "Can you share pricing for my reception?"
}
```

The webhook adapters now accept either:
- the normalized payloads shown above, or
- rough provider-shaped payloads from Wati / ManyChat that contain equivalent fields such as phone, name, message text, and custom fields

Each webhook response now also includes an `outboundTemplate` object you can hand back to Wati or ManyChat/Make to send the suggested reply generated by the system.

## Meta-native architecture notes

- Each MUA connects her own Meta assets through self-serve login and consent.
- Meta connections are stored per workspace and never shared across artists.
- The preferred connect flow uses Meta Business Login `configuration_id` values for Instagram and WhatsApp.
- Direct Meta webhooks are verified through `GET /webhooks/meta`.
- Data deletion callbacks are handled through `POST /compliance/meta/data-deletion`.
- The current implementation stores Meta tokens in the local workspace JSON store for development. Production should move this to encrypted storage.

### Meta Business Login setup

- Create one Business Login configuration for Instagram onboarding
- Create one Business Login configuration for WhatsApp onboarding
- Put those values into:
  - `META_INSTAGRAM_CONFIG_ID`
  - `META_WHATSAPP_CONFIG_ID`
- Use the same redirect URI:
  - `https://1glam-production.up.railway.app/auth/meta/callback`

## Important note

This is intentionally a private-code architecture. Users never receive your server code or editor access to your implementation. They only authorize access to their own Google assets.

## Next build steps

- Token refresh and secure token persistence
- Leegality webhook/status sync hardening against live account payloads
- Review and collections workflows

Webhook ingestion now uses stored per-workspace Google tokens with refresh support, so leads can be created even when the owner is not actively signed in.

Current limitation: tokens are persisted in the local JSON workspace store for this MVP. The next production-hardening step is moving token storage to a proper encrypted secrets/data store.
