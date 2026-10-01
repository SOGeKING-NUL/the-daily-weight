# The Daily Weight

An AI newspaper. One dated edition per day, and the page ends at the bottom.

It runs itself: every morning a GitHub Actions job gathers the news, Claude writes the stories, the site deploys, subscribers get the email and the X account posts the thread. Nobody has to be awake.

## Run

```sh
npm install
npm run dev      # http://localhost:4321
npm run build    # static site in dist/
npm test         # the pipeline's own checks
```

## Routes

- `/` — latest edition
- `/edition/YYYY-MM-DD` — any edition
- `/edition/YYYY-MM-DD/slug` — one story, with photo and full text
- `/archive` — every edition
- `/rss.xml`, `/md`, `/json` — feeds for readers and agents (`/md` and `/json` serve the latest edition)
- `/editions.json`, `/edition/YYYY-MM-DD.json` — every edition's date and count, and any edition in full
- `/email/YYYY-MM-DD.html` — the edition as the newsletter email
- `/cards/YYYY-MM-DD.png`, `/cards/YYYY-MM-DD/slug.png` — share cards (link previews and the X posts), drawn by `npm run cards`
- `/txt` — the latest edition as plain text, 80 columns, for terminals: `curl -s <site>/txt | less`. In Windows PowerShell `curl` is an alias for `Invoke-WebRequest`; type `curl.exe` instead. Locally: `curl.exe -s http://localhost:4321/txt`

## Read it in the terminal

```sh
npm run tui                          # reads the local site (npm run dev in another terminal)
npm run tui -- https://your.domain   # reads the published paper
```

A three-pane reader in the style of [eilmeldung](https://www.reddit.com/r/CLI/comments/1qxbw8b/eilmeldung_a_tui_rss_reader/): a sidebar tree (editions as Today / Yesterday, your views, sections, sources), a short story list, and the article in a rounded panel with tag pills, on a Catppuccin-style pastel palette. The app paints its own background, so it looks the same on light and dark terminal themes. The focused pane's header and selection turn lavender, and the status bar shows the current story's link. No dependencies; works in Windows Terminal, Warp, macOS and Linux terminals.

| Key | Does |
|---|---|
| `j`/`k` or arrows | move (scrolls when the article has focus) |
| `J`/`K` or `n`/`p` | next / previous story, from any pane |
| `/` | search the current view as you type; `enter` keeps it, `esc` clears it |
| `1` / `2` / `3`, `t` | article tabs: our story, the full source article, the Hacker News thread |
| `tab`, `h`/`l` | switch pane (the focused pane's header turns lavender) |
| `enter` | read the story, or open the sidebar item (editions load on enter) |
| `space`/`b`, `g`/`G` | page the article, jump to top/bottom |
| `o` / `d` / `w` | open the source / the discussion / the story on the website |
| `c` / `u` | copy the story as text / copy the source link |
| `m` / `r` / `R` | mark, toggle read, mark all in view read |
| `?` / `q` | keys / quit |

The article panel has three tabs. **Story** is our write-up with its interest score, reading time and live HN points and comment count. **Article** fetches the original page and shows it as clean text (headings, paragraphs, lists, quotes, code), including GitHub READMEs and arXiv abstracts; sites that refuse automated readers (openai.com returns 403) say so and `o` opens them in the browser. **Discussion** shows the Hacker News thread from its public API: up to 80 comments, threaded, with authors and times. The story list also shows each story's HN points.

A story counts as read after it has been on screen for a moment or when you open it, not when you scroll past it. Links in the article are clickable in terminals that support it (Windows Terminal, iTerm2, kitty, GNOME Terminal). Terminals without 24-bit colour get the nearest 256-colour match. Read and marked stories are remembered in `~/.daily-weight.json`. The reader uses `/editions.json` and `/edition/<date>.json`, which any other client can use too. `npm run check:tui` checks its layout at several terminal sizes.

## How an edition is made

```sh
npm run edition    # fetch → rank → write → cards → check, about ten minutes and roughly $0.75 in model calls
```

1. **Gather** (`scripts/fetch.mjs`, no keys needed except for X). Candidates from the last 36 hours land in `drafts/<date>.json`:
   - **Labs:** OpenAI, Google DeepMind, Google AI, Hugging Face, Qwen, NVIDIA, Microsoft Research and Apple ML feeds, plus Anthropic's sitemap (it has no feed)
   - **Press:** TechCrunch AI, The Verge AI, Ars Technica and Simon Willison, the last two filtered to AI
   - **AI Twitter:** every post in the window from one curated X List, read through [twitterapi.io](https://twitterapi.io) (`TWITTERAPI_KEY`, `X_LIST_ID`; about $0.15 per thousand posts). A post that links somewhere counts as a mention of that link, so a paper five researchers post about adds up on one candidate; a post with no link and real engagement is a candidate itself. [smol.ai's list of 544 AI accounts](https://twitter.com/i/lists/1585430245762441216) is a good starting point; make your own List and set its id.
   - **Other digests:** [smol.ai AI News](https://news.smol.ai), TLDR AI and Techmeme. Never cited; their outbound links are the net for what everything else missed, and a story two of them link is must-cover.
   - **Community:** Hacker News (AI stories from 10 points, plus every 150+ point story), Lobsters `ai`, and Reddit's top of the day across r/LocalLLaMA, r/MachineLearning, r/OpenAI and r/ClaudeAI (Reddit ends its RSS on 13 November 2026; after that it only logs an error and smol.ai covers it)
   - **Papers:** Hugging Face daily papers, which are arXiv papers ranked by community upvotes
   - **Code:** stable releases from about 30 watch-list repos (edit `REPOS`), AI repos on GitHub Trending, and new repos from the past week with 100+ stars. Uses `$GITHUB_TOKEN` or your `gh` login if present

   A link found in several places is merged into one candidate with `seen_on` listing where. One failing source goes into `errors[]` and the rest carry on.
2. **Rank** (`scripts/rank.mjs`, no LLM). Candidates about one event are clustered (same link, same repo, near-identical headlines, a post and what it quotes), scored for heat (HN points, X engagement, how many places it appeared, digest mentions, lab posts), and the ones the paper *must decide on* are flagged: every post from OpenAI, DeepMind, Anthropic or Qwen; 300+ points on HN; the top ten on AI Twitter; anything two digests both link; anything seen on three sources. The rules are in `scripts/lib/candidates.mjs` and `npm test` checks them. Output: `drafts/<date>.ranked.json`.
3. **Write** (`scripts/write.mjs`, needs `LLM_API_KEY`). The model is Claude Sonnet 5.5 through OpenRouter by default; `LLM_BASE_URL` and `LLM_MODEL` point it at any OpenAI-compatible provider. One call picks 20 to 30 stories from the top 60 clusters; every must-cover cluster is either picked or rejected with a reason. Then one call per story, given the source text we fetched ourselves (sites that block bots, like openai.com, are read through [Jina's reader](https://jina.ai/reader)), returns the front matter and two or three paragraphs. A fact check compares every number and proper name in the story against the source text; a story that fails gets one rewrite, then is dropped. `scripts/images.mjs` adds a Wikimedia Commons photo. The editorial rules are `scripts/editor-prompt.md`. `--limit 3` writes only the top three picks, a cheap trial.
4. **Cards** (`scripts/cards.mjs`). Share cards in the paper's look, 1200×630, for the edition and its top eight stories: link previews on X and elsewhere, and the images in the X thread.
5. **Check** (`scripts/check.mjs`). Drops any story whose source no longer answers, runs `npm run build` (which validates the front matter), and confirms every must-cover cluster was decided on. Undecided ones get one more writing pass in the workflow, then the edition goes out anyway and the leftovers are filed as a GitHub issue.

Every decision is recorded in `drafts/<date>.decisions.json`. To rebuild a past edition, fetch its window and run the same steps: `node scripts/fetch.mjs 2026-09-29 180 && node scripts/rank.mjs 2026-09-29 && node scripts/write.mjs 2026-09-29`. Stories already in any edition are never offered again.

## The daily run

`.github/workflows/edition.yml` does all of the above at 06:00 IST, then commits the edition, deploys to Cloudflare Pages, sends the email and posts the morning thread. At 19:45 IST (10:15 ET, when AI Twitter is at its desk) it posts the top three stories again as singles. `workflow_dispatch` runs it by hand, with a `date` and a `dry_run` that builds everything and publishes nothing. GitHub emails you when a run fails.

**The switch:** the repository variable `PUBLISH`. Unset, the schedule does nothing (a fresh fork is safe). `dry` builds the whole edition and publishes none of it, for testing. `on` is the real thing. Set it to `dry` or delete it to stop everything at once. **Fixing a published story:** edit its `.md` and push; the next run redeploys. To take down an X post: `node scripts/post-x.mjs --delete <id>`.

### Set it up

Copy `.env.example` to `.env` (gitignored) and fill it in as you create each account. With the [GitHub CLI](https://cli.github.com) logged in, `gh secret set -f .env` and `gh variable set -f vars.env` load them into Actions without the values passing through anything else; the same `.env` makes the scripts work locally.

Secrets (Settings → Secrets and variables → Actions):

| Secret | From |
|---|---|
| `LLM_API_KEY` | An [OpenRouter](https://openrouter.ai/keys) key (the default), or any OpenAI-compatible provider with `LLM_BASE_URL` and `LLM_MODEL` set, e.g. an [Anthropic](https://platform.claude.com) API key with `https://api.anthropic.com/v1` and `claude-sonnet-5`. A Claude Pro/Max login is not an API key. |
| `JINA_API_KEY` | Optional. [Jina](https://jina.ai) reader key, only to raise the rate limit for reading bot-blocking sites. |
| `TWITTERAPI_KEY` | [twitterapi.io](https://twitterapi.io). Pay as you go. |
| `RESEND_API_KEY`, `RESEND_SEGMENT_ID` | [resend.com](https://resend.com): verify your domain, create a segment for subscribers. Free up to 1,000 contacts. |
| `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | Cloudflare → create a Pages project and an API token with Pages edit rights. |
| `X_API_KEY`, `X_API_SECRET`, `X_ACCESS_TOKEN`, `X_ACCESS_SECRET` | [developer.x.com](https://developer.x.com): an app with read and write on the bot account, pay-per-use credits (about $0.015 a post, $0.20 for one with a link; the thread puts its one link last). |

Variables: `SITE_URL` (`https://your.domain`), `LLM_BASE_URL` and `LLM_MODEL` (optional, see above), `X_LIST_ID`, `CF_PAGES_PROJECT`, `MAIL_FROM` (`The Daily Weight <paper@your.domain>`), `PUBLIC_CF_ANALYTICS_TOKEN` (Cloudflare Web Analytics, optional), `PUBLISH` (`on`).

Cloudflare Pages environment variables (for the signup functions): `RESEND_API_KEY`, `RESEND_SEGMENT_ID`, `MAIL_FROM`, `SUBSCRIBE_SECRET` (any long random string).

The X account: create it, link it to your own account as its managing account and switch on the **Automated** label in settings (X requires it for bots). Consider X Premium ($8/month); it reportedly helps reach.

Locally, the same names in a `.env` file (gitignored) make `npm run edition`, `npm run newsletter -- --to you@x.com` and `npm run post -- morning --dry-run` work.

### Newsletter

The footer form posts to `functions/api/subscribe.ts`, which emails a confirmation link signed with `SUBSCRIBE_SECRET`; `functions/api/confirm.ts` checks the signature and adds the address to the Resend segment. Nothing is stored before the click and there is no database. Resend keeps the list, handles unsubscribes (`{{{RESEND_UNSUBSCRIBE_URL}}}` in the template) and can export it as CSV. `scripts/newsletter.mjs` sends `dist/email/<date>.html` as a broadcast, once per edition; `--to` sends a test copy to one address. Anti-spam law in most countries wants a postal address in marketing email; add yours to the footer in `src/pages/email/[date].html.ts` before the list grows.

### Costs

At under a hundred subscribers: the model about $15–25 a month (OpenRouter adds about 5% on top of Anthropic's prices), twitterapi.io $10–18, X posting $8–12, everything else (Resend, Cloudflare Pages and Functions, GitHub Actions on a public repo) free. Roughly $35–55 a month plus the domain.

## Add a story by hand

Create `content/editions/YYYY-MM-DD/some-slug.md`. The folder is the edition; `date` must match it.
Front matter is validated at build time (see `src/content.config.ts`):

```md
---
date: "2026-10-01"
title: "What happened, stated plainly"
authors: ["Who wrote the source"]
url: "https://..."
discuss_url: "https://news.ycombinator.com/item?id=..."   # or null; an x.com post works too
source: hn            # labs | press | hn | reddit | x | arxiv | github
section: infra        # models | agents | infra | research | safety | industry
interest_score: 7     # 1-10, sets order within the edition
recommended: true
must_read: false
why_read: "One or two sentences on why a builder should spend the time."
summary: "One line, used in RSS and the evening X posts."
image: "/images/2026-10-01-some-slug.jpg"   # file in public/images, or null
image_credit: "Author / Wikimedia Commons, CC BY-SA 4.0"   # shown as the photo caption
image_source: "https://commons.wikimedia.org/wiki/File:..."  # optional link for the credit
sample: false
---

Two or three short paragraphs. Explain what it is and why it matters, then link out. Do not reprint the original.
```

A new date folder is a new edition. The newest date becomes `/`.

## Editorial rules

AI only: models, agents, infra, research, safety, and industry news with technical consequence.
No tips-and-tricks lists, prompt packs, or duplicate coverage of one event.
Write specific, calm and mechanistic. No "game-changer", no emoji.

## Design rule

If it looks like a startup landing page, you broke it.
