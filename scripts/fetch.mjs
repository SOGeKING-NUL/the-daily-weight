// Gathers candidate stories for one edition into drafts/YYYY-MM-DD.json.
// No dependencies: Node 22 fetch and a few regexes. Ranking is scripts/rank.mjs, writing scripts/write.mjs.
//
//   node scripts/fetch.mjs                  today's edition (India date), window ending now
//   node scripts/fetch.mjs 2026-10-01       a specific edition date, window ending 01:00 UTC that day
//   node scripts/fetch.mjs 2026-09-29 168   a wider window in hours (catch-up or launch issues)
//
// For past dates, sources that only show "right now" (GitHub Trending, Reddit's top of the day)
// are skipped, since they'd describe today rather than that edition.
//
// X/Twitter comes from a curated X List read through twitterapi.io (TWITTERAPI_KEY, X_LIST_ID).
// Without them the X source is reported in errors[] and everything else still runs.

import { mkdirSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { decode } from './lib/article.mjs';
import { clean, fromPosts, merge } from './lib/candidates.mjs';

// Editions are dated in India time and published around 06:30 IST (01:00 UTC).
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const date = process.argv[2] ?? today;
const until = date === today ? Date.now() : Date.parse(`${date}T01:00:00Z`);
const hours = Number(process.argv[3] ?? 36);
const since = until - hours * 3600 * 1000;
const isPast = Date.now() - until > 24 * 3600 * 1000;
const UA = { 'User-Agent': 'Mozilla/5.0 (compatible; TheDailyWeight/0.3; daily AI news digest)' };

// Lab and company blogs. Anthropic has no feed, so it comes from its sitemap below.
const LAB_FEEDS = {
  OpenAI: 'https://openai.com/news/rss.xml',
  'Google DeepMind': 'https://deepmind.google/blog/rss.xml',
  'Google AI': 'https://blog.google/technology/ai/rss/',
  'Hugging Face': 'https://huggingface.co/blog/feed.xml',
  Qwen: 'https://qwenlm.github.io/blog/index.xml',
  'NVIDIA Developer': 'https://developer.nvidia.com/blog/feed/',
  'Microsoft Research': 'https://www.microsoft.com/en-us/research/feed/',
  'Apple ML Research': 'https://machinelearning.apple.com/rss.xml',
};
// News outlets and writers; `aiOnly` feeds carry other topics too and get filtered.
const PRESS_FEEDS = {
  TechCrunch: { url: 'https://techcrunch.com/category/artificial-intelligence/feed/' },
  'The Verge': { url: 'https://www.theverge.com/rss/ai-artificial-intelligence/index.xml' },
  'Ars Technica': { url: 'https://feeds.arstechnica.com/arstechnica/technology-lab', aiOnly: true },
  'Simon Willison': { url: 'https://simonwillison.net/atom/everything/', aiOnly: true },
};
// Other people's daily AI digests. We never cite them; their outbound links are a net for what we'd
// otherwise miss (smol.ai's issue is mostly X posts). Anything two of them link is must-cover in rank.mjs.
const AGGREGATOR_FEEDS = {
  'smol.ai': { url: 'https://news.smol.ai/rss.xml' },
  'TLDR AI': { url: 'https://tldr.tech/api/rss/ai', page: true }, // items carry no body; links live on the issue page
  Techmeme: { url: 'https://www.techmeme.com/feed.xml', aiOnly: true, oneStory: true }, // all of tech, one story per item
};
const SUBREDDITS = ['LocalLLaMA', 'MachineLearning', 'OpenAI', 'ClaudeAI'];
// Stable releases from these repos are always candidates. ponytail: hand-kept list; add to it as the beat changes.
const REPOS = [
  // inference and serving
  'vllm-project/vllm', 'sgl-project/sglang', 'ggml-org/llama.cpp', 'ollama/ollama', 'NVIDIA/TensorRT-LLM',
  'huggingface/text-generation-inference', 'ml-explore/mlx', 'ml-explore/mlx-lm', 'exo-explore/exo', 'LMCache/LMCache',
  // training and kernels
  'pytorch/pytorch', 'huggingface/transformers', 'unslothai/unsloth', 'axolotl-ai-cloud/axolotl',
  'Dao-AILab/flash-attention', 'triton-lang/triton', 'deepspeedai/DeepSpeed', 'jax-ml/jax', 'tinygrad/tinygrad',
  // agents, coding tools, protocols
  'openai/codex', 'anthropics/claude-code', 'google-gemini/gemini-cli', 'Aider-AI/aider', 'cline/cline',
  'All-Hands-AI/OpenHands', 'browser-use/browser-use', 'modelcontextprotocol/modelcontextprotocol',
  'langchain-ai/langgraph', 'stanfordnlp/dspy', 'microsoft/autogen', 'openai/openai-agents-python',
  // apps
  'open-webui/open-webui', 'comfyanonymous/ComfyUI',
];
// GitHub allows 60 requests/hour without a token, which the watch list alone would exhaust.
// Use $GITHUB_TOKEN, or the GitHub CLI's login if it's installed; fall back to anonymous.
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || (() => {
  try { return execSync('gh auth token', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { return ''; }
})();
const GH = GITHUB_TOKEN ? { Authorization: `Bearer ${GITHUB_TOKEN}` } : {};
// A title hint, not a gate: product names change weekly, so the big HN stories go to the editor
// even when this misses (see hn()). "gpt" has no leading \b so ChatGPT/GPTs match.
const AI = /gpt|\b(ai|a\.i\.|llms?|ml|machine learning|deep learning|claude|opus|sonnet|haiku|gemini|gemma|openai|anthropic|deepmind|mistral|llama|qwen|deepseek|kimi|glm|grok|xai|jev|codex|copilot|cursor|agents?|agentic|chatbots?|inference|transformers?|diffusion|neural|models?|benchmarks?|evals?|fine-?tun\w*|rlhf|tokens?|gpus?|tpus?|cuda|nvidia|mcp|hugging ?face|robot\w*|facial recognition|face scans?|alignment|interpretability)\b/i;
const AI_DOMAINS = /(openai|anthropic|deepmind|huggingface|arxiv|mistral|x\.ai|together|fireworks|groq|cerebras|ollama|lmsys|meta\.com\/ai|ai\.google|nvidia)\./i;
const isAI = (title, url = '') => AI.test(title) || AI_DOMAINS.test(url);

const inWindow = (t) => t >= since && t <= until;
const iso = (t) => new Date(t).toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const inner = (xml, name) => xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`))?.[1]?.replace(/<!\[CDATA\[|\]\]>/g, '') ?? '';
const tag = (xml, name) => decode(inner(xml, name).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());

// Retries rate limits with backoff: 429 everywhere, and GitHub's 403 when it says how long to wait.
async function get(url, as = 'json', headers = {}) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, { headers: { ...UA, ...headers }, signal: AbortSignal.timeout(30000) });
    if (res.ok) return as === 'json' ? res.json() : res.text();
    const wait = Math.min(60, Number(res.headers.get('retry-after')) || 0) * 1000;
    if ((res.status !== 429 && !(res.status === 403 && wait)) || attempt === 3) throw new Error(`${res.status} ${url}`);
    await sleep(wait || attempt * 6000);
  }
}

// RSS <item> and Atom <entry> in one pass; returns items inside the window.
async function feed(url) {
  const xml = await get(url, 'text');
  return xml.split(/<item[\s>]|<entry[\s>]/).slice(1).map((it) => ({
    title: tag(it, 'title'),
    url: it.match(/<link[^>]*href="([^"]+)"/)?.[1] ?? tag(it, 'link'),
    published: Date.parse(tag(it, 'pubDate') || tag(it, 'published') || tag(it, 'updated') || tag(it, 'dc:date')),
    blurb: (tag(it, 'description') || tag(it, 'summary') || tag(it, 'content')).slice(0, 400),
    author: tag(it, 'dc:creator') || tag(it, 'name'),
    subreddit: it.match(/<category[^>]*label="(r\/\w+)"/)?.[1],
    raw: it,
  })).filter((i) => i.title && inWindow(i.published)).map(({ raw, ...i }) => ({ ...i, published: iso(i.published),
    // the item's body as HTML, for the digests whose links we want (feeds escape it or wrap it in CDATA)
    html: decode(inner(raw, 'content:encoded') || inner(raw, 'description') || inner(raw, 'content')) }));
}
const strip = ({ html, ...i }) => i;

async function labs() {
  const out = [];
  for (const [lab, url] of Object.entries(LAB_FEEDS)) {
    out.push(...(await settle(lab, () => feed(url))).map((i) => ({ source: 'labs', lab, ...strip(i) })));
  }
  // Anthropic: sitemap lastmod is the best date signal it publishes (it also moves on edits).
  const map = await get('https://www.anthropic.com/sitemap.xml', 'text');
  for (const [, loc, mod] of map.matchAll(/<loc>([^<]+)<\/loc>\s*<lastmod>([^<]+)<\/lastmod>/g)) {
    if (/\/(news|research|engineering)\/|\/claude-[\w-]+$/.test(loc) && inWindow(Date.parse(mod))) {
      out.push({ source: 'labs', lab: 'Anthropic', title: loc.split('/').pop().replace(/-/g, ' '), url: loc,
        published: iso(Date.parse(mod)), note: 'title from URL slug; open the page for the real headline' });
    }
  }
  return out;
}

async function press() {
  const out = [];
  for (const [outlet, { url, aiOnly }] of Object.entries(PRESS_FEEDS)) {
    out.push(...(await feed(url)).filter((i) => !aiOnly || AI.test(`${i.title} ${i.blurb}`))
      .map((i) => ({ source: 'press', outlet, ...strip(i) })));
  }
  return out;
}

// Outbound links of a digest issue, minus its own pages, sponsors, social profiles and home pages.
const JUNK_HOSTS = /(^|\.)(tldr\.tech|techmeme\.com|smol\.ai|latent\.space|substack\.com|instagram\.com|linkedin\.com|facebook\.com|goldcast\.io|ashbyhq\.com)$/;
const JUNK_TEXT = /sponsor|advertis|careers|unsubscribe|opt in|save your seat|register|see how it works/i;
function outlinks(html) {
  const links = [];
  for (const [, href, text] of html.matchAll(/<a\b[^>]*href="(https?:[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
    const anchor = decode(text.replace(/<[^>]+>/g, '')).replace(/\(\d+ minute read\)/, '').replace(/\s+/g, ' ').trim();
    let u;
    try { u = new URL(decode(href)); } catch { continue; }
    if (JUNK_HOSTS.test(u.host) || JUNK_TEXT.test(anchor) || u.pathname.length <= 1) continue;
    if (/^(www\.)?(x|twitter)\.com$/.test(u.host) && !u.pathname.includes('/status/')) continue;
    links.push({ url: clean(u.toString()), anchor });
  }
  return links;
}

async function aggregators() {
  const out = [];
  for (const [name, { url, page, aiOnly, oneStory }] of Object.entries(AGGREGATOR_FEEDS)) {
    for (const item of await settle(name, () => feed(url))) {
      if (aiOnly && !AI.test(`${item.title} ${item.blurb}`)) continue;
      const html = page ? await settle(`${name} page`, () => get(item.url, 'text')) : item.html;
      for (const { url: link, anchor } of outlinks(typeof html === 'string' ? html : '')) {
        // A one-story item's headline beats its anchors ("Financial Times").
        out.push({ source: 'aggregator', aggregators: [name], title: oneStory ? item.title : anchor || item.title,
          url: link, published: item.published });
      }
    }
  }
  return out;
}

async function hn() {
  const url = `https://hn.algolia.com/api/v1/search_by_date?tags=story&hitsPerPage=1000`
    + `&numericFilters=created_at_i>${since / 1000},created_at_i<${until / 1000},points>=10`;
  const { hits } = await get(url);
  // AI-looking stories from 10 points up (smaller launches, Show HNs and incident reports live
  // at 10-40), plus every front-page-sized story (150+) flagged ai_match: false, so a headline
  // that never says "AI" still reaches the editor. The bar scales with the window so a week-long
  // catch-up doesn't drown the editor in every non-AI front-page story of the week.
  const bigStory = 150 * Math.max(1, hours / 36);
  return hits.filter((h) => isAI(h.title, h.url) || h.points >= bigStory).map((h) => ({
    source: 'hn', title: h.title, url: h.url ?? `https://news.ycombinator.com/item?id=${h.objectID}`,
    discuss_url: `https://news.ycombinator.com/item?id=${h.objectID}`,
    published: h.created_at, points: h.points, comments: h.num_comments, ai_match: isAI(h.title, h.url),
  }));
}

// Reddit blocks unauthenticated JSON and rate-limits RSS hard, so fetch every subreddit
// in one combined "top of the day" feed; its order stands in for score.
// ponytail: Reddit ends RSS on 2026-11-13; after that this only adds a line to errors[]. Delete it then.
async function reddit() {
  // Wider or past windows read the week's top list; feed() keeps only posts inside the window.
  const period = isPast || hours > 36 ? 'week' : 'day';
  const items = await feed(`https://www.reddit.com/r/${SUBREDDITS.join('+')}/top/.rss?t=${period}&limit=100`);
  return items.map((i, rank) => ({ source: 'reddit', subreddit: i.subreddit, rank: rank + 1, ...strip(i), discuss_url: i.url }));
}

async function lobsters() {
  return (await get('https://lobste.rs/t/ai.json'))
    .filter((s) => inWindow(Date.parse(s.created_at)))
    .map((s) => ({ source: 'hn', site: 'Lobsters', title: s.title, url: s.url || s.comments_url,
      discuss_url: s.comments_url, published: iso(Date.parse(s.created_at)), points: s.score }));
}

// arXiv via Hugging Face daily papers: community-upvoted, so it's the signal, not the firehose.
async function papers() {
  const days = [];
  for (let t = until; t > since - 86400000; t -= 86400000) days.push(new Date(t).toISOString().slice(0, 10));
  const seen = new Map();
  for (const d of days) {
    for (const p of await get(`https://huggingface.co/api/daily_papers?date=${d}`)) seen.set(p.paper.id, p);
  }
  return [...seen.values()]
    .sort((a, b) => b.paper.upvotes - a.paper.upvotes).slice(0, 30)
    .map(({ paper: p }) => ({
      source: 'arxiv', title: p.title.replace(/\s+/g, ' '), url: `https://arxiv.org/abs/${p.id}`,
      discuss_url: `https://huggingface.co/papers/${p.id}`, published: p.publishedAt, upvotes: p.upvotes,
      organization: p.organization?.fullname ?? null, github: p.githubRepo ?? null,
      authors: p.authors.map((a) => a.name).slice(0, 8), blurb: (p.summary ?? '').replace(/\s+/g, ' ').slice(0, 600),
    }));
}

// GitHub from three angles: releases of the repos the beat depends on, what's trending today and
// this week, and brand-new AI repos gathering stars. Star counts can be gamed; the editor judges.
// Every call is settled on its own, so one rate-limited search doesn't cost the releases.
async function github() {
  const api = (path) => get(`https://api.github.com${path}`, 'json', GH);

  const releases = await Promise.all(REPOS.map((repo) => settle(`github ${repo}`, async () =>
    (await api(`/repos/${repo}/releases?per_page=5`))
      // Skip drafts, pre-releases, nightlies and llama.cpp's per-commit bNNNN builds.
      .filter((r) => !r.draft && !r.prerelease && !/nightly|alpha|preview|rc\d*$|^b\d+$/i.test(r.tag_name))
      .filter((r) => inWindow(Date.parse(r.published_at)))
      .map((r) => ({ source: 'github', kind: 'release', repo, title: `${repo} ${r.name || r.tag_name}`,
        url: r.html_url, published: r.published_at, blurb: (r.body ?? '').slice(0, 800) })))));

  // ponytail: scrapes github.com/trending HTML (no API exists); breaks if GitHub changes markup
  const trending = await Promise.all((isPast ? [] : ['daily', 'weekly']).map((period) => // trending only describes today
    settle(`github trending ${period}`, async () => {
      const html = await get(`https://github.com/trending?since=${period}`, 'text');
      return html.split('<article class="Box-row">').slice(1).flatMap((row) => {
        const repo = row.match(/<h2[^>]*>\s*<a[^>]*href="\/([^"]+)"/)?.[1];
        const about = decode(row.match(/<p class="col-9[^>]*>([\s\S]*?)<\/p>/)?.[1]?.replace(/<[^>]+>/g, '').trim() ?? '');
        const gained = Number(row.match(/([\d,]+) stars (today|this week)/)?.[1]?.replace(/,/g, '') ?? 0);
        return repo && AI.test(`${repo} ${about}`)
          ? [{ source: 'github', kind: `trending-${period}`, repo, title: `Trending (${period}): ${repo}`,
            url: `https://github.com/${repo}`, published: iso(until), stars_gained: gained, blurb: about }]
          : [];
      });
    })));

  // New this week and already past 100 stars. Search allows 10 requests/minute anonymously.
  const from = new Date(Math.min(since, until - 7 * 86400000)).toISOString().slice(0, 10);
  const to = new Date(until).toISOString().slice(0, 10);
  const fresh = [];
  for (const term of ['llm', 'agent', 'mcp', 'model', 'inference']) {
    fresh.push(...await settle(`github search ${term}`, async () => {
      const { items = [] } = await api(`/search/repositories?sort=stars&order=desc&per_page=15&q=${
        encodeURIComponent(`created:${from}..${to} stars:>=100 ${term} in:name,description,topics`)}`);
      return items.map((r) => ({ source: 'github', kind: 'new-repo', repo: r.full_name, title: `New: ${r.full_name}`,
        url: r.html_url, published: r.created_at, stars: r.stargazers_count, blurb: r.description ?? '' }));
    }));
  }
  return [...releases.flat(), ...trending.flat(), ...fresh];
}

// AI Twitter: every post in the window from one curated X List, read through twitterapi.io
// (about $0.15 per 1,000 posts; X's own read API costs ~30x more). fromPosts() turns them into mentions.
const X_MAX_PAGES = 150; // ponytail: 20 posts a page, so a 3,000-post (~$0.45) daily ceiling; raise for bigger lists

async function x() {
  const { TWITTERAPI_KEY: key, X_LIST_ID: list } = process.env;
  if (!key || !list) throw new Error('set TWITTERAPI_KEY and X_LIST_ID to read AI Twitter');
  const posts = [];
  let cursor = '';
  for (let page = 0; page < X_MAX_PAGES; page++) {
    const r = await get(`https://api.twitterapi.io/twitter/list/tweets?listId=${list}&includeReplies=false`
      + `&sinceTime=${Math.floor(since / 1000)}&untilTime=${Math.floor(until / 1000)}&cursor=${encodeURIComponent(cursor)}`,
      'json', { 'X-API-Key': key });
    if (r.status === 'error') throw new Error(r.message);
    posts.push(...(r.tweets ?? []));
    if (!r.has_next_page || !r.next_cursor || !r.tweets?.length) break;
    cursor = r.next_cursor;
  }
  return fromPosts(posts);
}

// One failing source shouldn't sink the edition; record it and carry on.
const errors = [];
async function settle(name, fn) {
  try { return await fn(); } catch (e) { errors.push(`${name}: ${e.message}`); return []; }
}

const pools = await Promise.all(Object.entries({ labs, press, aggregators, x, hn, reddit, lobsters, papers, github })
  .map(([name, fn]) => settle(name, fn)));
const candidates = merge(pools.flat());

mkdirSync('drafts', { recursive: true });
const file = `drafts/${date}.json`;
writeFileSync(file, JSON.stringify({ date, window: { since: iso(since), until: iso(until) }, errors, candidates }, null, 2));

const counts = Object.groupBy(candidates, (c) => c.site ?? c.source);
console.log(`${file}: ${candidates.length} candidates`,
  Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, v.length])));
if (errors.length) console.warn('Source errors:\n  ' + errors.join('\n  '));
