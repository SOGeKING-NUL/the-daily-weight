// Finds a freely licensed landscape photo on Wikimedia Commons for one story, saves it to
// public/images/<date>-<slug>.jpg and writes image / image_credit / image_source into the front matter.
//
//   node scripts/images.mjs content/editions/2026-10-01/some-story.md "server racks data center"
//
// Pick generic subjects. Skip anything showing real people or brand logos.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename, dirname } from 'node:path';

const [file, query] = process.argv.slice(2);
if (!file || !query) {
  console.error('usage: node scripts/images.mjs <story.md> "<search query>"');
  process.exit(1);
}

const UA = { 'User-Agent': 'TheDailyWeight/0.1 (image credits kept in front matter)' };
const LICENSE = /^(CC0|CC BY(-SA)? [\d.]+|Public domain)$/i;
const AVOID = /dall|midjourney|stable diffusion|ai-generated|ai generated|logo|portrait|headshot/i;
const strip = (s = '') => s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

// Commons rate-limits bursts with HTTP 429; wait and retry rather than fail the story.
async function get(url) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, { headers: UA });
    if (res.ok) return res;
    if (res.status !== 429 || attempt === 5) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
    await new Promise((r) => setTimeout(r, attempt * 5000));
  }
}

const api = 'https://commons.wikimedia.org/w/api.php?action=query&format=json&generator=search'
  + `&gsrsearch=${encodeURIComponent(query)}&gsrnamespace=6&gsrlimit=25`
  + '&prop=imageinfo&iiprop=url|extmetadata|size|mime&iiurlwidth=1280&iiextmetadatafilter=Artist|LicenseShortName';
const pages = Object.values((await (await get(api)).json()).query?.pages ?? {})
  .sort((a, b) => a.index - b.index);

const pick = pages.find((p) => {
  const i = p.imageinfo?.[0];
  return i && i.mime === 'image/jpeg' && i.width >= 1200 && i.width > i.height * 1.2
    && LICENSE.test(i.extmetadata?.LicenseShortName?.value ?? '') && !AVOID.test(p.title);
});
if (!pick) {
  console.error(`No suitable photo for "${query}". Try a broader or different subject.`);
  process.exitCode = 2; // not process.exit(): it aborts open sockets and crashes Node on Windows
} else {
  const i = pick.imageinfo[0];
  // Dated, so two editions with the same slug never share (or delete) each other's photo.
  const slug = `${basename(dirname(file))}-${basename(file, '.md')}`;
  mkdirSync('public/images', { recursive: true });
  writeFileSync(`public/images/${slug}.jpg`, Buffer.from(await (await get(i.thumburl)).arrayBuffer()));

  const credit = `${strip(i.extmetadata.Artist?.value).slice(0, 60) || 'Unknown'} / Wikimedia Commons, ${i.extmetadata.LicenseShortName.value}`;
  const md = readFileSync(file, 'utf8')
    .replace(/^image_credit:.*\n|^image_source:.*\n/gm, '')
    .replace(/^image: .*$/m, `image: "/images/${slug}.jpg"\nimage_credit: ${JSON.stringify(credit)}\nimage_source: "${i.descriptionurl}"`);
  writeFileSync(file, md);
  console.log(`${slug}: ${pick.title} (${credit})`);
}
