// Wikipedia & Wikidata API layer
// All requests use CORS (origin=*). User-Agent cannot be set from browser.

const WP_API = 'https://en.wikipedia.org/w/api.php'
const WD_API = 'https://www.wikidata.org/w/api.php'

async function wpFetch(params) {
  params.format = 'json'
  params.origin = '*'
  const r = await fetch(WP_API + '?' + new URLSearchParams(params))
  if (!r.ok) throw new Error(`Wikipedia API ${r.status}: ${params.action}`)
  return r.json()
}

async function wdFetch(params) {
  params.format = 'json'
  params.origin = '*'
  const r = await fetch(WD_API + '?' + new URLSearchParams(params))
  if (!r.ok) throw new Error(`Wikidata API ${r.status}`)
  return r.json()
}

// ─── Article content ──────────────────────────────────────────────────────────

// Returns { sections: [...], html: '...' } in one API call
export async function getArticleData(title) {
  const data = await wpFetch({
    action: 'parse',
    page: title,
    prop: 'sections|text',
    disableeditsection: '1',
  })
  if (!data.parse) throw new Error(`Article not found: ${title}`)
  return {
    sections: data.parse.sections,
    html: data.parse.text['*'],
    displayTitle: data.parse.displaytitle || title,
  }
}

// Returns just the page HTML (cheaper if sections already known)
export async function getArticleHTML(title) {
  const data = await wpFetch({
    action: 'parse',
    page: title,
    prop: 'text',
    disableeditsection: '1',
  })
  if (!data.parse) throw new Error(`Article not found: ${title}`)
  return data.parse.text['*']
}

// ─── Section HTML cleanup ─────────────────────────────────────────────────────

const STRIP_SELS = [
  'table.infobox', 'table.navbox', '.navbox', '.navbox-inner', '.navbox-subgroup',
  'table.wikitable', '.succession-box', '.geography', '.sidebar',
  '.toc', '.reflist', '.references', '.hatnote', '.gallery', '.thumb',
  'style', '.mw-references-wrap', '.mw-editsection',
  'sup.reference', 'sup.noprint',
]

export function cleanHTML(rawHTML) {
  const doc = new DOMParser().parseFromString(rawHTML, 'text/html')
  STRIP_SELS.forEach(sel => doc.querySelectorAll(sel).forEach(el => el.remove()))
  // Mark internal wiki links for in-app navigation
  doc.querySelectorAll('a[href^="/wiki/"]').forEach(a => {
    const raw = a.getAttribute('href').slice(6).split('#')[0]
    const title = decodeURIComponent(raw).replace(/_/g, ' ')
    if (!title.includes(':')) {
      a.removeAttribute('href')
      a.dataset.wiki = title
      a.classList.add('wiki-link')
    } else {
      a.removeAttribute('href')  // strip File:/Category: etc
    }
  })
  // Strip external links but keep text
  doc.querySelectorAll('a[href^="http"]').forEach(a => {
    a.removeAttribute('href')
    a.classList.add('ext-link')
  })
  return doc.body.innerHTML
}

// Extract body links (articles only, no navboxes/infoboxes)
// Titles that are infrastructure / metadata — never surfaced as cards
const SKIP_TITLE = /
  \(identifier\)$
  | ^(ISBN|ISSN|DOI|OCLC|PMID|PMC|arXiv|Bibcode|Zbl|MR|JFM|S2CID)\b
  | ^Wayback\sMachine$
  | ^List\sof\s
  | ^Index\sof\s
  | ^Outline\sof\s
  | ^Glossary\sof\s
/xi

export function extractBodyLinks(rawHTML) {
  const doc = new DOMParser().parseFromString(rawHTML, 'text/html')
  STRIP_SELS.forEach(sel => doc.querySelectorAll(sel).forEach(el => el.remove()))
  const SKIP_NS = /^(File:|Image:|Category:|Help:|Wikipedia:|Portal:|Template:|Talk:|Special:|User:|WP:|MOS:)/i
  const seen = new Set()
  const links = []
  doc.querySelectorAll('a[href^="/wiki/"]').forEach(a => {
    const raw = a.getAttribute('href').slice(6).split('#')[0]
    const title = decodeURIComponent(raw).replace(/_/g, ' ')
    if (!SKIP_NS.test(title) && !SKIP_TITLE.test(title) && !seen.has(title)) {
      seen.add(title)
      links.push(title)
    }
  })
  return links
}

// ─── Section parsing ──────────────────────────────────────────────────────────

// Sections the feed never shows
const SKIP_HEADINGS = new Set([
  'references', 'see also', 'notes', 'external links', 'bibliography',
  'works', 'further reading', 'footnotes', 'sources', 'citations',
  'notes and references', 'selected works', 'selected bibliography',
  'partial bibliography', 'publications', 'discography', 'filmography',
  'awards', 'accolades', 'honors', 'honours',
])

// Headings that get a score boost
const PREFER_HEADINGS = new Set([
  'etymology', 'history', 'background', 'reception', 'legacy',
  'interpretation', 'controversy', 'criticism', 'influence',
  'overview', 'development', 'origin', 'significance', 'philosophy',
  'thought', 'theory', 'ideas', 'context', 'analysis', 'themes',
  'concept', 'principles',
])

function plainText(html) {
  const d = document.createElement('div')
  d.innerHTML = html
  return d.textContent.trim()
}

function wordCount(text) {
  return text.split(/\s+/).filter(Boolean).length
}

// Split full article HTML into section objects using heading id attributes
export function parseSections(fullHTML, sectionsMeta) {
  const doc = new DOMParser().parseFromString(fullHTML, 'text/html')

  // Map anchor → metadata
  const anchorMap = {}
  for (const s of sectionsMeta) {
    anchorMap[s.anchor] = s
  }

  const headings = [...doc.querySelectorAll('h2[id], h3[id]')]
  const results = []

  headings.forEach((heading, i) => {
    const anchor = heading.id
    const meta = anchorMap[anchor]
    if (!meta) return

    const toclevel = parseInt(meta.toclevel)
    if (toclevel > 2) return  // skip sub-sub-sections

    // Collect content until next h2/h3
    const contentEls = []
    let node = heading.nextElementSibling
    const nextBoundary = headings[i + 1]
    while (node && node !== nextBoundary) {
      contentEls.push(node)
      node = node.nextElementSibling
    }

    // Build section HTML from collected elements
    const wrapper = document.createElement('div')
    contentEls.forEach(el => wrapper.appendChild(el.cloneNode(true)))
    const rawSectionHTML = wrapper.innerHTML

    const text = plainText(rawSectionHTML)
    const wc = wordCount(text)

    // Scoring
    const headingLower = (meta.line || '').toLowerCase().replace(/<[^>]+>/g, '').trim()
    let score = 0
    if (SKIP_HEADINGS.has(headingLower)) {
      score = 0
    } else if (wc < 80) {
      score = 0
    } else {
      score = 1.0
      if (toclevel === 1) score += 0.15
      for (const pref of PREFER_HEADINGS) {
        if (headingLower.includes(pref)) { score += 0.45; break }
      }
      if (wc >= 150 && wc <= 900) score += 0.1
      if (wc > 2000) score = Math.min(score, 0.6)
    }

    results.push({
      anchor,
      heading: headingLower.charAt(0).toUpperCase() + headingLower.slice(1),
      toclevel,
      wordCount: wc,
      score,
      html: rawSectionHTML,
    })
  })

  return results
}

// ─── Search ───────────────────────────────────────────────────────────────────

export async function searchArticles(query) {
  const data = await wpFetch({
    action: 'opensearch',
    search: query,
    limit: '8',
    namespace: '0',
  })
  // opensearch returns [query, [titles], [descriptions], [urls]]
  const titles = data[1] || []
  const descs = data[2] || []
  return titles.map((t, i) => ({ title: t, description: descs[i] || '' }))
}

// ─── Wikidata expansion ───────────────────────────────────────────────────────

export async function getWikidataQID(wpTitle) {
  const data = await wpFetch({
    action: 'query',
    titles: wpTitle,
    prop: 'pageprops',
    ppprop: 'wikibase_item',
  })
  for (const page of Object.values(data.query?.pages || {})) {
    return page.pageprops?.wikibase_item || null
  }
  return null
}

// Returns Wikipedia titles of notable works (P800) for a person QID
export async function getNotableWorkTitles(qid) {
  // Fetch P800 claims and sitelinks in one batched call
  const claimData = await wdFetch({
    action: 'wbgetentities',
    ids: qid,
    props: 'claims',
  })
  const entity = claimData.entities?.[qid] || {}
  const p800Claims = entity.claims?.P800 || []
  const workQIDs = p800Claims
    .filter(c => c.mainsnak?.snaktype === 'value')
    .map(c => c.mainsnak?.datavalue?.value?.id)
    .filter(Boolean)

  if (workQIDs.length === 0) return []

  // Batch-fetch sitelinks for all works
  const sitelinkData = await wdFetch({
    action: 'wbgetentities',
    ids: workQIDs.slice(0, 40).join('|'),
    props: 'sitelinks',
    sitefilter: 'enwiki',
  })

  const titles = []
  for (const [, ent] of Object.entries(sitelinkData.entities || {})) {
    const title = ent.sitelinks?.enwiki?.title
    if (title) titles.push(title)
  }
  return titles
}

// Check if article is Featured (quality=2) or Good (quality=1.5)
export async function getQuality(title) {
  const data = await wpFetch({
    action: 'query',
    titles: title,
    prop: 'categories',
    clcategories: 'Category:Featured articles|Category:Good articles',
    cllimit: '5',
  })
  for (const page of Object.values(data.query?.pages || {})) {
    const cats = (page.categories || []).map(c => c.title.toLowerCase())
    if (cats.some(c => c.includes('featured articles'))) return 2.0
    if (cats.some(c => c.includes('good articles'))) return 1.5
    return 1.0
  }
  return 1.0
}
