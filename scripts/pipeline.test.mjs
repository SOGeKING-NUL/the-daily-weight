// node --test scripts/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cluster, fromPosts, merge, mustCover, summarize, urlKey } from './lib/candidates.mjs';
import { slugify, storyFile, unsupported } from './lib/story.mjs';

test('urlKey: one key per story however it is linked', () => {
  assert.equal(urlKey('https://www.openai.com/index/gpt/?utm_source=tldrai#top'), urlKey('https://openai.com/index/gpt'));
  assert.equal(urlKey('https://twitter.com/sama/status/123?s=20'), 'x.com/i/status/123');
  assert.equal(urlKey('https://threadreaderapp.com/thread/123.html'), 'x.com/i/status/123');
  assert.equal(urlKey('https://huggingface.co/papers/2609.01234'), urlKey('https://arxiv.org/pdf/2609.01234v2'));
  assert.notEqual(urlKey('https://news.ycombinator.com/item?id=1'), urlKey('https://news.ycombinator.com/item?id=2'));
});

const post = (id, extra) => ({ id, url: `https://x.com/u${id}/status/${id}`, text: `post ${id} https://t.co/x`,
  createdAt: 'Tue Sep 30 07:00:30 +0000 2026', likeCount: 10, author: { userName: `u${id}` }, ...extra });

test('fromPosts: links become mentions, reposts count once, quiet link-less posts drop', () => {
  const link = { entities: { urls: [{ expanded_url: 'https://example.com/paper?utm_source=x' }] } };
  const out = fromPosts([
    post('1', link),
    { retweeted_tweet: post('1', link) },        // repost of the same post
    post('2', { likeCount: 5 }),                  // no link, too quiet
    post('3', { likeCount: 500 }),                // no link, loud: stands alone
    post('4', { isReply: true, ...link }),        // replies are noise
  ]);
  assert.deepEqual(out.map((c) => c.url), ['https://example.com/paper', 'https://x.com/u3/status/3']);
  assert.equal(out[0].title, 'post 1');
});

test('merge: a real source takes the headline, signals add up, digest-only X links go', () => {
  const merged = merge([
    { source: 'x', title: 'wow', url: 'https://lab.ai/model', x_engagement: 100, x_posts: [{ url: 'a' }] },
    { source: 'labs', lab: 'OpenAI', title: 'Introducing Model', url: 'https://lab.ai/model/?utm_source=rss' },
    { source: 'x', title: 'yes', url: 'https://lab.ai/model', x_engagement: 50, x_posts: [{ url: 'b' }] },
    { source: 'hn', title: 'Model', url: 'https://lab.ai/model', discuss_url: 'https://news.ycombinator.com/item?id=9', points: 400 },
    { source: 'aggregator', aggregators: ['smol.ai'], title: 'someone', url: 'https://x.com/someone/status/5' },
  ]);
  assert.equal(merged.length, 1);
  const [c] = merged;
  assert.equal(c.title, 'Introducing Model');
  assert.equal(c.source, 'labs');
  assert.equal(c.x_engagement, 150);
  assert.equal(c.x_posts.length, 2);
  assert.equal(c.discuss_url, 'https://news.ycombinator.com/item?id=9');
  assert.deepEqual(c.seen_on, ['x', 'labs', 'x', 'hn']);
});

test('cluster: same repo and near-identical headlines group; unrelated stay apart', () => {
  const groups = cluster([
    { source: 'github', repo: 'vllm-project/vllm', title: 'vllm-project/vllm v0.30', url: 'https://github.com/vllm-project/vllm/releases/v0.30' },
    { source: 'github', repo: 'vllm-project/vllm', title: 'Trending (daily): vllm-project/vllm', url: 'https://github.com/vllm-project/vllm' },
    { source: 'press', title: 'Google releases Gemini 3.8 with native audio output', url: 'https://press.com/a' },
    { source: 'hn', title: 'Gemini 3.8 with native audio output released by Google', url: 'https://blog.google/b' },
    { source: 'hn', title: 'A database written in Rust for embedded devices', url: 'https://c.dev' },
    { source: 'hn', title: 'Gemini 4 Argon', url: 'https://d.dev' },
    { source: 'labs', title: 'Gemini 4 Argon: our next era of frontier intelligence', url: 'https://deepmind.google/e' },
    { source: 'hn', title: 'Gemini 4 Flash pricing', url: 'https://f.dev' },
  ]);
  assert.deepEqual(groups.map((g) => g.length).sort(), [1, 1, 2, 2, 2]);
});

test('mustCover: core labs, two digests and big HN threads must be decided on', () => {
  const [lab, digests, hn, quiet] = mustCover([
    [{ source: 'labs', lab: 'Anthropic', title: 'a', url: 'https://anthropic.com/news/a' }],
    [{ source: 'aggregator', aggregators: ['smol.ai', 'TLDR AI'], title: 'b', url: 'https://b.com' }],
    [{ source: 'hn', title: 'c', url: 'https://c.com', points: 350, discuss_url: 'https://news.ycombinator.com/item?id=3' }],
    [{ source: 'press', title: 'd', url: 'https://d.com' }],
  ].map(summarize));
  assert.deepEqual([lab.must_cover, digests.must_cover, hn.must_cover, quiet.must_cover], [true, true, true, false]);
  assert.deepEqual(hn.reasons, ['300+ points on HN']);
});

test('unsupported: numbers and mid-sentence names the source never mentions', () => {
  const source = 'OpenAI released GPT-6.1 Sol on Tuesday. It costs $2,000 a month and is 40% faster than GPT-6 Sol.';
  const ok = 'The model is GPT-6.1 Sol from OpenAI. It costs $2000 a month and runs 40% faster, OpenAI says.';
  assert.deepEqual(unsupported(ok, source), []);
  const bad = 'Google says the model scores 92% on SWE-bench. Anthropic declined to comment.';
  assert.deepEqual(unsupported(bad, source), ['92', 'SWE-bench']); // "Google" and "Anthropic" start sentences
  assert.deepEqual(unsupported('See [the post](https://x.com/a/status/123) by OpenAI.', source), []);
});

test('storyFile: front matter the content schema accepts', () => {
  const md = storyFile({ date: '2026-10-01', title: 'A "quoted" title: yes', authors: ['A', 'B'], url: 'https://a.b',
    discuss_url: null, source: 'labs', section: 'models', interest_score: 7, recommended: true, must_read: false,
    why_read: 'Why.', summary: 'Sum.', image: null, sample: false }, 'Body.\n');
  assert.match(md, /^---\ndate: "2026-10-01"\ntitle: "A \\"quoted\\" title: yes"\nauthors: \["A","B"\]\n/);
  assert.match(md, /\nimage: null\nsample: false\n---\n\nBody.\n$/);
  assert.equal(slugify('Gemini 4 Argon: our next era!'), 'gemini-4-argon-our-next-era');
});
