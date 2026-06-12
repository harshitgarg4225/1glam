# BusyDays — Product Audit & Build List

*Written from the perspective of a first-time, non-technical, busy makeup artist.
Grounded in a code audit of `public/index.html`, `public/book.html`, `src/index.ts`,
and `src/services/*` — every finding below is marked **exists**, **half-built**, or **missing**.*

---

## 1. The headline finding

When we walked through each complaint against the codebase, the verdict was uncomfortable:

| Her complaint | What the code says | Verdict |
|---|---|---|
| "Can't see how my estimate looks" | Sample previews exist (`/api/documents/sample/quote\|invoice\|contract`), per-document previews exist, 4 visual themes exist, brand-colour tinting exists | **Exists — buried** in Settings → "Document templates & content" collapsible |
| "Can't change my estimate mode" | Theme picker exists (classic/minimal/noir/blush). But "mode" — package vs itemized vs range — does not exist; price is always one calculated number. `quotePackages` config is stored and **used nowhere** | **Half-built** |
| "Can't see my invoices" | A full Documents tab exists: unified list, filters by type/status, create/send/preview/export-for-accountant | **Exists** — likely hidden behind the "More" sheet on mobile |
| "Can't configure how my AI talks" | Full AI section exists: persona name, sign-off, language, tone samples, "✨ Learn my tone" trainer, "👁 Preview reply" tester | **Exists — buried** in Settings, 4th collapsible section |
| "No distance calculator / travel rules" | 3 flat fees; Google-Maps geocoding + haversine when key configured; `travelNearbyCity` and `travelOutstationThresholdKm` are **hidden inputs** the UI never shows; the 25 km nearby boundary is **hardcoded** (`booking.ts` `calculatePricing`) | **Half-built** |
| "Waitlist + intelligent insight about it" | A Yes/No flag. Full date → lead created with `source: "Waitlist"` and a chip on the board. **Nothing downstream**: no queue view, no notification when a date frees, no insight, no auto-offer | **Mostly missing** |
| "Bridal 3h vs party 1h — where do I set windows, does calendar respect them?" | `serviceDurations` grid exists in Settings → Prices; calendar events ARE created with those durations. But **availability ignores them** — capacity is bookings-per-day only; two 4-hour bridals can be booked into overlapping slots | **Half-built** |
| "Change the colour of my page" | My Page tab: brand colour picker, cover image, headline, tagline, about, portfolio upload, live iframe preview, QR code | **Exists** (note: verify headline/tagline actually render in book.html — audit flagged this as unclear; possible bug) |
| "Nothing AI-native about it" | AI drafts replies, learns tone, enriches leads, prices dynamically — but it never **comes to her**: no digest, no nudges, no "here's what I noticed" | **Fair criticism** — intelligence is reactive, never proactive |

**Conclusion:** the product's biggest gap is not missing features. It is that features live
where the *developer* organized them (one giant Settings form with 8 collapsible sections,
~80 fields) instead of where *she* would look for them (at the moment of need). The second
gap is depth: waitlist, durations, travel, and packages are all turned on at the config layer
and abandoned before they do their job. The third gap is proactivity: the AI works for her
clients, not for her.

---

## 2. Why she can't find things (root causes)

1. **Settings is organized by data type, not by her jobs.** She thinks "I want to see what
   my client receives," not "Document Templates & Content (section 5 of 8)."
2. **Nothing is surfaced at the point of need.** When she sends her first quote, that is the
   moment she cares how it looks — and the send flow offers no preview, no "change the look."
3. **Mobile navigation hides the money screens.** Documents, Analytics, Settings sit behind
   a "More" sheet on the phone — the device she actually lives on.
4. **Powerful features have no introduction.** "Learn my tone" is one of the best features in
   the product and nothing ever points her at it.
5. **Half the travel fields are literally `<input hidden>`** (`travelNearbyCity`,
   `travelOutstationThresholdKm`, all 12 seasonal multipliers, profile multipliers, `qrImageUrl`).

---

## 3. The build list

### Tier 0 — Make what exists findable (highest ROI, ~days not weeks)

**T0-1. Preview & look-picker at the point of send (P0)**
When she creates or sends a quote/invoice/contract, the flow shows the rendered document
first, with a "Change the look" button → visual theme picker (4 themes as thumbnail cards,
not a hidden input) + brand colour + logo, with live re-render.
*Acceptance: a new user sends her first quote and sees exactly what the client will receive,
and can switch theme, without ever visiting Settings.*

**T0-2. "My AI" becomes a first-class tab, not Settings section 4 (P0)**
Dedicated view: the reply tester front and centre ("type what a client might ask → see
exactly how your AI answers"), tone training as a guided 2-minute flow, persona/language/
sign-off beside it. Add a one-time nudge after first login: "Teach BusyDays to talk like
you."
*Acceptance: from the home screen, ≤2 taps to test the AI; tone training discoverable
without scrolling a form.*

**T0-3. Travel & locations card, in plain language (P0)**
One card: "Jobs in **{city}**: ₹X travel · Nearby (25–100 km): ₹Y · Outstation (>100 km): ₹Z."
Unhide `travelNearbyCity` and `travelOutstationThresholdKm`; make the hardcoded 25 km
boundary a config field. On every lead, show what was applied: "📍 Udaipur → 38 km
(Google Maps) → nearby-city fee ₹2,000" with one-tap override.
*Acceptance: she can explain her own travel pricing after reading one card; every quoted
travel fee is traceable on the lead.*

**T0-4. Mobile navigation pass (P0)**
Documents and My Page must be reachable in ≤2 taps on the phone. Re-rank the bottom nav by
her actual jobs: Today · Requests · Calendar · Documents · More.

**T0-5. Job-based settings re-organization + settings search (P1)**
Reshape Settings into her language: "My services & prices" / "My booking page" /
"How my documents look" / "How my AI talks" / "Money & GST" / "Messages I send."
Add a search box that filters fields. Kill the remaining hidden fields or give them a home
("Advanced pricing" for seasonal/profile multipliers — she should at least know surge
pricing exists, since it changes her quotes).

**T0-6. Setup checklist that teaches the good stuff (P1)**
Extend the existing dashboard checklist with deep-linking items: "Preview your quote" ·
"Teach the AI your tone" · "Set how long each service takes" · "Pick your page colour."
Each completes itself when done.

### Tier 1 — Finish the half-built features

**T1-1. A real waitlist (P0)**
- Waitlist view: per-date queue (who, service, when they joined), on Calendar day-tap and
  as a Requests board filter that actually aggregates.
- When a booking is cancelled/rescheduled off a full date → notify her ("A slot opened on
  21 Nov — Priya has been waiting 4 days. Offer it?") with a pre-drafted WhatsApp she can
  send in one tap.
- Booking-page copy tells the client their position and what happens next.
- New WhatsApp template: `busydays_waitlist_offer`.
*Acceptance: cancellation on a full date produces an actionable offer within a minute;
no waitlisted client is ever silently forgotten.*

**T1-2. Duration-aware availability (P0)**
`serviceDurations` × `bookingTimeSlots` → real conflict detection. A 4-hour bridal at 09:00
greys out the 11:00 slot on the public page and warns her on manual/quick bookings.
Add optional buffer time between jobs and (later) travel-time-aware blocking for outstation
days.
*Acceptance: it is impossible for the booking page to accept two overlapping jobs; the
calendar reflects true busy windows.*

**T1-3. Estimate modes (P0 — her explicit ask)**
When creating a quote, she picks:
1. **Package** — one price (today's behaviour);
2. **Itemized** — line items with a proper editor (the `orderItems` plumbing and PDF
   rendering already exist; build the UI);
3. **Range** — "₹12,000–15,000, finalized after consultation" rendered on the quote.
Make `quotePackages` real: saved packages appear as one-tap choices in this flow and
pre-fill the line items.
*Acceptance: all three modes render correctly on the PDF and the public quote page;
a saved package fills a quote in one tap.*

**T1-4. Add-ons that price themselves (P1)**
Clients already pick add-ons on the booking page; today they're stored and ignored by
pricing. Wire them into the quote as itemized lines ("Airbrush +₹2,000 · Saree draping
+₹800").

**T1-5. Per-km travel option + config'd tiers (P2)**
Optional ₹/km mode for artists who prefer it; tier boundaries fully configurable.

### Tier 2 — Make it AI-native (her "nothing AI about this" complaint)

**T2-1. Morning digest (P0)**
One push/WhatsApp at her chosen hour: "Today: bridal for Sneha, 9 AM, Bandra (leave by
7:30). 2 quotes unviewed for 3+ days — nudge? ₹8,000 advance still pending for Friday."
All data already exists in leads/bookings/documents; this is assembly + scheduling on the
existing reminder scheduler.

**T2-2. Demand & conflict insights (P0)**
The intelligence she described, surfaced on the dashboard and calendar:
- "21 Nov: 3 confirmed + 4 waitlisted. You could raise your price for this date, or offer
  20 Nov to the waitlist." (data: `getDemandCountForDate` + waitlist leads — already there)
- "December enquiries are 2× November but your December multiplier is 1.0 — raise it?"
- "You priced below your own base 4 times this month."

**T2-3. Smart follow-ups (P1)**
Quote viewed-but-silent for N days → suggested nudge with an AI-drafted message in her
tone, one tap to send. Same for unsigned contracts and unpaid advances (extends the
existing reminder engine from payments to the whole funnel).

**T2-4. Stop making her maintain two copies of her services (P1)**
Auto-build `aiServicesContext` from her prices/services/add-ons config so the AI always
quotes current reality; her field becomes "anything extra the AI should know."

**T2-5. Funnel & money intelligence (P2)**
Conversion funnel (enquiry → quote → confirmed → paid) with the bottleneck called out in
words; payment-lag stats; month-vs-last-month deltas in Analytics.

**T2-6. Continuous tone learning (P2, opt-in)**
When she edits an AI draft before sending, learn from the edit.

### Tier 3 — Depth & polish

- **T3-1.** Booking-page depth: font pairings, section re-ordering, more layout variants
  (live preview already exists — extend it). Fix/verify headline & tagline rendering on
  `book.html` (flagged as possibly not rendered — check first, it may be a bug).
- **T3-2.** Custom questions on the booking form ("trial needed?", "HD or airbrush?").
- **T3-3.** Document depth: drag-reorder line items, save-quote-as-package, localized PDFs
  (template language is stored but PDFs render English-only).
- **T3-4.** Multi-artist calendars & per-artist assignment (future; data model is
  single-calendar today).
- **T3-5.** Calendar two-way sanity: detect when she deletes an event directly in Google
  Calendar so the app doesn't believe a phantom booking.

---

## 4. Two code-level fixes to fold into the above

1. `calculatePricing()` hardcodes the 25 km nearby-city boundary while
   `travelOutstationThresholdKm` is config — move both to config (T0-3).
2. `quotePackages` is parsed into config and referenced nowhere — either wire it up (T1-3)
   or remove the field; a config field that does nothing is a broken promise.

---

## 5. Suggested order of attack

| Wave | Items | Why first |
|---|---|---|
| 1 | T0-1, T0-2, T0-3, T0-4 | Directly answers every "I can't find it" complaint with features that mostly exist |
| 2 | T1-1, T1-2, T1-3 | The three half-built features she tripped over; waitlist + durations also unlock T2-2 |
| 3 | T2-1, T2-2, T0-5, T0-6 | The "AI-native" turn: the product starts talking to *her* |
| 4 | T1-4, T2-3, T2-4, then Tier 3 | Depth |
