// The checks that stand in for a human editor before an edition goes out:
//   1. coverage: every must-cover cluster from rank.mjs was written, or rejected with a reason
//   2. links: every story's source still answers (a dead one is dropped, not published)
//   3. schema: `npm run build` validates every story's front matter
// Exits 1 if the build fails (nothing should publish) and 3 if must-cover stories are undecided,
// so the workflow can run `node scripts/write.mjs --gaps` once and check again with --final.
// With --final, gaps are written to drafts/<date>.gaps.md (the workflow files it as an issue) and the run passes.
//
//   node scripts/check.mjs [date] [--final]

import { execFileSync, execSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const date = args.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a))
  ?? readdirSync('drafts').filter((f) => f.endsWith('.ranked.json')).sort().at(-1)?.slice(0, 10);
const UA = { 'User-Agent': 'Mozilla/5.0 (compatible; TheDailyWeight/0.3; link check)' };

// ---------- 2. links ----------

// Sites that turn bots away (openai.com answers 403) are fine; gone is not.
async function alive(url) {
  try {
    const res = await fetch(url, { method: 'GET', redirect: 'follow', headers: UA, signal: AbortSignal.timeout(20000) });
    return res.status < 400 || [401, 403, 405, 429].includes(res.status);
  } catch { return false; }
}

const record = `drafts/${date}.decisions.json`;
const decisions = existsSync(record) ? JSON.parse(readFileSync(record, 'utf8')) : { written: [], rejections: [] };
const dir = `content/editions/${date}`;
const stories = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.md')) : [];
for (const f of stories) {
  const url = readFileSync(`${dir}/${f}`, 'utf8').match(/^url: "([^"]+)"/m)?.[1];
  if (url && !(await alive(url))) {
    execFileSync('node', ['scripts/drop.mjs', `${dir}/${f}`], { stdio: 'inherit' });
    const w = decisions.written.find((x) => x.file?.endsWith(`/${f}`));
    if (w) decisions.rejections.push({ id: w.id, reason: `source link is dead: ${url}` });
    console.warn(`dropped ${f}: ${url} does not answer`);
  }
}
writeFileSync(record, JSON.stringify(decisions, null, 2));

// ---------- 3. schema ----------

try { execSync('npm run build', { stdio: 'inherit' }); } catch {
  console.error('Build failed: fix the story front matter above before anything publishes.');
  process.exit(1);
}

// ---------- 1. coverage ----------

const ranked = JSON.parse(readFileSync(`drafts/${date}.ranked.json`, 'utf8')).clusters;
const live = new Set((existsSync(dir) ? readdirSync(dir) : []).map((f) => `${dir}/${f}`));
const done = new Set([
  ...decisions.written.filter((w) => live.has(w.file)).map((w) => w.id),
  ...decisions.rejections.filter((r) => r.reason).map((r) => r.id),
]);
const gaps = ranked.filter((c) => c.must_cover && !done.has(c.id));
console.log(`${date}: ${live.size} stories, ${ranked.filter((c) => c.must_cover).length - gaps.length} must-cover decided, ${gaps.length} undecided`);
for (const r of decisions.rejections) console.log(`  rejected ${r.id}: ${r.reason}`);

if (gaps.length) {
  for (const c of gaps) console.warn(`  undecided ${c.id} [${c.reasons.join('; ')}] ${c.title}`);
  if (!args.includes('--final')) process.exit(3);
  writeFileSync(`drafts/${date}.gaps.md`, `The ${date} edition went out without a decision on these must-cover stories:\n\n${
    gaps.map((c) => `- [${c.title}](${c.url}): ${c.reasons.join('; ')}`).join('\n')}\n\nAdd any that belong with a story file in content/editions/${date}/ and push.\n`);
}
