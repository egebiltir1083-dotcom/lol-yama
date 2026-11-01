const parse = s => String(s).split('.').map(Number);

/** "26.9" < "26.21" < "27.1" sıralaması için karşılaştırma. */
export function comparePatch(a, b) {
  const [am, an] = parse(a), [bm, bn] = parse(b);
  return am - bm || an - bn;
}

/** Son `limit` yamadan, şampiyon kimliğine göre değişiklik geçmişi üretir (yeniden eskiye). */
export function buildHistory(patches, limit = 12) {
  const sorted = [...patches].sort((a, b) => comparePatch(b.patch, a.patch)).slice(0, limit);
  const out = { surum: 1, yamalar: sorted.map(p => p.patch), sampiyonlar: {} };
  for (const p of sorted) {
    for (const mod of ['sv', 'classic', 'arena']) {
      for (const e of (p[mod] && p[mod].sampiyonlar) || []) {
        if (!e.id) continue;
        (out.sampiyonlar[e.id] ||= []).push({ patch: p.patch, tarih: p.tarih, mod, tur: e.tur, ad: e.ad, degisiklik: e.degisiklik });
      }
    }
  }
  return out;
}
