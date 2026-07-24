# BusyDays — Pilot Launch Runbook (first 30 artists)

How to launch **now**, while Google app verification and Meta app review are still
pending. Both pending reviews only narrow *who can connect what* — they don't block
a controlled pilot, because:

- **Google** allows up to **100 named test users** while the OAuth consent screen is
  in *Testing* status — they sign in normally, no scary warning.
- **Meta** is optional by design: every client-facing send (reminders, quotes,
  invoices, contracts, review asks) falls back to **one-tap wa.me links** from the
  artist's own WhatsApp. Clients book via the public page, which needs nothing.

---

## 1. One-time production config (~10 min)

### Railway environment
| Variable | Value | Why |
|---|---|---|
| `APP_BASE_URL` | `https://www.busydays.co` | OAuth callback + all links (apex isn't routed; use www) |
| `OPERATIONAL_STORE` | `dual` | Payments/leads/bookings on Postgres — **the payment-failure fix goes live with this flag** |
| `MAX_WORKSPACES` | `35` | Only your invitees get in, even if the link leaks |
| `XAI_API_KEY` | your xAI key | Enables all AI features (replies, assistant, drafting) |
| `ADMIN_EMAILS` | your Gmail | Unlocks the `/admin` dashboard (manual recharges, IG-access queue) |
| `SUPPORT_WHATSAPP` | `91XXXXXXXXXX` | One-tap "request top-up" + "request Instagram access" buttons route to you |
| `GUPSHUP_API_KEY` | from gupshup.io | Automated WhatsApp sends (templates, reminders) — per-message pricing, no Meta review needed |
| `GUPSHUP_APP_NAME` | your Gupshup app | — |
| `GUPSHUP_SOURCE_NUMBER` | `91XXXXXXXXXX` | Your registered WhatsApp business number, digits only |
| `GUPSHUP_WEBHOOK_SECRET` | `openssl rand -hex 24` | Inbound client replies. Set Gupshup's callback URL to `https://www.busydays.co/webhooks/gupshup?token=<secret>` |
| `BILLING_ENFORCED` | *(leave unset)* | Usage tracked, nothing ever blocks — right for a pilot |
| `DATABASE_CA_CERT` | *(optional)* | PEM CA → DB certificate verification on |

Already set and unchanged: `DATABASE_URL`, `SESSION_SECRET` (32+ chars), `TOKEN_ENCRYPTION_KEY`.

### Google Cloud (console.cloud.google.com)
1. **OAuth consent screen → Publishing status → PUBLISH APP** ("In production").
   This stops the 7-day refresh-token expiry that keeps signing everyone out,
   and removes the test-user list requirement. Until verification is approved,
   artists see an "unverified app" warning at sign-in — walk them through
   **Advanced → Go to busydays.co** (sensitive-scope cap: 100 users, fine for the pilot).
2. **Credentials → your OAuth client → Authorized redirect URIs** → confirm
   `https://www.busydays.co/auth/google/callback` is present.
3. **Resubmit verification** (privacy URL `https://www.busydays.co/legal/privacy`)
   and reply to Google's email with the scope-justification draft.

### Smoke test (60 seconds, before inviting anyone)
`https://www.busydays.co/api/health` → `{"ok":true}` → sign in with a test-user
account → create a booking → **record a payment (must succeed — that's dual mode
working)** → send an invoice (wa.me opens) → check the Google Sheet mirrored it.

---

## 2. Instagram + WhatsApp setup & testing the AI replies

### WhatsApp — zero per-artist setup (Gupshup)
With the `GUPSHUP_*` env set (§1), confirmations, reminders and payment nudges
send automatically from the platform number, and client **replies** flow back
into the right artist's Messages tab (routed by the client's phone) with an
AI-drafted response — auto-sent if she's enabled auto-reply. Artists connect
nothing. Connecting an artist's *own* number unlocks after Meta app review.

### Instagram — the in-app access pipeline (while Meta review is pending)
Only invited tester accounts can connect in Development Mode. The product runs
the whole dance: artist taps **Request Instagram access** on her Settings card →
it appears in your **/admin → Instagram access requests** queue with her @handle
→ tap **Open Meta roles ↗** (deep link), paste the handle, send the invite (your
one manual click — Meta has no API for this) → tap **Mark invited** → her card
shows exactly where to accept in Instagram, then she connects.

### Meta app plumbing (one-time, if not already set)

1. **Meta env on Railway** (if not already set): `META_APP_ID`, `META_APP_SECRET`,
   `META_WEBHOOK_VERIFY_TOKEN` (any random string you choose),
   `META_INSTAGRAM_CONFIG_ID`, `META_WHATSAPP_CONFIG_ID` (the two Business Login
   configuration IDs from the Meta app dashboard).
2. **Webhooks** (Meta app dashboard → Webhooks): callback URL
   `https://www.busydays.co/webhooks/meta`, verify token = your
   `META_WEBHOOK_VERIFY_TOKEN`. Subscribe to **instagram → messages** and
   **whatsapp_business_account → messages**.
3. **Roles**: you (app admin) can connect immediately. For a pilot artist who
   wants DM capture before approval: App roles → **Testers** → invite her
   Facebook account (she must accept the invite).
4. **Artist prerequisites**: Instagram must be a *professional* account linked to
   a Facebook Page; WhatsApp connects a WhatsApp Business Account via the
   embedded signup the config ID points at.
5. **Connect** in-app: **WhatsApp & Instagram** tab → *Connect via Facebook*
   (per channel).

### Testing the AI — no Meta needed (do this first)
**My AI tab** → *Teach the AI your voice*: paste 3+ real past replies → **Learn my
tone** → then *Try it — type like a client* and watch it answer in your voice.
This exercises the exact same reply pipeline the DM auto-reply uses.

### Testing the real auto-reply loop (with your own connected IG)
1. Connect your Instagram (you're app admin — works in dev mode).
2. From a *different* personal account, DM your business: *"Hi! Bridal makeup for
   20 Dec, what are your rates?"*
3. In BusyDays: a lead appears (Requests), enriched with an AI insight + a
   suggested reply; the thread shows in **Messages**.
4. Turn on auto-reply (**My AI tab → Turn on auto-reply**) and DM again — the
   reply goes out automatically, badged 🤖 in Messages.
5. **Expected safety behaviour, not a bug:** replies containing money/commitment
   words are *not* auto-sent until you've approved the lead — they wait as
   suggested replies for one-tap send. AI replies cost 2 credits each (tracked,
   never blocking, since billing isn't enforced).

---

## 3. Onboarding the first 30 artists — step by step

**Batching: 5 artists/day for 6 days.** You'll find and fix friction after every
batch instead of 30 people hitting the same rock.

### Before day 1
- [ ] Railway env set (§1), smoke test passed.
- [ ] Gupshup templates approved and their IDs pasted into Settings (template fields).
- [ ] Create a WhatsApp group (you + pilot artists) as the support channel.

### Per artist (~20-min concierge call / screen share)
1. **Sign in** — send `https://www.busydays.co` → *Sign in with Google* → the
   workspace auto-provisions (her Sheet + two calendars appear in her Google account).
2. **Setup checklist** (the app shows it — walk it together): business name,
   WhatsApp number, base prices per service, **UPI ID** (payments), time slots,
   2-3 portfolio photos, brand colour.
3. **Her booking link** — My Page tab → copy → have her put it in her Instagram bio
   *on the call*.
4. **Install** — phone: *Add to Home Screen* (or sideload the APK from the
   GitHub Actions artifact for Android die-hards).
5. **Live drill (the aha moment)** — you open her booking link on your phone and
   book a fake "Party" for next week. She watches the request land, approves it,
   sends the quote, and marks a ₹500 advance recorded. Then cancel/delete it together.
6. **Teach the AI her voice** — My AI tab, paste 3 of her real past replies, run
   the *Try it* preview. (Leave auto-reply OFF until Meta approval unless she's a
   Tester — suggested replies still work everywhere.)

### After each batch
- [ ] Ask each artist to send her link to **one real client** within 48h.
- [ ] Day-2 check-in in the group: any booking requests? anything confusing?
- [ ] Watch Railway logs + Sentry for errors; watch the Wallet tab pattern for AI usage.
- [ ] Fix the top friction item before the next batch.

### What clients experience (nothing to set up)
Booking page, payment page, contract signing, reschedule/cancel links, and the
appointment hub are all public — **no reviews gate the client side at all**.

---

## 4. When the reviews clear
- **Google approved** → OAuth consent screen → *Publish to Production* → remove
  `MAX_WORKSPACES` cap → open signup.
- **Meta approved** → artists connect IG/WhatsApp themselves from the Channels
  tab → automatic template sends + DM lead capture switch on; wa.me remains the
  fallback whenever a channel isn't connected.

## 5. Rollback levers
- `OPERATIONAL_STORE=sheets` → instantly back to the legacy datastore (dual-write
  kept the Sheets current; no data loss).
- Railway → redeploy a previous build for a full app rollback.
- Google → remove a test user to cut off a workspace's sign-in.
