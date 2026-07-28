import express from "express";
import cors from "cors";
import { chromium } from "playwright";
import { execSync } from "child_process";
import cron from "node-cron";
import pg from "pg";

const { Pool } = pg;
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ─── Database ────────────────────────────────────────────────────────────────

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL environment variable is required.");
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function query(sql, params = []) {
  const client = await pool.connect();
  try {
    return await client.query(sql, params);
  } finally {
    client.release();
  }
}

async function initDb() {
  await query(`
    CREATE TABLE IF NOT EXISTS pages (
      slug          TEXT PRIMARY KEY,
      nome          TEXT NOT NULL,
      url           TEXT NOT NULL,
      tipo          TEXT NOT NULL DEFAULT 'pagina',
      instagram_url TEXT,
      geo           TEXT,
      nicho         TEXT,
      created_at    TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS scrape_history (
      id           SERIAL PRIMARY KEY,
      slug         TEXT NOT NULL,
      ads_count    INTEGER NOT NULL,
      slot         SMALLINT,
      collected_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);

  await query(`
    CREATE INDEX IF NOT EXISTS idx_scrape_history_slug ON scrape_history(slug)
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS scrape_latest (
      slug         TEXT PRIMARY KEY,
      ads_count    INTEGER NOT NULL,
      collected_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);

  // Migrações: garante colunas novas em banco antigo (seguro rodar sempre)
  await query(`ALTER TABLE pages ADD COLUMN IF NOT EXISTS tipo TEXT NOT NULL DEFAULT 'pagina'`);
  await query(`ALTER TABLE pages ADD COLUMN IF NOT EXISTS inicial_count INTEGER`);
  await query(`ALTER TABLE pages ADD COLUMN IF NOT EXISTS instagram_url TEXT`);
  await query(`ALTER TABLE pages ADD COLUMN IF NOT EXISTS geo TEXT`);
  await query(`ALTER TABLE pages ADD COLUMN IF NOT EXISTS nicho TEXT`);
  await query(`ALTER TABLE pages ADD COLUMN IF NOT EXISTS funil TEXT`);

  await query(`
    CREATE TABLE IF NOT EXISTS funnel_nodes (
      id         SERIAL PRIMARY KEY,
      slug       TEXT NOT NULL REFERENCES pages(slug) ON DELETE CASCADE,
      tipo       TEXT NOT NULL CHECK (tipo IN ('advertorial','tsl','vsl','quiz','whatsapp','checkout')),
      rotulo     TEXT NOT NULL,
      url        TEXT NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS funnel_edges (
      id           SERIAL PRIMARY KEY,
      from_node_id INTEGER NOT NULL REFERENCES funnel_nodes(id) ON DELETE CASCADE,
      to_node_id   INTEGER NOT NULL REFERENCES funnel_nodes(id) ON DELETE CASCADE,
      created_at   TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_funnel_nodes_slug ON funnel_nodes(slug)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_funnel_edges_from ON funnel_edges(from_node_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_funnel_edges_to ON funnel_edges(to_node_id)`);

  console.log("[DB] Tables ready.");
}


// ─── Helpers ─────────────────────────────────────────────────────────────────

function toSlug(nome) {
  return nome
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function getChromiumPath() {
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH) {
    return process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  }
  try {
    return execSync("which chromium || which chromium-browser || which google-chrome", {
      encoding: "utf8",
    }).trim().split("\n")[0];
  } catch {
    return undefined;
  }
}

// ─── Scraper ─────────────────────────────────────────────────────────────────

async function scrapeWithContext(context, url) {
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(15000);
    const content = await page.content();
    const htmlMatch = content.match(/([\d.,]+)\s*(resultados|results)/i);
    if (htmlMatch) {
      const parsed = parseInt(htmlMatch[1].replace(/[,.]/g, ""), 10);
      if (!isNaN(parsed)) return parsed;
    }
    for (const kw of ["resultados", "results"]) {
      try {
        const el = page.locator(`text=/${kw}/i`).first();
        await el.waitFor({ timeout: 3000 });
        const texto = await el.innerText();
        const match = texto.replace(/[,.]/g, "").match(/\d+/);
        if (match) return parseInt(match[0], 10);
      } catch {
        continue;
      }
    }
    const bodyText = (await page.textContent("body")) ?? "";
    const textMatch = bodyText.match(/([\d.,]+)\s*(resultados|results)/i);
    if (textMatch) {
      const parsed = parseInt(textMatch[1].replace(/[,.]/g, ""), 10);
      if (!isNaN(parsed)) return parsed;
    }
    return null;
  } finally {
    await page.close();
  }
}

async function scrapeAdCount(url, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    const browser = await chromium.launch({
      executablePath: getChromiumPath(),
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-blink-features=AutomationControlled"],
    });
    try {
      const context = await browser.newContext({
        locale: "pt-BR",
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        extraHTTPHeaders: { "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8" },
      });
      const count = await scrapeWithContext(context, url);
      if (count !== null) {
        console.log(`[SCRAPE] attempt=${attempt} count=${count}`);
        return count;
      }
      console.warn(`[SCRAPE] attempt=${attempt} — count not found, retrying...`);
    } catch (err) {
      console.error(`[SCRAPE] attempt=${attempt} error: ${err.message}`);
    } finally {
      await browser.close();
    }
    if (attempt < retries) await new Promise((r) => setTimeout(r, 5000));
  }
  console.error(`[SCRAPE] all ${retries} attempts failed, returning 0`);
  return 0;
}

// Dedupe considera slot — só bloqueia duplicata do MESMO slot
async function saveCount(slug, count, slot) {
  console.log(`[SAVECOUNT] slug=${slug} slot=${slot}`);
  const { rows: recent } = await query(
    `SELECT id FROM scrape_history
     WHERE slug = $1
       AND slot IS NOT DISTINCT FROM $2
       AND collected_at >= NOW() - INTERVAL '60 seconds'
     LIMIT 1`,
    [slug, slot]
  );

  await query(
    `INSERT INTO scrape_latest (slug, ads_count, collected_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (slug) DO UPDATE
       SET ads_count    = EXCLUDED.ads_count,
           collected_at = EXCLUDED.collected_at`,
    [slug, count]
  );

  if (recent.length === 0) {
    await query("INSERT INTO scrape_history (slug, ads_count, slot) VALUES ($1, $2, $3)", [slug, count, slot]);
    console.log(`[HISTORY] slug=${slug} slot=${slot} count=${count} saved`);
  } else {
    console.log(`[HISTORY] slug=${slug} slot=${slot} skipped duplicate`);
  }
}

// Captura inicial no momento do cadastro (individual)
async function captureInicial(slug, url) {
  try {
    const count = await scrapeAdCount(url, 2);
    await query(
      `UPDATE pages SET inicial_count = COALESCE(inicial_count, $2) WHERE slug = $1`,
      [slug, count]
    );
    await query(
      `INSERT INTO scrape_latest (slug, ads_count, collected_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (slug) DO UPDATE
         SET ads_count    = EXCLUDED.ads_count,
             collected_at = EXCLUDED.collected_at`,
      [slug, count]
    );
    console.log(`[DESCOBERTA] slug=${slug} inicial=${count} capturado no cadastro`);
    return count;
  } catch (err) {
    console.error(`[DESCOBERTA] falha ao capturar inicial de slug=${slug}: ${err.message}`);
    return null;
  }
}

// Versão de captureInicial que reutiliza browser já aberto (para lotes)
async function captureInicialWithContext(context, slug, url) {
  let count = null;
  for (let attempt = 1; attempt <= 2 && count === null; attempt++) {
    try {
      count = await scrapeWithContext(context, url);
    } catch (err) {
      console.error(`[LOTE] slug=${slug} attempt=${attempt} error: ${err.message}`);
    }
  }
  const final = count ?? 0;
  await query(`UPDATE pages SET inicial_count = COALESCE(inicial_count, $2) WHERE slug = $1`, [slug, final]);
  await query(
    `INSERT INTO scrape_latest (slug, ads_count, collected_at) VALUES ($1, $2, NOW())
     ON CONFLICT (slug) DO UPDATE SET ads_count = EXCLUDED.ads_count, collected_at = EXCLUDED.collected_at`,
    [slug, final]
  );
  return final;
}

// Processa lote em background (fire-and-forget)
async function runLote(itens) {
  if (isRunning) {
    console.warn("[LOTE] abortado — já existe uma coleta em andamento (cron ou outro lote)");
    loteStatus.erros.push("Abortado: já havia uma coleta (cron ou outro lote) em andamento. Tente de novo em alguns minutos.");
    loteStatus.emAndamento = false;
    return;
  }
  isRunning = true;
  loteStatus = {
    emAndamento: true,
    total: itens.length,
    concluidos: 0,
    atual: null,
    erros: [],
    iniciadoEm: new Date().toISOString(),
    finalizadoEm: null,
  };
  console.log(`[LOTE] ===== iniciado — ${itens.length} itens =====`);

  let browser;
  try {
    browser = await chromium.launch({
      executablePath: getChromiumPath(),
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-blink-features=AutomationControlled"],
    });
    const context = await browser.newContext({
      locale: "pt-BR",
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      extraHTTPHeaders: { "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8" },
    });

    for (const item of itens) {
      loteStatus.atual = item.nome;
      const slug = toSlug(item.nome);
      if (!slug) {
        loteStatus.erros.push(`"${item.nome}" — nome inválido, ignorado`);
        loteStatus.concluidos++;
        continue;
      }
      try {
        await query(
          `INSERT INTO pages (slug, nome, url, tipo, instagram_url)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (slug) DO UPDATE SET nome=$2, url=$3, tipo=$4,
             instagram_url = COALESCE(EXCLUDED.instagram_url, pages.instagram_url)`,
          [slug, item.nome, item.url, item.tipo, item.instagram_url || null]
        );
        await captureInicialWithContext(context, slug, item.url);
        console.log(`[LOTE] slug=${slug} cadastrado e capturado (${loteStatus.concluidos + 1}/${itens.length})`);
      } catch (err) {
        console.error(`[LOTE] erro no item slug=${slug}: ${err.message}`);
        loteStatus.erros.push(`"${item.nome}" — erro: ${err.message}`);
      }
      loteStatus.concluidos++;
    }
  } catch (err) {
    console.error(`[LOTE] erro fatal: ${err.message}`);
    loteStatus.erros.push(`Erro fatal: ${err.message}`);
  } finally {
    if (browser) await browser.close();
    isRunning = false;
    loteStatus.emAndamento = false;
    loteStatus.atual = null;
    loteStatus.finalizadoEm = new Date().toISOString();
    console.log(`[LOTE] ===== finalizado — ${loteStatus.concluidos}/${loteStatus.total} processados, ${loteStatus.erros.length} erros =====`);
  }
}

function resolveSlot(trigger) {
  switch (trigger) {
    case "cron-03h": return 3;
    case "cron-12h": return 12;
    case "cron-22h": return 22;
    default: return null;
  }
}

async function mirrorToSheet(rows) {
  const url = process.env.SHEET_WEBHOOK_URL;
  if (!url) return;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ collected_at: new Date().toISOString(), rows }),
    });
    console.log("[SHEET] mirrored to backup webhook");
  } catch (err) {
    console.error(`[SHEET] mirror failed: ${err.message}`);
  }
}

let isRunning = false;

let loteStatus = {
  emAndamento: false,
  total: 0,
  concluidos: 0,
  atual: null,
  erros: [],
  iniciadoEm: null,
  finalizadoEm: null,
};

// Parser de lote — aceita 3 formatos:
//   Nome | URL
//   tipo | Nome | URL
//   Nome | URL | https://instagram.com/...   (Instagram no final — opcional)
//   tipo | Nome | URL | https://instagram.com/...
function parseLoteInput(texto) {
  const linhas = texto.split("\n").map((l) => l.trim()).filter(Boolean);
  const itens = [];
  for (const linha of linhas) {
    const partes = linha.split("|").map((s) => s.trim()).filter(Boolean);
    let nome, url, tipoForcado = null, instagram_url = null;

    if (partes.length >= 2) {
      const possivelTipo = partes[0].toLowerCase();
      if (possivelTipo === "dominio" || possivelTipo === "pagina") {
        // tipo | Nome | URL [| Instagram]
        tipoForcado = possivelTipo;
        nome = partes[1];
        // Verifica se o último campo é uma URL do Instagram
        const ultimo = partes[partes.length - 1];
        if (partes.length >= 4 && (ultimo.includes("instagram.com") || ultimo.startsWith("https://www.instagram"))) {
          instagram_url = ultimo;
          url = partes.slice(2, partes.length - 1).join("|");
        } else {
          url = partes.slice(2).join("|");
        }
      } else {
        // Nome | URL [| Instagram]
        nome = partes[0];
        const ultimo = partes[partes.length - 1];
        if (partes.length >= 3 && (ultimo.includes("instagram.com") || ultimo.startsWith("https://www.instagram"))) {
          instagram_url = ultimo;
          url = partes.slice(1, partes.length - 1).join("|");
        } else {
          url = partes.slice(1).join("|");
        }
      }
    } else {
      continue; // linha sem "|" ou vazia — ignora
    }

    if (!nome || !url) continue;
    const tipo = tipoForcado || (url.includes("view_all_page_id=") ? "pagina" : "dominio");
    itens.push({ nome, url, tipo, instagram_url });
  }
  return itens;
}

async function runAllScrapes(trigger = "cron") {
  if (isRunning) {
    console.warn(`[RUN] skipped (${trigger}) — already running`);
    return { skipped: true };
  }
  isRunning = true;
  const startedAt = new Date();
  console.log(`[RUN] ===== started (${trigger}) at ${startedAt.toISOString()} =====`);

  const { rows: pages } = await query("SELECT slug, nome, url FROM pages");
  if (!pages.length) {
    console.log("[RUN] no pages registered");
    isRunning = false;
    return { pages: 0 };
  }

  let browser;
  const results = [];
  try {
    browser = await chromium.launch({
      executablePath: getChromiumPath(),
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-blink-features=AutomationControlled"],
    });
    const context = await browser.newContext({
      locale: "pt-BR",
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      extraHTTPHeaders: { "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8" },
    });
    for (const p of pages) {
      let count = null;
      for (let attempt = 1; attempt <= 2 && count === null; attempt++) {
        try {
          count = await scrapeWithContext(context, p.url);
        } catch (err) {
          console.error(`[RUN] slug=${p.slug} attempt=${attempt} error: ${err.message}`);
        }
      }
      const final = count ?? 0;

      if (trigger.startsWith("cron")) {
        const slot = resolveSlot(trigger);
        await saveCount(p.slug, final, slot);
      } else {
        await query(
          `INSERT INTO scrape_latest (slug, ads_count, collected_at)
           VALUES ($1, $2, NOW())
           ON CONFLICT (slug) DO UPDATE
             SET ads_count    = EXCLUDED.ads_count,
                 collected_at = EXCLUDED.collected_at`,
          [p.slug, final]
        );
        console.log(`[LATEST] slug=${p.slug} count=${final} (manual — histórico preservado)`);
      }

      results.push({ slug: p.slug, nome: p.nome, count: final });
    }
  } catch (err) {
    console.error(`[RUN] fatal error: ${err.message}`);
  } finally {
    if (browser) await browser.close();
    isRunning = false;
  }

  await mirrorToSheet(results);
  const secs = Math.round((Date.now() - startedAt.getTime()) / 1000);
  console.log(`[RUN] ===== finished (${trigger}) — ${results.length} pages in ${secs}s =====`);
  return { pages: results.length, durationSec: secs, results };
}

// ─── Routes ──────────────────────────────────────────────────────────────────

app.get("/api/healthz", (_req, res) => res.json({ status: "ok", ts: new Date().toISOString() }));

app.post("/api/salvar", async (req, res) => {
  const { nome, url, tipo, instagram_url, geo, nicho, funil } = req.body;
  if (!nome || !url) return res.status(400).json({ error: "Fields 'nome' and 'url' are required." });
  const slug = toSlug(nome);
  if (!slug) return res.status(400).json({ error: "Could not generate a valid slug." });
  const tipoFinal = tipo === "dominio" ? "dominio" : "pagina";
  await query(
    `INSERT INTO pages (slug, nome, url, tipo, instagram_url, geo, nicho, funil)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (slug) DO UPDATE
       SET nome=$2, url=$3, tipo=$4,
           instagram_url=COALESCE(EXCLUDED.instagram_url, pages.instagram_url),
           geo=COALESCE(EXCLUDED.geo, pages.geo),
           nicho=COALESCE(EXCLUDED.nicho, pages.nicho),
           funil=COALESCE(EXCLUDED.funil, pages.funil)`,
    [slug, nome, url, tipoFinal, instagram_url || null, geo || null, nicho || null, funil || null]
  );
  console.log(`[SALVAR] registered slug=${slug} tipo=${tipoFinal}`);
  const inicial = await captureInicial(slug, url);
  res.json({ slug, tipo: tipoFinal, inicial, coletarPath: `/api/coletar/${slug}` });
});

app.get("/api/coletar/:slug", async (req, res) => {
  const { slug } = req.params;
  const { rows } = await query("SELECT * FROM pages WHERE slug = $1 LIMIT 1", [slug]);
  const row = rows[0];
  if (!row) return res.status(404).type("text/plain").send(`Page '${slug}' not registered.`);
  try {
    const count = await scrapeAdCount(row.url);
    res.type("text/plain").send(String(count));
    await query(
      `INSERT INTO scrape_latest (slug, ads_count, collected_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (slug) DO UPDATE
         SET ads_count    = EXCLUDED.ads_count,
             collected_at = EXCLUDED.collected_at`,
      [slug, count]
    );
    console.log(`[LATEST] slug=${slug} count=${count} (manual via /api/coletar — histórico preservado)`);
  } catch (err) {
    console.error(`[COLETAR] error slug=${slug}: ${err.message}`);
    res.type("text/plain").send("0");
  }
});

app.get("/api/coletar-tudo", async (_req, res) => {
  res.json({ status: "started" });
  runAllScrapes("manual").catch((e) => console.error("[RUN] manual error:", e.message));
});

app.get("/api/historico/:slug", async (req, res) => {
  const { slug } = req.params;
  const { rows } = await query(
    `SELECT id, slug, ads_count, collected_at FROM scrape_history WHERE slug = $1 ORDER BY collected_at DESC`,
    [slug]
  );
  res.json(rows);
});

app.get("/api/resumo/:slug", async (req, res) => {
  const { slug } = req.params;
  const { rows } = await query(
    `SELECT ads_count, collected_at FROM scrape_history WHERE slug = $1 ORDER BY collected_at ASC`,
    [slug]
  );
  if (rows.length === 0) return res.json({ slug, message: "No data yet." });
  const counts = rows.map((r) => r.ads_count);
  const min = Math.min(...counts), max = Math.max(...counts);
  const avg = Math.round(counts.reduce((a, b) => a + b, 0) / counts.length);
  const first = counts[0], last = counts[counts.length - 1];
  const trend = last > first ? "crescendo" : last < first ? "caindo" : "estável";
  res.json({ slug, total_coletas: rows.length, min, max, avg, trend, first, last });
});

app.get("/api/status", async (_req, res) => {
  const { rows: pages } = await query("SELECT slug, nome, url FROM pages");
  const result = await Promise.all(pages.map(async (p) => {
    const { rows } = await query(
      `SELECT ads_count, collected_at FROM scrape_history WHERE slug = $1 ORDER BY collected_at DESC LIMIT 1`,
      [p.slug]
    );
    const latest = rows[0];
    return { slug: p.slug, nome: p.nome, url: p.url, ads_ativos: latest?.ads_count ?? null, ultima_coleta: latest?.collected_at ?? null };
  }));
  res.json(result);
});

app.get("/api/paginas", async (_req, res) => {
  const { rows } = await query("SELECT slug, nome, url, tipo, instagram_url, geo, nicho, funil FROM pages");
  res.json(rows);
});

// ─── Admin ───────────────────────────────────────────────────────────────────

app.get("/admin", async (_req, res) => {
  const { rows: pages } = await query(
    "SELECT slug, nome, url, tipo, instagram_url, geo, nicho, funil, created_at FROM pages ORDER BY tipo, created_at DESC"
  );

  // JSON de cada item, embutido no atributo data-item, usado pelo JS para preencher o formulário ao clicar em Editar
  function escAttr(str) {
    return String(str ?? "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  const lista = pages.map(p => `
    <tr>
      <td><span class="badge ${p.tipo === "dominio" ? "b-dom" : "b-pag"}">${p.tipo === "dominio" ? "🌐 Domínio" : "📡 Biblioteca"}</span></td>
      <td class="nome-cell">
        <div class="nome">${p.nome}</div>
        <div class="meta-badges">
          ${p.geo ? `<span class="meta-tag">🌍 ${p.geo}</span>` : ""}
          ${p.nicho ? `<span class="meta-tag">🏷️ ${p.nicho}</span>` : ""}
          ${p.funil ? `<span class="meta-tag">🎯 ${p.funil}</span>` : ""}
          ${p.instagram_url ? `<a href="${p.instagram_url}" target="_blank" class="ig-tag">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style="display:inline;vertical-align:middle;margin-right:3px"><rect width="24" height="24" rx="6" fill="url(#ig_admin)"/><circle cx="12" cy="12" r="4.5" stroke="white" stroke-width="1.8" fill="none"/><circle cx="17" cy="7" r="1.2" fill="white"/><rect x="3" y="3" width="18" height="18" rx="5" stroke="white" stroke-width="1.8" fill="none"/><defs><linearGradient id="ig_admin" x1="0" y1="24" x2="24" y2="0"><stop offset="0%" stop-color="#f09433"/><stop offset="25%" stop-color="#e6683c"/><stop offset="50%" stop-color="#dc2743"/><stop offset="75%" stop-color="#cc2366"/><stop offset="100%" stop-color="#bc1888"/></linearGradient></defs></svg>Instagram</a>` : ""}
        </div>
      </td>
      <td><a href="${p.url}" target="_blank" class="url-link">Ver na Meta ↗</a></td>
      <td>${new Date(p.created_at).toLocaleDateString("pt-BR")}</td>
      <td style="white-space:nowrap">
        <button type="button" class="btn-edit"
          data-slug="${escAttr(p.slug)}"
          data-nome="${escAttr(p.nome)}"
          data-url="${escAttr(p.url)}"
          data-tipo="${escAttr(p.tipo)}"
          data-instagram="${escAttr(p.instagram_url)}"
          data-geo="${escAttr(p.geo)}"
          data-nicho="${escAttr(p.nicho)}"
          data-funil="${escAttr(p.funil)}"
          onclick="editarItem(this)">✏️ Editar</button>
        <a href="/admin/funis/${p.slug}" class="btn-funis">🔀 Funis</a>
        <form method="POST" action="/admin/remover" style="display:inline" onsubmit="return confirm('Remover ${p.nome}?')">
          <input type="hidden" name="slug" value="${p.slug}">
          <button type="submit" class="btn-del">Remover</button>
        </form>
      </td>
    </tr>`).join("");

  const msgOk = (() => {
    const q = res.req?.query || {};
    if (q.ok === "1") return '<div class="msg ok">✅ Rastreamento cadastrado com sucesso.</div>';
    if (q.ok === "editado") return '<div class="msg ok">✏️ Rastreamento atualizado com sucesso.</div>';
    if (q.ok === "removido") return '<div class="msg ok">🗑️ Rastreamento removido.</div>';
    if (q.erro === "campos-obrigatorios") return '<div class="msg err">⚠️ Nome e URL são obrigatórios.</div>';
    if (q.erro === "nome-invalido") return '<div class="msg err">⚠️ Nome inválido.</div>';
    if (q.erro === "lote-vazio") return '<div class="msg err">⚠️ Nenhum item enviado no lote.</div>';
    if (q.erro === "lote-invalido") return '<div class="msg err">⚠️ Nenhuma linha válida encontrada no lote.</div>';
    if (q.erro === "lote-em-andamento") return '<div class="msg err">⚠️ Já existe um lote em andamento. Aguarde terminar.</div>';
    if (q.erro === "erro-interno") return '<div class="msg err">⚠️ Erro interno. Tente novamente.</div>';
    return "";
  })();

  res.send(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Lowticket Monitor — Admin</title>
<style>
:root{--bg:#0a0a14;--surface:#12121f;--border:#23233f;--text:#f0f0fa;--muted:#7a7a98;--accent:#7c6fff;--up:#34d399;--down:#fb7185}
*{margin:0;padding:0;box-sizing:border-box}
body{background:var(--bg);color:var(--text);font-family:'Space Grotesk',sans-serif;padding:24px;max-width:1000px;margin:0 auto}
.hdr{display:flex;align-items:center;gap:14px;margin-bottom:28px;padding-bottom:16px;border-bottom:1px solid var(--border)}
.hdr h1{font-size:18px;font-weight:700}
.hdr a{margin-left:auto;font-size:13px;color:var(--accent);text-decoration:none;border:1px solid var(--accent);padding:7px 16px;border-radius:8px}
.hdr a:hover{background:var(--accent);color:#fff}
.card{background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:22px 24px;margin-bottom:20px}
.card h2{font-size:14px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.6px;margin-bottom:18px}
.form-row{display:grid;grid-template-columns:160px 1fr 1fr;gap:12px;align-items:end;margin-bottom:12px}
.form-row-2{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px}
.form-row-3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-bottom:12px}
@media(max-width:700px){.form-row,.form-row-2,.form-row-3{grid-template-columns:1fr}}
.field{display:flex;flex-direction:column;gap:6px}
label{font-size:11px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.5px}
.label-optional{font-size:10px;color:var(--muted);font-weight:400;text-transform:none;letter-spacing:0;margin-left:4px;opacity:.7}
input,select{background:#0f0f1e;border:1px solid var(--border);border-radius:8px;color:var(--text);font-family:'Space Grotesk',sans-serif;font-size:14px;padding:10px 14px;outline:none;transition:border-color .2s}
input:focus,select:focus{border-color:var(--accent)}
input::placeholder{color:var(--muted)}
.btn{background:var(--accent);color:#fff;border:none;border-radius:8px;font-family:'Space Grotesk',sans-serif;font-size:14px;font-weight:600;padding:10px 22px;cursor:pointer;transition:opacity .2s}
.btn:hover{opacity:.85}
.btn-del{background:transparent;color:var(--down);border:1px solid var(--down);border-radius:6px;font-family:'Space Grotesk',sans-serif;font-size:11px;padding:4px 10px;cursor:pointer;transition:all .2s;margin-left:6px}
.btn-edit{background:transparent;color:var(--accent);border:1px solid var(--accent);border-radius:6px;font-family:'Space Grotesk',sans-serif;font-size:11px;padding:4px 10px;cursor:pointer;transition:all .2s}
.btn-edit:hover{background:var(--accent);color:#fff}
.btn-funis{display:inline-block;background:transparent;color:#34d399;border:1px solid #34d399;border-radius:6px;font-family:'Space Grotesk',sans-serif;font-size:11px;padding:4px 10px;cursor:pointer;transition:all .2s;text-decoration:none;margin-left:6px}
.btn-funis:hover{background:#34d399;color:#0a0a14}
.btn-del:hover{background:var(--down);color:#fff}
.tip{font-size:12px;color:var(--muted);margin-top:14px;line-height:1.6;background:#0f0f1e;border-radius:8px;padding:12px 14px;border-left:3px solid var(--accent)}
table{width:100%;border-collapse:collapse;font-size:13px}
thead th{color:var(--muted);font-size:10px;text-transform:uppercase;letter-spacing:.6px;padding:10px 14px;text-align:left;border-bottom:1px solid var(--border)}
td{padding:11px 14px;border-bottom:1px solid var(--border);vertical-align:middle}
.nome{font-weight:600;color:#fff}
.nome-cell{vertical-align:middle}
.meta-badges{display:flex;flex-wrap:wrap;gap:5px;margin-top:5px}
.meta-tag{font-size:10px;background:rgba(124,111,255,.12);color:#a78bfa;padding:2px 7px;border-radius:5px;font-weight:500}
.ig-tag{font-size:10px;background:rgba(220,39,67,.12);color:#fb7185;padding:2px 7px;border-radius:5px;font-weight:500;text-decoration:none;display:inline-flex;align-items:center;gap:3px}
.ig-tag:hover{background:rgba(220,39,67,.25)}
.url-link{color:var(--accent);font-size:12px;text-decoration:none;font-family:'Space Mono',monospace}
.url-link:hover{text-decoration:underline}
.badge{display:inline-block;padding:3px 9px;border-radius:6px;font-size:11px;font-weight:600}
.b-dom{background:rgba(124,111,255,.15);color:#a78bfa}
.b-pag{background:rgba(52,211,153,.12);color:#34d399}
.msg{padding:12px 16px;border-radius:8px;font-size:13px;margin-bottom:18px}
.msg.ok{background:rgba(52,211,153,.12);color:#34d399;border:1px solid rgba(52,211,153,.25)}
.msg.err{background:rgba(251,113,133,.12);color:#fb7185;border:1px solid rgba(251,113,133,.25)}
.empty{color:var(--muted);font-size:13px;text-align:center;padding:24px}
.divider{border:none;border-top:1px solid var(--border);margin:16px 0}
</style>
</head>
<body>
<div class="hdr">
  <h1>⚙️ Admin — Lowticket Monitor</h1>
  <div style="margin-left:auto;display:flex;gap:8px;flex-wrap:wrap">
    <a href="/dashboard" style="font-size:13px;color:var(--accent);text-decoration:none;border:1px solid var(--accent);padding:7px 16px;border-radius:8px">← Ver Dashboard</a>
    <a href="/funis" style="font-size:13px;color:var(--accent);text-decoration:none;border:1px solid var(--accent);padding:7px 16px;border-radius:8px">🔀 Ver Mapa de Funis</a>
  </div>
</div>

${msgOk}

<div class="card" id="form-card">
  <h2 id="form-title">➕ Cadastrar novo rastreamento</h2>
  <form method="POST" action="/admin/salvar" id="mainForm">
    <input type="hidden" name="original_slug" id="originalSlug" value="">
    <div class="form-row">
      <div class="field">
        <label>Tipo</label>
        <select name="tipo" id="tipoSelect" onchange="atualizarDica()">
          <option value="pagina">📡 Biblioteca (página)</option>
          <option value="dominio">🌐 Domínio (URL)</option>
        </select>
      </div>
      <div class="field">
        <label>Nome</label>
        <input type="text" name="nome" id="nomeInput" placeholder="Ex: FlowForce Max ou FLOWFORCE.COM" required>
      </div>
      <div class="field">
        <label>URL da Meta Ad Library</label>
        <input type="url" name="url" id="urlInput" placeholder="https://www.facebook.com/ads/library/..." required>
      </div>
    </div>

    <hr class="divider">
    <div style="font-size:11px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:12px">Informações adicionais <span style="font-weight:400;text-transform:none;letter-spacing:0;opacity:.6">(opcionais)</span></div>

    <div class="form-row-3">
      <div class="field">
        <label>Instagram <span class="label-optional">opcional</span></label>
        <input type="url" name="instagram_url" id="instagramInput" placeholder="https://www.instagram.com/perfil">
      </div>
      <div class="field">
        <label>Geo <span class="label-optional">opcional</span></label>
        <input type="text" name="geo" id="geoInput" placeholder="Ex: US, BR, UK">
      </div>
      <div class="field">
        <label>Nicho <span class="label-optional">opcional</span></label>
        <input type="text" name="nicho" id="nichoInput" placeholder="Ex: Próstata, Weight Loss, ED">
      </div>
    </div>
    <div class="form-row-3">
      <div class="field">
        <label>Funil <span class="label-optional">opcional</span></label>
        <input type="text" name="funil" id="funilInput" placeholder="Ex: VSL, Advertorial, Quiz">
      </div>
    </div>

    <div style="display:flex;gap:10px;margin-top:4px">
      <button type="submit" class="btn" id="submitBtn">Cadastrar</button>
      <button type="button" class="btn" id="cancelBtn" style="display:none;background:transparent;border:1px solid var(--border);color:var(--text2)" onclick="cancelarEdicao()">Cancelar edição</button>
    </div>

    <div class="tip" id="dica">
      💡 <strong>Biblioteca:</strong> Cole a URL da página do anunciante na Meta Ad Library com filtro "Anúncios ativos".<br>
      Exemplo: <code>https://www.facebook.com/ads/library/?active_status=active&ad_type=all&id=XXXXXXXXX</code>
    </div>
  </form>
</div>

<div class="card">
  <h2>📦 Cadastro em lote</h2>
  <form method="POST" action="/admin/lote">
    <div class="field">
      <label>Uma linha por item</label>
      <textarea name="itens" rows="7"
        placeholder="FlowForce Max | https://www.facebook.com/ads/library/?view_all_page_id=123456 | https://instagram.com/flowforcemax&#10;FLOWFORCE.COM | https://www.facebook.com/ads/library/?q=FLOWFORCE.COM...&#10;dominio | AnotherOffer | https://www.facebook.com/ads/library/?q=ANOTHEROFFER.COM | https://instagram.com/anotheroffer"
        style="background:#0f0f1e;border:1px solid var(--border);border-radius:8px;color:var(--text);font-family:'Space Mono',monospace;font-size:12px;padding:12px 14px;outline:none;resize:vertical;width:100%"></textarea>
    </div>
    <button type="submit" class="btn" style="margin-top:12px">Cadastrar lote</button>
    <div class="tip">
      💡 Formatos aceitos por linha:<br>
      <code>Nome | URL da Meta Ad Library</code><br>
      <code>Nome | URL da Meta Ad Library | https://instagram.com/perfil</code><br>
      <code>tipo | Nome | URL | https://instagram.com/perfil</code><br><br>
      O tipo (Biblioteca ou Domínio) é detectado automaticamente pela URL. O Instagram é opcional — basta omitir.<br>
      Geo e Nicho só podem ser preenchidos após o cadastro, editando o item individualmente no admin.<br>
      Cada item leva ~15-20s pra processar. A página não precisa ficar aberta.
    </div>
  </form>
  <div id="lote-progresso" style="display:none;margin-top:16px;background:#0f0f1e;border:1px solid var(--border);border-radius:8px;padding:14px 16px">
    <div id="lote-texto" style="font-size:13px;color:var(--text2)"></div>
    <div style="background:var(--border);border-radius:6px;height:8px;margin-top:10px;overflow:hidden">
      <div id="lote-barra" style="background:var(--accent);height:100%;width:0%;transition:width .3s"></div>
    </div>
    <div id="lote-erros" style="font-size:12px;color:var(--down);margin-top:10px"></div>
  </div>
</div>

<div class="card">
  <h2>📋 Rastreamentos cadastrados (${pages.length})</h2>
  ${pages.length === 0 ? '<div class="empty">Nenhum rastreamento cadastrado ainda.</div>' : `
  <table>
    <thead><tr><th>Tipo</th><th>Nome / Metadados</th><th>Link Meta</th><th>Cadastrado</th><th></th></tr></thead>
    <tbody>${lista}</tbody>
  </table>`}
</div>

<script>
function atualizarDica(){
  const tipo=document.getElementById('tipoSelect').value;
  const dica=document.getElementById('dica');
  const url=document.getElementById('urlInput');
  if(tipo==='dominio'){
    dica.innerHTML='💡 <strong>Domínio:</strong> Cole a URL de busca por palavra-chave/domínio na Meta Ad Library.<br>Exemplo: <code>https://www.facebook.com/ads/library/?active_status=active&q=SEUDOMINIO.COM&search_type=keyword_unordered</code>';
    url.placeholder='https://www.facebook.com/ads/library/?active_status=active&q=SEUDOMINIO.COM...';
  }else{
    dica.innerHTML='💡 <strong>Biblioteca:</strong> Cole a URL da página do anunciante na Meta Ad Library com filtro "Anúncios ativos".<br>Exemplo: <code>https://www.facebook.com/ads/library/?active_status=active&ad_type=all&id=XXXXXXXXX</code>';
    url.placeholder='https://www.facebook.com/ads/library/?active_status=active&id=...';
  }
}

function editarItem(btn){
  document.getElementById('originalSlug').value=btn.dataset.slug;
  document.getElementById('nomeInput').value=btn.dataset.nome;
  document.getElementById('urlInput').value=btn.dataset.url;
  document.getElementById('tipoSelect').value=btn.dataset.tipo;
  document.getElementById('instagramInput').value=btn.dataset.instagram;
  document.getElementById('geoInput').value=btn.dataset.geo;
  document.getElementById('nichoInput').value=btn.dataset.nicho;
  document.getElementById('funilInput').value=btn.dataset.funil;
  document.getElementById('form-title').textContent='✏️ Editando: '+btn.dataset.nome;
  document.getElementById('submitBtn').textContent='Salvar alterações';
  document.getElementById('cancelBtn').style.display='inline-block';
  atualizarDica();
  document.getElementById('form-card').scrollIntoView({behavior:'smooth',block:'start'});
}

function cancelarEdicao(){
  document.getElementById('mainForm').reset();
  document.getElementById('originalSlug').value='';
  document.getElementById('form-title').textContent='➕ Cadastrar novo rastreamento';
  document.getElementById('submitBtn').textContent='Cadastrar';
  document.getElementById('cancelBtn').style.display='none';
  atualizarDica();
}

(function iniciarPollingLote(){
  const params=new URLSearchParams(window.location.search);
  const painel=document.getElementById('lote-progresso');
  const texto=document.getElementById('lote-texto');
  const barra=document.getElementById('lote-barra');
  const errosEl=document.getElementById('lote-erros');
  if(!painel)return;
  async function checarStatus(){
    try{
      const r=await fetch('/api/lote/status');
      const s=await r.json();
      if(!s.emAndamento&&!s.total)return;
      painel.style.display='block';
      const pct=s.total?Math.round((s.concluidos/s.total)*100):0;
      barra.style.width=pct+'%';
      if(s.emAndamento){
        texto.textContent='Processando '+s.concluidos+' de '+s.total+'... atual: '+(s.atual||'—');
        setTimeout(checarStatus,3000);
      }else{
        texto.textContent='Lote finalizado — '+s.concluidos+' de '+s.total+' itens processados.';
        if(s.erros&&s.erros.length){errosEl.innerHTML=s.erros.map(e=>'⚠️ '+e).join('<br>');}
      }
    }catch(e){console.error('Falha ao consultar status do lote',e);}
  }
  if(params.get('lote')==='iniciado'){checarStatus();}else{checarStatus();}
})();
</script>
</body>
</html>`);
});

app.post("/admin/salvar", async (req, res) => {
  const { nome, url, tipo, instagram_url, geo, nicho, funil, original_slug } = req.body;
  if (!nome || !url) return res.redirect("/admin?erro=campos-obrigatorios");
  const tipoFinal = tipo === "dominio" ? "dominio" : "pagina";

  // Modo edição: atualiza o registro existente pelo slug original — o slug NUNCA muda,
  // mesmo que o nome de exibição mude, para preservar o vínculo com scrape_history/scrape_latest.
  if (original_slug && original_slug.trim()) {
    try {
      const { rowCount } = await query(
        `UPDATE pages SET nome=$1, url=$2, tipo=$3, instagram_url=$4, geo=$5, nicho=$6, funil=$7 WHERE slug=$8`,
        [nome, url, tipoFinal, instagram_url || null, geo || null, nicho || null, funil || null, original_slug.trim()]
      );
      if (rowCount === 0) {
        console.warn(`[ADMIN] edição falhou — slug=${original_slug} não encontrado`);
        return res.redirect("/admin?erro=erro-interno");
      }
      console.log(`[ADMIN] editou slug=${original_slug}`);
      return res.redirect("/admin?ok=editado");
    } catch (err) {
      console.error("[ADMIN] erro ao editar:", err.message);
      return res.redirect("/admin?erro=erro-interno");
    }
  }

  // Modo cadastro (novo item)
  const slug = toSlug(nome);
  if (!slug) return res.redirect("/admin?erro=nome-invalido");
  try {
    await query(
      `INSERT INTO pages (slug, nome, url, tipo, instagram_url, geo, nicho, funil)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (slug) DO UPDATE
         SET nome=$2, url=$3, tipo=$4,
             instagram_url=COALESCE(EXCLUDED.instagram_url, pages.instagram_url),
             geo=COALESCE(EXCLUDED.geo, pages.geo),
             nicho=COALESCE(EXCLUDED.nicho, pages.nicho),
             funil=COALESCE(EXCLUDED.funil, pages.funil)`,
      [slug, nome, url, tipoFinal, instagram_url || null, geo || null, nicho || null, funil || null]
    );
    console.log(`[ADMIN] cadastrou slug=${slug} tipo=${tipoFinal}`);
    await captureInicial(slug, url);
    res.redirect("/admin?ok=1");
  } catch (err) {
    console.error("[ADMIN] erro:", err.message);
    res.redirect("/admin?erro=erro-interno");
  }
});

app.post("/admin/remover", async (req, res) => {
  const { slug } = req.body;
  if (!slug) return res.redirect("/admin");
  await query("DELETE FROM pages WHERE slug=$1", [slug]);
  await query("DELETE FROM scrape_history WHERE slug=$1", [slug]);
  await query("DELETE FROM scrape_latest WHERE slug=$1", [slug]);
  console.log(`[ADMIN] removeu slug=${slug}`);
  res.redirect("/admin?ok=removido");
});

app.post("/admin/lote", async (req, res) => {
  const { itens: textoItens } = req.body;
  if (!textoItens || !textoItens.trim()) return res.redirect("/admin?erro=lote-vazio");
  const itens = parseLoteInput(textoItens);
  if (!itens.length) return res.redirect("/admin?erro=lote-invalido");
  if (loteStatus.emAndamento) return res.redirect("/admin?erro=lote-em-andamento");
  res.redirect("/admin?lote=iniciado");
  runLote(itens).catch((err) => console.error("[LOTE] erro não tratado:", err.message));
});

app.get("/api/lote/status", (_req, res) => {
  res.json(loteStatus);
});

// ─── Funis (modelo de grafo: nós + conexões) ────────────────────────────────

const TIPO_INFO = {
  advertorial: { icon: "📄", label: "Advertorial" },
  tsl:         { icon: "📝", label: "TSL" },
  vsl:         { icon: "🎬", label: "VSL" },
  quiz:        { icon: "🧩", label: "Quiz" },
  whatsapp:    { icon: "💬", label: "WhatsApp" },
  checkout:    { icon: "💳", label: "Checkout" },
};
const TIPOS_ORDEM = ["advertorial", "tsl", "vsl", "quiz", "whatsapp", "checkout"];

// Computa todos os caminhos (raiz → folha) de um grafo de nós/conexões.
// Raiz = nó sem conexão de entrada. Folha = nó sem conexão de saída.
// Guarda contra ciclos interrompendo o caminho se o nó já apareceu nele.
function computarCaminhos(nodes, edges) {
  const nodesById = {};
  nodes.forEach(n => { nodesById[n.id] = n; });
  const adj = {};
  edges.forEach(e => {
    if (!adj[e.from_node_id]) adj[e.from_node_id] = [];
    adj[e.from_node_id].push(e.to_node_id);
  });
  const temEntrada = new Set(edges.map(e => e.to_node_id));
  const raizes = nodes.filter(n => !temEntrada.has(n.id));

  const caminhos = [];
  function dfs(nodeId, caminho) {
    if (caminho.includes(nodeId)) { caminhos.push([...caminho]); return; }
    const novoCaminho = [...caminho, nodeId];
    const proximos = adj[nodeId] || [];
    if (proximos.length === 0) {
      caminhos.push(novoCaminho);
    } else {
      proximos.forEach(p => dfs(p, novoCaminho));
    }
  }
  raizes.forEach(r => dfs(r.id, []));
  return caminhos.map(c => c.map(id => nodesById[id]).filter(Boolean));
}

async function getNodesEdges(slug) {
  const { rows: nodes } = await query(
    `SELECT id, tipo, rotulo, url FROM funnel_nodes WHERE slug=$1 ORDER BY created_at ASC`, [slug]
  );
  let edges = [];
  if (nodes.length) {
    const ids = nodes.map(n => n.id);
    const { rows } = await query(
      `SELECT id, from_node_id, to_node_id FROM funnel_edges WHERE from_node_id = ANY($1) OR to_node_id = ANY($1)`,
      [ids]
    );
    edges = rows;
  }
  return { nodes, edges };
}

function renderChip(node) {
  const info = TIPO_INFO[node.tipo] || { icon: "🔗", label: node.tipo };
  return `<a href="${node.url}" target="_blank" rel="noopener" class="chip">
    <span class="chip-icon">${info.icon}</span>
    <span class="chip-label">${node.rotulo}</span>
  </a>`;
}

function renderCaminho(caminho) {
  return `<div class="caminho-row">${caminho.map(renderChip).join('<span class="chip-arrow">→</span>')}</div>`;
}

// Página de gerenciamento de nós/conexões de um player
app.get("/admin/funis/:slug", async (req, res) => {
  const { slug } = req.params;
  const { rows: pages } = await query("SELECT nome, url FROM pages WHERE slug=$1 LIMIT 1", [slug]);
  if (!pages.length) return res.status(404).send("Player não encontrado.");
  const nomePage = pages[0].nome;

  const { nodes, edges } = await getNodesEdges(slug);
  const nodesById = {};
  nodes.forEach(n => { nodesById[n.id] = n; });

  const optionsNodes = nodes.map(n => {
    const info = TIPO_INFO[n.tipo] || { icon: "🔗", label: n.tipo };
    return `<option value="${n.id}">${info.icon} ${n.rotulo} (${info.label})</option>`;
  }).join("");

  const optionsTipos = TIPOS_ORDEM.map(t => `<option value="${t}">${TIPO_INFO[t].icon} ${TIPO_INFO[t].label}</option>`).join("");

  const listaNodes = nodes.length ? nodes.map(n => {
    const info = TIPO_INFO[n.tipo] || { icon: "🔗", label: n.tipo };
    return `<div class="node-row">
      <span class="node-tipo">${info.icon} ${info.label}</span>
      <span class="node-rotulo">${n.rotulo}</span>
      <a href="${n.url}" target="_blank" class="node-url">${n.url.length > 45 ? n.url.slice(0,45)+'...' : n.url}</a>
      <form method="POST" action="/admin/funis/remover-node" style="display:inline">
        <input type="hidden" name="node_id" value="${n.id}">
        <input type="hidden" name="slug" value="${slug}">
        <button type="submit" class="btn-del-sm" onclick="return confirm('Remover etapa ${n.rotulo}? Isso também remove as conexões dela.')">✕</button>
      </form>
    </div>`;
  }).join("") : '<div class="empty-hint-sm">Nenhuma etapa cadastrada ainda. Crie a primeira acima.</div>';

  const listaEdges = edges.length ? edges.map(e => {
    const de = nodesById[e.from_node_id], para = nodesById[e.to_node_id];
    if (!de || !para) return "";
    return `<div class="edge-row">
      ${renderChip(de)}<span class="chip-arrow">→</span>${renderChip(para)}
      <form method="POST" action="/admin/funis/remover-edge" style="display:inline;margin-left:auto">
        <input type="hidden" name="edge_id" value="${e.id}">
        <input type="hidden" name="slug" value="${slug}">
        <button type="submit" class="btn-del-sm" onclick="return confirm('Remover essa conexão?')">✕</button>
      </form>
    </div>`;
  }).join("") : '<div class="empty-hint-sm">Nenhuma conexão criada ainda.</div>';

  const caminhos = computarCaminhos(nodes, edges);
  const previaCaminhos = caminhos.length
    ? caminhos.map(renderCaminho).join("")
    : '<div class="empty-hint-sm">Cadastre etapas e conecte-as para ver os caminhos aqui.</div>';

  const msgOk = (() => {
    const q = req.query;
    if (q.ok === "node-add") return '<div class="msg ok">✅ Etapa criada.</div>';
    if (q.ok === "node-rem") return '<div class="msg ok">🗑️ Etapa removida.</div>';
    if (q.ok === "edge-add") return '<div class="msg ok">✅ Conexão criada.</div>';
    if (q.ok === "edge-rem") return '<div class="msg ok">🗑️ Conexão removida.</div>';
    if (q.erro === "sem-etapas") return '<div class="msg err">⚠️ Cadastre pelo menos 2 etapas antes de conectar.</div>';
    if (q.erro === "mesma-etapa") return '<div class="msg err">⚠️ Uma etapa não pode se conectar a ela mesma.</div>';
    return "";
  })();

  res.send(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-
<truncated 44485 bytes>

NOTE: The output was truncated because it was too long. Use a more targeted query or a smaller range to get the information you need.