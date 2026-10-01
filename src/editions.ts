import { getCollection, type CollectionEntry } from 'astro:content';

export type Story = CollectionEntry<'stories'>;
export type Edition = { date: string; stories: Story[] };

export const SOURCES = {
  hn: 'HN', reddit: 'Reddit', x: 'X', labs: 'Labs', arxiv: 'arXiv', github: 'GitHub', press: 'Press',
} as const;

// Every source filter a story answers to: its primary type, plus HN, Reddit or X when that's
// where it's being discussed. A lab post with a big HN thread shows under both Labs and HN.
export const sourcesOf = ({ data: d }: Story) => {
  const tags = new Set<string>([d.source]);
  if (d.discuss_url?.includes('news.ycombinator.com')) tags.add('hn');
  if (d.discuss_url?.includes('reddit.com')) tags.add('reddit');
  if (/\/\/(x|twitter)\.com\//.test(d.discuss_url ?? '')) tags.add('x');
  return [...tags];
};

// Attributes the front-page filter reads; shared by story blocks and the headline rail.
export const filterAttrs = (story: Story) => ({
  'data-source': sourcesOf(story).join(' '),
  'data-rec': String(story.data.recommended || story.data.must_read),
  'data-must': String(story.data.must_read),
});
export const SECTIONS = {
  models: 'Models', agents: 'Agents', infra: 'Infra', research: 'Research', safety: 'Safety', industry: 'Industry',
} as const;

// Newest edition first; stories within an edition by interest, highest first.
export async function getEditions(): Promise<Edition[]> {
  const byDate = new Map<string, Story[]>();
  for (const s of await getCollection('stories')) {
    byDate.set(s.data.date, [...(byDate.get(s.data.date) ?? []), s]);
  }
  return [...byDate]
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([date, stories]) => ({
      date,
      stories: stories.sort((a, b) => b.data.interest_score - a.data.interest_score),
    }));
}

export const slug = (s: Story) => s.id.split('/').pop()!;
export const href = (s: Story) => `/edition/${s.data.date}/${slug(s)}`;

export const longDate = (date: string) =>
  new Date(`${date}T00:00:00Z`).toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC',
  });

export const plural = (n: number) => `${n} ${n === 1 ? 'Story' : 'Stories'}`;

// One edition as JSON for agents and the terminal reader (/json, /edition/<date>.json).
export const editionJson = (e: Edition) => JSON.stringify({
  date: e.date,
  count: e.stories.length,
  stories: e.stories.map((s) => ({
    ...s.data, slug: slug(s), link: href(s), sources: sourcesOf(s), body: s.body?.trim(),
  })),
}, null, 2);

export const jsonResponse = (body: string) =>
  new Response(body, { headers: { 'Content-Type': 'application/json; charset=utf-8' } });

// Front page split: lead, two seconds, then the rest boxed by section (only sections with stories left).
export function frontPage({ stories }: Edition) {
  const [lead, ...others] = stories;
  const rest = others.slice(2);
  const sections = Object.entries(SECTIONS)
    .map(([key, label]) => ({ key, label, stories: rest.filter((s) => s.data.section === key) }))
    .filter((s) => s.stories.length);
  return { lead, seconds: others.slice(0, 2), sections };
}
