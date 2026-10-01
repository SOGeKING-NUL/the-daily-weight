// Posts the edition on X. Morning: a thread (the edition card and three headlines, then the top
// stories with their cards, quoting the X post that broke a story where there is one, then the one
// link to the edition). Evening: the top three as single posts, for the US morning. Re-runs don't
// double-post: the account's own recent posts are checked first.
//
// Pay-per-use pricing is why the thread is shaped this way: a post costs about $0.015, a post with a
// URL about $0.20, so the link goes in one post at the end (which is also what the algorithm prefers).
// Needs X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN and X_ACCESS_SECRET (the bot account's OAuth 1.0a keys).
//
//   node scripts/post-x.mjs morning [date] [--dry-run]
//   node scripts/post-x.mjs evening [date] [--dry-run]
//   node scripts/post-x.mjs --delete <post id>

import { TwitterApi } from 'twitter-api-v2';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { editionStories } from './cards.mjs';

const MORNING = 5; // stories in the thread (cards exist for the top 8)
const EVENING = 3;
const SITE = (process.env.SITE_URL ?? 'https://thedailyweight.example').replace(/\/$/, '');

const args = process.argv.slice(2);
const dry = args.includes('--dry-run');
const mode = args.find((a) => ['morning', 'evening'].includes(a));
const date = args.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a)) ?? readdirSync('content/editions').sort().at(-1);
const longDate = new Date(`${date}T00:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });

const client = () => {
  const { X_API_KEY: appKey, X_API_SECRET: appSecret, X_ACCESS_TOKEN: accessToken, X_ACCESS_SECRET: accessSecret } = process.env;
  if (!appKey || !appSecret || !accessToken || !accessSecret) throw new Error('set X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN and X_ACCESS_SECRET');
  return new TwitterApi({ appKey, appSecret, accessToken, accessSecret }).readWrite;
};

if (args.includes('--delete')) {
  const id = args[args.indexOf('--delete') + 1];
  await client().v2.deleteTweet(id);
  console.log(`deleted ${id}`);
  process.exit(0);
}
if (!mode) throw new Error('usage: node scripts/post-x.mjs morning|evening [date] [--dry-run]');

// 280 characters, URLs aside (we only put one in the last post).
const fit = (title, more) => {
  const room = 275 - title.length - 2;
  return room < 40 ? title : `${title}\n\n${more.length > room ? `${more.slice(0, room - 1).replace(/\s+\S*$/, '')}…` : more}`;
};
const xPost = (url) => (url ?? '').match(/^https:\/\/(?:www\.)?(?:x|twitter)\.com\/[^/]+\/status\/(\d+)/)?.[1];
const card = (s) => (existsSync(`public/cards/${date}/${s.slug}.png`) ? `public/cards/${date}/${s.slug}.png` : null);

const stories = editionStories(date);
const posts = mode === 'morning'
  ? [
    { text: `Today in AI — ${longDate}\n\n${stories.slice(0, 3).map((s, i) => `${i + 1}. ${s.data.title}`).join('\n')}\n\n${stories.length} stories in today's edition. Thread ↓`,
      image: `public/cards/${date}.png` },
    ...stories.slice(0, MORNING).map((s) => ({ text: fit(s.data.title, s.data.why_read), image: card(s), quote: xPost(s.data.discuss_url) })),
    { text: `The full edition, with sources and discussion for every story:\n${SITE}/edition/${date}` },
  ]
  : stories.slice(0, EVENING).map((s) => ({ text: fit(s.data.title, s.data.summary), image: card(s), quote: xPost(s.data.discuss_url) }));

if (dry) {
  for (const p of posts) console.log(`--- ${p.image ?? 'no image'}${p.quote ? ` quoting ${p.quote}` : ''}\n${p.text}\n`);
  process.exit(0);
}

const x = client();
// What the account already said today, so a re-run (or the evening job on a morning that
// overran) adds nothing twice. Owned reads cost a tenth of a cent each.
const me = await x.v2.me();
const recent = (await x.v2.userTimeline(me.data.id, { max_results: 50, exclude: ['retweets'] })).data.data ?? [];
const said = (text) => recent.some((t) => t.text.startsWith(text.split('\n')[0]));

const upload = async (file) => (file ? { media_ids: [await x.v2.uploadMedia(readFileSync(file), { media_type: 'image/png', media_category: 'tweet_image' })] } : undefined);
const payload = async (p) => ({ text: p.text, media: await upload(p.image), quote_tweet_id: p.quote });

if (mode === 'morning') {
  if (said(posts[0].text)) { console.log('this morning\'s thread is already up'); process.exit(0); }
  const thread = await x.v2.tweetThread(await Promise.all(posts.map(payload)));
  console.log(`thread of ${thread.length}: https://x.com/${me.data.username}/status/${thread[0].data.id}`);
} else {
  for (const p of posts) {
    if (said(p.text)) { console.log(`already posted: ${p.text.split('\n')[0]}`); continue; }
    const { data } = await x.v2.tweet(await payload(p));
    console.log(`posted https://x.com/${me.data.username}/status/${data.id}`);
  }
}
