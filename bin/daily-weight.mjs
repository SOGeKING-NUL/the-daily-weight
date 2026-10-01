#!/usr/bin/env node
// The Daily Weight in the terminal: a three-pane reader (sidebar, story list, article).
// No dependencies: Node's readline for keys, ANSI escapes for drawing.
//
//   node bin/daily-weight.mjs                        reads http://localhost:4321 (npm run dev)
//   node bin/daily-weight.mjs https://your.domain    reads the published paper
//   DAILY_WEIGHT_URL=https://your.domain node bin/daily-weight.mjs
//
// Read and marked stories are remembered in ~/.daily-weight.json.
//
// Testing without a terminal: --snapshot prints one frame and exits, after replaying --keys.
//   node bin/daily-weight.mjs --snapshot --size 120x34 --keys "jj\tj"

import readline from 'node:readline';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { extractArticle, htmlText, pageTitle } from '../scripts/lib/article.mjs';

const ARGS = process.argv.slice(2);
const opt = (name) => { const i = ARGS.indexOf(name); return i >= 0 ? ARGS[i + 1] : undefined; };
const SITE = (ARGS.find((a) => /^https?:\/\//.test(a))
  ?? process.env.DAILY_WEIGHT_URL ?? 'http://localhost:4321').replace(/\/$/, '');
const SNAPSHOT = ARGS.includes('--snapshot');
if (SNAPSHOT) {
  const [c, r] = (opt('--size') ?? '120x34').split('x').map(Number);
  Object.assign(process.stdout, { columns: c, rows: r });
}

// ---------- persistent state ----------

const STATE_FILE = join(homedir(), '.daily-weight.json');
const state = (() => {
  if (SNAPSHOT) return {}; // snapshots start clean and never touch the real file
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
})();
state.read ??= {};
state.marked ??= {};
const save = () => { if (!SNAPSHOT) try { writeFileSync(STATE_FILE, JSON.stringify(state)); } catch {} };
const idOf = (s) => `${s.date}/${s.slug}`;

// ---------- data ----------

async function getJSON(path) {
  const res = await fetch(SITE + path);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${SITE}${path}`);
  return res.json();
}
const editionCache = new Map();
const loadEdition = async (date) => {
  if (!editionCache.has(date)) editionCache.set(date, await getJSON(`/edition/${date}.json`));
  return editionCache.get(date);
};

const SECTIONS = { models: 'Models', agents: 'Agents', infra: 'Infra', research: 'Research', safety: 'Safety', industry: 'Industry' };
const SOURCES = { hn: 'HN', reddit: 'Reddit', x: 'X', labs: 'Labs', arxiv: 'arXiv', github: 'GitHub', press: 'Press' };

// ---------- drawing primitives ----------

const ESC = '\x1b[';
// 24-bit colour where the terminal says it has it (Windows Terminal, iTerm2, kitty, most Linux
// terminals set COLORTERM); otherwise the nearest of the 256 standard colours, so macOS
// Terminal.app and older terminals get close colours instead of wrong ones.
const TRUECOLOR = /truecolor|24bit/i.test(process.env.COLORTERM ?? '') || !!process.env.WT_SESSION
  || process.env.TERM_PROGRAM === 'vscode' || (process.platform === 'win32' && process.env.TERM_PROGRAM !== 'mintty');
const to256 = (r, g, b) => 16 + 36 * Math.round(r / 51) + 6 * Math.round(g / 51) + Math.round(b / 51);
const fg = (r, g, b) => (TRUECOLOR ? `${ESC}38;2;${r};${g};${b}m` : `${ESC}38;5;${to256(r, g, b)}m`);
const bg = (r, g, b) => (TRUECOLOR ? `${ESC}48;2;${r};${g};${b}m` : `${ESC}48;5;${to256(r, g, b)}m`);
const RESET = `${ESC}0m`, BOLD = `${ESC}1m`, ITALIC = `${ESC}3m`;

// Palette: Catppuccin Mocha pastels, the look of eilmeldung. The app paints its own background,
// so it looks the same on light and dark terminal themes.
const P = {
  base: [30, 30, 46], panel: [37, 37, 56], surface: [49, 50, 68], surface1: [69, 71, 90], overlay: [108, 112, 134],
  text: [205, 214, 244], subtext: [166, 173, 200], lavender: [180, 190, 254], blue: [137, 180, 250],
  teal: [148, 226, 213], green: [166, 227, 161], yellow: [249, 226, 175], peach: [250, 179, 135],
  red: [243, 139, 168], mauve: [203, 166, 247], pink: [245, 194, 231],
};
const T = {
  ink: fg(...P.text), muted: fg(...P.subtext), faint: fg(...P.overlay), accent: fg(...P.lavender),
  red: fg(...P.red), gold: fg(...P.yellow), rule: fg(...P.surface1),
  pane: bg(...P.base) + fg(...P.text), panel: bg(...P.panel) + fg(...P.text),
  selFocus: bg(...P.lavender) + fg(...P.base), selBlur: bg(...P.surface1) + fg(...P.text),
  statusBar: bg(...P.lavender) + fg(...P.base), search: bg(...P.yellow) + fg(...P.base),
};
const CHIP = {
  models: P.blue, agents: P.teal, infra: P.peach, research: P.mauve, safety: P.red, industry: P.green,
  hn: P.peach, reddit: P.red, labs: P.lavender, arxiv: P.pink, github: P.subtext, press: P.yellow,
};

// Display width: CJK and full-width forms take two cells.
const WIDE = /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/;
const cw = (ch) => (WIDE.test(ch) ? 2 : 1);
const width = (s) => [...s].reduce((n, ch) => n + cw(ch), 0);

// Cut or pad plain text to exactly w cells, with an ellipsis when it had to cut.
function fit(s, w) {
  if (w <= 0) return '';
  if (width(s) <= w) return s + ' '.repeat(w - width(s));
  let out = '', n = 0;
  for (const ch of s) {
    if (n + cw(ch) > w - 1) break;
    out += ch; n += cw(ch);
  }
  return out + '…' + ' '.repeat(w - n - 1);
}

// A line made of styled pieces [text, style, url?], fitted to w cells. A url makes the piece a
// clickable OSC 8 hyperlink in terminals that support it; others just show the text.
function line(pieces, w, base = '') {
  let out = '', used = 0;
  for (const [text, style = '', url] of pieces) {
    if (used >= w) break;
    const room = w - used;
    const t = width(text) > room ? fit(text, room) : text;
    out += base + style + (url ? `\x1b]8;;${url}\x07${t}\x1b]8;;\x07` : t) + RESET;
    used += width(t);
  }
  return out + base + ' '.repeat(Math.max(0, w - used)) + RESET;
}

// Word wrap to w cells; words longer than a line (URLs) are split.
function wrap(text, w) {
  const lines = [];
  let cur = '';
  for (let word of text.split(/\s+/).filter(Boolean)) {
    while (width(word) > w) {
      if (cur) { lines.push(cur); cur = ''; }
      let head = '';
      for (const ch of word) { if (width(head) + cw(ch) > w) break; head += ch; }
      lines.push(head); word = word.slice(head.length);
    }
    if (!cur) cur = word;
    else if (width(cur) + 1 + width(word) <= w) cur += ' ' + word;
    else { lines.push(cur); cur = word; }
  }
  if (cur) lines.push(cur);
  return lines;
}

const plainBody = (md = '') => md.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)').replace(/[`*_]/g, '');
const shortDate = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
const longDate = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });

// ---------- app state ----------

let editions = [];        // [{date, count}]
let edition = null;       // the loaded edition
let tree = [];            // sidebar rows
let treeAt = 0, listAt = 0, listTop = 0, readerTop = 0, treeTop = 0;
let focus = 1;            // 0 sidebar, 1 list, 2 reader
let filter = { key: 'all', label: 'All stories', test: () => true };
let message = '';
let showHelp = false;
let query = '', searching = false; // "/" search over the current view

const matches = (s) => !query || [s.title, s.why_read, s.authors.join(' '), SECTIONS[s.section], ...s.sources.map((k) => SOURCES[k])]
  .join(' ').toLowerCase().includes(query.toLowerCase());
const stories = () => (edition?.stories ?? []).filter((s) => filter.test(s) && matches(s));
const current = () => stories()[listAt];

// "Today" and "Yesterday" read better than a date followed by a count ("Wed, Sep 30 30").
function editionLabel(date) {
  const local = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const today = new Date();
  if (date === local(today)) return 'Today';
  if (date === local(new Date(today.getTime() - 86400000))) return 'Yesterday';
  return shortDate(date);
}

function buildTree() {
  const all = edition?.stories ?? [];
  const count = (test) => all.filter(test).length;
  const rows = [{ header: 'Editions' }];
  for (const e of editions) rows.push({ kind: 'edition', date: e.date, label: editionLabel(e.date), count: e.count });
  rows.push({ header: '' }, { header: 'This edition' });
  const views = [
    ['all', '▸', 'All stories', () => true],
    ['unread', '○', 'Unread', (s) => !state.read[idOf(s)]],
    ['marked', '★', 'Marked', (s) => state.marked[idOf(s)]],
    ['must', '◆', 'Must read', (s) => s.must_read],
  ];
  for (const [key, icon, label, test] of views) rows.push({ kind: 'filter', key, icon, label, test, count: count(test) });
  rows.push({ header: '' }, { header: 'Sections' });
  for (const [key, label] of Object.entries(SECTIONS)) {
    const test = (s) => s.section === key;
    if (count(test)) rows.push({ kind: 'filter', key: `section:${key}`, icon: '■', chip: key, label, test, count: count(test) });
  }
  rows.push({ header: '' }, { header: 'Sources' });
  for (const [key, label] of Object.entries(SOURCES)) {
    const test = (s) => s.sources.includes(key);
    if (count(test)) rows.push({ kind: 'filter', key: `source:${key}`, icon: '●', chip: key, label, test, count: count(test) });
  }
  tree = rows;
  if (!tree[treeAt] || 'header' in tree[treeAt]) treeAt = tree.findIndex((r) => !('header' in r));
}

async function openEdition(date) {
  try {
    message = `Loading ${longDate(date)}…`; render();
    edition = await loadEdition(date);
    listAt = 0; listTop = 0; readerTop = 0; message = '';
    buildTree(); readSoon(); loadHnMeta(edition.stories); render();
  } catch (e) { message = `Couldn't load that edition: ${e.message}`; render(); }
}

function applyTreeRow() {
  const row = tree[treeAt];
  if (!row) return;
  if (row.kind === 'edition' && row.date !== edition?.date) return openEdition(row.date);
  if (row.kind === 'filter') {
    filter = row;
    listAt = 0; listTop = 0; readerTop = 0;
    readSoon(); render();
  }
}

// A story counts as read once it has been on screen for a moment, or when opened with Enter,
// so skimming down the list doesn't mark everything you passed.
let readTimer;
function markRead(s = current()) {
  if (s && !state.read[idOf(s)]) { state.read[idOf(s)] = 1; save(); buildTree(); }
}
function readSoon() {
  clearTimeout(readTimer);
  if (SNAPSHOT) return;
  const s = current();
  readTimer = setTimeout(() => { if (current() === s) { markRead(s); render(); } }, 1500);
}

// Moves the story selection from any pane (J/K, n/p), resetting the article to its top.
function step(delta) {
  const n = stories().length;
  if (!n) return;
  listAt = Math.max(0, Math.min(n - 1, listAt + delta));
  readerTop = 0; readSoon();
}

// ---------- OS helpers ----------

function openUrl(url) {
  if (!url) return (message = 'No link for that.');
  const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  spawn(cmd, args, { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
  message = `Opened ${url}`;
}

// OSC 52 reaches the clipboard in most modern terminals, even over SSH; the native tool covers the rest.
function copy(text, what) {
  const b64 = Buffer.from(text).toString('base64');
  process.stdout.write(`\x1b]52;c;${b64}\x07`);
  // Windows PowerShell 5.1 decodes piped stdin in the OEM code page and mangles "·", "—" and
  // accents, so hand it base64 and decode as UTF-8 inside.
  const ps = `Set-Clipboard -Value ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}')))`;
  const tools = process.platform === 'win32' ? [['powershell', ['-NoProfile', '-Command', ps]]]
    : process.platform === 'darwin' ? [['pbcopy', []]]
    : [['wl-copy', []], ['xclip', ['-selection', 'clipboard']], ['xsel', ['-b']]];
  for (const [cmd, args] of tools) if (spawnSync(cmd, args, { input: text }).status === 0) break;
  message = `Copied ${what}.`;
}

const storyText = (s) => [
  s.title, `${SECTIONS[s.section]} · ${longDate(s.date)} · By ${s.authors.join(', ')}`, '',
  `Why read: ${s.why_read}`, '', plainBody(s.body), '',
  `Source:  ${s.url}`, ...(s.discuss_url ? [`Discuss: ${s.discuss_url}`] : []), `Read:    ${SITE}${s.link}`,
].join('\n');

// ---------- rendering ----------

// ---------- story details: the full article and the Hacker News discussion ----------

let tab = 'story';                  // what the article panel shows: 'story' | 'article' | 'discussion'
const TABS = [['story', 'Story'], ['article', 'Article'], ['discussion', 'Discussion']];
const pending = new Set();          // in-flight fetches; snapshots wait for them
const articles = new Map();         // source url -> { status, blocks?, title?, error? }
const threads = new Map();          // HN id -> { status, item?, error? }
const hnMeta = new Map();           // HN id -> { points, comments }

const UA = { 'User-Agent': 'Mozilla/5.0 (compatible; TheDailyWeight/0.2; terminal reader)' };
const hnId = (s) => s?.discuss_url?.match(/news\.ycombinator\.com\/item\?id=(\d+)/)?.[1];
const track = (p) => { pending.add(p); p.finally(() => { pending.delete(p); render(); }); return p; };
const fetchOk = async (url) => {
  const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`the site answered ${res.status}`);
  return res;
};
const why = (e) => (e.name === 'TimeoutError' ? 'it took too long to answer' : e.message);


function loadArticle(s) {
  if (!s || articles.has(s.url)) return;
  articles.set(s.url, { status: 'loading' });
  track(fetchOk(s.url).then(async (res) => {
    const type = res.headers.get('content-type') ?? '';
    if (type.includes('pdf')) throw new Error("it's a PDF");
    if (!type.includes('html')) throw new Error(`it isn't a web page (${type.split(';')[0] || 'unknown type'})`);
    const html = await res.text();
    const blocks = extractArticle(html);
    if (!blocks.length) throw new Error('no readable text was found on the page');
    articles.set(s.url, { status: 'ok', blocks, title: pageTitle(html) });
  }).catch((e) => articles.set(s.url, { status: 'error', error: why(e) })));
}

const countComments = (node) => (node.children ?? []).reduce((n, c) => n + (c.text ? 1 : 0) + countComments(c), 0);

function loadThread(s) {
  const id = hnId(s);
  if (!id || threads.has(id)) return;
  threads.set(id, { status: 'loading' });
  track(fetchOk(`https://hn.algolia.com/api/v1/items/${id}`).then((r) => r.json()).then((item) => {
    threads.set(id, { status: 'ok', item });
    hnMeta.set(id, { points: item.points ?? 0, comments: countComments(item) });
  }).catch((e) => threads.set(id, { status: 'error', error: why(e) })));
}

// Points and comment counts for every HN-discussed story in the edition, in one request.
function loadHnMeta(list) {
  const ids = [...new Set(list.map(hnId).filter((id) => id && !hnMeta.has(id)))];
  if (!ids.length) return;
  track(fetchOk(`https://hn.algolia.com/api/v1/search?hitsPerPage=${ids.length}&tags=story,(${ids.map((i) => `story_${i}`).join(',')})`)
    .then((r) => r.json())
    .then(({ hits }) => { for (const h of hits) hnMeta.set(h.objectID, { points: h.points ?? 0, comments: h.num_comments ?? 0 }); })
    .catch(() => {}));
}

function ensureDetails() {
  const s = current();
  if (tab === 'article') loadArticle(s);
  if (tab === 'discussion') loadThread(s);
}

const compact = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n));
function ago(iso) {
  const min = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
  return min < 60 ? `${min}m ago` : min < 1440 ? `${Math.round(min / 60)}h ago` : `${Math.round(min / 1440)}d ago`;
}

function tabBar(w) {
  const pieces = [];
  TABS.forEach(([key, label], i) => {
    const on = tab === key;
    pieces.push([` ${i + 1} ${label} `, on ? bg(...P.lavender) + fg(...P.base) + BOLD : T.muted], [' ']);
  });
  const s = current();
  const busy = (tab === 'article' && articles.get(s?.url)?.status === 'loading')
    || (tab === 'discussion' && threads.get(hnId(s))?.status === 'loading');
  if (busy) pieces.push(['  loading…', ITALIC + T.faint]);
  return line(pieces, w, T.panel);
}

// The source article, as fetched and cleaned.
function articleLines(s, w, measure) {
  const L = (pieces) => line(pieces, w, T.panel);
  const host = new URL(s.url).hostname.replace(/^www\./, '');
  const a = articles.get(s.url);
  const out = [L([]), L([[`From ${host}`, T.accent], [a?.title ? `  ·  ${a.title}` : '', T.muted]]), L([])];
  if (!a || a.status === 'loading') return [...out, L([[`Fetching the full article from ${host}…`, ITALIC + T.muted]])];
  if (a.status === 'error') {
    return [...out, L([[`Couldn't show the article here: ${a.error}.`, T.ink]]), L([]),
      L([['Press ', T.muted], ['o', BOLD + T.accent], [' to open it in your browser.', T.muted]])];
  }
  for (const { tag, text } of a.blocks) {
    if (tag.startsWith('h')) {
      if (out.length > 3) out.push(L([]));
      for (const t of wrap(text, measure)) out.push(L([[t, BOLD + T.accent]]));
      out.push(L([]));
    } else if (tag === 'li') {
      wrap(text, measure - 2).forEach((t, i) => out.push(L([[i ? '  ' : '• ', T.accent], [t, T.ink]])));
    } else if (tag === 'blockquote') {
      for (const t of wrap(text, measure - 2)) out.push(L([['▌ ', T.accent], [t, ITALIC + T.ink]]));
      out.push(L([]));
    } else if (tag === 'pre') {
      for (const t of text.split('\n')) out.push(L([[fit(t.replace(/\t/g, '  '), measure), fg(...P.teal)]]));
      out.push(L([]));
    } else {
      for (const t of wrap(text, measure)) out.push(L([[t, T.ink]]));
      out.push(L([]));
    }
  }
  out.push(L([['Extracted from the source page; formatting is simplified. ', T.faint], ['o', BOLD + T.accent], [' opens the original.', T.faint]]));
  return [...out, L([])];
}

// The Hacker News thread, threaded with guides, up to 80 comments.
function discussionLines(s, w, measure) {
  const L = (pieces) => line(pieces, w, T.panel);
  const id = hnId(s);
  const out = [L([])];
  if (!id) {
    out.push(L([['No Hacker News thread for this story.', T.ink]]));
    if (s.discuss_url) out.push(L([]), L([['Discussion: ', T.muted], [s.discuss_url, fg(...P.blue), s.discuss_url]]), L([['Press ', T.muted], ['d', BOLD + T.accent], [' to open it.', T.muted]]));
    return out;
  }
  const t = threads.get(id);
  if (!t || t.status === 'loading') return [...out, L([['Loading the Hacker News thread…', ITALIC + T.muted]])];
  if (t.status === 'error') return [...out, L([[`Couldn't load the thread: ${t.error}. Press d to open it.`, T.ink]])];

  const total = countComments(t.item);
  const LIMIT = 80;
  out.push(L([['Hacker News', BOLD + fg(...P.peach)], [`  ·  ▲ ${t.item.points ?? 0} points  ·  ${total} comments`, T.muted],
    [total > LIMIT ? `  ·  first ${LIMIT} shown` : '', T.faint]]));
  out.push(L([[t.item.title ?? '', T.faint]]), L([]));
  let shown = 0;
  const walk = (node, depth) => {
    for (const c of node.children ?? []) {
      if (shown >= LIMIT) return;
      if (!c.text) { walk(c, depth); continue; }
      shown++;
      const d = Math.min(depth, 5);
      const guide = [['  '.repeat(Math.max(0, d - 1))], [d ? '│ ' : '', T.rule]];
      const room = measure - width('  '.repeat(Math.max(0, d - 1))) - (d ? 2 : 0);
      out.push(L([...guide, [c.author ?? '[deleted]', BOLD + T.accent], [`  ${ago(c.created_at)}`, T.faint]]));
      htmlText(c.text).split(/\n\s*\n/).forEach((para, i) => {
        if (i) out.push(L([...guide]));
        for (const t of wrap(para, Math.max(20, room))) out.push(L([...guide, [t, T.ink]]));
      });
      out.push(L([...guide]));
      walk(c, depth + 1);
    }
  };
  walk(t.item, 0);
  out.push(L([['Press ', T.faint], ['d', BOLD + T.accent], [' to read the whole thread on Hacker News.', T.faint]]), L([]));
  return out;
}

const readingMinutes = (s) => Math.max(1, Math.round(`${s.why_read} ${s.body ?? ''}`.split(/\s+/).length / 220));

// Age of a story relative to today, eilmeldung-style: "new", "3d", "2w".
function age(date) {
  const days = Math.floor((Date.now() - Date.parse(`${date}T12:00:00Z`)) / 86400000);
  return days <= 0 ? 'new' : days < 7 ? `${days}d` : `${Math.floor(days / 7)}w`;
}

// Tag pill: pastel background with half-block caps so the ends look rounded.
const pill = (key, label, base) => {
  const c = CHIP[key] ?? P.subtext;
  return [['▐', fg(...c)], [label, bg(...c) + fg(...P.base) + BOLD], ['▌', fg(...c)], [' ', base]];
};

// The article, inside the reader panel.
function readerLines(s, w) {
  const B = T.panel;
  if (showHelp) return helpLines(w);
  if (!s) return [line([], w, B), line([['Nothing in this view.', T.muted]], w, B)];
  const measure = Math.min(w, 104);
  if (tab === 'article') return articleLines(s, w, measure);
  if (tab === 'discussion') return discussionLines(s, w, measure);
  const L = (pieces) => line(pieces, w, B);
  const tags = [...pill(s.section, SECTIONS[s.section].toLowerCase(), B)];
  for (const src of s.sources) tags.push(...pill(src, SOURCES[src].toLowerCase(), B));
  if (s.must_read) tags.push(...pill('safety', 'must read', B));

  const out = [
    L([]),
    L([[`${longDate(s.date)} ── ${SOURCES[s.source]}`, T.accent]]),
    ...wrap(s.title, measure).map((t) => L([[t, BOLD + T.ink, SITE + s.link]])),
    L([[`by ${s.authors.join(', ')}`, T.muted]]),
    L(tags),
    L([]),
  ];
  // Detail line: how the editor ranked it, reading time, and live HN numbers when there's a thread.
  const meta = hnMeta.get(hnId(s));
  out.splice(out.length - 1, 0, L([
    ['Interest ', T.faint], [`${s.interest_score}/10`, BOLD + T.ink], ['   ·   ', T.faint],
    [`${readingMinutes(s)} min read`, T.ink],
    ...(meta ? [['   ·   ', T.faint], [`▲ ${meta.points}`, BOLD + fg(...P.peach)], [' points on HN, ', T.muted],
      [`${meta.comments}`, BOLD + T.ink], [' comments', T.muted], ['  (press 3)', T.faint]] : []),
  ]));
  const why = wrap(`Why read  ${s.why_read}`, measure);
  why.forEach((t, i) => out.push(L(i === 0 ? [['Why read', BOLD + T.accent], [t.slice(8), ITALIC + T.ink]] : [[t, ITALIC + T.ink]])));
  out.push(L([]));
  for (const para of plainBody(s.body).split(/\n\s*\n/)) {
    for (const t of wrap(para, measure)) out.push(L([[t, T.ink]]));
    out.push(L([]));
  }
  const link = (label, url, key) => L([[`${label} `, T.faint], [key, BOLD + T.accent], ['  '], [url, fg(...P.blue), url]]);
  out.push(link('Source ', s.url, 'o'));
  if (s.discuss_url) out.push(link('Discuss', s.discuss_url, 'd'));
  out.push(link('Website', SITE + s.link, 'w'));
  if (s.image_credit) out.push(L([]), L([[`Photo: ${s.image_credit}`, T.faint]]));
  out.push(L([]));
  return out;
}

function helpLines(w) {
  const B = T.panel;
  const keys = [
    ['j / k, ↓ / ↑', 'move (scrolls when the article has focus)'], ['J / K, n / p', 'next / previous story, from any pane'],
    ['tab, h / l', 'switch pane'], ['enter', 'read the story (or open the sidebar item)'],
    ['/', 'search this view; enter keeps it, esc clears it'],
    ['1 / 2 / 3, t', 'our story / the full source article / the Hacker News thread'],
    ['esc', 'back to the list'], ['space / b', 'page the article down / up'], ['g / G', 'top / bottom'],
    ['o', 'open the source in your browser'], ['d', 'open the discussion'], ['w', 'open the story on the website'],
    ['c', 'copy the story as text'], ['u', 'copy the source link'], ['m', 'mark / unmark'],
    ['r', 'toggle read'], ['R', 'mark everything in view as read'], ['?', 'close this help'], ['q', 'quit'],
  ];
  return [line([], w, B), line([['Keys', BOLD + T.accent]], w, B), line([], w, B),
    ...keys.map(([k, v]) => line([[k.padEnd(16), BOLD + T.ink], [v, T.muted]], w, B)),
    line([], w, B), line([[`Reading ${SITE}`, T.faint]], w, B)];
}

// Pane header: eilmeldung's ☰ ● ★ strip and a thin line. The icons show which view is active,
// and the header turns lavender on the focused pane.
function paneHeader(w, on, label = '') {
  const icon = (ch, key) => [ch + ' ', filter.key === key ? BOLD + T.accent : T.faint];
  const edge = on ? T.accent : T.rule;
  const pieces = [[' '], icon('☰', 'all'), icon('●', 'unread'), icon('★', 'marked')];
  if (label) pieces.push([` ${label} `, on ? BOLD + T.accent : T.muted]);
  const used = pieces.reduce((n, [t]) => n + width(t), 0);
  pieces.push(['─'.repeat(Math.max(0, w - used - 1)), edge], [' ']);
  return line(pieces, w, T.pane);
}

// Sidebar: a tree like eilmeldung's, with each count in italic lavender right after its label.
function sidebarLines(iw, ih) {
  if (treeAt < treeTop) treeTop = treeAt;
  if (treeAt >= treeTop + ih) treeTop = treeAt - ih + 1;
  return tree.slice(treeTop, treeTop + ih).map((row, i) => {
    if ('header' in row) return line(row.header ? [[' ▼ ', T.muted], [row.header, BOLD + T.ink]] : [], iw, T.pane);
    const at = treeTop + i;
    const active = row.kind === 'edition' ? row.date === edition?.date : row.key === filter.key;
    const selected = at === treeAt;
    const base = selected ? (focus === 0 ? T.selFocus : T.selBlur) : T.pane;
    const iconStyle = row.chip ? fg(...CHIP[row.chip]) : row.key === 'marked' ? T.gold : row.key === 'must' ? T.red : T.accent;
    const icon = row.kind === 'edition' ? (active ? '●' : '○') : row.icon;
    return line([
      ['   '], [icon, selected ? '' : iconStyle], [' '],
      [row.label, BOLD + (selected ? '' : row.count ? T.ink : T.faint)],
      [` ${row.count}`, ITALIC + BOLD + (selected ? '' : row.count ? T.accent : T.faint)],
      [active && !selected ? '  ◂' : '', T.accent],
    ], iw, base);
  });
}

// Story rows: read circle, section dot, marker, age, title. Selected row is a lavender bar.
function listLines(list, iw, ih) {
  if (listAt < listTop) listTop = listAt;
  if (listAt >= listTop + ih) listTop = listAt - ih + 1;
  if (!list.length && edition) {
    return [line([[query ? `   Nothing matches "${query}". Esc clears the search.` : '   No stories in this view.', T.muted]], iw, T.pane)];
  }
  return list.slice(listTop, listTop + ih).map((s, i) => {
    const id = idOf(s), selected = listTop + i === listAt;
    const base = selected ? (focus === 1 ? T.selFocus : T.selBlur) : T.pane;
    const unread = !state.read[id];
    const [mark, markStyle] = state.marked[id] ? ['★', T.gold] : s.must_read ? ['◆', T.red] : s.recommended ? ['◇', T.faint] : [' ', ''];
    return line([
      ['  '], [unread ? '●' : '○', selected ? '' : unread ? T.accent : T.faint], ['   '],
      ['■', selected ? '' : fg(...CHIP[s.section])], [' '], [mark, selected ? '' : markStyle], ['   '],
      [age(s.date).padStart(3), selected ? '' : T.muted], ['  '],
      [(hnMeta.has(hnId(s)) ? `▲${compact(hnMeta.get(hnId(s)).points)}` : '').padStart(5), selected ? '' : fg(...P.peach)], ['   '],
      [s.title, BOLD + (selected ? '' : unread ? T.ink : T.muted)],
    ], iw, base);
  });
}

// The reader panel: a rounded box on a slightly lighter background, with a scroll thumb.
function panel(lines, w, h, scroll) {
  const innerW = w - 6, innerH = h - 2;
  const edge = bg(...P.base) + (focus === 2 ? T.accent : T.rule);
  let thumb = null;
  if (scroll.total > innerH) {
    const size = Math.max(1, Math.round((innerH * innerH) / scroll.total));
    const at = Math.round(((innerH - size) * scroll.top) / Math.max(1, scroll.total - innerH));
    thumb = [at, at + size];
  }
  const out = [edge + '╭' + '─'.repeat(w - 2) + '╮' + RESET];
  for (let i = 0; i < innerH; i++) {
    const right = thumb && i >= thumb[0] && i < thumb[1] ? bg(...P.base) + T.accent + '┃' : edge + '│';
    out.push(edge + '│' + RESET + T.panel + '  ' + (lines[i] ?? line([], innerW, T.panel)) + T.panel + '  ' + right + RESET);
  }
  out.push(edge + '╰' + '─'.repeat(w - 2) + '╯' + RESET);
  return out;
}

function render() {
  if (SNAPSHOT) return;
  ensureDetails();
  process.stdout.write(frame());
}

function frame() {
  const W = process.stdout.columns || 100, H = process.stdout.rows || 30;
  const bodyH = H - 1;
  const list = stories();
  const s = current();

  // eilmeldung's proportions: a quarter-width sidebar, a short list, and the article filling the rest.
  const SW = Math.max(24, Math.min(40, Math.floor(W * 0.25)));
  const RW = W - SW - 1;
  const LH = Math.max(4, Math.min(list.length || 1, 8, Math.floor(bodyH * 0.3))) + 1; // + header
  const AH = bodyH - LH;

  const side = [paneHeader(SW, focus === 0), ...sidebarLines(SW, bodyH - 1)];
  while (side.length < bodyH) side.push(line([], SW, T.pane));

  const label = edition ? `${shortDate(edition.date)} · ${filter.label}${query ? ` · "${query}"` : ''} · ${list.length}` : 'Loading…';
  const right = [paneHeader(RW, focus === 1, label), ...listLines(list, RW, LH - 1)];
  while (right.length < LH) right.push(line([], RW, T.pane));

  // The article panel: a fixed tab bar (Story · Article · Discussion), then the scrolling content.
  const article = readerLines(s, RW - 6);
  const AI = AH - 3;
  readerTop = Math.max(0, Math.min(readerTop, Math.max(0, article.length - AI)));
  const head = showHelp ? [] : [tabBar(RW - 6)];
  right.push(...panel([...head, ...article.slice(readerTop, readerTop + AI + (showHelp ? 1 : 0))], RW, AH,
    { top: readerTop, total: article.length + head.length }));

  // Status bar: the story's link on the left (as eilmeldung shows it), position and hints on the right.
  let status;
  if (searching) {
    const hint = '  enter keep · esc clear ';
    status = line([[fit(` / ${query}▏`, W - width(hint))], [hint]], W, T.search);
  } else {
    const hints = ['enter open · / search · ? keys · q quit', 'enter read · J/K next · o open · c copy · ? keys',
      'j/k scroll · 1 2 3 story/article/discussion · J/K next · esc back · ? keys'][focus];
    const pct = article.length > AI ? `${Math.round(((readerTop + AI) / article.length) * 100)}%` : '';
    const where = [list.length ? `${listAt + 1}/${list.length}` : '', pct, hints].filter(Boolean).join('  ·  ');
    status = line([[fit(` ${message || s?.url || ''}`, W - width(where) - 2)], [` ${where} `]], W, T.statusBar);
  }

  const sep = bg(...P.base) + T.rule + '│' + RESET;
  let out = `${ESC}H`;
  for (let r = 0; r < bodyH; r++) out += side[r] + sep + right[r] + '\r\n';
  return out + status;
}

// ---------- input ----------

function move(delta) {
  if (focus === 0) {
    let i = treeAt;
    do { i += delta; } while (tree[i] && 'header' in tree[i]);
    // Filters apply as you move; editions wait for Enter so passing over one doesn't load it.
    if (tree[i]) { treeAt = i; if (tree[i].kind === 'filter') applyTreeRow(); }
  } else if (focus === 1) {
    step(delta);
  } else {
    readerTop = Math.max(0, readerTop + delta);
  }
}

// While searching, keys edit the query; the list filters as you type.
function onSearchKey(str, key) {
  if (key.name === 'escape') { query = ''; searching = false; }
  else if (key.name === 'return') { searching = false; if (!query) message = ''; }
  else if (key.name === 'backspace') query = query.slice(0, -1);
  else if (str && !key.ctrl && str >= ' ' && str !== '\x7f') query += str;
  else return;
  listAt = 0; listTop = 0; readerTop = 0; readSoon();
  render();
}

function onKey(str, key = {}) {
  if (key.ctrl && key.name === 'c') return quit();
  if (searching) return onSearchKey(str, key);
  message = '';
  const s = current();
  const page = Math.max(1, (process.stdout.rows || 30) - 12);
  // Printable keys by character, so Shift+g arrives as 'G' and Shift+r as 'R'; others by name.
  const k = key.name === 'tab' ? (key.shift ? 'S-tab' : 'tab')
    : str === ' ' ? 'space' : str && /^[!-~]$/.test(str) ? str : key.name;
  switch (k) {
    case 'q': return quit();
    case 'j': case 'down': move(1); break;
    case 'k': case 'up': move(-1); break;
    case 'tab': focus = (focus + 1) % 3; break;
    case 'S-tab': focus = (focus + 2) % 3; break;
    case 'h': case 'left': focus = Math.max(0, focus - 1); break;
    case 'l': case 'right': focus = Math.min(2, focus + 1); break;
    case 'return': if (focus === 0) { applyTreeRow(); focus = 1; } else { markRead(); focus = 2; } break;
    case 'escape':
      if (showHelp) showHelp = false;
      else if (query && focus !== 2) { query = ''; listAt = 0; listTop = 0; }
      focus = 1; break;
    case 'J': case 'n': step(1); break;
    case 'K': case 'p': step(-1); break;
    case '1': case '2': case '3': tab = TABS[k - 1][0]; readerTop = 0; showHelp = false; break;
    case 't': tab = TABS[(TABS.findIndex(([key]) => key === tab) + 1) % TABS.length][0]; readerTop = 0; showHelp = false; break;
    case '/': searching = true; showHelp = false; if (focus === 0) focus = 1; break;
    case 'space': case 'pagedown': readerTop += page; break;
    case 'b': case 'pageup': readerTop = Math.max(0, readerTop - page); break;
    case 'g': case 'home': if (focus === 2) readerTop = 0; else move(-1e6); break;
    case 'o': openUrl(s?.url); break;
    case 'd': openUrl(s?.discuss_url); break;
    case 'w': openUrl(s && SITE + s.link); break;
    case 'c': if (s) copy(storyText(s), 'the story'); break;
    case 'u': if (s) copy(s.url, 'the source link'); break;
    case 'm': if (s) { state.marked[idOf(s)] ? delete state.marked[idOf(s)] : (state.marked[idOf(s)] = 1); save(); buildTree(); } break;
    case 'r': if (s) { state.read[idOf(s)] ? delete state.read[idOf(s)] : (state.read[idOf(s)] = 1); save(); buildTree(); } break;
    case '?': showHelp = !showHelp; break;
    case 'G': case 'end': if (focus === 2) readerTop = 1e6; else move(1e6); break;
    case 'R': for (const x of stories()) state.read[idOf(x)] = 1; save(); buildTree(); message = 'Marked everything in view as read.'; break;
    default: return;
  }
  render();
}

// ---------- lifecycle ----------

function restoreTerminal() {
  process.stdout.write(`${RESET}${ESC}?25h${ESC}?1049l`);
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
}

function quit(code = 0) {
  restoreTerminal();
  process.exit(code);
}

// Replays keys like vim's normal mode: \t is tab, \r is enter, \e is escape.
async function snapshot() {
  editions = await getJSON('/editions.json');
  await openEdition(editions[0].date);
  const names = { '\t': 'tab', '\r': 'return', '\x1b': 'escape' };
  for (const ch of (opt('--keys') ?? '').replace(/\\t/g, '\t').replace(/\\r/g, '\r').replace(/\\e/g, '\x1b')) {
    onKey(ch, { name: names[ch] ?? (/[a-z]/.test(ch) ? ch : undefined), shift: /[A-Z]/.test(ch) });
    await new Promise((r) => setTimeout(r, 0)); // let edition loads finish
    while (message.startsWith('Loading')) await new Promise((r) => setTimeout(r, 20));
  }
  // Let article and thread fetches land (up to 20s) so the snapshot shows real content.
  ensureDetails();
  const deadline = Date.now() + 20000;
  while (pending.size && Date.now() < deadline) await Promise.race([Promise.allSettled([...pending]), new Promise((r) => setTimeout(r, 500))]);
  process.stdout.write(frame().replace(`${ESC}H`, '') + '\n');
  process.exit(0);
}

async function main() {
  if (SNAPSHOT) return snapshot();
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error('The Daily Weight reader needs an interactive terminal. For plain text, use: curl -s ' + SITE + '/txt');
    process.exit(1);
  }
  try {
    editions = await getJSON('/editions.json');
  } catch (e) {
    console.error(`Couldn't reach The Daily Weight at ${SITE} (${e.cause?.code ?? e.message}).`);
    console.error(existsSync('package.json')
      ? 'Start the site with `npm run dev` in another terminal, or pass the paper\'s address: npm run tui -- https://your.domain'
      : 'Pass the paper\'s address: daily-weight https://your.domain');
    process.exit(1);
  }
  if (!editions.length) { console.error('No editions published yet.'); process.exit(1); }

  process.stdout.write(`${ESC}?1049h${ESC}?25l${ESC}2J`);
  process.on('uncaughtException', (e) => { restoreTerminal(); console.error(e); process.exit(1); });
  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.on('keypress', onKey);
  process.stdout.on('resize', () => { process.stdout.write(`${ESC}2J`); render(); });
  await openEdition(editions[0].date);
}

main();
