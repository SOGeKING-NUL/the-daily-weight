// Share cards in the paper's own look (paper, ink, one red, Lora headlines, the double rule),
// 1200x630 PNG: one for the edition and one for each of its top stories. They are the link
// previews (og:image) on X and elsewhere, and the images in the X thread (scripts/post-x.mjs).
//
//   node scripts/cards.mjs [date]   writes public/cards/<date>.png and public/cards/<date>/<slug>.png
//
// Fonts: Lora (The Lora Project Authors) and PT Sans / PT Serif (ParaType), SIL Open Font
// License 1.1, in scripts/fonts. satori needs WOFF or TTF, not the WOFF2 the site loads.

import satori from 'satori';
import { Resvg } from '@resvg/resvg-js';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { readStory } from './lib/story.mjs';

export const TOP = 8; // story cards for the stories the X account can post; the rest use their photo
const INK = '#1a1a1a', PAPER = '#fbfaf6', MUTED = '#5b564d', RULE = '#dcd6cb', ACCENT = '#b0071e';
const SECTIONS = { models: 'Models', agents: 'Agents', infra: 'Infra', research: 'Research', safety: 'Safety', industry: 'Industry' };
const font = (f) => readFileSync(`scripts/fonts/${f}`);
const fonts = [
  { name: 'Lora', data: font('lora-latin-700-normal.woff'), weight: 700, style: 'normal' },
  { name: 'PT Sans', data: font('pt-sans-latin-700-normal.woff'), weight: 700, style: 'normal' },
  { name: 'PT Serif', data: font('pt-serif-latin-400-normal.woff'), weight: 400, style: 'normal' },
  { name: 'PT Serif', data: font('pt-serif-latin-400-italic.woff'), weight: 400, style: 'italic' },
];
const SITE = (process.env.SITE_URL ?? 'https://thedailyweight.example').replace(/\/$/, '');

// A tiny element builder for satori's object form; every box is a flex column unless it says otherwise.
const h = (style, ...children) => ({ type: 'div', props: { style: { display: 'flex', flexDirection: 'column', ...style }, children: children.flat() } });
const text = (style, s) => ({ type: 'div', props: { style: { display: 'flex', ...style }, children: s } });
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1).replace(/\s+\S*$/, '')}…` : s);
const longDate = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });

// The thick-and-thin rule under the nameplate.
const doubleRule = h({ width: '100%' }, h({ height: 4, background: INK }), h({ height: 3 }), h({ height: 1, background: INK }));

async function png(tree) {
  const svg = await satori(h({ width: 1200, height: 630, background: PAPER, color: INK, padding: '48px 64px' }, tree), { width: 1200, height: 630, fonts });
  return new Resvg(svg, { fitTo: { mode: 'width', value: 1200 } }).render().asPng();
}

export function storyCard(date, d) {
  const size = d.title.length <= 60 ? 66 : d.title.length <= 100 ? 56 : 48;
  return png([
    h({ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end', paddingBottom: 12 },
      text({ fontFamily: 'Lora', fontSize: 36, letterSpacing: -1 }, 'The Daily Weight'),
      text({ fontFamily: 'PT Sans', fontSize: 22, color: MUTED }, longDate(date))),
    doubleRule,
    h({ flexGrow: 1, justifyContent: 'center' },
      h({ flexDirection: 'row', fontFamily: 'PT Sans', fontSize: 26, marginBottom: 18 },
        text({ color: ACCENT }, SECTIONS[d.section] ?? ''),
        d.must_read || d.recommended
          ? text({ color: MUTED, marginLeft: 14, paddingLeft: 14, borderLeft: `1px solid ${RULE}` }, d.must_read ? 'Must read' : 'Recommended')
          : []),
      text({ fontFamily: 'Lora', fontSize: size, lineHeight: 1.08, letterSpacing: -1.5 }, clip(d.title, 140)),
      text({ fontFamily: 'PT Serif', fontSize: 27, lineHeight: 1.4, color: MUTED, marginTop: 22 }, clip(d.why_read ?? '', 150))),
    h({ flexDirection: 'row', justifyContent: 'space-between', borderTop: `1px solid ${RULE}`, paddingTop: 14,
      fontFamily: 'PT Sans', fontSize: 21, color: MUTED },
      text({}, new URL(SITE).host),
      text({}, `Source: ${new URL(d.url).host.replace(/^www\./, '')}`)),
  ]);
}

export function editionCard(date, stories) {
  return png([
    h({ alignItems: 'center', borderBottom: `1px solid ${RULE}`, paddingBottom: 10, fontFamily: 'PT Sans', fontSize: 22, color: MUTED },
      text({}, `${longDate(date)} · ${stories.length} ${stories.length === 1 ? 'Story' : 'Stories'}`)),
    h({ alignItems: 'center', padding: '18px 0 14px' },
      text({ fontFamily: 'Lora', fontSize: 104, letterSpacing: -3, lineHeight: 1 }, 'The Daily Weight'),
      text({ fontFamily: 'PT Serif', fontStyle: 'italic', fontSize: 28, color: MUTED, marginTop: 8 }, 'An AI Newspaper')),
    doubleRule,
    h({ marginTop: 18 }, stories.slice(0, 3).map((s, i) =>
      h({ flexDirection: 'row', alignItems: 'flex-start', padding: '12px 0', borderBottom: i < 2 ? `1px solid ${RULE}` : 'none' },
        text({ fontFamily: 'PT Sans', fontSize: 28, lineHeight: 1.3, color: ACCENT, width: 40 }, String(i + 1)),
        text({ fontFamily: 'Lora', fontSize: 31, lineHeight: 1.2, flex: 1 }, clip(s.data.title, 82))))),
  ]);
}

// Stories of one edition, in paper order (interest, highest first), with their slugs.
export function editionStories(date) {
  const dir = `content/editions/${date}`;
  return readdirSync(dir).filter((f) => f.endsWith('.md'))
    .map((f) => ({ slug: f.slice(0, -3), ...readStory(readFileSync(`${dir}/${f}`, 'utf8')) }))
    .sort((a, b) => b.data.interest_score - a.data.interest_score);
}

if (process.argv[1]?.endsWith('cards.mjs')) {
  const date = process.argv[2] ?? readdirSync('content/editions').sort().at(-1);
  const stories = editionStories(date);
  mkdirSync(`public/cards/${date}`, { recursive: true });
  writeFileSync(`public/cards/${date}.png`, await editionCard(date, stories));
  for (const s of stories.slice(0, TOP)) writeFileSync(`public/cards/${date}/${s.slug}.png`, await storyCard(date, s.data));
  console.log(`public/cards/${date}.png and ${Math.min(TOP, stories.length)} story cards`);
}
