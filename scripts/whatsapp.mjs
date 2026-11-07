/* WhatsApp Web sender for order alerts — run by .github/workflows/whatsapp.yml.
 *   node scripts/whatsapp.mjs login      → prints an 8-character code; enter it on the phone that should SEND
 *                                         (WhatsApp → Linked devices → Link a device → Link with phone number)
 *   node scripts/whatsapp.mjs send       → decrypts ALERT_DATA (from the website) and sends it
 *   node scripts/whatsapp.mjs test       → sends a test message to TEST_TO
 *   node scripts/whatsapp.mjs keepalive  → opens WhatsApp so the saved login stays fresh
 * The logged-in browser profile lives in ./wa-profile (the workflow encrypts it before caching it).
 * Never prints message contents: the repo is public. */
import { chromium } from "playwright";
import crypto from "node:crypto";
import fs from "node:fs";

const MODE = process.argv[2] || "send";
const PROFILE = process.env.WA_PROFILE || "wa-profile";
const KEY = process.env.WA_KEY || "";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const log = m => console.log("[whatsapp] " + m);
const fail = m => { console.error("::error::" + m); process.exitCode = 1; };

function openAlert() {
  const buf = Buffer.from(String(process.env.ALERT_DATA || ""), "base64");
  if (buf.length < 30) throw new Error("No alert data");
  const key = crypto.createHash("sha256").update(KEY).digest();
  const iv = buf.subarray(0, 12), tag = buf.subarray(buf.length - 16), ct = buf.subarray(12, buf.length - 16);
  const d = crypto.createDecipheriv("aes-256-gcm", key, iv); d.setAuthTag(tag);
  return JSON.parse(Buffer.concat([d.update(ct), d.final()]).toString("utf8"));
}

async function browser() {
  fs.mkdirSync(PROFILE, { recursive: true });
  const ctx = await chromium.launchPersistentContext(PROFILE, { headless: true, userAgent: UA, viewport: { width: 1280, height: 900 }, locale: "en-US",
    args: ["--disable-blink-features=AutomationControlled"] });
  const page = ctx.pages()[0] || await ctx.newPage();
  return { ctx, page };
}
const CHATS = '#pane-side, [aria-label="Chat list"], [data-testid="chat-list"]';
async function useHere(page) { const b = page.getByRole("button", { name: /use here/i }); if (await b.isVisible().catch(() => false)) { log("another session was open — taking over"); await b.click(); } }
async function loggedIn(page, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    await useHere(page);
    if (await page.locator(CHATS).first().isVisible().catch(() => false)) return true;
    if (await page.locator('canvas[aria-label*="Scan"], [data-ref] canvas').first().isVisible().catch(() => false)) return false;
    await page.waitForTimeout(1500);
  }
  return false;
}

async function login() {
  const phone = String(process.env.WA_PHONE || "").replace(/\D/g, "");
  if (phone.length < 10) return fail("Set the phone number that should send the alerts (with country code, e.g. 916397988191)");
  const { ctx, page } = await browser();
  await page.goto("https://web.whatsapp.com/", { waitUntil: "domcontentloaded" });
  if (await loggedIn(page, 25000)) { log("Already logged in — nothing to do."); await page.waitForTimeout(15000); return ctx.close(); }
  const link = page.getByText(/(log ?in|link) with phone number/i).first();
  await link.waitFor({ timeout: 60000 });
  await link.evaluate(e => e.click());                 // sits outside the headless viewport, so click it directly
  const input = page.locator('input[aria-label*="phone" i], input[type="text"]').first();
  await input.waitFor({ timeout: 30000 });
  await input.click(); await page.keyboard.press("Control+A"); await page.keyboard.press("Backspace");
  await input.pressSequentially("+" + phone, { delay: 60 });   // the field formats as you type; fill() doesn't stick
  log("number entered: " + (await input.inputValue()).replace(/\d(?=[\d ]{4})/g, "•"));
  await page.getByRole("button", { name: /^next$/i }).click();
  let code = "";
  for (let i = 0; i < 40 && !code; i++) {
    await page.waitForTimeout(1000);
    code = await page.evaluate(() => {
      const el = document.querySelector("[data-link-code]"); if (el) return el.getAttribute("data-link-code").replace(/,/g, "-");
      for (const box of document.querySelectorAll("div, span")) {          // the code is shown one character per span
        const kids = [...box.children]; if (kids.length < 8 || kids.length > 9) continue;
        const t = kids.map(k => k.textContent.trim()); if (t.every(x => /^[A-Z0-9-]$/.test(x)) && t.filter(x => x !== "-").length === 8) return t.join("");
      }
      const m = document.body.innerText.match(/\b[A-Z0-9]{4}-[A-Z0-9]{4}\b/); return m ? m[0] : "";
    });
  }
  if (!code) { log("page said: " + (await page.evaluate(() => document.body.innerText)).replace(/\s+/g, " ").slice(0, 400)); await ctx.close(); return fail("WhatsApp didn't show a link code — run the login again"); }
  const pretty = code.replace(/-/g, "").replace(/^(.{4})(.{4})$/, "$1-$2");
  log("");
  log("========================================================");
  log("  ON YOUR PHONE (" + phone + "): WhatsApp → Settings → Linked devices");
  log("  → Link a device → Link with phone number instead → enter:");
  log("");
  log("        " + pretty);
  log("");
  log("  You have about 3 minutes.");
  log("========================================================");
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY || "/dev/null", "### WhatsApp login code: `" + pretty + "`\nEnter it on the phone: Linked devices → Link a device → Link with phone number instead.\n");
  if (!(await loggedIn(page, 4 * 60000))) { await ctx.close(); return fail("Not linked in time — run the login again and enter the new code"); }
  log("Linked! Letting WhatsApp finish syncing…");
  await page.waitForTimeout(60000);
  await ctx.close(); log("Saved. Order alerts will now be sent from this number.");
}

async function send(to, text) {
  const { ctx, page } = await browser();
  try {
    await page.goto("https://web.whatsapp.com/", { waitUntil: "domcontentloaded" });
    if (!(await loggedIn(page, 90000))) throw new Error("WhatsApp is logged out — run the workflow once with mode = login");
    for (const n of to) {
      await page.goto("https://web.whatsapp.com/send?phone=" + n + "&text=" + encodeURIComponent(text), { waitUntil: "domcontentloaded" });
      await useHere(page);
      const box = page.locator('footer div[contenteditable="true"]').last();
      const bad = page.getByText(/phone number shared via url is invalid/i);
      await Promise.race([box.waitFor({ timeout: 90000 }), bad.waitFor({ timeout: 90000 }).then(() => { throw new Error("That number isn't on WhatsApp: …" + n.slice(-4)); })]);
      await page.waitForTimeout(1500);
      const before = await page.locator('div.message-out, [data-id^="true_"]').count();
      const sendBtn = page.locator('button[aria-label="Send"], span[data-icon="send"], span[data-icon="wds-ic-send-filled"]').first();
      if (await sendBtn.isVisible().catch(() => false)) await sendBtn.click(); else await box.press("Enter");
      await page.waitForFunction(b => document.querySelectorAll('div.message-out, [data-id^="true_"]').length > b, before, { timeout: 30000 }).catch(() => {});
      for (let i = 0; i < 30; i++) {                  // wait until the clock icon turns into a tick
        if (!(await page.locator('span[data-icon="msg-time"]').count())) break;
        await page.waitForTimeout(1000);
      }
      log("sent to …" + n.slice(-4));
    }
    await page.waitForTimeout(4000);
  } finally { await ctx.close(); }
}

try {
  if (MODE === "login") await login();
  else if (MODE === "send") { const a = openAlert(); await send(a.to, a.text); log("order " + String(a.id || "").slice(0, 12) + "… alerted"); }
  else if (MODE === "test") { const to = String(process.env.TEST_TO || "").split(",").map(x => x.replace(/\D/g, "")).filter(x => x.length >= 10);
    if (!to.length) throw new Error("Set the number to send the test to"); await send(to, "✅ Test from the 52 Alive order alerts — if you can read this, new orders will reach this WhatsApp."); }
  else if (MODE === "keepalive") { const { ctx, page } = await browser(); await page.goto("https://web.whatsapp.com/"); const ok = await loggedIn(page, 90000); await page.waitForTimeout(ok ? 30000 : 1000); await ctx.close();
    if (!ok) throw new Error("WhatsApp is logged out — run the workflow once with mode = login"); log("still logged in"); }
  else throw new Error("Unknown mode " + MODE);
} catch (e) { fail(e.message); }
