# Google OAuth Verification — Demo Video & Scope Justifications

Google asks for this because your app requests **sensitive** Google scopes
(Sheets, Calendar, Business Profile). This guide gives you (1) the exact
justification text to paste into the OAuth verification form, and (2) a
shot-by-shot script for the demo video you record on your own machine.

> **Why you have to record it yourself:** Google requires a *real* screen
> recording of *your live app* showing the actual consent screen and each scope
> in use, with the OAuth **Client ID under review** visible. They reject
> mock-ups and third-party recordings. A headless server can't produce this.

---

## 1. Your scopes (what to declare)

| Scope | Google class | Used for |
|---|---|---|
| `userinfo.email` | Non-sensitive | Sign-in — identify the account |
| `userinfo.profile` | Non-sensitive | Sign-in — show name/photo in the app |
| `spreadsheets` | **Sensitive** | The app stores each artist's bookings, leads and payment ledger in a Google Sheet **in the artist's own Drive** — that Sheet is the app's database |
| `calendar` | **Sensitive** | Create/update tentative + confirmed booking holds on the artist's calendar so they don't double-book a wedding date |
| `drive.file` | Non-sensitive (per-file) | Store files the app itself creates: client payment screenshots, portfolio images, business logo |
| `business.manage` | **Sensitive** (requested only if the artist opts into Google Business features) | Read Google reviews and post replies / Google Posts on the artist's behalf |

**Good news:** these are *sensitive* scopes, not *restricted* ones (like full
Drive or Gmail). So you need **brand verification + this demo video**, but **not**
the paid third-party security assessment that restricted scopes require.

> If you don't actually ship the Google Business Profile feature yet, the
> simplest path is to **remove `business.manage`** from the verification request
> and submit only Sheets + Calendar. Fewer sensitive scopes = faster approval.
> (In this codebase that scope is only requested when the artist explicitly
> connects Google Business, via `BUSINESS_MANAGE_SCOPE`.)

---

## 2. Justification text (paste into the form)

**App name:** BusyDays
**What the app does (one-liner):**
> BusyDays is a booking and client-management tool for independent makeup
> artists and small studios. Each artist signs in with Google; the app manages
> their bookings, calendar holds, quotes/invoices and payment records.

**Per-scope justification:**

- **`.../auth/spreadsheets`** —
  "We use a Google Sheet in the signed-in artist's own Google Drive as the
  application's database. When the artist signs up we create one spreadsheet
  and read/write their leads, bookings and payment ledger to it. We only touch
  spreadsheets our own app created for that user; we never browse or read their
  other spreadsheets. This keeps each artist's business data in an account they
  fully own and can export at any time."

- **`.../auth/calendar`** —
  "When an artist confirms a booking, we create a calendar event for the event
  date/time so they don't accept two weddings on the same day, and we update or
  remove that event if the booking is rescheduled or cancelled. We read free/busy
  to warn about clashes. We do not read or modify events the app did not create
  for a booking."

- **`.../auth/drive.file`** —
  "We store files our app generates or the client uploads — a client's payment
  screenshot, the artist's portfolio images and business logo. `drive.file`
  limits us to only the files our app creates; we cannot see the rest of the
  user's Drive."

- **`.../auth/userinfo.email` and `.../auth/userinfo.profile`** —
  "Standard sign-in: we use the email as the account identifier and the
  name/photo to personalise the dashboard."

- **`.../auth/business.manage`** *(only if you keep it)* —
  "If the artist chooses to connect their Google Business Profile, we read their
  customer reviews so they can reply from our app, and we publish Google Posts
  they write. This is optional and only requested when they tap 'Connect Google
  Business'."

---

## 3. Pre-recording checklist

Do these before you hit record, or Google will bounce the video:

- [ ] The OAuth **Client ID** in the video matches the one under verification.
      Easiest proof: during the consent step, the URL bar shows
      `accounts.google.com/.../oauth/...client_id=XXXX` — let it be readable, **or**
      show the Client ID once in your Google Cloud Console at the start.
- [ ] The app is served from your **verified domain** (the same homepage URL and
      privacy-policy URL you entered in the OAuth consent screen). `localhost`
      recordings are often rejected — record against your real deployed URL.
- [ ] Your **app name + logo** appear on the Google consent screen exactly as
      configured.
- [ ] A **privacy policy** is live and linked from the consent screen and your
      homepage.
- [ ] Record in **English** (or add English captions). Keep it 2–4 minutes.
- [ ] Upload to **YouTube as Unlisted** and paste that link in the form.

---

## 4. Video script (shot list)

Narrate as you go. Keep the cursor visible; don't cut between Google's screen
and yours.

**Shot 1 — Identify the app & client (10s)**
> "This is BusyDays, at https://<your-domain>. The OAuth Client ID under review
> is <paste id>." Show the homepage, then briefly the Cloud Console OAuth client
> page (or just keep the client_id visible in the consent URL in Shot 3).

**Shot 2 — Start sign-in (10s)**
> "An artist signs in with Google to set up their account." Click **Sign in with
> Google**.

**Shot 3 — The consent screen (20s) — REQUIRED**
> Slow down here. Read the scopes Google shows: "Google asks the artist to grant
> access to Sheets, Calendar and Drive files." Make sure the app name, logo, and
> the requested scopes are clearly visible. Click **Allow**.

**Shot 4 — Sheets scope in use (40s)**
> "BusyDays just created a Google Sheet in the artist's own Drive — this is our
> database." Open a booking in the app, add/edit it, then switch to the artist's
> Google Drive and open that Sheet to show the same row was written. This visibly
> proves *what* you do with `spreadsheets`.

**Shot 5 — Calendar scope in use (30s)**
> "When a booking is confirmed, we put a hold on the artist's Google Calendar."
> Confirm a booking in the app, then open Google Calendar and show the event.
> Reschedule it in the app and show the calendar event move. That covers
> `calendar`.

**Shot 6 — Drive.file scope in use (20s)**
> "Clients upload a payment screenshot; we store it as an app file." Upload a
> screenshot on the payment page and show it attached to the booking. That covers
> `drive.file`.

**Shot 7 — (Optional) Business Profile (20s)**
> Only if you kept `business.manage`: tap **Connect Google Business**, show a
> review being read and a reply posted.

**Shot 8 — Close (5s)**
> "All Google data stays in the artist's own account; they can disconnect any
> time from Settings." Show the disconnect/sign-out control.

---

## 5. Top reasons these get rejected (avoid them)

1. **Client ID not shown / doesn't match** → always show it.
2. **Recorded on localhost** instead of the verified production domain.
3. **Scope shown but not demonstrated** → every sensitive scope must be *used*
   on camera, not just named. Shots 4–6 above are mandatory for Sheets/Calendar/Drive.
4. **App name/logo on consent screen don't match** the listing.
5. **No live privacy policy** at the URL you declared.
6. **Asking for more scopes than you demo** → if you can't show `business.manage`
   in action, drop it from the request.

---

*Generated for the BusyDays OAuth verification submission. Update the
`<your-domain>` / Client ID placeholders before recording.*
