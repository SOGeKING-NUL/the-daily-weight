// HTML to readable text, shared by the terminal reader (bin/daily-weight.mjs) and the
// pipeline (scripts/fetch.mjs, scripts/write.mjs). No dependencies.

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…',
  rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', middot: '·', copy: '©' };
export const decode = (s) => s.replace(/&(#x[\da-f]+|#\d+|\w+);/gi, (m, e) => {
  if (e[0] !== '#') return NAMED[e.toLowerCase()] ?? m;
  try { return String.fromCodePoint(/^#x/i.test(e) ? parseInt(e.slice(2), 16) : Number(e.slice(1))); } catch { return m; }
});

// HTML fragment to plain text with paragraph breaks kept.
export const htmlText = (html = '') => decode(html
  .replace(/<\s*(br)\s*\/?>/gi, '\n').replace(/<\/?\s*p\b[^>]*>/gi, '\n\n').replace(/<[^>]+>/g, ''))
  .replace(/[ \t]+/g, ' ').replace(/\n[ \t]+/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

// Readable text from an article page: the <article> (or <main>) without navigation, scripts and
// page furniture, as headings, paragraphs, list items, quotes and code. Deliberately simple.
export function extractArticle(html) {
  const h = html.replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|svg|nav|header|footer|aside|form|iframe|button|select|template)\b[\s\S]*?<\/\1\s*>/gi, '');
  const scope = h.match(/<article\b[^>]*>([\s\S]*)<\/article>/i)?.[1] ?? h.match(/<main\b[^>]*>([\s\S]*)<\/main>/i)?.[1]
    ?? h.match(/<body\b[^>]*>([\s\S]*)<\/body>/i)?.[1] ?? h;
  const blocks = [];
  for (const m of scope.matchAll(/<(h[1-4]|p|li|pre|blockquote)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi)) {
    const tag = m[1].toLowerCase();
    const text = tag === 'pre'
      ? decode(m[2].replace(/<[^>]+>/g, '')).replace(/\s+$/, '')
      : decode(m[2].replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
    if (!text || (tag === 'p' && text.length < 30 && !/[.!?:]$/.test(text))) continue;
    if (blocks.at(-1)?.text === text) continue;
    blocks.push({ tag, text });
    if (blocks.length >= 400) break;
  }
  return blocks;
}

export const pageTitle = (html) => decode(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '').trim();
