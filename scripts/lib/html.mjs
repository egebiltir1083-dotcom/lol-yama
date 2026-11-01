import { createHash } from 'node:crypto';

const NAMED = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  rArr: '⇒', rarr: '→', hellip: '…', ndash: '–', mdash: '—',
  rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”'
};

export function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try { return String.fromCodePoint(code); } catch { return m; }
    }
    return Object.prototype.hasOwnProperty.call(NAMED, e) ? NAMED[e] : (NAMED[e.toLowerCase()] ?? m);
  });
}

/** HTML'i, başlık yapısını (#, ##, ###) ve madde işaretlerini koruyan düz metne çevirir. */
export function htmlToText(html) {
  let s = String(html)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|svg|noscript|template)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<(h[1-6])\b[^>]*>/gi, (_, t) => '\n\n' + '#'.repeat(Number(t[1])) + ' ')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|article|h[1-6]|li|ul|ol|tr|blockquote|header|footer|figure|table)\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  s = decodeEntities(s);
  const out = [];
  for (const raw of s.split('\n')) {
    const l = raw.replace(/[ \t\u00a0]+/g, ' ').trim();
    if (l === '' && out[out.length - 1] === '') continue;
    out.push(l);
  }
  return out.join('\n').trim();
}

/** "İlgili Makaleler" bölümünden sonrasını atar; oradaki içerik yama değişmese de değişir. */
export function cutRelated(text) {
  const m = text.match(/\n#{1,6}\s*(İlgili Makaleler|Related Articles)\b/i);
  return m ? text.slice(0, m.index).trim() : text;
}

/** Sayfadaki ilk ISO tarihini (YYYY-MM-DD) döndürür. */
export function extractDate(html) {
  const m = String(html).match(/(20\d\d-\d\d-\d\d)T\d\d:\d\d/);
  return m ? m[1] : null;
}

export function sha(text) {
  return createHash('sha256').update(String(text).replace(/\s+/g, ' ').trim()).digest('hex').slice(0, 16);
}
