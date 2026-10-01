// Story helpers for scripts/write.mjs: the fact check and the Markdown file. No I/O.

// Words a careful writer may capitalise without the source saying them.
const ALLOWED = new Set(['AI', 'API', 'APIs', 'GPU', 'GPUs', 'CPU', 'LLM', 'LLMs', 'HN', 'X', 'I', 'US', 'UK', 'EU',
  'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday', 'January', 'February', 'March',
  'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December', 'Hacker', 'News']);

const norm = (s) => s.toLowerCase().replace(/(\d),(\d)/g, '$1$2');

// Numbers and proper names in a story body that its source text never mentions. A name is a
// capitalised word that doesn't start a sentence; a number is any figure ("40%", "1.4T", "2,000").
// ponytail: string matching, so "three" vs "3" is flagged; write.mjs asks for one rewrite before dropping.
export function unsupported(body, source) {
  const text = body.replace(/\]\([^)]*\)/g, ']').replace(/`[^`]*`/g, ''); // link targets and code aren't claims
  const hay = norm(source);
  const missing = new Set();
  for (const [n] of text.matchAll(/\d[\d,]*(?:\.\d+)?/g)) {
    if (!hay.includes(norm(n))) missing.add(n);
  }
  // mid-sentence only: after a word, comma or closing quote and a space, never after . ! ? : or a line start
  for (const [name] of text.matchAll(/(?<=[\p{L}\p{N},;)'"’”*]\s+)[A-Z][\p{L}\p{N}]*(?:[-.][\p{L}\p{N}]+)*/gu)) {
    if (!ALLOWED.has(name) && !hay.includes(name.toLowerCase())) missing.add(name);
  }
  return [...missing];
}

export const slugify = (s) => s.toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim()
  .replace(/[\s_]+/g, '-').replace(/-+/g, '-').slice(0, 60).replace(/-$/, '') || 'story';

// The front matter src/content.config.ts validates; JSON strings are valid YAML scalars.
// Reads a story file back: values are JSON where they look like it (quoted strings, arrays, numbers,
// booleans, null), bare words otherwise (source: hn). Enough for the files this project writes.
export function readStory(md) {
  const [, head = '', body = ''] = md.replace(/\r\n/g, '\n').match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/) ?? [];
  const data = {};
  for (const [, k, v] of head.matchAll(/^(\w+):\s*(.*)$/gm)) {
    try { data[k] = JSON.parse(v); } catch { data[k] = v.trim(); }
  }
  return { data, body: body.trim() };
}

export function storyFile(d, body) {
  const fields = ['date', 'title', 'authors', 'url', 'discuss_url', 'source', 'section', 'interest_score',
    'recommended', 'must_read', 'why_read', 'summary', 'image', 'sample'];
  return `---\n${fields.map((k) => `${k}: ${JSON.stringify(d[k])}`).join('\n')}\n---\n\n${body.trim()}\n`;
}
