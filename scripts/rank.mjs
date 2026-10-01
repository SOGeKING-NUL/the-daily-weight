// Turns one edition's candidates (drafts/<date>.json) into the clusters the writer chooses from
// (drafts/<date>.ranked.json): grouped by event, scored by heat, must-cover flagged. No LLM; the
// rules live in scripts/lib/candidates.mjs.
//
//   node scripts/rank.mjs              newest drafts file
//   node scripts/rank.mjs 2026-10-01

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cluster, heat, mustCover, summarize, urlKey } from './lib/candidates.mjs';

const POOL = 400; // the hottest candidates get clustered
const TOP = 60;   // what the writer's pick call sees, plus any must-cover beyond it

const date = process.argv[2]
  ?? readdirSync('drafts').filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().at(-1)?.slice(0, 10);
const { candidates } = JSON.parse(readFileSync(`drafts/${date}.json`, 'utf8'));

// Already in the paper (any edition, including stories already written for this date): don't offer again.
const published = new Set(readdirSync('content/editions', { recursive: true })
  .filter((f) => f.endsWith('.md'))
  .map((f) => readFileSync(`content/editions/${f}`, 'utf8').match(/^url: "([^"]+)"/m)?.[1])
  .filter(Boolean).map(urlKey));

const pool = candidates.filter((c) => !published.has(urlKey(c.url))).sort((a, b) => heat(b) - heat(a)).slice(0, POOL);
const clusters = mustCover(cluster(pool).map(summarize)).sort((a, b) => b.heat - a.heat)
  .filter((c, i) => i < TOP || c.must_cover)
  .map((c, i) => ({ id: `c${i + 1}`, ...c }));

const file = `drafts/${date}.ranked.json`;
writeFileSync(file, JSON.stringify({ date, clusters }, null, 2));
const must = clusters.filter((c) => c.must_cover);
console.log(`${file}: ${clusters.length} clusters from ${pool.length} candidates, ${must.length} must-cover`);
for (const c of must) console.log(`  ${c.id} [${c.reasons.join('; ')}] ${c.title.slice(0, 90)}`);
