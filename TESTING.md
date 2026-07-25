# BusyDays — Test Plan

How to test the whole product end-to-end before onboarding artists.
Work top-to-bottom; each test lists **steps → expected result**. Tick as you go.
Report failures with: what you did, what you expected, what you saw (screenshot), and the time (so logs can be pulled).

**You'll need:** your main Google account (admin), a second Google account (test artist), your phone with WhatsApp (opted in to the Gupshup sandbox number), and a second phone or a friend (the "client").

---

## 0 · Pre-flight (5 min) — do this first

- [ ] Open `www.busydays.co/admin` (signed in with your admin Gmail).
- [ ] **Configuration health**: every required row is ✅. Any ❌ → fix that Railway variable before testing anything else.
- [ ] **Send me a test WhatsApp**: enter your number → message arrives on your phone.
- [ ] Reply to that message → it does NOT need to appear anywhere yet (no lead exists for your number) — but the server should log it. This proves the webhook is receiving.

If all three pass, every credential is wired. Everything below is product behavior.

## 1 · Artist onboarding (fresh eyes — use the second Google account, ~15 min)

- [ ] Incognito window → `www.busydays.co` → *Get started with Google* → sign in with the **second** account. Expect: workspace provisions (few seconds), you land on Today with the setup checklist. An "unverified app" warning at consent is expected until Google verification clears — click Advanced → continue.
- [ ] Complete the checklist: business name, WhatsApp number, upload 1 photo, UPI ID. Expect: ticks appear; greeting changes from "add your name…" to "share your booking link 🚀" only after name + number + photo exist.
- [ ] Open **Settings** (⚙️): opens on **💄 The basics** with only 3 sections; the other chips (Services & offers / Messages & documents / Advanced) swap the view; search "GST" finds the right section from any chip.
- [ ] **Insta & WhatsApp** tab (main nav): WhatsApp card says "✅ Already working"; Instagram shows the 3-step journey with step ① lit.

## 2 · Client books (on a phone, ~10 min)

Open the artist's booking link on your phone (share it from the topbar).

- [ ] Page loads fast, burgundy brand, services show prices + durations.
- [ ] Pick a service → calendar shows availability → pick a date.
- [ ] **Time:** the question is "What time do you need to be ready by?" (or ready-by-labelled slot chips). Pick one → expect the line "Your artist starts at X — you'll be ready by Y (about Nh)".
- [ ] Negative: try a ready-by too early for the service (e.g. 2 AM) → clear error, submit blocked.
- [ ] Multi-day: tick "runs over multiple days", try an end date before the start → blocked with a message.
- [ ] Fill name/WhatsApp (use YOUR real number as the client) → Request booking → warm confirmation screen.

## 3 · The money loop (artist side, ~15 min)

- [ ] The request appears in **Requests** (and a "new request" signal on Today).
- [ ] Open it: the drawer shows the price AND the money block — *Includes GST @X%* (if configured), *Advance to confirm (P%)*, *"Nothing received yet — ₹X confirms the date."*
- [ ] **✏️ Edit quote** → change the amount, add a line item, save → toast offers "👁 Preview it" → the PDF shows the new numbers, the editorial design (tracked-caps masthead, right-aligned amounts, emphasized total).
- [ ] Reopen ✏️ Edit quote → your previous edits are prefilled (not blank).
- [ ] Approve / send quote → status moves to Awaiting Client with a hold expiry.
- [ ] Confirm the booking → it appears in **Bookings** and on Google Calendar with the correct time block (start → ready-by).
- [ ] **💰 Record** an advance → drawer money block updates: *Paid so far* (green), *Balance due* (red), pill → Advance Paid.
- [ ] Invoice: preview (new design) → send. Complete the booking after "the event".

## 4 · WhatsApp automation (~10 min + overnight)

- [ ] On confirming the booking (step 3), the confirmation template arrives on the client phone (sandbox: that phone must have opted in first).
- [ ] From a booking row/drawer, **Send reminder** → lands on the client phone.
- [ ] **Reply from the client phone** ("Can we do 4 PM instead?") → within seconds it appears in the artist's **Messages** tab, threaded, with an AI-drafted reply waiting.
- [ ] Turn on auto-reply (My AI tab) → reply again from the client phone → AI answers automatically (🤖 badge in the thread). A message asking about price should NOT auto-send if the lead isn't approved — it waits as a suggestion. That's the guardrail, not a bug.
- [ ] Send "STOP" from the client phone → no reply comes back (correct, legally required silence).
- [ ] Overnight: the pre-event reminder fires on schedule (per reminder settings).

## 5 · The AI (~10 min)

- [ ] **My AI → Try it**: type "Hi! Bridal makeup for 21 Nov, what are your rates?" → coherent reply quoting the artist's actual configured prices.
- [ ] **📸 Upload chat screenshots**: upload 2–3 WhatsApp screenshots → your outgoing replies appear in the samples box → check them → ✨ Learn my tone → voice profile appears. Re-run Try it → the reply now sounds like you.
- [ ] **Ask (assistant)**: ask "who still owes me money?" → correct answer with tappable action buttons; tap one → the real action executes.

## 6 · Instagram journey (needs your one admin click)

- [ ] Artist account: Insta & WhatsApp tab → step ① **Request access** → your WhatsApp receives the note; `/admin` shows it in the Instagram queue with the @handle.
- [ ] `/admin`: **Open Meta roles ↗** → send the tester invite → **Mark invited**.
- [ ] Artist refreshes: step ② now says accept-in-Instagram with the exact path; step ③ Connect is lit.
- [ ] After accepting in Instagram: **Connect** completes OAuth → card flips to "✅ Connected — @handle". DM the account from another IG account → lead appears.

## 7 · Client self-service links (~10 min)

- [ ] **Pay link** (from the quote/invoice): payment page renders, shows the right amounts; screenshot upload accepts an image and rejects a non-image.
- [ ] **Reschedule link**: slots show ready-by labels; picking the same booking's own time is NOT blocked as "taken"; a fully-booked day says "fully booked — choose another day" and disables submit.
- [ ] **Cancel link**: shows the correct fee (or none) based on how far out the event is; cancelling frees the calendar.

## 8 · Admin (~5 min)

- [ ] Credit the test workspace 100 credits → balance updates; submit the same form again untouched → "already credited", no double.
- [ ] Non-admin account opening `/admin` → 404.

## 9 · Mobile & polish (~10 min)

- [ ] On the phone browser: bottom nav present, all tabs usable, no horizontal scroll anywhere.
- [ ] Add to Home Screen → opens standalone with the burgundy icon.
- [ ] Airplane mode mid-use → friendly "you seem offline" messaging, no silent failures; actions recover on reconnect.
- [ ] Fast tap-tap on any action button → no double submissions (buttons lock while working).

## 10 · Not testable yet (external approvals — don't chase these)

- Artist connecting her **own WhatsApp number** (waits for Meta app review; platform pipe covers it).
- Instagram connect **without** a tester invite (same review).
- **Real client phones on WhatsApp without sandbox opt-in** (waits for Gupshup Go Live on your real number).
- iOS/Android **store apps** (build/publish step; the web app + PWA is the pilot surface).
- Online **Razorpay top-ups** (keys not added yet; `/admin` manual credit is the pilot flow).

---

## Reporting a bug

> **What I did:** (steps)
> **Expected:** …
> **Saw instead:** … (+ screenshot)
> **When:** date + time (IST) — enables pulling the exact server logs
> **Account:** admin / test-artist / client-phone

One message per bug. Small papercuts count — they're the difference between "works" and "feels premium."
