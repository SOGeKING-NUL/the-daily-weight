// Writes one edition from its ranked clusters (drafts/<date>.ranked.json) with the Claude API:
// one call picks the stories, then one call per story writes it from source text we fetch ourselves.
// Every decision lands in drafts/<date>.decisions.json, which scripts/check.mjs holds to account.
// Needs ANTHROPIC_API_KEY (an API key from platform.claude.com, not a Claude subscription login).
//
//   node scripts/write.mjs                       newest ranked drafts
//   node scripts/write.mjs 2026-10-01
//   node scripts/write.mjs 2026-10-01 --limit 3  only the top three picks: a cheap trial run
//   node scripts/write.mjs --gaps                only the must-cover clusters no earlier run decided on

import Anthropic from '@anthropic-ai/sdk';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { extractArticle } from './lib/article.mjs';
import { slugify, storyFile, unsupported } from './lib/story.mjs';

const MODEL = 'claude-sonnet-5'; // ponytail: the plan's cost pick; claude-opus-5 judges better at ~2.5x the price
const SECTIONS = ['models', 'agents', 'infra', 'research', 'safety', 'industry'];
const SOURCES = ['labs', 'press', 'hn', 'reddit', 'x', 'arxiv', 'github'];
const MAX_SOURCE = 15000; // characters of source text per story (~4k tokens)
const UA = { 'User-Agent': 'Mozilla/5.0 (compatible; TheDailyWeight/0.3; daily AI news digest)' };

const args = process.argv.slice(2);
const limit = args.includes('--limit') ? Number(args[args.indexOf('--limit') + 1]) : Infinity;
const date = args.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a))
  ?? readdirSync('drafts').filter((f) => f.endsWith('.ranked.json')).sort().at(-1)?.slice(0, 10);
const { clusters } = JSON.parse(readFileSync(`drafts/${date}.ranked.json`, 'utf8'));
const byId = new Map(clusters.map((c) => [c.id, c]));

const client = new Anthropic({ maxRetries: 5 }); // the SDK retries 429, 529 and 5xx with backoff
// Stable across every call so the prompt cache can serve it (a no-op below the model's minimum size).
const system = [{ type: 'text', text: readFileSync('scripts/editor-prompt.md', 'utf8'), cache_control: { type: 'ephemeral' } }];

// One structured-output request. Server tools (web fetch) may pause a long turn; continue it.
async function ask(content, schema, { effort = 'high', tools } = {}) {
  const messages = [{ role: 'user', content }];
  for (let turn = 0; turn < 4; turn++) {
    const res = await client.messages.create({ model: MODEL, max_tokens: 16000, system, messages, tools,
      output_config: { effort, format: { type: 'json_schema', schema } } });
    if (res.stop_reason === 'pause_turn') { messages.push({ role: 'assistant', content: res.content }); continue; }
    if (res.stop_reason === 'refusal') throw new Error(`declined (${res.stop_details?.category ?? 'no category'})`);
    if (res.stop_reason === 'max_tokens') throw new Error('ran out of output tokens');
    const text = res.content.filter((b) => b.type === 'text').at(-1)?.text;
    // Fetched pages travel with the answer so the fact check can read what the model read.
    const fetched = res.content.filter((b) => b.type === 'web_fetch_tool_result').map((b) => JSON.stringify(b.content)).join('\n');
    return { ...JSON.parse(text), fetched };
  }
  throw new Error('no answer after four turns');
}

const str = { type: 'string' };
const obj = (properties) => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });
const PICKS = obj({
  picks: { type: 'array', items: obj({ id: str, section: { type: 'string', enum: SECTIONS }, interest_score: { type: 'integer' },
    recommended: { type: 'boolean' }, must_read: { type: 'boolean' } }) },
  rejections: { type: 'array', items: obj({ id: str, reason: str }) },
});
const STORY = obj({
  keep: { type: 'boolean' }, reason: str, title: str, authors: { type: 'array', items: str },
  source: { type: 'string', enum: SOURCES }, why_read: str, summary: str, body: str, slug: str,
  image_subjects: { type: 'array', items: str },
});

// What the editor sees of a cluster: signals, the primary, and what else was said about it.
const brief = (c) => ({
  id: c.id, must_cover: c.must_cover ? c.reasons : undefined, heat: c.heat, title: c.title, url: c.url, source: c.source,
  signals: c.signals, discuss_url: c.discuss_url,
  members: c.members.map((m) => ({ title: m.title, url: m.url, source: m.source, from: m.lab ?? m.outlet ?? m.subreddit ?? m.site,
    blurb: m.blurb?.slice(0, 300), authors: m.authors, note: m.note, kind: m.kind, points: m.points })),
  top_posts: c.top_posts,
});

// ---------- 1. pick ----------

const recent = readdirSync('content/editions').filter((d) => d < date).sort().slice(-2).flatMap((d) =>
  readdirSync(`content/editions/${d}`).map((f) => readFileSync(`content/editions/${d}/${f}`, 'utf8').match(/^title: (.*)$/m)?.[1]));

async function pick(list, note = '') {
  return ask(`Job: choose the stories for the edition dated ${date}.

Below are ${list.length} clusters, hottest first. Each is one event as gathered from lab blogs, press, Hacker News, Reddit, X (a curated list of AI accounts), arXiv, GitHub and other people's daily digests. heat and signals measure attention, not quality. A cluster with must_cover set must appear either in your picks or in your rejections with a specific reason; other clusters you skip need no entry.

For each pick give its section, interest_score (1-10; the highest leads the paper), recommended, and must_read (true for at most 4 stories).
${note}
Recent editions already ran these headlines; skip repeats unless there is material news:
${recent.map((t) => `- ${t}`).join('\n')}

Clusters:
${JSON.stringify(list.map(brief))}`, PICKS);
}

// Re-runs for the same date add to the record rather than replace it.
const record = `drafts/${date}.decisions.json`;
const before = existsSync(record) ? JSON.parse(readFileSync(record, 'utf8')) : { written: [], rejections: [] };
const decided = (r) => new Set([...(r.picks ?? r.written), ...r.rejections].map((p) => p.id));

const first = args.includes('--gaps') ? before : await pick(clusters);
const missed = clusters.filter((c) => c.must_cover && !decided(first).has(c.id));
const second = missed.length
  ? await pick(missed, `\nThese are all must-cover and the first pass left them undecided: pick or reject every one.`)
  : { picks: [], rejections: [] };
const picks = [...(first.picks ?? []), ...second.picks].filter((p) => byId.has(p.id))
  .map((p) => ({ ...p, interest_score: Math.min(10, Math.max(1, Math.round(p.interest_score))) }))
  .sort((a, b) => b.interest_score - a.interest_score);
picks.filter((p) => p.must_read).slice(4).forEach((p) => { p.must_read = false; }); // four at most
const rejections = args.includes('--gaps') ? second.rejections : [...first.rejections, ...second.rejections];
console.log(`${picks.length} picked, ${rejections.length} must-cover rejected`);

// ---------- 2. write ----------

// Readable text of a page: GitHub repos by their README, everything else through extractArticle().
async function readPage(url) {
  const repo = url.match(/^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/?$/)?.[1];
  const res = await fetch(repo ? `https://raw.githubusercontent.com/${repo}/HEAD/README.md` : url,
    { headers: UA, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`${res.status}`);
  const body = await res.text();
  if (repo) return body.slice(0, MAX_SOURCE);
  if (!(res.headers.get('content-type') ?? '').includes('html')) throw new Error('not a web page');
  return extractArticle(body).map((b) => b.text).join('\n\n').slice(0, MAX_SOURCE);
}

// The primary if we can read it, else the next member that has real text. X posts are their own text.
async function source(c) {
  for (const m of [c, ...c.members]) {
    if (/\/\/x\.com\//.test(m.url)) continue;
    try {
      const text = await readPage(m.url);
      if (text.length > 400) return { url: m.url, text };
    } catch {}
  }
  const post = c.members.find((m) => m.source === 'x');
  return post ? { url: post.url, text: `${post.author ?? ''} on X: ${post.text ?? post.title}` } : null;
}

const run = promisify(execFile);
const taken = new Set(existsSync(`content/editions/${date}`) ? readdirSync(`content/editions/${date}`) : []);
const unique = (s) => { let slug = s; for (let n = 2; taken.has(`${slug}.md`); n++) slug = `${s}-${n}`; taken.add(`${slug}.md`); return slug; };

async function write(p) {
  const c = byId.get(p.id);
  const src = await source(c);
  const job = (fix = '') => ask(`Job: write one story for the edition dated ${date}.

${src ? `Source text, from ${src.url}:\n<<<\n${src.text}\n>>>` : `We could not read ${c.url} ourselves. Use the web_fetch tool on it (or on the other member URLs) and write from what it returns; if nothing loads, set keep to false.`}

Cluster: ${JSON.stringify(brief(c))}
Placement: section ${p.section}, interest ${p.interest_score}${p.must_read ? ', must read' : ''}.

Return: title (a plain, specific headline in sentence case), authors (the byline as published: people, or the organisation), source (labs: a lab or company's own post; press: a news report; hn, reddit or x: a community find; arxiv: a paper; github: a repo or release), why_read (one or two sentences on why a builder should spend the time), summary (one line for RSS), body (two or three short Markdown paragraphs: what it is, how it works, what it changes), slug (3 to 6 words, kebab-case), image_subjects (two generic photo subjects for a stock photo: objects or places, never people or logos, e.g. "server racks", "chess pieces"). If the source doesn't support a story, set keep to false and say why in reason, leaving the other fields empty.${fix}`,
  STORY, { effort: 'medium', tools: src ? undefined : [{ type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 3 }] });

  // The fact check reads everything the writer was given: source text, fetched pages, cluster titles and blurbs.
  const known = (s) => [src?.text, s.fetched, JSON.stringify(brief(c))].join('\n');
  const claims = (s) => `${s.title}\n${s.why_read}\n${s.summary}\n${s.body}`;
  let story = await job();
  let bad = story.keep ? unsupported(claims(story), known(story)) : [];
  if (bad.length) {
    story = await job(`\n\nA first draft used numbers or names the source text doesn't contain: ${bad.join(', ')}. Use only what the source says.\nThat draft: ${JSON.stringify(story)}`);
    bad = story.keep ? unsupported(claims(story), known(story)) : [];
  }
  if (!story.keep) return { id: p.id, reason: story.reason || 'source does not support a story' };
  if (bad.length) return { id: p.id, reason: `failed the fact check: ${bad.join(', ')}` };

  const url = src?.url ?? c.url;
  const file = `content/editions/${date}/${unique(slugify(story.slug || story.title))}.md`;
  mkdirSync(`content/editions/${date}`, { recursive: true });
  writeFileSync(file, storyFile({
    date, title: story.title, authors: story.authors.length ? story.authors : ['Unknown'], url,
    discuss_url: c.discuss_url && c.discuss_url !== url ? c.discuss_url : null,
    source: story.source, section: p.section, interest_score: p.interest_score,
    recommended: p.recommended || p.must_read, must_read: p.must_read,
    why_read: story.why_read, summary: story.summary, image: null, sample: false,
  }, story.body));
  for (const subject of story.image_subjects.slice(0, 2)) {
    try { await run('node', ['scripts/images.mjs', file, subject]); break; } catch {} // exit 2: nothing suitable
  }
  console.log(`  wrote ${file}`);
  return { id: p.id, file, title: story.title };
}

// A few stories at a time: fast enough for a morning run, gentle on API rate limits and Wikimedia.
async function pool(items, n, fn) {
  const out = [];
  let next = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]).catch((e) => ({ id: items[i].id, reason: `error: ${e.message}` }));
    }
  }));
  return out;
}

const results = await pool(picks.slice(0, limit), 4, write);
const written = results.filter((r) => r.file);
const dropped = results.filter((r) => !r.file);
for (const d of dropped) console.log(`  dropped ${d.id}: ${d.reason}`);

writeFileSync(record, JSON.stringify({
  date,
  written: [...before.written, ...written],
  rejections: [...before.rejections, ...rejections, ...dropped],
}, null, 2));
console.log(`${record}: ${written.length} written, ${dropped.length} dropped`);
