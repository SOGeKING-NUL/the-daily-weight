// Pure candidate logic shared by scripts/fetch.mjs (merge) and scripts/rank.mjs (heat, clusters,
// must-cover). No I/O here, so scripts/candidates.test.mjs can check it with plain objects.

// ---------- one story, one key ----------

// Same story, same key: no tracking parameters, no www., twitter.com is x.com.
const TRACKING = /^(utm_\w+|ref|ref_src|s|t|source|accessToken)$/i;
export function clean(url) {
  try {
    const u = new URL(url);
    u.hash = '';
    for (const p of [...u.searchParams.keys()]) if (TRACKING.test(p)) u.searchParams.delete(p);
    u.host = u.host.replace(/^(www|mobile)\./, '').replace(/^twitter\.com$/, 'x.com');
    return u.toString();
  } catch { return url; }
}
export const urlKey = (url) => clean(url).replace(/^https?:\/\//, '').replace(/\/$/, '').toLowerCase()
  // one X post however it's linked: x.com/<anyone>/status/<id>, or a Thread Reader copy of it
  .replace(/^(x\.com\/[^/]+|threadreaderapp\.com\/thread)\/(status\/)?(\d+).*$/, 'x.com/i/status/$3')
  // one paper: its arXiv abstract, PDF, or Hugging Face papers page
  .replace(/^(arxiv\.org\/(abs|pdf)|huggingface\.co\/papers)\/(\d{4}\.\d{4,5})(v\d+)?.*$/, 'arxiv.org/abs/$3');

// ---------- X posts to candidates ----------

export const engagement = (t) => (t.likeCount ?? 0) + 2 * (t.retweetCount ?? 0) + 3 * (t.quoteCount ?? 0) + (t.replyCount ?? 0);
const X_MIN_ENGAGEMENT = 100; // a post with no link needs this much attention to stand as its own candidate
const isXPost = (url) => /\/\/(www\.)?(x|twitter)\.com\//.test(url);

// twitterapi.io post objects to candidates. A post that links somewhere is a mention of that link,
// so a paper five researchers post about adds up on one candidate; a post with no link (an
// announcement written on X) is a candidate itself if it drew enough attention.
export function fromPosts(posts) {
  const out = [];
  const seen = new Set();
  for (const raw of posts) {
    const t = raw.retweeted_tweet ?? raw; // a repost by a list member counts for the original
    if (!t?.id || seen.has(t.id) || t.isReply) continue;
    seen.add(t.id);
    const post = { url: clean(t.url ?? `https://x.com/${t.author?.userName ?? 'i'}/status/${t.id}`), engagement: engagement(t),
      author: `@${t.author?.userName}`, author_name: t.author?.name, followers: t.author?.followers };
    const text = (t.text ?? '').replace(/https:\/\/t\.co\/\S+/g, '').replace(/\s+/g, ' ').trim();
    const mention = (url) => ({ source: 'x', title: text.slice(0, 200) || url, url, published: new Date(Date.parse(t.createdAt)).toISOString(),
      x_engagement: post.engagement, x_posts: [post] });
    const links = (t.entities?.urls ?? []).map((u) => u.expanded_url).filter((u) => u && !isXPost(u));
    if (t.quoted_tweet?.id) links.push(`https://x.com/${t.quoted_tweet.author?.userName ?? 'i'}/status/${t.quoted_tweet.id}`);
    for (const link of new Set(links.map(clean))) out.push(mention(link));
    if (!links.length && post.engagement >= X_MIN_ENGAGEMENT) out.push({ ...mention(post.url), text });
  }
  return out;
}

// ---------- merge by URL ----------

// The same link often arrives from several places (a lab feed, its HN thread, forty X posts):
// merge, don't drop, so the story keeps its discussion link and the ranker sees how far it travelled.
const weak = (c) => c.source === 'aggregator' || c.source === 'x';
export function merge(all) {
  const byUrl = new Map();
  for (const c of all.filter((c) => c.url)) {
    const key = urlKey(c.url);
    const prev = byUrl.get(key);
    if (!prev) { byUrl.set(key, { ...c, seen_on: [c.site ?? c.source] }); continue; }
    // A real source beats a digest's anchor text or a post's first line as the headline.
    const [base, extra] = weak(prev) && !weak(c) ? [c, prev] : [prev, c];
    const next = { ...base, seen_on: [...prev.seen_on, c.site ?? c.source] };
    for (const k of ['discuss_url', 'points', 'comments', 'upvotes']) next[k] ??= extra[k];
    if (prev.x_engagement || c.x_engagement) next.x_engagement = (prev.x_engagement ?? 0) + (c.x_engagement ?? 0);
    for (const k of ['x_posts', 'aggregators']) if (prev[k] || c[k]) next[k] = [...(prev[k] ?? []), ...(c[k] ?? [])];
    byUrl.set(key, next);
  }
  // An X post that only a digest linked has no readable text for us; it can boost a candidate, not be one.
  return [...byUrl.values()].filter((c) => !(c.source === 'aggregator' && urlKey(c.url).startsWith('x.com/i/status/')));
}

// ---------- heat ----------

// The labs whose every post is a decision the paper has to make (cover it, or say why not).
export const CORE_LABS = new Set(['OpenAI', 'Google DeepMind', 'Anthropic', 'Qwen']);

// ponytail: hand-tuned weights. Log scales so one huge signal can't drown the rest; adjust after
// looking at what readers click (Resend, Cloudflare Web Analytics, X metrics).
const log2 = (n) => Math.log2(1 + Math.max(0, n ?? 0));
export function heat(c) {
  // Big HN stories with no AI word in them come along only so the writer can spot a hidden AI story.
  return (c.ai_match === false ? 0.3 : 1) * (3 * log2(c.points) + log2(c.comments)
    + 2 * log2((c.x_engagement ?? 0) / 10)
    + 1.5 * log2(c.upvotes)
    + log2((c.stars_gained ?? 0) / 50) + log2((c.stars ?? 0) / 100)
    + 4 * new Set(c.aggregators ?? []).size
    + 2 * (new Set(c.seen_on ?? []).size - 1)
    + (c.source === 'labs' ? (CORE_LABS.has(c.lab) ? 12 : 4) : 0)
    + (c.source === 'press' ? 3 : 0)
    + (c.rank ? Math.max(0, 6 - c.rank / 10) : 0));
}

// ---------- clusters ----------

const STOP = new Set('the and for with from that this into over your what how why are its has have new now via using launches launch introducing announces releases release says will can our you their show just'.split(' '));
// Words that tell headlines apart; version numbers ("4", "gpt-6.1") count however short.
const words = (s = '') => new Set(s.toLowerCase().replace(/[^\p{L}\p{N}.\-]+/gu, ' ').split(' ')
  .map((w) => w.replace(/^[.\-]+|[.\-]+$/g, '')).filter((w) => (w.length > 2 || /\d/.test(w)) && !STOP.has(w)));
// Same event: mostly the same words, or a short headline ("Gemini 4 Argon") contained in a longer one.
export function similar(a, b) {
  const [x, y] = [words(a), words(b)];
  const small = Math.min(x.size, y.size);
  if (small < 2) return false;
  let both = 0;
  for (const w of x) if (y.has(w)) both++;
  return both / (x.size + y.size - both) >= 0.5 || (small <= 4 && both >= 2 && both / small >= 0.75);
}

// Groups candidates that are one event: same repo, an X post and a candidate that quotes it, or
// near-identical headlines. ponytail: O(n²) over the hottest few hundred; an inverted index if n grows.
export function cluster(cands) {
  const parent = cands.map((_, i) => i);
  const root = (i) => (parent[i] === i ? i : (parent[i] = root(parent[i])));
  const join = (i, j) => { parent[root(i)] = root(j); };
  const byKey = new Map(cands.map((c, i) => [urlKey(c.url), i]));
  cands.forEach((c, i) => {
    for (const p of c.x_posts ?? []) if (byKey.has(urlKey(p.url))) join(i, byKey.get(urlKey(p.url)));
  });
  for (let i = 0; i < cands.length; i++) {
    for (let j = i + 1; j < cands.length; j++) {
      const [a, b] = [cands[i], cands[j]];
      if ((a.repo && a.repo === b.repo) || similar(a.title, b.title)) join(i, j);
    }
  }
  const groups = new Map();
  cands.forEach((c, i) => groups.set(root(i), [...(groups.get(root(i)) ?? []), c]));
  return [...groups.values()];
}

// ---------- the cluster the writer sees ----------

// Who to cite: the original beats the coverage of it.
const AUTHORITY = ['labs', 'arxiv', 'github', 'hn', 'press', 'reddit', 'x', 'aggregator'];
const discussRank = (u = '') => [/news\.ycombinator\.com/, /lobste\.rs/, /reddit\.com/, /huggingface\.co\/papers/].findIndex((r) => r.test(u));

export function summarize(members) {
  const byHeat = [...members].sort((a, b) => heat(b) - heat(a));
  const primary = [...byHeat].sort((a, b) => AUTHORITY.indexOf(a.source) - AUTHORITY.indexOf(b.source))[0];
  const posts = members.flatMap((m) => m.x_posts ?? []).sort((a, b) => b.engagement - a.engagement);
  const discuss = members.map((m) => m.discuss_url).filter((u) => u && discussRank(u) >= 0)
    .sort((a, b) => discussRank(a) - discussRank(b))[0] ?? posts[0]?.url ?? null;
  return {
    heat: Math.round(members.reduce((n, m) => n + heat(m), 0) * 10) / 10,
    title: primary.title, url: primary.url, source: primary.source, discuss_url: discuss,
    published: primary.published,
    signals: {
      hn_points: Math.max(0, ...members.map((m) => (m.discuss_url?.includes('ycombinator') ? m.points ?? 0 : 0))),
      x_engagement: members.reduce((n, m) => n + (m.x_engagement ?? 0), 0),
      x_posts: posts.length,
      aggregators: [...new Set(members.flatMap((m) => m.aggregators ?? []))],
      seen_on: [...new Set(members.flatMap((m) => m.seen_on ?? [m.source]))],
    },
    top_posts: posts.slice(0, 3),
    members: byHeat.slice(0, 6).map(({ x_posts, seen_on, ...m }) => m),
  };
}

// Stories the paper must decide on: publish, or write down why not (scripts/check.mjs holds it to that).
export function mustCover(clusters) {
  const xTop = new Set([...clusters].filter((c) => c.signals.x_engagement > 0)
    .sort((a, b) => b.signals.x_engagement - a.signals.x_engagement).slice(0, 10));
  for (const c of clusters) {
    const reasons = [];
    const lab = c.members.find((m) => m.source === 'labs' && CORE_LABS.has(m.lab));
    if (lab) reasons.push(`${lab.lab} post`);
    if (c.members.some((m) => m.discuss_url?.includes('ycombinator') && m.points >= 300 && m.ai_match !== false)) reasons.push('300+ points on HN');
    if (xTop.has(c)) reasons.push('top 10 on AI Twitter');
    if (c.signals.aggregators.length >= 2) reasons.push(`in ${c.signals.aggregators.join(' and ')}`);
    if (c.signals.seen_on.length >= 3) reasons.push(`seen on ${c.signals.seen_on.length} sources`);
    c.must_cover = reasons.length > 0;
    c.reasons = reasons;
  }
  return clusters;
}
