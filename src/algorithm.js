// Feed algorithm: graph expansion, scoring, session building
// Strategy: body-link graph from follows; P800 for people; frequency × quality × novelty

import { db } from './db.js'
import * as api from './api.js'

const GRAPH_TTL = 24 * 60 * 60 * 1000  // 24h
const SECTION_TTL = 6 * 60 * 60 * 1000 // 6h

// ─── Graph fetching ───────────────────────────────────────────────────────────

async function ensureGraph(title) {
  let cached = await db.get('graph', title)
  if (cached && (Date.now() - cached.fetchedAt) < GRAPH_TTL) return cached

  let links = []
  let quality = 1.0
  try {
    const html = await api.getArticleHTML(title)
    links = api.extractBodyLinks(html)
  } catch (e) {
    console.warn('Graph fetch failed:', title, e.message)
    links = cached?.links || []
    quality = cached?.quality || 1.0
  }

  const entry = { id: title, links, quality, fetchedAt: Date.now() }
  await db.put('graph', entry)
  // Update quality when it arrives — spread entry (not cached) to keep links intact
  api.getQuality(title).then(q => {
    db.put('graph', { ...entry, quality: q })
  }).catch(() => {})
  return entry
}

// ─── Candidate building ───────────────────────────────────────────────────────

// Returns Map<title, { score, via, type }>
export async function buildCandidates(follows) {
  const scores = new Map()

  const add = (title, weight, via, type = 'link') => {
    if (title === via) return  // don't suggest the follow itself
    const cur = scores.get(title)
    if (!cur || cur.score < weight) {
      scores.set(title, { score: weight, via, type })
    } else {
      // Accumulate: multiple follows linking here boosts score
      scores.set(title, { ...cur, score: cur.score + weight * 0.4 })
    }
  }

  // Fetch all graphs in parallel (rate-limited by browser)
  const graphs = await Promise.all(follows.map(f => ensureGraph(f.id)))

  for (let i = 0; i < follows.length; i++) {
    const follow = follows[i]
    const graph = graphs[i]
    const boost = follow.type === 'like' ? 1.2 : 1.0

    // 1-hop: direct body links of the follow
    for (const link of graph.links) {
      add(link, 1.0 * boost, follow.id, '1hop')
    }
  }

  // P800 expansion: run in background, don't await during session build
  // (enriches the graph for future sessions)
  expandP800(follows).catch(() => {})

  return scores
}

// Background P800 expansion — adds 2-hop entries via notable works
async function expandP800(follows) {
  for (const follow of follows) {
    const cached = await db.get('graph', '__p800__' + follow.id)
    if (cached && (Date.now() - cached.fetchedAt) < GRAPH_TTL) continue

    try {
      const qid = await api.getWikidataQID(follow.id)
      if (!qid) continue
      const works = await api.getNotableWorkTitles(qid)
      await db.put('graph', { id: '__p800__' + follow.id, works, fetchedAt: Date.now() })

      // Fetch body links for each work (lazily, rate-limited)
      for (const work of works) {
        await ensureGraph(work)
        await new Promise(r => setTimeout(r, 400))  // polite delay
      }
    } catch (e) {
      console.warn('P800 expansion failed for', follow.id, e.message)
    }
  }
}

// Get P800-expanded candidates for a follow (from cache only)
export async function getP800Candidates(followTitle) {
  const cached = await db.get('graph', '__p800__' + followTitle)
  if (!cached) return new Map()

  const result = new Map()
  for (const work of (cached.works || [])) {
    const workGraph = await db.get('graph', work)
    if (!workGraph) continue
    result.set(work, { score: 0.8, via: followTitle, type: 'p800', work })
    for (const link of workGraph.links) {
      if (!result.has(link)) {
        result.set(link, { score: 0.3, via: followTitle, type: '2hop', work })
      }
    }
  }
  return result
}

// ─── Scoring & session building ───────────────────────────────────────────────

export async function buildSession() {
  const follows = await db.getAll('follows')
  const seenList = await db.getAll('seen')
  const seenMap = new Map(seenList.map(s => [s.id, s]))

  if (follows.length === 0) return []

  // Build raw candidates from direct follows
  const candidates = await buildCandidates(follows)

  // Merge P800 candidates (from cache only, non-blocking)
  for (const follow of follows) {
    const p800 = await getP800Candidates(follow.id)
    for (const [title, entry] of p800) {
      if (!candidates.has(title) || candidates.get(title).score < entry.score) {
        candidates.set(title, entry)
      }
    }
  }

  // Remove follows themselves and already-known articles
  for (const follow of follows) candidates.delete(follow.id)
  for (const [id, seen] of seenMap) {
    const title = id.split('#')[0]
    if (seen.action === 'know') candidates.delete(title)
  }

  // Apply quality boosts and novelty penalties
  const graphCache = new Map()
  const scored = []
  for (const [title, entry] of candidates) {
    const graph = await db.get('graph', title)
    const quality = graph?.quality || 1.0

    // Novelty: lower score if seen recently
    const seenEntry = seenMap.get(title + '#any')
    const recency = seenEntry
      ? Math.max(0, 1 - (Date.now() - seenEntry.seenAt) / (7 * 24 * 3600 * 1000))
      : 0
    const novelty = 1 - recency * 0.7

    scored.push({
      title,
      score: entry.score * quality * novelty,
      via: entry.via,
      type: entry.type,
      work: entry.work,
    })
  }

  scored.sort((a, b) => b.score - a.score)

  // Session mix: top 60% near, 25% mid-range (exploration), 15% tail (wildcard)
  const n = scored.length
  const near = scored.slice(0, Math.ceil(n * 0.6))
  const mid  = scored.slice(Math.ceil(n * 0.6), Math.ceil(n * 0.85))
  const tail = scored.slice(Math.ceil(n * 0.85))

  function pick(arr, count) {
    const shuffled = [...arr].sort(() => Math.random() - 0.5)
    return shuffled.slice(0, count)
  }

  const sessionSize = 15
  const nearCount = Math.round(sessionSize * 0.6)
  const midCount  = Math.round(sessionSize * 0.25)
  const tailCount = sessionSize - nearCount - midCount

  const session = [
    ...pick(near, nearCount),
    ...pick(mid, midCount),
    ...pick(tail, tailCount),
  ].sort(() => Math.random() - 0.5)  // shuffle the mix

  return session
}

// ─── Section picking ──────────────────────────────────────────────────────────

// Returns best unseen section for an article
export async function pickSection(title, seenMap) {
  let { sections, html } = await api.getArticleData(title)
  const parsed = api.parseSections(html, sections)
  const withScore = parsed.filter(s => s.score > 0)
  console.log('[pickSection]', title, '→ parsed:', parsed.length, 'score>0:', withScore.length,
    withScore.length ? 'best: ' + withScore[0].heading + ' (' + withScore[0].wordCount + 'w)' : '')
  const candidates = withScore
    .filter(s => !seenMap.has(title + '#' + s.anchor))
    .sort((a, b) => b.score - a.score)

  return candidates[0] || null
}

// Build provenance display string for a candidate
export function provenanceLabel(candidate, followTitle) {
  if (candidate.type === '1hop') {
    return `Following: ${followTitle}`
  }
  if (candidate.type === 'p800') {
    return `${followTitle} → ${candidate.work}`
  }
  if (candidate.type === '2hop' && candidate.work) {
    return `${followTitle} → ${candidate.work} → ${candidate.title}`
  }
  return `Via ${candidate.via || followTitle}`
}
