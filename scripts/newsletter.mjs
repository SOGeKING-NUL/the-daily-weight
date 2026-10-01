// Sends one edition's email (dist/email/<date>.html, built by `npm run build`) as a Resend broadcast
// to the subscriber segment. Safe to re-run: an edition that already went out is skipped.
// Needs RESEND_API_KEY, RESEND_SEGMENT_ID and MAIL_FROM ("The Daily Weight <paper@your.domain>").
//
//   node scripts/newsletter.mjs                 newest edition, to the list
//   node scripts/newsletter.mjs 2026-10-01
//   node scripts/newsletter.mjs --to you@x.com  a test copy to one address, nothing to the list

import { readdirSync, readFileSync } from 'node:fs';
import { readStory } from './lib/story.mjs';

try { process.loadEnvFile(); } catch {} // .env, when there is one

const args = process.argv.slice(2);
const date = args.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a)) ?? readdirSync('content/editions').sort().at(-1);
const to = args.includes('--to') ? args[args.indexOf('--to') + 1] : null;
const { RESEND_API_KEY: key, RESEND_SEGMENT_ID: segment, MAIL_FROM: from } = process.env;
if (!key || !from || (!to && !segment)) throw new Error('set RESEND_API_KEY, MAIL_FROM and RESEND_SEGMENT_ID');

const html = readFileSync(`dist/email/${date}.html`, 'utf8');
const dir = `content/editions/${date}`;
const stories = readdirSync(dir).map((f) => readStory(readFileSync(`${dir}/${f}`, 'utf8')).data)
  .sort((a, b) => b.interest_score - a.interest_score);
// Under about 50 characters so phones show all of it: the lead, then how much more there is.
const lead = stories[0].title;
const subject = `${lead.length > 44 ? `${lead.slice(0, 43).replace(/\s+\S*$/, '')}…` : lead} +${stories.length - 1} more`;

async function api(method, path, body) {
  const res = await fetch(`https://api.resend.com${path}`, { method, body: body && JSON.stringify(body),
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' } });
  if (!res.ok) throw new Error(`Resend ${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

if (to) {
  const { id } = await api('POST', '/emails', { from, to, subject, html: html.replace('{{{RESEND_UNSUBSCRIBE_URL}}}', '#') });
  console.log(`test copy ${id} sent to ${to}: "${subject}"`);
} else {
  const name = `edition-${date}`;
  const { data = [] } = await api('GET', '/broadcasts');
  const sent = data.find((b) => b.name === name && b.status !== 'draft');
  if (sent) { console.log(`${name} already sent (${sent.id}); nothing to do`); process.exit(0); }
  const { id } = await api('POST', '/broadcasts', { name, segment_id: segment, from, subject, html, send: true });
  console.log(`broadcast ${id} sent: "${subject}"`);
}
