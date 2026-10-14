// Card rendering and swipe controller

import { db } from './db.js'
import * as api from './api.js'
import { buildSession, pickSection, provenanceLabel } from './algorithm.js'

// ─── Icons (inline SVG) ───────────────────────────────────────────────────────
const ICONS = {
  feed:    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="3" width="18" height="7" rx="2"/><rect x="3" y="14" width="18" height="7" rx="2"/></svg>`,
  saved:   `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>`,
  threads: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="5" r="3"/><circle cx="5" cy="19" r="3"/><circle cx="19" cy="19" r="3"/><line x1="12" y1="8" x2="5" y2="16"/><line x1="12" y1="8" x2="19" y2="16"/></svg>`,
  settings:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="3"/><path d="M19.07 4.93A10 10 0 0 0 4.93 19.07M19.07 19.07A10 10 0 0 0 4.93 4.93"/></svg>`,
  know:    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2zm0 0v10m0 0 3-3m-3 3-3-3"/></svg>`,
  like:    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3H14z"/><path d="M7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"/></svg>`,
  save:    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>`,
  open:    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>`,
  add:     `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/></svg>`,
  mute:    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><line x1="3" y1="3" x2="21" y2="21"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"/></svg>`,
}

// ─── Feed state ───────────────────────────────────────────────────────────────
let session = []
let sessionIdx = 0
let cardHistory = []    // for swipe-back
let currentCard = null

// ─── Build & display the feed ─────────────────────────────────────────────────
export async function initFeed() {
  const stack = document.getElementById('card-stack')
  stack.innerHTML = '<div class="card-loading"><div class="spinner"></div><span>Building feed…</span></div>'

  const follows = await db.getAll('follows')
  if (follows.length === 0) {
    showOnboarding()
    return
  }

  session = await buildSession()
  sessionIdx = 0
  cardHistory = []

  if (session.length === 0) {
    stack.innerHTML = `<div class="empty-state">
      <h3>No cards yet</h3>
      <p>Your followed articles are being indexed. Try again in a moment.</p>
      <button class="btn-primary" onclick="location.reload()">Refresh</button>
    </div>`
    return
  }

  await showNextCard()
}

function showOnboarding() {
  const stack = document.getElementById('card-stack')
  stack.innerHTML = `
    <div class="onboarding">
      <h2>Start with an article you love</h2>
      <p>WikiFeed builds a reading feed from articles you follow, surfacing sections from related topics.</p>
      <p>No algorithms, no engagement tracking — just Wikipedia's own text, routed by your interests.</p>
      <button class="btn-primary" id="ob-follow-btn">Follow your first article</button>
    </div>`
  document.getElementById('ob-follow-btn').addEventListener('click', () => {
    import('./router.js').then(r => r.navigate('threads'))
  })
}

async function showNextCard(direction = 'up') {
  if (sessionIdx >= session.length) {
    showSessionEnd()
    return
  }

  const candidate = session[sessionIdx]
  sessionIdx++

  const stack = document.getElementById('card-stack')

  // Build card (async — show loading while fetching)
  const loadingCard = document.createElement('div')
  loadingCard.className = 'card'
  loadingCard.innerHTML = `<div class="card-loading"><div class="spinner"></div><span>Loading…</span></div>`
  stack.appendChild(loadingCard)

  try {
    const seenList = await db.getAll('seen')
    const seenMap = new Map(seenList.map(s => [s.id, s]))
    const section = await pickSection(candidate.title, seenMap)

    if (!section) {
      // Article fully seen — try next
      loadingCard.remove()
      sessionIdx++  // skip
      await showNextCard(direction)
      return
    }

    const card = buildCard(candidate, section)
    loadingCard.replaceWith(card)
    attachSwipe(card)
    if (currentCard) currentCard.remove()
    currentCard = card

  } catch (e) {
    console.error('Card load failed:', candidate.title, e)
    loadingCard.innerHTML = `<div class="empty-state">
      <p>Couldn't load this card.</p>
      <button class="btn-primary" onclick="">Next</button>
    </div>`
    loadingCard.querySelector('button').addEventListener('click', () => {
      loadingCard.remove()
      showNextCard('up')
    })
  }
}

function showSessionEnd() {
  const stack = document.getElementById('card-stack')
  stack.innerHTML = `
    <div class="session-end">
      <h2>That's your session</h2>
      <p>${sessionIdx} cards from your interests</p>
      <button class="btn-continue">Continue reading</button>
    </div>`
  stack.querySelector('.btn-continue').addEventListener('click', async () => {
    session = await buildSession()
    sessionIdx = 0
    await showNextCard()
  })
}

// ─── Card construction ────────────────────────────────────────────────────────
function buildCard(candidate, section) {
  const card = document.createElement('div')
  card.className = 'card'
  card.dataset.title = candidate.title
  card.dataset.anchor = section.anchor

  // Provenance
  const follows = []  // populated below
  const via = candidate.via || ''
  const provParts = buildProvenance(candidate)

  // Section text with truncation
  const cleanedHTML = api.cleanHTML(section.html)
  const words = textWords(cleanedHTML)
  const PREVIEW_WORDS = 200

  let bodyHTML
  if (words.length <= PREVIEW_WORDS) {
    bodyHTML = `<div class="card-section-text">${cleanedHTML}</div>`
  } else {
    const preview = buildPreview(cleanedHTML, PREVIEW_WORDS)
    const tail = buildTail(cleanedHTML, PREVIEW_WORDS)
    bodyHTML = `
      <div class="card-section-text section-truncated">
        <div class="section-head">${preview}</div>
        <div class="section-tail">${tail}</div>
        <button class="expand-btn">Read more (${words.length} words)</button>
      </div>`
  }

  card.innerHTML = `
    <div class="card-meta">
      <div class="card-article-title">${escHtml(candidate.title)}</div>
      <div class="card-provenance" id="prov-${Date.now()}">${provParts}</div>
    </div>
    <div class="card-body">
      <h2 class="card-section-heading">${escHtml(section.heading)}</h2>
      ${bodyHTML}
    </div>
    <div class="card-actions">
      <button class="action-btn" data-action="know"  title="I know this">${ICONS.know}<span>I know this</span></button>
      <button class="action-btn" data-action="like"  title="More like this">${ICONS.like}<span>More like this</span></button>
      <button class="action-btn" data-action="save"  title="Save">${ICONS.save}<span>Save</span></button>
      <button class="action-btn" data-action="open"  title="Open article">${ICONS.open}<span>Open article</span></button>
    </div>`

  // Expand button
  const expandBtn = card.querySelector('.expand-btn')
  const truncated = card.querySelector('.section-truncated')
  if (expandBtn && truncated) {
    expandBtn.addEventListener('click', e => {
      e.stopPropagation()
      truncated.classList.add('expanded')
    })
  }

  // Wiki link clicks
  card.querySelectorAll('.wiki-link').forEach(a => {
    a.addEventListener('click', e => {
      e.preventDefault()
      const title = a.dataset.wiki
      if (title) handleWikiLinkClick(title, candidate.title)
    })
  })

  // Action buttons
  card.querySelectorAll('.action-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation()
      handleAction(btn.dataset.action, candidate, section, card)
    })
  })

  // Provenance step clicks
  card.querySelectorAll('.prov-step').forEach(span => {
    span.addEventListener('click', e => {
      e.stopPropagation()
      showProvenanceMenu(span, span.dataset.title)
    })
  })

  return card
}

function buildProvenance(candidate) {
  if (!candidate.via) return '<span class="prov-step">Following</span>'

  const steps = []

  if (candidate.type === '1hop') {
    steps.push(`<span class="prov-step" data-title="${escAttr(candidate.via)}">${escHtml(candidate.via)}</span>`)
  } else if (candidate.type === 'p800' && candidate.work) {
    steps.push(`<span class="prov-step" data-title="${escAttr(candidate.via)}">${escHtml(candidate.via)}</span>`)
    steps.push(`<span style="color:var(--border)">›</span>`)
    steps.push(`<span class="prov-step" data-title="${escAttr(candidate.work)}">${escHtml(candidate.work)}</span>`)
  } else if (candidate.type === '2hop' && candidate.work) {
    steps.push(`<span class="prov-step" data-title="${escAttr(candidate.via)}">${escHtml(candidate.via)}</span>`)
    steps.push(`<span style="color:var(--border)">›</span>`)
    steps.push(`<span class="prov-step" data-title="${escAttr(candidate.work)}">${escHtml(candidate.work)}</span>`)
  } else {
    steps.push(`<span class="prov-step" data-title="${escAttr(candidate.via)}">${escHtml(candidate.via)}</span>`)
  }

  return steps.join(' ')
}

async function showProvenanceMenu(el, title) {
  // Simple: prompt to follow or mute
  const menu = document.createElement('div')
  menu.style.cssText = `
    position:fixed; background:var(--bg); border:1px solid var(--border);
    border-radius:8px; padding:8px; z-index:100; box-shadow:0 4px 12px rgba(0,0,0,0.15);
    top:${el.getBoundingClientRect().bottom + 6}px;
    left:${Math.min(el.getBoundingClientRect().left, window.innerWidth - 180)}px;
    min-width:160px; font-family:var(--sans); font-size:0.88em;`

  const follows = await db.getAll('follows')
  const isFollowed = follows.some(f => f.id === title)

  menu.innerHTML = `
    <div style="padding:4px 8px 8px; font-weight:600; color:var(--text-dim); font-size:0.85em">${escHtml(title)}</div>
    ${isFollowed
      ? `<button class="menu-btn" data-act="unfollow">Unfollow</button>`
      : `<button class="menu-btn" data-act="follow">Follow</button>`}
    <button class="menu-btn" data-act="mute">Mute this path</button>`
  menu.querySelectorAll('.menu-btn').forEach(b => {
    Object.assign(b.style, { display:'block', width:'100%', padding:'7px 8px',
      background:'none', border:'none', cursor:'pointer', textAlign:'left',
      color:'var(--text)', borderRadius:'4px' })
    b.addEventListener('mouseover', () => b.style.background = 'var(--surface)')
    b.addEventListener('mouseout', () => b.style.background = 'none')
    b.addEventListener('click', async () => {
      if (b.dataset.act === 'follow') {
        await db.put('follows', { id: title, type: 'link', addedAt: Date.now() })
        showToast(`Now following ${title}`)
      } else if (b.dataset.act === 'unfollow') {
        await db.delete('follows', title)
        showToast(`Unfollowed ${title}`)
      } else if (b.dataset.act === 'mute') {
        await db.put('seen', { id: title + '#any', action: 'mute', seenAt: Date.now() })
        showToast(`Muted ${title}`)
      }
      menu.remove()
    })
  })

  document.body.appendChild(menu)
  const dismiss = e => { if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener('click', dismiss) } }
  setTimeout(() => document.addEventListener('click', dismiss), 10)
}

// ─── Action handlers ──────────────────────────────────────────────────────────
async function handleAction(action, candidate, section, card) {
  const id = candidate.title + '#' + section.anchor
  const btn = card.querySelector(`[data-action="${action}"]`)

  if (action === 'know') {
    await db.put('seen', { id: candidate.title + '#any', action: 'know', seenAt: Date.now() })
    btn.classList.add('active')
    await nextCard(card, 'up')

  } else if (action === 'like') {
    await db.put('follows', { id: candidate.title, type: 'like', addedAt: Date.now() })
    await db.put('seen', { id, action: 'like', seenAt: Date.now() })
    btn.classList.add('active')
    showToast(`Following: ${candidate.title}`)
    await nextCard(card, 'up')

  } else if (action === 'save') {
    const cleanText = plainTextFromHTML(api.cleanHTML(section.html))
    await db.put('saved', {
      id,
      title: candidate.title,
      heading: section.heading,
      text: cleanText.slice(0, 2000),
      html: api.cleanHTML(section.html),
      url: `https://en.wikipedia.org/wiki/${encodeURIComponent(candidate.title.replace(/ /g, '_'))}#${section.anchor}`,
      savedAt: Date.now(),
    })
    btn.classList.add('active')
    showToast('Saved')
    await db.put('seen', { id, action: 'save', seenAt: Date.now() })

  } else if (action === 'open') {
    const url = `https://en.wikipedia.org/wiki/${encodeURIComponent(candidate.title.replace(/ /g, '_'))}#${section.anchor}`
    window.open(url, '_blank', 'noopener')
    await db.put('seen', { id, action: 'open', seenAt: Date.now() })
  }
}

async function nextCard(exitingCard, direction) {
  exitingCard.classList.add(direction === 'up' ? 'exiting-up' : 'exiting-down')
  await wait(300)
  exitingCard.remove()
  await showNextCard(direction)
}

function handleWikiLinkClick(title, fromTitle) {
  // Show quick-follow prompt
  showToast(`"${title}" — swipe to explore or follow from Threads`, 3000)
}

// ─── Swipe gesture controller ─────────────────────────────────────────────────
function attachSwipe(card) {
  let startY = null
  let dragging = false

  card.addEventListener('pointerdown', e => {
    // Only start drag if not clicking a button/link
    if (e.target.closest('button, a, .wiki-link, .prov-step')) return
    startY = e.clientY
    dragging = true
    card.setPointerCapture(e.pointerId)
  })

  card.addEventListener('pointermove', e => {
    if (!dragging || startY === null) return
    const dy = e.clientY - startY
    card.style.transform = `translateY(${dy * 0.4}px)`
    card.style.opacity = String(1 - Math.abs(dy) / 400)
  })

  card.addEventListener('pointerup', async e => {
    if (!dragging) return
    dragging = false
    const dy = e.clientY - startY
    startY = null
    card.style.transform = ''
    card.style.opacity = ''

    if (dy < -80) {
      // Swipe up → next card
      await db.put('seen', {
        id: card.dataset.title + '#' + card.dataset.anchor,
        action: 'skip',
        seenAt: Date.now(),
      })
      await nextCard(card, 'up')
    }
    // Swipe down: could go back — not implemented in v0
  })

  card.addEventListener('pointercancel', () => {
    dragging = false
    startY = null
    card.style.transform = ''
    card.style.opacity = ''
  })
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function textWords(html) {
  const d = document.createElement('div')
  d.innerHTML = html
  return d.textContent.trim().split(/\s+/).filter(Boolean)
}

function plainTextFromHTML(html) {
  const d = document.createElement('div')
  d.innerHTML = html
  return d.textContent.trim()
}

// Split HTML at word boundary for preview/tail
function buildPreview(html, wordLimit) {
  const d = document.createElement('div')
  d.innerHTML = html
  const walker = document.createTreeWalker(d, NodeFilter.SHOW_TEXT)
  let count = 0
  const node = walker.nextNode()
  // Simplified: just show full HTML, let CSS handle fade
  // For accuracy, we'd need a proper truncator; skip complexity for v0
  return html
}

function buildTail(html, wordLimit) {
  return ''  // expanded state just shows full section
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
function escAttr(str) { return escHtml(str) }

function wait(ms) { return new Promise(r => setTimeout(r, ms)) }

// ─── Toast notifications ──────────────────────────────────────────────────────
let toastTimer = null
export function showToast(msg, duration = 2000) {
  let toast = document.getElementById('toast')
  if (!toast) {
    toast = document.createElement('div')
    toast.id = 'toast'
    toast.style.cssText = `
      position:fixed; bottom:calc(var(--nav-h) + 12px + var(--safe-bot)); left:50%;
      transform:translateX(-50%); background:var(--text); color:var(--bg);
      padding:8px 18px; border-radius:20px; font-size:0.85em; font-family:var(--sans);
      z-index:200; opacity:0; transition:opacity 0.2s; pointer-events:none;
      white-space:nowrap; max-width:90vw; overflow:hidden; text-overflow:ellipsis;`
    document.body.appendChild(toast)
  }
  toast.textContent = msg
  toast.style.opacity = '1'
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { toast.style.opacity = '0' }, duration)
}
