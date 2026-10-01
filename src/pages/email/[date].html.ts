// The edition as an email, built with the site: /email/<date>.html. scripts/newsletter.mjs sends
// it as a Resend broadcast. Tables and inline styles because mail clients still need them; the
// paper's own palette and rules; web fonts fall back to Georgia and Helvetica.
import type { APIContext } from 'astro';
import { SECTIONS, frontPage, getEditions, href, longDate, plural, type Edition, type Story } from '../../editions';

export async function getStaticPaths() {
  return (await getEditions()).map((edition) => ({ params: { date: edition.date }, props: { edition } }));
}

const PAPER = '#fbfaf6', INK = '#1a1a1a', MUTED = '#5b564d', RULE = '#dcd6cb', ACCENT = '#b0071e';
const SERIF = "Lora, 'PT Serif', Georgia, 'Times New Roman', serif";
const SANS = "'PT Sans', 'Helvetica Neue', Helvetica, Arial, sans-serif";
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const words = (s: string) => s.split(/\s+/).filter(Boolean).length;

export function GET({ props, site }: APIContext) {
  const { edition } = props as { edition: Edition };
  const abs = (path: string) => new URL(path, site).toString();
  const { sections } = frontPage(edition);
  const top = edition.stories.slice(0, 5);
  const rest = sections.map((s) => ({ ...s, stories: s.stories.filter((x) => !top.includes(x)) })).filter((s) => s.stories.length);
  const minutes = Math.max(1, Math.round(edition.stories.reduce((n, s) => n + words(s.data.title) + (top.includes(s) ? words(s.data.why_read) : 0), 0) / 220));

  const kicker = (s: Story) => `<span style="color:${ACCENT}">${SECTIONS[s.data.section]}</span>${
    s.data.must_read ? ` <span style="color:${MUTED}">&nbsp;|&nbsp; Must read</span>` : s.data.recommended ? ` <span style="color:${MUTED}">&nbsp;|&nbsp; Recommended</span>` : ''}`;

  const lead = (s: Story, i: number) => `
    <tr><td style="padding:${i ? 18 : 22}px 0 ${i ? 16 : 20}px;border-bottom:1px solid ${RULE}">
      <p style="margin:0 0 6px;font:700 13px/1.3 ${SANS}">${kicker(s)}</p>
      <h2 style="margin:0 0 8px;font:700 ${i ? 21 : 27}px/1.15 ${SERIF};letter-spacing:-0.01em">
        <a href="${abs(href(s))}" style="color:${INK};text-decoration:none">${esc(s.data.title)}</a></h2>
      <p style="margin:0 0 8px;font:400 16px/1.5 ${SERIF};color:${INK}"><strong>Why read:</strong> ${esc(s.data.why_read)}</p>
      <p style="margin:0;font:400 13px/1.4 ${SANS};color:${MUTED}">By ${esc(s.data.authors.join(', '))} &nbsp;·&nbsp;
        <a href="${s.data.url}" style="color:${INK}">Source ›</a>${s.data.discuss_url ? ` &nbsp;·&nbsp; <a href="${s.data.discuss_url}" style="color:${INK}">Discuss ›</a>` : ''}</p>
    </td></tr>`;

  const brief = (s: Story) => `
    <tr><td style="padding:9px 0;border-bottom:1px solid ${RULE};font:700 16px/1.3 ${SERIF}">
      <a href="${abs(href(s))}" style="color:${INK};text-decoration:none">${esc(s.data.title)}</a>
      <span style="font:400 12px/1 ${SANS};color:${MUTED}">&nbsp; <a href="${s.data.url}" style="color:${MUTED}">source ›</a></span>
    </td></tr>`;

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>The Daily Weight — ${longDate(edition.date)}</title>
</head>
<body style="margin:0;padding:0;background:${PAPER};color:${INK}">
<div style="display:none;max-height:0;overflow:hidden;font-size:1px;color:${PAPER}">${esc(edition.stories[0].data.why_read)}&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${PAPER}"><tr><td align="center" style="padding:24px 16px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%">
  <tr><td align="center" style="padding:0 0 10px;border-bottom:1px solid ${RULE};font:400 13px/1.4 ${SANS};color:${MUTED}">
    ${longDate(edition.date)} &nbsp;·&nbsp; ${plural(edition.stories.length)} &nbsp;·&nbsp; ${minutes} min read</td></tr>
  <tr><td align="center" style="padding:22px 0 14px">
    <a href="${abs(`/edition/${edition.date}`)}" style="font:700 44px/1 ${SERIF};letter-spacing:-0.03em;color:${INK};text-decoration:none">The Daily Weight</a>
    <p style="margin:10px 0 0;font:italic 400 15px/1.2 ${SERIF};color:${MUTED}">An AI Newspaper</p></td></tr>
  <tr><td style="border-bottom:4px solid ${INK};font-size:0;line-height:0">&nbsp;</td></tr>
  <tr><td style="height:3px;font-size:0;line-height:0">&nbsp;</td></tr>
  <tr><td style="border-bottom:1px solid ${INK};font-size:0;line-height:0">&nbsp;</td></tr>
  ${top.map(lead).join('')}
  ${rest.map((sec) => `
  <tr><td style="padding:26px 0 4px;font:700 17px/1.2 ${SANS}">
    <span style="display:inline-block;border-top:4px solid ${ACCENT};padding-top:6px">${sec.label}</span></td></tr>
  ${sec.stories.map(brief).join('')}`).join('')}
  <tr><td align="center" style="padding:30px 0 0;font:italic 400 16px/1.4 ${SERIF};color:${MUTED}">That's the paper.</td></tr>
  <tr><td align="center" style="padding:26px 0 0;border-top:4px solid ${INK};margin-top:18px;font:400 12px/1.6 ${SANS};color:${MUTED}">
    <a href="${abs(`/edition/${edition.date}`)}" style="color:${INK}">Read on the web</a> &nbsp;·&nbsp;
    <a href="${abs('/archive')}" style="color:${INK}">Archive</a> &nbsp;·&nbsp;
    <a href="{{{RESEND_UNSUBSCRIBE_URL}}}" style="color:${INK}">Unsubscribe</a><br>
    One edition a day on models, agents, infra, research and safety.</td></tr>
</table>
</td></tr></table>
</body>
</html>
`;
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}
