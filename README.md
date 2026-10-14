# WikiFeed

A deliberate Wikipedia reading feed. Section cards from articles you follow,
routed by a local graph algorithm. No LLM in the content path — all text is
Wikipedia's own writing.

## What it is

- **Section cards** — individual article sections (150–900 words), not lead summaries
- **Graph-based algorithm** — follows body links between articles; P800 notable-works
  expansion for people; score = link frequency × article quality × novelty
- **No engagement optimisation** — no streaks, badges, autoplay, or tracking
- **Provenance** — every card shows its route (e.g. "Umberto Eco → The Name of the Rose")
- **Local state** — all follows, scores, history and saves in IndexedDB on your device
- **PWA** — installable on iPhone via Safari → Add to Home Screen; works offline

## Setup

```bash
# Serve locally
python3 -m http.server 8000
# Open http://localhost:8000 in a browser
```

For iPhone: deploy to GitHub Pages, open in Safari, tap Share → Add to Home Screen.

## Deploy to GitHub Pages

```bash
git remote add origin https://github.com/nimjit/wiki-feed.git
git push -u origin main
# Enable Pages in repo Settings → Pages → Deploy from branch: main
```

## Architecture

```
index.html          PWA shell (4 screens)
manifest.json       PWA manifest (icons, display:standalone)
sw.js               Service worker — cache-first shell, 1h TTL for API responses
style.css           3 themes (light/sepia/dark), card layout, swipe animations
src/
  app.js            Entry: register SW, open DB, init router
  db.js             IndexedDB wrapper (follows, seen, saved, graph, settings)
  api.js            Wikipedia Action API + Wikidata; section parsing; link extraction
  algorithm.js      Graph expansion, scoring (freq × quality × novelty), session building
  renderer.js       Card construction, swipe gesture, action handlers, provenance menu
  router.js         Screen switching + Saved/Threads/Settings screen rendering
probes/
  probe_sections.py Verified section scoring heuristics (Action API, not mobile-sections)
  probe_links.py    Verified body-link extraction (212 useful links from Umberto Eco)
  probe_wikidata.py Verified P800 expansion (Wikidata batched; P921 too sparse to use)
```

## API notes (verified October 2026)

- **Mobile Content Service is decommissioned** (T328036). Do not use
  `api/rest_v1/page/mobile-sections/`.
- Use `action=parse&prop=sections|text` — 2 requests per article, sections + full HTML.
- New Wikipedia HTML: section `id` is on `<h2>`/`<h3>` directly, not on inner span.
- Body links: fetch full article HTML, remove `.navbox`/`.infobox` etc., then extract
  `href="/wiki/"` links. Yields ~40% of raw prop=links count (212 vs 500 for Umberto Eco).
- Wikidata P921 (main subject) is too sparse for use. Instead: P800 → work articles →
  body links of those articles.
- Rate limit: Wikipedia Action API will 429 if you fetch ~10+ sections in a tight loop.
  Client uses 1 request per article (full HTML), not per section.

## Scoring constants

```javascript
// algorithm.js
GRAPH_TTL    = 24h   // re-fetch body links after 24 hours
SECTION_TTL  = 6h    // re-fetch article sections after 6 hours

// Candidate scoring
freq_weight  = 1.0   // direct body link from follow
p800_weight  = 0.8   // P800 notable work
hop2_weight  = 0.3   // body link of a P800 work
like_boost   = 1.2x  // articles you've liked get 20% more weight
quality_FA   = 2.0   // Wikipedia Featured Article
quality_GA   = 1.5   // Wikipedia Good Article
novelty      = 0→1   // decays over 7 days since last seen
```

## Session mix

15 cards per session: ~60% top-scored (near interests), ~25% mid-range (exploration),
~15% tail (wildcard). Shuffled within each tier.

## Acceptance tests (v0)

- Follow "Umberto Eco": expect sections on semiotics, apostolic poverty, Knights Templar,
  William of Ockham, Rosicrucians — NOT a list of Italian writers.
- Follow "Stoicism": expect the History section with Stoa Poikile etymology,
  Logic/Ethics/Physics subsections.
- Mark "Uncertainty principle" known: stops appearing; feed moves to neighbours.
- Installed on iPhone: opens offline with cached cards, theme persists.
