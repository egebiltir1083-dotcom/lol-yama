import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { htmlToText, cutRelated, extractDate, sha } from '../scripts/lib/html.mjs';
import { normalizePatch, validatePatch, norm } from '../scripts/lib/validate.mjs';
import { buildHistory, comparePatch } from '../scripts/lib/history.mjs';

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../scripts/update.mjs');

/* ---------------- birim testleri ---------------- */
describe('html', () => {
  const html = `<html><head><script>var a="<h1>gizli</h1>"</script><style>.x{}</style></head><body>
    <h1>26.22 Yama Notları</h1><time datetime="2026-10-27T18:00:00.000Z">x</time>
    <h3>Lee&nbsp;Sin</h3><ul><li>R hasarı: 175 &rArr; 150</li><li>Q &amp; W</li></ul>
    <h2>İlgili Makaleler</h2><ul><li>Eski makale</li></ul></body></html>`;
  test('betik/stil atılır, başlık ve maddeler korunur, varlıklar çözülür', () => {
    const t = htmlToText(html);
    assert.ok(!t.includes('gizli') && !t.includes('.x{}'));
    assert.match(t, /# 26\.22 Yama Notları/);
    assert.match(t, /### Lee Sin/);
    assert.match(t, /- R hasarı: 175 ⇒ 150/);
    assert.match(t, /- Q & W/);
  });
  test('ilgili makaleler kesilir; hash yalnızca asıl içeriğe bağlı', () => {
    const a = cutRelated(htmlToText(html));
    assert.ok(!a.includes('Eski makale'));
    const b = cutRelated(htmlToText(html.replace('Eski makale', 'Tamamen başka makale')));
    assert.equal(sha(a), sha(b));
    assert.notEqual(sha(a), sha(a + ' yama ortası'));
  });
  test('tarih çıkarılır', () => assert.equal(extractDate(html), '2026-10-27'));
});

describe('validate', () => {
  const src = 'R hasarı 175 150, Azir 40 50, Wukong 3,5 5,5 ve 12 15';
  const mk = (changes) => normalizePatch({
    ozet: 'x',
    sv: { sampiyonlar: changes.map((c, i) => ({ id: 'C' + i, ad: 'C' + i, tur: 'buff', degisiklik: c })) }
  });
  test('normalizePatch eksikleri doldurur, bozuk kaydı atar, bilinmeyen turu ayar yapar', () => {
    const p = normalizePatch({ ozet: 'a', sv: { sampiyonlar: [{ id: 'A', ad: 'A', tur: 'Güçlendi', degisiklik: 'x' }, { ad: '', degisiklik: 'y' }, null] } });
    assert.equal(p.sv.sampiyonlar.length, 1);
    assert.equal(p.sv.sampiyonlar[0].tur, 'ayar');
    assert.deepEqual(p.arena.eklentiler, []);
  });
  test('kaynakta olan sayılar geçer', () => {
    const v = validatePatch(mk(['R 175 → 150', 'Mana 40 → 50', 'Can 3,5 → 5,5', 'SG 12 → 15']), src);
    assert.deepEqual(v.errors, []); assert.deepEqual(v.warnings, []);
  });
  test('az sayıda uydurma uyarı olur, çok sayıda uydurma hata olur', () => {
    const few = mk(['R 175 → 150', 'Mana 40 → 50', 'Can 3,5 → 5,5', 'SG 12 → 15', 'A 175 → 150', 'B 175 → 150', 'C 175 → 150', 'D 175 → 150', 'E 175 → 150', 'F 175 → 150', 'G 40 → 50', 'H 40 → 50', 'X 9999 → 1']);
    const v1 = validatePatch(few, src);
    assert.equal(v1.errors.length, 0); assert.equal(v1.warnings.length, 1);
    const many = mk(['1 → 9999', '2 → 8888', '175 → 150', '40 → 50']);
    assert.ok(validatePatch(many, src).errors.some(e => e.includes('sayı uyuşmazlığı')));
  });
  test('çok az şampiyon ve boş özet hata', () => {
    const v = validatePatch(normalizePatch({ sv: { sampiyonlar: [] } }), src);
    assert.equal(v.errors.length, 2);
  });
  test('norm', () => { assert.equal(norm("Bel'Veth"), 'belveth'); assert.equal(norm('Nunu ve Willump'), 'nunuvewillump'); });
});

describe('history', () => {
  test('yama sıralaması ve geçmiş', () => {
    assert.ok(comparePatch('26.9', '26.21') < 0 && comparePatch('27.1', '26.24') > 0);
    const p = (patch, tur) => ({ patch, tarih: '2026-01-01', sv: { sampiyonlar: [{ id: 'Azir', ad: 'Azir', tur, degisiklik: patch }] }, classic: { sampiyonlar: [] }, arena: { sampiyonlar: [{ id: 'Azir', ad: 'Azir', tur: 'buff', degisiklik: 'a' }] } });
    const h = buildHistory([p('26.20', 'nerf'), p('26.22', 'buff'), p('26.21', 'ayar')], 2);
    assert.deepEqual(h.yamalar, ['26.22', '26.21']);
    assert.deepEqual(h.sampiyonlar.Azir.map(e => e.patch + e.mod), ['26.22sv', '26.22arena', '26.21sv', '26.21arena']);
  });
});

/* ---------------- uçtan uca: sahte site + sahte Claude ---------------- */
const CHAMPS = { LeeSin: 'Lee Sin', Azir: 'Azir', MonkeyKing: 'Wukong', Ahri: 'Ahri' };

function makePage(id, { related = 'Eski makale', mid = '' } = {}) {
  const date = id === '26.21' ? '2026-10-20' : '2026-10-27';
  const filler = Array.from({ length: 120 }, (_, i) => `<p>Bu bir deneme paragrafıdır ${i}. Yama ${id} için dolgu metni.</p>`).join('\n');
  return `<!doctype html><html><head><title>${id} Yama Notları</title><script>window.x="<h1>gizli</h1>"</script><style>.a{}</style></head><body>
<h1>${id} Yama Notları</h1><time datetime="${date}T18:00:00.000Z">tarih</time>
<h2>Yamada Öne Çıkanlar</h2>${filler}
<h2>Şampiyonlar</h2>
<h3>Lee Sin</h3><ul><li>R hasarı: 175 &rArr; 150</li></ul>
<h3>Azir</h3><ul><li>Mana büyüme oranı: 40 &rArr; 50</li></ul>
<h3>Wukong</h3><ul><li>Can yenilenmesi: 3,5 &rArr; 5,5</li></ul>
<h2>Eşyalar</h2><h3>Kibir</h3><ul><li>Saldırı gücü: 12 &rArr; 15</li></ul>
<p>Sistem notu: 10 saatlik sınır.</p>${mid}
<h2>İlgili Makaleler</h2><ul><li>${related}</li></ul></body></html>`;
}

function modelOutput(mode) {
  const ch = (id, ad, tur, degisiklik) => ({ id, ad, tur, degisiklik });
  if (mode === 'halluc') {
    return { ozet: 'Uydurma', sv: { sampiyonlar: [ch('LeeSin', 'Lee Sin', 'nerf', 'R 9991 → 9992'), ch('Azir', 'Azir', 'buff', 'Q 9993 → 9994'), ch('MonkeyKing', 'Wukong', 'ayar', 'W 9995 → 9996')], esyalar: [] } };
  }
  return {
    ozet: 'Test özeti', yama_ortasi: [], sistem: ['Test sistem notu 10'],
    sv: {
      sampiyonlar: [ch('LeeSin', 'Lee Sin', 'nerf', 'R hasarı 175 → 150'), ch('Azir', 'azir', 'buff', 'Mana büyümesi 40 → 50'), ch('monkeyking', 'wukong', 'ayar', 'Can yenilenmesi 3,5 → 5,5')],
      esyalar: [{ ad: 'Kibir', tur: 'ayar', degisiklik: 'SG 12 → 15' }]
    },
    arena: { sampiyonlar: [ch('LeeSin', 'Lee Sin', 'buff', 'E oranı 175 → 150')], esyalar: [], eklentiler: [] }
  };
}

let server, base;
const S = { pages: {}, mode: 'ok', badOnce: false, calls: 0, siteDown: false };

before(async () => {
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const send = (code, body, type = 'application/json') => { res.writeHead(code, { 'content-type': type }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };
    const m = url.pathname.match(/league-of-legends-patch-(\d+)-(\d+)-notes/);
    if (m) {
      if (S.siteDown) return send(500, 'hata', 'text/plain');
      const page = S.pages[`${m[1]}.${m[2]}`];
      return page ? send(200, page, 'text/html; charset=utf-8') : send(404, 'yok', 'text/plain');
    }
    if (url.pathname === '/api/versions.json') return send(200, ['16.21.1']);
    if (url.pathname.endsWith('/champion.json')) return send(200, { data: Object.fromEntries(Object.entries(CHAMPS).map(([id, name]) => [id, { id, name }])) });
    if (url.pathname === '/v1/messages') {
      let body = ''; for await (const c of req) body += c;
      S.calls++;
      if (req.headers['x-api-key'] !== 'test-key') return send(401, { error: 'anahtar' });
      if (S.badOnce) { S.badOnce = false; return send(200, { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Bu JSON değil' }] }); }
      const sent = JSON.parse(body);
      assert.ok(sent.messages[0].content.includes('<yama_notu>'));
      return send(200, { stop_reason: 'end_turn', content: [{ type: 'text', text: '```json\n' + JSON.stringify(modelOutput(S.mode)) + '\n```' }] });
    }
    send(404, 'bilinmiyor', 'text/plain');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.closeAllConnections?.(); server.close(); });

function run(dir, args = [], extra = {}) {
  return new Promise(resolve => {
    execFile(process.execPath, [SCRIPT, ...args], {
      env: { ...process.env, DATA_DIR: dir, SOURCE_ORIGIN: base, DDRAGON_ORIGIN: base, ANTHROPIC_BASE_URL: base, ANTHROPIC_API_KEY: 'test-key', RETRY_DELAY_MS: '0', FAKE_NOW: '2026-11-01T12:00:00Z', ...extra }
    }, (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }));
  });
}
const rj = async (dir, f) => JSON.parse(await readFile(path.join(dir, f), 'utf8'));
const tmp = () => mkdtemp(path.join(os.tmpdir(), 'yama-'));

describe('uçtan uca', () => {
  let dir;
  before(async () => { dir = await tmp(); S.pages = { '26.21': makePage('26.21'), '26.22': makePage('26.22') }; });

  test('1) sıfırdan başlangıç: 26.21 + keşfedilen 26.22 işlenir', async () => {
    const r = await run(dir);
    assert.equal(r.code, 0, r.stderr + r.stdout);
    assert.equal(S.calls, 2);
    const idx = await rj(dir, 'index.json');
    assert.equal(idx.guncel, '26.22');
    assert.deepEqual(idx.yamalar.map(y => y.patch), ['26.22', '26.21']);
    const latest = await rj(dir, 'latest.json');
    assert.equal(latest.patch, '26.22'); assert.equal(latest._meta, undefined);
    assert.equal(latest.tarih, '2026-10-27');
    assert.match(latest.kaynak, /patch-26-22-notes/);
    // id/ad Data Dragon'a göre düzeltilir
    assert.deepEqual(latest.sv.sampiyonlar.map(c => [c.id, c.ad]), [['LeeSin', 'Lee Sin'], ['Azir', 'Azir'], ['MonkeyKing', 'Wukong']]);
    const hist = await rj(dir, 'history.json');
    assert.deepEqual(hist.sampiyonlar.LeeSin.map(e => `${e.patch}/${e.mod}`), ['26.22/sv', '26.22/arena', '26.21/sv', '26.21/arena']);
    assert.deepEqual((await readdir(path.join(dir, 'patches'))).sort(), ['26.21.json', '26.22.json']);
  });

  let indexBytes;
  test('2) değişiklik yoksa Claude çağrılmaz, dosyalar aynı kalır', async () => {
    indexBytes = await readFile(path.join(dir, 'index.json'), 'utf8');
    const before = S.calls;
    const r = await run(dir);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(S.calls, before);
    assert.equal(await readFile(path.join(dir, 'index.json'), 'utf8'), indexBytes);
  });

  test('3) yalnızca "İlgili Makaleler" değişirse yeniden işlenmez', async () => {
    S.pages['26.22'] = makePage('26.22', { related: 'Bambaşka yeni makale' });
    const before = S.calls;
    assert.equal((await run(dir)).code, 0);
    assert.equal(S.calls, before);
  });

  test('4) yama ortası güncelleme: sayfa içeriği değişince yeniden işlenir, hash güncellenir', async () => {
    const oldHash = (await rj(dir, 'index.json')).yamalar[0].hash;
    S.pages['26.22'] = makePage('26.22', { mid: '<h2>Yama Ortası Güncellemeleri</h2><p>30 Ekim: Varus düzeltmesi.</p>' });
    const before = S.calls;
    const r = await run(dir);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(S.calls, before + 1);
    const idx = await rj(dir, 'index.json');
    assert.notEqual(idx.yamalar[0].hash, oldHash);
    assert.equal(idx.guncelleme, '2026-11-01T12:00:00.000Z');
  });

  test('5) uydurma sayılı çıktı reddedilir: çıkış kodu 1, hiçbir dosya değişmez', async () => {
    S.pages['26.23'] = makePage('26.23'); S.mode = 'halluc';
    const before = S.calls;
    const r = await run(dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /sayı uyuşmazlığı/);
    assert.equal(S.calls, before + 2); // 2 deneme
    assert.ok(!existsSync(path.join(dir, 'patches', '26.23.json')));
    assert.equal((await rj(dir, 'index.json')).guncel, '26.22');
    S.mode = 'ok';
  });

  test('6) bozuk JSON gelirse bir kez yeniden dener ve başarır', async () => {
    S.badOnce = true;
    const before = S.calls;
    const r = await run(dir);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(S.calls, before + 2);
    assert.equal((await rj(dir, 'index.json')).guncel, '26.23');
  });

  test('7) kaynak site çökmüşse çıkış kodu 1 ve veri bozulmaz', async () => {
    S.siteDown = true;
    const snapshot = await readFile(path.join(dir, 'index.json'), 'utf8');
    const r = await run(dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /HTTP 500/);
    assert.equal(await readFile(path.join(dir, 'index.json'), 'utf8'), snapshot);
    S.siteDown = false;
  });

  test('8) API anahtarı yoksa anlaşılır hata verir', async () => {
    const d = await tmp();
    const r = await run(d, [], { ANTHROPIC_API_KEY: '' });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /ANTHROPIC_API_KEY/);
  });

  test('9) --backfill: boş klasörde başlangıç yamasından geriye doğru tamamlar', async () => {
    delete S.pages['26.23'];
    const d = await tmp();
    const r = await run(d, ['--backfill', '2'], { START_PATCH: '26.22' });
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual((await readdir(path.join(d, 'patches'))).sort(), ['26.21.json', '26.22.json']);
    assert.equal((await rj(d, 'index.json')).guncel, '26.22');
  });

  test('10) --rebuild ağ kullanmadan dosyaları yeniden üretir; geçersiz --patch reddedilir', async () => {
    const r = await run(dir, ['--rebuild'], { SOURCE_ORIGIN: 'http://127.0.0.1:1' });
    assert.equal(r.code, 0, r.stderr);
    const bad = await run(dir, ['--patch', '26.22; rm -rf /']);
    assert.equal(bad.code, 1);
    assert.match(bad.stderr, /Geçersiz yama numarası/);
  });
});
