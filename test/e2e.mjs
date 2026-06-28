/**
 * 1Glam E2E smoke tests
 */
import { chromium } from "playwright";

const BASE = "http://localhost:3099";
const CHROME = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const results = [];

function log(name, status, note = "") {
  const icon = status === "PASS" ? "✅" : "❌";
  console.log(`${icon} ${name}${note ? " — " + note : ""}`);
  results.push({ name, status, note });
}

const browser = await chromium.launch({ headless: true, executablePath: CHROME });
const ctx = await browser.newContext();
const page = await ctx.newPage();
const jsErrors = [];
page.on("pageerror", (err) => jsErrors.push(err.message));
await page.goto(BASE, { waitUntil: "networkidle" });

// 1. PAGE STRUCTURE
const title = await page.title();
log("Page title", title.includes("BusyDays") ? "PASS" : "FAIL", title);
log("Sign-in link visible", await page.locator("#connect-link").isVisible() ? "PASS" : "FAIL");
const navHtml = await page.locator("#tab-nav").innerHTML();
log("Reviews in main tab bar", navHtml.includes('data-tab="reviews"') ? "PASS" : "FAIL");
log("Settings gear icon", await page.locator("#settings-icon-btn").count() > 0 ? "PASS" : "FAIL");
log("Settings reachable via More dropdown", navHtml.includes('data-tab="setup"') ? "PASS" : "FAIL");
const moreItems = await page.locator(".tab-more-item").allTextContents();
log("Reviews NOT in More dropdown", !moreItems.some(t=>t.includes("Reviews")) ? "PASS" : "FAIL");
log("More has Insights+Team+WhatsApp", moreItems.some(t=>t.includes("Insights")) && moreItems.some(t=>t.includes("Team")) && moreItems.some(t=>t.includes("WhatsApp")) ? "PASS" : "FAIL");
log("Notify-team modal in DOM", await page.locator("#notify-team-modal").count() > 0 ? "PASS" : "FAIL");
log("Toast shelf in DOM", await page.locator(".toast-shelf").count() > 0 ? "PASS" : "FAIL");
const connectTag = await page.locator("#connect-link").evaluate(el => el.tagName.toLowerCase());
log("Connect link is valid <a>", connectTag === "a" ? "PASS" : "FAIL");
const connectChildren = await page.locator("#connect-link").evaluate(el => el.children.length);
log("No button nested inside connect link", connectChildren === 0 ? "PASS" : "FAIL");

// 2. AUTH GUARDS (correct API paths)
for (const ep of ["/api/conversations","/api/team","/api/analytics","/api/reviews"]) {
  const r = await page.request.get(`${BASE}${ep}`);
  log(`GET ${ep} guarded (401)`, r.status() === 401 ? "PASS" : "FAIL", `HTTP ${r.status()}`);
}
for (const [ep, body] of [
  ["/api/workspace/config",{}],
  ["/api/leads/x/decision",{decision:"YES"}],
  ["/api/leads/x/confirm",{}],
  ["/api/leads/x/reply",{message:"hi"}],
  ["/api/leads/x/quote",{}],
  ["/api/leads/x/send-quote",{}],
  ["/api/leads/x/assign",{assignedArtist:""}],
  ["/api/bookings/x/invoice",{}],
  ["/api/bookings/x/send-invoice",{}],
  ["/api/bookings/x/contract",{}],
  ["/api/bookings/x/send-contract",{}],
  ["/api/bookings/x/contract/sync",{}],
  ["/api/bookings/x/send-review",{}],
  ["/api/bookings/x/send-collection",{kind:"advance"}],
]) {
  const r = await page.request.post(`${BASE}${ep}`, { data: body });
  log(`POST ${ep} guarded (401)`, r.status() === 401 ? "PASS" : "FAIL", `HTTP ${r.status()}`);
}

// 3. INPUT VALIDATION ON PUBLIC BOOKING
for (const [label, body, expected] of [
  ["bad date format",   {clientName:"A",clientWhatsApp:"+911234567890",eventType:"Bridal",eventDate:"not-a-date",locationText:"Mumbai"}, 400],
  ["slashes date",     {clientName:"A",clientWhatsApp:"+911234567890",eventType:"Bridal",eventDate:"01/08/2026",locationText:"Mumbai"}, 400],
  ["phone too short",  {clientName:"A",clientWhatsApp:"123",eventType:"Bridal",eventDate:"2026-08-01",locationText:"Mumbai"}, 400],
  ["missing name",     {clientWhatsApp:"+911234567890",eventType:"Bridal",eventDate:"2026-08-01",locationText:"Mumbai"}, 400],
  // Location is optional (the form says "add it later"), so a missing venue is
  // valid input → it passes schema validation and reaches the workspace lookup.
  ["missing location (optional)", {clientName:"A",clientWhatsApp:"+911234567890",eventType:"Bridal",eventDate:"2026-08-01"}, 404],
  ["unknown workspace",{clientName:"A",clientWhatsApp:"+911234567890",eventType:"Bridal",eventDate:"2026-08-01",locationText:"Mumbai"}, 404],
]) {
  const r = await page.request.post(`${BASE}/api/public/nonexistent-ws/book`, { data: body });
  log(`Public booking: ${label}`, r.status() === expected ? "PASS" : "FAIL", `HTTP ${r.status()} (expected ${expected})`);
}

// 4. WEBHOOKS FAIL-CLOSED
const wati = await page.request.post(`${BASE}/webhooks/wati`, { data: {workspaceEmail:"x@x.com"} });
log("WATI webhook fails closed (401)", wati.status() === 401 ? "PASS" : "FAIL", `HTTP ${wati.status()}`);
const mc = await page.request.post(`${BASE}/webhooks/manychat`, { data: {workspaceEmail:"x@x.com"} });
log("Manychat webhook fails closed (401)", mc.status() === 401 ? "PASS" : "FAIL", `HTTP ${mc.status()}`);
const meta = await page.request.get(`${BASE}/webhooks/meta?hub.mode=subscribe&hub.challenge=abc&hub.verify_token=bad`);
log("Meta verify rejects bad token (403)", meta.status() === 403 ? "PASS" : "FAIL", `HTTP ${meta.status()}`);

// 5. DOCUMENT TEMPLATES (public, no auth needed)
const tmpl = await page.request.get(`${BASE}/api/document-templates`);
log("Document templates endpoint is public", tmpl.status() === 200 ? "PASS" : "FAIL", `HTTP ${tmpl.status()}`);
const tmplData = await tmpl.json();
log("Has 4 document themes", (tmplData?.templates?.length ?? 0) >= 4 ? "PASS" : "FAIL", `${tmplData?.templates?.length} themes`);

// 6. RATE LIMITING
let rateLimited = false;
for (let i = 0; i < 25; i++) {
  const r = await page.request.post(`${BASE}/api/public/ws/book`, {
    data: {clientName:"x",clientWhatsApp:"+911234567890",eventType:"a",eventDate:"2026-08-01",locationText:"b"}
  });
  if (r.status() === 429) { rateLimited = true; break; }
}
log("Rate limiter triggers after 20 req/min", rateLimited ? "PASS" : "FAIL");

// 7. GOOGLE OAUTH START
const oauthStart = await page.request.get(`${BASE}/auth/google`, { maxRedirects: 0 });
log("Google auth start → 302", oauthStart.status() === 302 ? "PASS" : "FAIL", `HTTP ${oauthStart.status()}`);
const loc = oauthStart.headers()["location"] ?? "";
log("Redirects to accounts.google.com", loc.includes("accounts.google.com") ? "PASS" : "FAIL");

// 8. SESSION SAFETY
const sess = await (await page.request.get(`${BASE}/api/session`)).json();
log("Session unauthenticated → authenticated:false", sess.authenticated === false ? "PASS" : "FAIL");
log("No googleTokens leaked", !("googleTokens" in sess) ? "PASS" : "FAIL");

// 9. HEALTH CHECK
const health = await (await page.request.get(`${BASE}/api/health`)).json();
log("Health endpoint", health?.ok === true ? "PASS" : "FAIL");

// 10. PUBLIC BOOKING PAGE
const bookPage = await page.request.get(`${BASE}/book/nonexistent-artist`);
log("Public /book page → no 500", bookPage.status() < 500 ? "PASS" : "FAIL", `HTTP ${bookPage.status()}`);

// 11. GMB SEARCH (auth guarded — correct path)
const gmb = await page.request.get(`${BASE}/api/gmb/search?q=test`);
log("GET /api/gmb/search guarded (401)", gmb.status() === 401 ? "PASS" : "FAIL", `HTTP ${gmb.status()}`);

// 12. FRONTEND JS INTEGRITY
const html = await (await page.request.get(`${BASE}/`)).text();
log("debounce() in JS", html.includes("function debounce") ? "PASS" : "FAIL");
log("No double toast (else-toast pattern)", html.includes('else toast("Lead updated') ? "PASS" : "FAIL");
log("Modal Escape handler present", html.includes("modalEscHandler") ? "PASS" : "FAIL");
log("Modal focus management (openModalWithFocus)", html.includes("openModalWithFocus") ? "PASS" : "FAIL");
log("Settings tab wired to gear icon", html.includes('"setup"') ? "PASS" : "FAIL");

// 13. JS RUNTIME ERRORS
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(800);
const critical = jsErrors.filter(e => !e.includes("favicon") && !e.includes("net::ERR") && !e.includes("NetworkError"));
log("No JS runtime errors on load", critical.length === 0 ? "PASS" : "FAIL",
  critical.length ? critical.slice(0,3).join("; ") : "clean");

await browser.close();

const pass = results.filter(r => r.status === "PASS").length;
const fail = results.filter(r => r.status === "FAIL").length;
console.log(`\n${"═".repeat(55)}`);
console.log(`  ${pass} passed | ${fail} failed`);
console.log(`${"═".repeat(55)}`);
if (fail > 0) {
  console.log("\n❌ FAILURES:");
  results.filter(r => r.status === "FAIL").forEach(r => console.log(`  • ${r.name}: ${r.note}`));
}
process.exit(fail > 0 ? 1 : 0);
