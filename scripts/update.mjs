#!/usr/bin/env node
/**
 * Yeni LoL yama notlarını bulur, Claude ile Türkçe/sınıflandırılmış JSON'a çevirir ve data/ klasörüne yazar.
 *
 *   node scripts/update.mjs                  normal çalışma (yeni yama + yama ortası güncelleme kontrolü)
 *   node scripts/update.mjs --backfill 5     toplam 5 yamalık geçmiş oluştur
 *   node scripts/update.mjs --patch 26.22    belirli yamayı zorla yeniden işle
 *   node scripts/update.mjs --rebuild        ağ kullanmadan index/latest/history dosyalarını yeniden üret
 */
import { readFile, writeFile, readdir, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { htmlToText, cutRelated, extractDate, sha } from './lib/html.mjs';
import { SYSTEM, buildUser } from './lib/prompt.mjs';
import { normalizePatch, validatePatch, norm, MODLAR } from './lib/validate.mjs';
import { buildHistory, comparePatch } from './lib/history.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = process.env;
const cfg = {
  dataDir: env.DATA_DIR || path.join(ROOT, 'data'),
  source: (env.SOURCE_ORIGIN || 'https://www.leagueoflegends.com').replace(/\/$/, ''),
  ddragon: (env.DDRAGON_ORIGIN || 'https://ddragon.leagueoflegends.com').replace(/\/$/, ''),
  api: (env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/$/, ''),
  model: env.CLAUDE_MODEL || 'claude-sonnet-5-5',
  apiKey: env.ANTHROPIC_API_KEY || '',
  start: env.START_PATCH || '26.21',
  retryDelay: Number(env.RETRY_DELAY_MS ?? 4000),
  recheckDays: 14,
  heartbeatDays: 7,
  historyLimit: 12,
  now: env.FAKE_NOW ? new Date(env.FAKE_NOW) : new Date()
};
const UA = 'lol-yama-data/1.0 (personal patch-note summary project; a few requests per hour)'; // HTTP başlıkları yalnızca ASCII kabul eder
const patchesDir = path.join(cfg.dataDir, 'patches');
const log = (...a) => console.log(...a);
const warn = (...a) => console.warn('UYARI:', ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fatal = msg => Object.assign(new Error(msg), { fatal: true });
const PATCH_RE = /^\d{1,3}\.\d{1,3}$/;

/* ---------- dosya yardımcıları ---------- */
async function readJson(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}
async function writeJson(file, obj) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  await writeFile(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  await rename(tmp, file);
}
async function loadKnown() {
  const known = new Map();
  let files = [];
  try { files = await readdir(patchesDir); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  for (const f of files) {
    const m = f.match(/^(\d+\.\d+)\.json$/);
    if (m) known.set(m[1], await readJson(path.join(patchesDir, f)));
  }
  return known;
}
const savePatch = p => writeJson(path.join(patchesDir, `${p.patch}.json`), p);

/* ---------- kaynak sayfa ---------- */
async function fetchText(url) {
  const res = await fetch(url, { headers: { 'user-agent': UA, 'accept-language': 'tr-TR,tr;q=0.9' }, signal: AbortSignal.timeout(60000), redirect: 'follow' });
  if (res.status === 404 || res.status === 410) return null;
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.text();
}

/** Yama sayfasını döndürür; sayfa yoksa (henüz çıkmamış) null. Sayfa var ama içerik çıkarılamıyorsa hata fırlatır. */
async function getPatchPage(id) {
  const [M, m] = id.split('.');
  const url = `${cfg.source}/tr-tr/news/game-updates/league-of-legends-patch-${M}-${m}-notes/`;
  const html = await fetchText(url);
  if (html == null) return null;
  const text = cutRelated(htmlToText(html));
  if (!text.includes(id)) return null; // 404 sayfası gibi davranan, bu yamayı anmayan sayfa
  if (text.length < 6000) throw new Error(`${id} sayfası alındı ama içerik çıkarılamadı (${text.length} karakter). Sayfa tarayıcıda oluşuyor olabilir.`);
  return { patch: id, url, text, tarih: extractDate(html), hash: sha(text) };
}

const nextCandidates = id => { const [M, m] = id.split('.').map(Number); return [`${M}.${m + 1}`, `${M}.${m + 2}`, `${M + 1}.1`]; };

/* ---------- Data Dragon ---------- */
async function loadChampions() {
  try {
    const opts = { signal: AbortSignal.timeout(30000) };
    const versions = await (await fetch(`${cfg.ddragon}/api/versions.json`, opts)).json();
    const data = await (await fetch(`${cfg.ddragon}/cdn/${versions[0]}/data/tr_TR/champion.json`, opts)).json();
    return new Map(Object.values(data.data).map(c => [c.id, { id: c.id, name: c.name }]));
  } catch (e) {
    warn('Data Dragon şampiyon listesi alınamadı; kimlikler modelin tahminine kalacak:', e.message);
    return new Map();
  }
}

function resolveIds(p, champs, warnings) {
  const byNorm = new Map();
  for (const c of champs.values()) { byNorm.set(norm(c.id), c); byNorm.set(norm(c.name), c); }
  for (const mod of MODLAR) {
    for (const e of p[mod].sampiyonlar) {
      const c = champs.get(e.id) || byNorm.get(norm(e.id)) || byNorm.get(norm(e.ad));
      if (c) { e.id = c.id; e.ad = c.name; }
      else {
        if (champs.size) warnings.push(`şampiyon eşleşmedi: ${e.ad} (${e.id})`);
        e.id = e.id || e.ad.replace(/[^A-Za-z]/g, '');
      }
    }
  }
}

/* ---------- Claude ---------- */
async function callClaude(user) {
  if (!cfg.apiKey) throw fatal('ANTHROPIC_API_KEY tanımlı değil (GitHub → Settings → Secrets → Actions).');
  let last;
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(`${cfg.api}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': cfg.apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: cfg.model, max_tokens: 24000, system: SYSTEM, messages: [{ role: 'user', content: user }] }),
        signal: AbortSignal.timeout(300000)
      });
      if (res.status === 429 || res.status >= 500) last = new Error(`Claude API ${res.status}`);
      else if (!res.ok) throw fatal(`Claude API ${res.status}: ${(await res.text()).slice(0, 300)}`);
      else {
        const j = await res.json();
        if (j.stop_reason === 'max_tokens') throw new Error('Yanıt max_tokens sınırında kesildi');
        return (j.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
      }
    } catch (e) {
      if (e.fatal) throw e;
      last = e;
    }
    await sleep(cfg.retryDelay * (i + 1));
  }
  throw last;
}

function parseJson(t) {
  const s = String(t).replace(/^\s*```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b < a) throw new Error('Yanıtta JSON bulunamadı');
  try { return JSON.parse(s.slice(a, b + 1)); } catch (e) { throw new Error('JSON ayrıştırılamadı: ' + e.message); }
}

async function processPatch(page, champs) {
  let hata = '';
  for (let attempt = 1; attempt <= 2; attempt++) {
    const user = buildUser({ patch: page.patch, tarih: page.tarih, text: page.text, champs: [...champs.values()], hata });
    let raw;
    try {
      raw = parseJson(await callClaude(user));
    } catch (e) {
      if (e.fatal || attempt === 2) throw e;
      hata = e.message; warn(`${page.patch}: deneme ${attempt} başarısız (${hata})`); continue;
    }
    const p = normalizePatch(raw);
    p.patch = page.patch;
    p.kaynak = page.url;
    p.tarih = page.tarih || cfg.now.toISOString().slice(0, 10);
    const idWarnings = [];
    resolveIds(p, champs, idWarnings);
    const v = validatePatch(p, page.text);
    if (v.errors.length) {
      hata = v.errors.join('; ');
      if (attempt === 2) throw new Error('Doğrulama başarısız: ' + hata);
      warn(`${page.patch}: deneme ${attempt} reddedildi (${hata})`); continue;
    }
    const uyarilar = [...idWarnings, ...v.warnings];
    uyarilar.forEach(u => warn(`${page.patch}: ${u}`));
    p._meta = { kaynak_hash: page.hash, islendi: cfg.now.toISOString(), model: cfg.model, uyarilar };
    return p;
  }
}

/* ---------- index / latest / history ---------- */
async function rebuildAll() {
  const known = await loadKnown();
  const list = [...known.values()].sort((a, b) => comparePatch(b.patch, a.patch));
  if (!list.length) { log('Kayıtlı yama yok; indeks yazılmadı.'); return false; }
  const idxOld = await readJson(path.join(cfg.dataDir, 'index.json'));
  const core = {
    surum: 1,
    guncel: list[0].patch,
    yamalar: list.map(p => ({ patch: p.patch, tarih: p.tarih, dosya: `patches/${p.patch}.json`, hash: (p._meta && p._meta.kaynak_hash) || null }))
  };
  const oldCore = idxOld ? { surum: idxOld.surum, guncel: idxOld.guncel, yamalar: idxOld.yamalar } : null;
  const changed = JSON.stringify(core) !== JSON.stringify(oldCore);
  const nowIso = cfg.now.toISOString();
  const stale = !idxOld || !idxOld.son_kontrol || (cfg.now - new Date(idxOld.son_kontrol)) / 864e5 > cfg.heartbeatDays;
  // Zaman damgaları yalnızca bir şey değişince ya da haftada bir güncellenir; böylece repo gereksiz commit almaz ama zamanlanmış iş "etkin" kalır.
  const index = { ...core, guncelleme: changed ? nowIso : (idxOld.guncelleme || nowIso), son_kontrol: changed || stale ? nowIso : idxOld.son_kontrol };
  const strip = ({ _meta, ...rest }) => rest;
  await writeJson(path.join(cfg.dataDir, 'index.json'), index);
  await writeJson(path.join(cfg.dataDir, 'latest.json'), strip(list[0]));
  await writeJson(path.join(cfg.dataDir, 'history.json'), buildHistory(list, cfg.historyLimit));
  log(`İndeks: ${list.length} yama, güncel ${list[0].patch}${changed ? ' (değişti)' : ''}`);
  return changed;
}

/* ---------- ana akış ---------- */
function parseArgs(argv) {
  const a = { backfill: 0, patch: '', rebuild: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--backfill') a.backfill = Number(argv[++i]) || 0;
    else if (argv[i] === '--patch') a.patch = argv[++i] || '';
    else if (argv[i] === '--rebuild') a.rebuild = true;
  }
  if (a.patch && !PATCH_RE.test(a.patch)) throw new Error(`Geçersiz yama numarası: ${a.patch}`);
  a.backfill = Math.min(Math.max(a.backfill, 0), 30);
  return a;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.rebuild) { await rebuildAll(); return; }

  const known = await loadKnown();
  const ids = [...known.keys()].sort(comparePatch);
  const todo = new Map();

  if (args.patch) {
    const pg = await getPatchPage(args.patch);
    if (!pg) throw new Error(`${args.patch} yama sayfası bulunamadı`);
    todo.set(args.patch, pg);
  } else {
    // 1) Yukarı keşif: bilinen en yeni yamadan sonrasını dene
    const baseline = ids.length ? ids[ids.length - 1] : cfg.start;
    if (!known.has(baseline)) {
      const pg = await getPatchPage(baseline);
      if (!pg) throw new Error(`Başlangıç yaması ${baseline} sayfası bulunamadı`);
      todo.set(baseline, pg);
    }
    let cur = baseline;
    for (let i = 0; i < 6; i++) {
      let found = null;
      for (const cand of nextCandidates(cur)) { found = await getPatchPage(cand); if (found) break; }
      if (!found) break;
      log(`Yeni yama bulundu: ${found.patch}`);
      todo.set(found.patch, found);
      cur = found.patch;
    }

    // 2) Yama ortası güncelleme: son iki yamanın sayfası değiştiyse yeniden işle
    for (const id of ids.slice(-2)) {
      const p = known.get(id);
      const ageDays = p.tarih ? (cfg.now - new Date(p.tarih)) / 864e5 : 0;
      if (ageDays > cfg.recheckDays) continue;
      let pg;
      try { pg = await getPatchPage(id); } catch (e) { warn(`${id} yeniden kontrol edilemedi: ${e.message}`); continue; }
      if (!pg) { warn(`${id} sayfası artık bulunamıyor`); continue; }
      const old = p._meta && p._meta.kaynak_hash;
      if (!old) {
        p._meta = { ...(p._meta || {}), kaynak_hash: pg.hash };
        await savePatch(p);
        log(`${id}: kaynak özeti kaydedildi (ilk kez).`);
      } else if (old !== pg.hash) {
        log(`${id}: yama notu değişmiş (yama ortası güncelleme), yeniden işlenecek.`);
        todo.set(id, pg);
      }
    }

    // 3) Geçmiş doldurma: toplam N yamaya tamamla
    if (args.backfill) {
      const have = new Set([...known.keys(), ...todo.keys()]);
      let cur2 = [...have].sort(comparePatch)[0];
      let misses = 0;
      while (have.size < args.backfill && misses < 3) {
        const [M, m] = cur2.split('.').map(Number);
        if (m <= 1) break;
        const cand = `${M}.${m - 1}`;
        cur2 = cand;
        const pg = await getPatchPage(cand);
        if (!pg) { misses++; continue; }
        misses = 0; have.add(cand); todo.set(cand, pg);
      }
    }
  }

  let failed = 0;
  if (todo.size) {
    const champs = await loadChampions();
    for (const id of [...todo.keys()].sort(comparePatch)) {
      try {
        log(`İşleniyor: ${id} (${todo.get(id).text.length} karakter)`);
        const p = await processPatch(todo.get(id), champs);
        await savePatch(p);
        log(`✓ ${id} kaydedildi: SV ${p.sv.sampiyonlar.length}, Classic ${p.classic.sampiyonlar.length}, Arena ${p.arena.sampiyonlar.length} şampiyon`);
      } catch (e) {
        failed++;
        console.error(`✗ ${id}: ${e.message}`);
      }
    }
  } else {
    log('Yeni yama ya da değişiklik yok.');
  }
  await rebuildAll();
  if (failed) process.exitCode = 1;
}

main().catch(e => { console.error('HATA:', e.message); process.exit(1); });
