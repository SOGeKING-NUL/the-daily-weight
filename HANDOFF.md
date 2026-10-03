# Handoff: The Daily Weight

Where the project stands, what works, what doesn't yet, and what to do next. Written 2026-10-04. The README covers how everything works; this file covers the state of things.

## What it is

A daily AI newspaper that runs itself. Every morning a GitHub Actions job gathers the news, ranks it, has an LLM write the stories from their sources, builds the static Astro site, deploys it, emails subscribers and posts a thread on X. Audience: people who follow AI on X. The edition lands in the India morning (06:00 IST run), with a second round of X posts at 19:45 IST for the US morning.

## State

| Part | Code | Ran for real? |
|---|---|---|
| Gather (`scripts/fetch.mjs`) | done | yes, on live sources (330 candidates on 2026-10-01). The X source is skipped until `TWITTERAPI_KEY` is set. |
| Rank (`scripts/rank.mjs`, `scripts/lib/candidates.mjs`) | done | yes, on live data. Unit-tested (`npm test`). |
| Write (`scripts/write.mjs`) | done | **no**: needs `LLM_API_KEY`. Syntax-checked only. |
| Share cards (`scripts/cards.mjs`) | done | yes, rendered and checked by eye for 2026-09-30. |
| Check (`scripts/check.mjs`) | done | yes, including exit codes 3 and `--final`. |
| Site (OG tags, subscribe form, `/email/<date>.html`) | done | yes, `npm run build` passes. |
| Newsletter send (`scripts/newsletter.mjs`) + signup (`functions/api/*`) | done | **no**: needs a domain and a Resend account. |
| X posting (`scripts/post-x.mjs`) | done | dry run only (`--dry-run`). Needs the X account and keys. |
| Daily workflow (`.github/workflows/edition.yml`) | pushed | **idle**: does nothing until the repo variable `PUBLISH` is set. |
| Terminal reader (`npm run tui`) | unchanged, still passes `npm run check:tui` | yes |

Branch `main` is level with `origin/main`. No `.env` exists locally yet.

## Decisions already made (don't reopen without a reason)

- **Code gathers and ranks; the LLM only picks and writes.** Must-cover rules live in code (`mustCover()` in `scripts/lib/candidates.mjs`), so a launch everyone is talking about can't be silently missed. The old `claude -p` editor step is gone.
- **Fully automatic, with no human approval gate.** Its place is taken by the fact check (numbers and proper names must appear in the source), the coverage gate, dead-link drops, and the `PUBLISH` switch.
- **The model goes through OpenRouter** (the user has an OpenRouter key, not an Anthropic one). The default is `anthropic/claude-sonnet-5.5`. `LLM_BASE_URL` and `LLM_MODEL` change provider or model with no code change.
- **X trends come from twitterapi.io reading a curated X List**, about $10–18 a month. X's own read API was about 30 times more expensive. The default list is smol.ai's public list of about 544 AI accounts (`1585430245762441216`).
- **Newsletter: Resend's free tier** (fewer than 100 readers expected). Signup is double opt-in through Cloudflare Pages Functions, using HMAC-signed links and no database.
- **Hosting is Cloudflare Pages.** The free plan allows commercial use, and the Functions run the signup.
- Expected running cost is about $35–55 a month, plus a domain.

## Next steps, in order

1. **Model key.** Put `LLM_API_KEY=sk-or-...` in `.env` (copy `.env.example`). Then run a trial against real candidates and read the stories against their sources:
   ```sh
   node scripts/fetch.mjs && node scripts/rank.mjs && node scripts/write.mjs --limit 2
   ```
   That costs about $0.10. Tune `scripts/editor-prompt.md` if the writing is off.
2. **Domain**, then a **Cloudflare Pages project** named `the-daily-weight` and an API token with *Pages: Edit*.
3. **GitHub CLI** (`winget install GitHub.cli`, then `gh auth login`). Copy `vars.env.example` to `vars.env`, fill it in, and run `gh secret set -f .env` and `gh variable set -f vars.env`. Start with `PUBLISH=dry`.
4. **Manual dry run** from the Actions tab (`workflow_dispatch` with `dry_run` ticked). Read the log.
5. **Resend**: verify the domain, create a segment, set the Pages environment variables (`RESEND_API_KEY`, `RESEND_SEGMENT_ID`, `MAIL_FROM`, `SUBSCRIBE_SECRET`). Send yourself a test with `npm run newsletter -- --to you@x.com` and check it in Gmail and Apple Mail.
6. **twitterapi.io** key. The X signal starts flowing in the next fetch.
7. **X account**: create it, link it to a managing account, turn on the *Automated* label, create a developer app with read+write and pay-per-use credits. Test with `npm run post -- morning --dry-run`, then one real post.
8. Set `PUBLISH=on`.

## Known limits and open risks

- **The fact check is string matching.** "three" in the source against "3" in the story gets flagged; the writer then gets one rewrite before the story is dropped. Watch `drafts/<date>.decisions.json` for good stories dropped this way.
- **Reddit ends RSS on 2026-11-13.** `reddit()` will start logging an error, which is harmless; smol.ai covers Reddit. Delete the function after that date.
- **twitterapi.io scrapes X, and X is hostile to scrapers.** If the vendor disappears, HN and the digest feeds keep coverage running, and the X List can move to X's official API at a higher cost.
- **Cloudflare Pages allows about 20,000 files per deploy.** Photos, cards and pages add roughly 70 files a day, which reaches the limit in about nine months. Plan to move images to R2, or prune old ones, before then.
- **Clustering is O(n²)** over the hottest 400 candidates. That is fine now; it would need an inverted index if the pool grows.
- **Heat weights are hand-tuned** (`heat()` in `scripts/lib/candidates.mjs`). Adjust them weekly from Resend clicks, Cloudflare analytics and X metrics.
- `npm audit` reports a moderate issue in satori's zip library (fflate). It only matters when unzipping untrusted archives, which we never do.
- Marketing email needs a postal address in most countries. Add one to the footer in `src/pages/email/[date].html.ts` before the list grows.

## Working rules for this repo

- **Never `git push` without the owner's explicit yes for that push.** Commit locally, then ask.
- Keep to the existing shape: small dependency-free `scripts/*.mjs`, pure logic in `scripts/lib/` with tests in `scripts/pipeline.test.mjs`, and no new services without a reason.
- Design rule: if it looks like a startup landing page, you broke it.

## Map

```
scripts/fetch.mjs          gather candidates      → drafts/<date>.json
scripts/rank.mjs           cluster, heat, must    → drafts/<date>.ranked.json
scripts/write.mjs          pick + write stories   → content/editions/<date>/*.md, drafts/<date>.decisions.json
scripts/cards.mjs          share cards            → public/cards/ (gitignored, rebuilt each run)
scripts/check.mjs          links, build, coverage → drafts/<date>.gaps.md if anything is left undecided
scripts/newsletter.mjs     Resend broadcast of dist/email/<date>.html
scripts/post-x.mjs         morning thread / evening singles / --delete
scripts/editor-prompt.md   the editorial rules the model writes by
scripts/lib/               candidates.mjs (merge, heat, cluster, must-cover), story.mjs (fact check, front matter), article.mjs (HTML to text)
functions/api/             subscribe.ts, confirm.ts (Cloudflare Pages Functions)
.github/workflows/edition.yml   the daily run
```
