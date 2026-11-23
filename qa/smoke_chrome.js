// Teste de fumaça em Chrome REAL: carrega a extensão desempacotada e abre uma página simulada da Ad Library.
// Uso: node smoke.js <pasta-da-extensao>
const { chromium } = require("playwright");
const fs = require("fs");
const ext = process.argv[2];
(async () => {
  const ctx = await chromium.launchPersistentContext(`/tmp/smoke-${Date.now()}`, { executablePath: "/usr/bin/google-chrome", headless: false, viewport: { width: 1300, height: 860 }, ignoreDefaultArgs: ["--disable-extensions"], args: ["--no-sandbox", "--headless=new", "--enable-unsafe-extension-debugging"] });
  const bs = await ctx.browser().newBrowserCDPSession();
  let loaded;
  try { loaded = await bs.send("Extensions.loadUnpacked", { path: ext }); } catch (e) { console.log("FALHA AO CARREGAR EXTENSÃO:", e.message); process.exit(2); }
  const swErr = [];
  ctx.on("weberror", e => swErr.push(e.error().message));
  const page = await ctx.newPage();
  const logs = [];
  page.on("console", m => { if (["error", "warning"].includes(m.type())) logs.push(m.type() + ": " + m.text().slice(0, 300)); });
  page.on("pageerror", e => logs.push("pageerror: " + e.message.slice(0, 300)));
  await page.route("https://www.facebook.com/**", r => r.fulfill({ contentType: "text/html; charset=utf-8", body: `<!doctype html><html><head><title>Ad Library</title></head><body><div role="main"><div>Biblioteca de Anúncios</div></div></body></html>` }));
  await page.goto("https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=BR&q=teste&search_type=keyword_unordered");
  await page.waitForTimeout(3500);
  const r = await page.evaluate(() => ({
    topBar: !!document.querySelector("#viva-top-bar, .viva-top-bar, [id^='viva-top']"),
    dock: !!document.querySelector("#viva-dock, .viva-dock, [id*='dock']"),
    btnRanking: !!document.querySelector("#viva-btn-show-ranking"),
    avisoArquivos: (document.querySelector("#viva-erro-arquivos") || {}).textContent || null,
    vivaEls: document.querySelectorAll("[id^='viva-'], .viva-el").length,
    ids: Array.from(document.querySelectorAll("[id^='viva-']")).map(e => e.id).slice(0, 12),
  }));
  console.log(JSON.stringify({ ext: ext.split("/").pop(), carregou: !!loaded.id, ...r, erros: logs.slice(0, 6), erros_sw: swErr.slice(0, 3) }));
  await page.screenshot({ path: `/tmp/smoke-${ext.split("/").pop()}.png` });
  await ctx.close();
  process.exit(r.btnRanking && r.topBar && r.dock && !r.avisoArquivos ? 0 : 1);
})().catch(e => { console.error("ERR", e.message); process.exit(3); });
