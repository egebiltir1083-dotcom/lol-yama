export const TURLER = ['buff', 'nerf', 'ayar', 'yeni'];
export const MODLAR = ['sv', 'classic', 'arena'];

const arr = v => (Array.isArray(v) ? v : []);
const str = v => (typeof v === 'string' ? v.trim() : '');

export function norm(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/ı/g, 'i').replace(/[^a-z0-9]/g, '');
}

/** Modelin ürettiği ham nesneyi şemaya oturtur: eksik alanları doldurur, bozuk kayıtları atar, bilinmeyen "tur" değerini "ayar" yapar. */
export function normalizePatch(raw) {
  const p = raw && typeof raw === 'object' ? raw : {};
  const tur = t => (TURLER.includes(str(t)) ? str(t) : 'ayar');
  const entry = (e, champ) => {
    e = e && typeof e === 'object' ? e : {};
    return { ...(champ ? { id: str(e.id) } : {}), ad: str(e.ad), tur: tur(e.tur), degisiklik: str(e.degisiklik) };
  };
  const entries = (list, champ) => arr(list).map(e => entry(e, champ)).filter(e => e.ad && e.degisiklik);
  const strs = list => arr(list).map(str).filter(Boolean);
  const sv = p.sv || {}, cl = p.classic || {}, ar = p.arena || {}, aram = p.aram_samata || {};
  return {
    patch: str(p.patch), tarih: str(p.tarih), ozet: str(p.ozet), kaynak: str(p.kaynak),
    yama_ortasi: strs(p.yama_ortasi),
    sistem: strs(p.sistem),
    sv: { sampiyonlar: entries(sv.sampiyonlar, true), esyalar: entries(sv.esyalar, false) },
    aram_samata: {
      ozet: str(aram.ozet), not: str(aram.not),
      yeni_eklentiler: strs(aram.yeni_eklentiler), kaldirilan_eklentiler: strs(aram.kaldirilan_eklentiler)
    },
    classic: { not: str(cl.not), sampiyonlar: entries(cl.sampiyonlar, true), esyalar: entries(cl.esyalar, false) },
    arena: { sampiyonlar: entries(ar.sampiyonlar, true), esyalar: entries(ar.esyalar, false), eklentiler: entries(ar.eklentiler, false) },
    yeni_skinler: strs(p.yeni_skinler),
    hata_duzeltmeleri: strs(p.hata_duzeltmeleri)
  };
}

const numbers = t => (String(t).match(/\d+(?:[.,]\d+)?/g) || []).map(n => n.replace('.', ','));

function* allEntries(p) {
  for (const mod of MODLAR) {
    for (const e of p[mod].sampiyonlar) yield { yer: `${mod}.sampiyonlar`, e };
    for (const e of p[mod].esyalar) yield { yer: `${mod}.esyalar`, e };
  }
  for (const e of p.arena.eklentiler) yield { yer: 'arena.eklentiler', e };
}

/**
 * Doğrulama. Hata (errors) varsa yama yazılmaz.
 * Sayı kontrolü: değişiklik metnindeki her sayı kaynak yama notunda geçmeli.
 * Bu, modelin sayı uydurmasına karşı kaba ama ucuz bir güvenlik ağıdır; sayıların doğru yere bağlandığını doğrulamaz.
 */
export function validatePatch(p, source, { minSv = 3, maxRatio = 0.15 } = {}) {
  const errors = [], warnings = [], flagged = [];
  if (!p.ozet) errors.push('ozet boş');
  if (p.sv.sampiyonlar.length < minSv) errors.push(`sv.sampiyonlar çok az (${p.sv.sampiyonlar.length} < ${minSv})`);

  const src = new Set(numbers(source));
  let total = 0;
  for (const { yer, e } of allEntries(p)) {
    total++;
    const bad = numbers(e.degisiklik).filter(n => !src.has(n));
    if (bad.length) flagged.push({ yer, ad: e.ad, sayilar: [...new Set(bad)] });
  }
  if (total && flagged.length / total > maxRatio) {
    errors.push(`sayı uyuşmazlığı yüksek: ${flagged.length}/${total} kayıt kaynak metinde olmayan sayı içeriyor (örn. ${flagged[0].ad}: ${flagged[0].sayilar.join(', ')})`);
  } else {
    for (const f of flagged) warnings.push(`${f.yer} / ${f.ad}: kaynakta olmayan sayı ${f.sayilar.join(', ')}`);
  }
  return { errors, warnings, flagged };
}
