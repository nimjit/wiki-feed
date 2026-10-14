// Card rendering and swipe controller

import { db } from './db.js'
import * as api from './api.js'
import { buildSession, pickSection } from './algorithm.js'

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
  share:   `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>`,
}

// ─── Feed state ───────────────────────────────────────────────────────────────
let session = []
let sessionIdx = 0
let cardHistory = []
let currentCard = null
let feedLoading = false
let nextCardData = null        // pre-fetched {candidate, section, forIdx}
let nextSessionCache = null    // pre-built next session array
let buildingNextSession = false

// ─── Build & display the feed ─────────────────────────────────────────────────
export async function initFeed() {
  if (session.length > 0 && sessionIdx < session.length) return
  if (feedLoading) return
  feedLoading = true

  const stack = document.getElementById('card-stack')
  stack.innerHTML = '<div class="card-loading"><div class="spinner"></div><span>Building feed…</span></div>'

  try {
    const follows = await db.getAll('follows')
    if (follows.length === 0) { showOnboarding(); return }

    session = await buildSession()
    sessionIdx = 0
    cardHistory = []
    nextCardData = null

    if (session.length === 0) {
      stack.innerHTML = `<div class="empty-state">
        <h3>No cards yet</h3>
        <p>Your followed articles are being indexed. Try again in a moment.</p>
        <button class="btn-primary" id="feed-retry-btn">Refresh</button>
      </div>`
      stack.querySelector('#feed-retry-btn').addEventListener('click', () => { session = []; initFeed() })
      return
    }

    await showNextCard()
  } catch (e) {
    console.error('Feed init failed:', e)
    const offline = !navigator.onLine
    stack.innerHTML = `<div class="empty-state">
      <h3>${offline ? 'You\'re offline' : 'Couldn\'t load feed'}</h3>
      <p>${offline ? 'Saved articles are still available. Connect and try again.' : escHtml(e.message)}</p>
      <button class="btn-primary" id="feed-retry-btn">Try again</button>
    </div>`
    stack.querySelector('#feed-retry-btn').addEventListener('click', () => { session = []; initFeed() })
  } finally {
    feedLoading = false
  }
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

async function showNextCard(attempts = 0) {
  if (sessionIdx >= session.length || attempts > 30) {
    showSessionEnd()
    return
  }

  // Start pre-building the next session when near the end of this one
  if (!buildingNextSession && session.length - sessionIdx <= 3) {
    buildingNextSession = true
    buildSession().then(s => { nextSessionCache = s }).catch(() => {}).finally(() => { buildingNextSession = false })
  }

  const idxNow = sessionIdx
  const candidate = session[idxNow]
  sessionIdx++

  const stack = document.getElementById('card-stack')
  const hasPrefetch = nextCardData?.forIdx === idxNow
  let loadingCard = null

  if (!hasPrefetch) {
    loadingCard = document.createElement('div')
    loadingCard.className = 'card'
    loadingCard.innerHTML = `<div class="card-loading"><div class="spinner"></div><span>Loading…</span></div>`
    stack.appendChild(loadingCard)
  }

  try {
    let section
    if (hasPrefetch) {
      section = nextCardData.section
      nextCardData = null
    } else {
      const seenList = await db.getAll('seen')
      const seenMap = new Map(seenList.map(s => [s.id, s]))
      section = await pickSection(candidate.title, seenMap)
    }

    if (!section) {
      loadingCard?.remove()
      await showNextCard(attempts + 1)
      return
    }

    const card = buildCard(candidate, section)
    if (loadingCard) loadingCard.replaceWith(card)
    else stack.appendChild(card)
    attachSwipe(card)
    if (currentCard) currentCard.remove()
    currentCard = card
    cardHistory.push({ candidate, section, savedIdx: idxNow })
    if (cardHistory.length > 20) cardHistory.shift()

    // Pre-fetch the next card in the background
    prefetchNext().catch(() => {})

  } catch (e) {
    console.error('Card load failed:', candidate.title, e)
    if (loadingCard) {
      loadingCard.innerHTML = `<div class="empty-state">
        <p>Couldn't load this card.</p>
        <button class="btn-primary">Next</button>
      </div>`
      loadingCard.querySelector('button').addEventListener('click', () => { loadingCard.remove(); showNextCard() })
    } else {
      await showNextCard(attempts + 1)
    }
  }
}

async function prefetchNext() {
  nextCardData = null
  if (sessionIdx >= session.length) return
  const seenList = await db.getAll('seen')
  const seenMap = new Map(seenList.map(s => [s.id, s]))
  for (let i = sessionIdx; i < Math.min(sessionIdx + 5, session.length); i++) {
    try {
      const section = await pickSection(session[i].title, seenMap)
      if (section) { nextCardData = { candidate: session[i], section, forIdx: i }; return }
    } catch { /* skip this candidate */ }
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
    currentCard = null; cardHistory = []; nextCardData = null
    stack.innerHTML = '<div class="card-loading"><div class="spinner"></div><span>Building feed…</span></div>'
    // Use pre-built session if available, otherwise build fresh
    if (nextSessionCache) {
      session = nextSessionCache; nextSessionCache = null
    } else {
      session = await buildSession()
    }
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

  const cleanedHTML = api.cleanHTML(section.html)
  const words = textWords(cleanedHTML)
  const PREVIEW_WORDS = 200

  let bodyHTML
  if (words.length <= PREVIEW_WORDS) {
    bodyHTML = `<div class="card-section-text"><div class="section-head" style="max-height:none">${cleanedHTML}</div></div>`
  } else {
    bodyHTML = `
      <div class="card-section-text section-truncated">
        <div class="section-head">${cleanedHTML}</div>
        <button class="expand-btn">Read more (${words.length} words)</button>
      </div>`
  }

  card.innerHTML = `
    <div class="card-meta">
      <div class="card-article-title">${escHtml(candidate.title)}</div>
      <div class="card-provenance">${buildProvenance(candidate)}</div>
    </div>
    <div class="card-body">
      <h2 class="card-section-heading">${escHtml(section.heading)}</h2>
      ${bodyHTML}
    </div>
    <div class="card-actions">
      <button class="action-btn" data-action="know"  title="I know this">${ICONS.know}<span>I know this</span></button>
      <button class="action-btn" data-action="like"  title="More like this">${ICONS.like}<span>More like this</span></button>
      <button class="action-btn" data-action="save"  title="Save">${ICONS.save}<span>Save</span></button>
      <button class="action-btn" data-action="share" title="Share">${ICONS.share}<span>Share</span></button>
      <button class="action-btn" data-action="open"  title="Open article">${ICONS.open}<span>Open</span></button>
    </div>`

  card.querySelector('.expand-btn')?.addEventListener('click', e => {
    e.stopPropagation()
    card.querySelector('.section-truncated')?.classList.add('expanded')
  })

  card.querySelectorAll('.wiki-link').forEach(a => {
    a.addEventListener('click', e => {
      e.preventDefault()
      if (a.dataset.wiki) handleWikiLinkClick(a.dataset.wiki, candidate.title)
    })
  })

  card.querySelectorAll('.action-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation()
      handleAction(btn.dataset.action, candidate, section, card)
    })
  })

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
  steps.push(`<span class="prov-step" data-title="${escAttr(candidate.via)}">${escHtml(candidate.via)}</span>`)
  if ((candidate.type === 'p800' || candidate.type === '2hop') && candidate.work) {
    steps.push(`<span style="color:var(--border)">›</span>`)
    steps.push(`<span class="prov-step" data-title="${escAttr(candidate.work)}">${escHtml(candidate.work)}</span>`)
  }
  return steps.join(' ')
}

async function showProvenanceMenu(el, title) {
  const menu = document.createElement('div')
  menu.style.cssText = `
    position:fixed; background:var(--bg); border:1px solid var(--border);
    border-radius:8px; padding:8px; z-index:100; box-shadow:0 4px 12px rgba(0,0,0,0.2);
    top:${Math.min(el.getBoundingClientRect().bottom + 6, window.innerHeight - 120)}px;
    left:${Math.min(el.getBoundingClientRect().left, window.innerWidth - 180)}px;
    min-width:160px; font-family:var(--sans); font-size:0.88em;`

  const follows = await db.getAll('follows')
  const isFollowed = follows.some(f => f.id === title)
  menu.innerHTML = `
    <div style="padding:4px 8px 8px; font-weight:600; color:var(--text-dim); font-size:0.85em; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:160px">${escHtml(title)}</div>
    ${isFollowed
      ? `<button class="menu-btn" data-act="unfollow">Unfollow</button>`
      : `<button class="menu-btn" data-act="follow">Follow</button>`}
    <button class="menu-btn" data-act="mute">Mute this path</button>`
  styleMenuBtns(menu)
  menu.querySelectorAll('.menu-btn').forEach(b => {
    b.addEventListener('click', async () => {
      if (b.dataset.act === 'follow') { await db.put('follows', { id: title, type: 'link', addedAt: Date.now() }); showToast(`Now following ${title}`) }
      else if (b.dataset.act === 'unfollow') { await db.delete('follows', title); showToast(`Unfollowed ${title}`) }
      else if (b.dataset.act === 'mute') { await db.put('seen', { id: title + '#any', action: 'mute', seenAt: Date.now() }); showToast(`Muted ${title}`) }
      menu.remove()
    })
  })
  document.body.appendChild(menu)
  const dismiss = e => { if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener('click', dismiss) } }
  setTimeout(() => document.addEventListener('click', dismiss), 10)
}

// ─── Wiki-link popup ──────────────────────────────────────────────────────────
function handleWikiLinkClick(title, fromTitle) {
  document.getElementById('wikilink-popup')?.remove()
  const popup = document.createElement('div')
  popup.id = 'wikilink-popup'
  popup.style.cssText = `
    position:fixed; background:var(--bg); border:1px solid var(--border);
    border-radius:8px; padding:8px; z-index:100; box-shadow:0 4px 16px rgba(0,0,0,0.2);
    bottom:calc(var(--nav-h) + 14px + var(--safe-bot)); left:50%;
    transform:translateX(-50%); min-width:220px; max-width:85vw;
    font-family:var(--sans); font-size:0.88em;`
  popup.innerHTML = `
    <div style="padding:4px 8px 8px; font-weight:600; color:var(--text-dim); font-size:0.85em; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${escHtml(title)}</div>
    <button class="menu-btn" data-act="session">Add to this session</button>
    <button class="menu-btn" data-act="follow">Follow</button>`
  styleMenuBtns(popup)
  popup.querySelectorAll('.menu-btn').forEach(b => {
    b.addEventListener('click', async () => {
      if (b.dataset.act === 'session') {
        session.splice(sessionIdx, 0, { title, score: 1.5, via: fromTitle, type: '1hop' })
        showToast(`"${title}" added to session`)
      } else if (b.dataset.act === 'follow') {
        await db.put('follows', { id: title, type: 'link', addedAt: Date.now() })
        showToast(`Following: ${title}`)
      }
      popup.remove()
    })
  })
  document.body.appendChild(popup)
  const dismiss = e => { if (!popup.contains(e.target)) { popup.remove(); document.removeEventListener('click', dismiss) } }
  setTimeout(() => document.addEventListener('click', dismiss), 10)
}

// ─── Action handlers ──────────────────────────────────────────────────────────
async function handleAction(action, candidate, section, card) {
  const id = candidate.title + '#' + section.anchor
  const btn = card.querySelector(`[data-action="${action}"]`)

  if (action === 'know') {
    await db.put('seen', { id: candidate.title + '#any', action: 'know', seenAt: Date.now() })
    btn.classList.add('active')
    showToastWithUndo(`Marked as known`, async () => {
      await db.delete('seen', candidate.title + '#any')
      showToast('Undone')
    })
    await nextCard(card)

  } else if (action === 'like') {
    await db.put('follows', { id: candidate.title, type: 'like', addedAt: Date.now() })
    await db.put('seen', { id, action: 'like', seenAt: Date.now() })
    btn.classList.add('active')
    showToast(`Following: ${candidate.title}`)
    await nextCard(card)

  } else if (action === 'save') {
    const cleanText = plainTextFromHTML(api.cleanHTML(section.html))
    await db.put('saved', {
      id, title: candidate.title, heading: section.heading,
      text: cleanText.slice(0, 2000),
      html: api.cleanHTML(section.html),
      url: `https://en.wikipedia.org/wiki/${encodeURIComponent(candidate.title.replace(/ /g, '_'))}#${section.anchor}`,
      savedAt: Date.now(),
    })
    btn.classList.add('active')
    showToast('Saved')
    await db.put('seen', { id, action: 'save', seenAt: Date.now() })

  } else if (action === 'share') {
    const url = `https://en.wikipedia.org/wiki/${encodeURIComponent(candidate.title.replace(/ /g, '_'))}#${section.anchor}`
    if (navigator.share) {
      navigator.share({ title: `${candidate.title} — ${section.heading}`, url }).catch(() => {})
    } else {
      navigator.clipboard?.writeText(url).then(() => showToast('Link copied'))
        .catch(() => showToast('Open in Wikipedia to share'))
    }

  } else if (action === 'open') {
    const url = `https://en.wikipedia.org/wiki/${encodeURIComponent(candidate.title.replace(/ /g, '_'))}#${section.anchor}`
    window.open(url, '_blank', 'noopener')
    await db.put('seen', { id, action: 'open', seenAt: Date.now() })
  }
}

async function nextCard(exitingCard) {
  exitingCard.classList.add('exiting-left')
  await wait(280)
  exitingCard.remove()
  await showNextCard()
}

async function goBack(exitingCard) {
  if (cardHistory.length < 2) {
    showToast('Already at the first card')
    exitingCard.style.transform = ''
    exitingCard.style.opacity = ''
    return
  }
  cardHistory.pop()
  const prev = cardHistory[cardHistory.length - 1]
  sessionIdx = prev.savedIdx + 1
  nextCardData = null  // invalidate pre-fetch since we're going back

  exitingCard.classList.add('exiting-right')
  await wait(280)
  exitingCard.remove()

  const stack = document.getElementById('card-stack')
  const prevCard = buildCard(prev.candidate, prev.section)
  stack.appendChild(prevCard)
  attachSwipe(prevCard)
  currentCard = prevCard
}

// ─── Swipe gesture controller ─────────────────────────────────────────────────
function attachSwipe(card) {
  let startX = null, startY = null, pid = null
  let dir = null  // 'h' | 'v' — locked in after first 10px of movement

  card.addEventListener('pointerdown', e => {
    if (e.target.closest('button, a, .wiki-link, .prov-step')) return
    startX = e.clientX; startY = e.clientY; pid = e.pointerId; dir = null
  })

  card.addEventListener('pointermove', e => {
    if (startX === null || e.pointerId !== pid) return
    const dx = e.clientX - startX
    const dy = e.clientY - startY
    if (!dir) {
      if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return
      dir = Math.abs(dx) >= Math.abs(dy) ? 'h' : 'v'
      if (dir === 'h') card.setPointerCapture(pid)
      else { startX = null; return }
    }
    if (dir !== 'h') return
    card.style.transform = `translateX(${dx * 0.75}px)`
    card.style.opacity = String(1 - Math.abs(dx) / 500)
  })

  card.addEventListener('pointerup', async e => {
    if (startX === null || dir !== 'h' || e.pointerId !== pid) { startX = null; dir = null; return }
    const dx = e.clientX - startX
    startX = null; dir = null
    card.style.transform = ''; card.style.opacity = ''
    if (dx < -80) {
      await db.put('seen', { id: card.dataset.title + '#' + card.dataset.anchor, action: 'skip', seenAt: Date.now() })
      await nextCard(card)
    } else if (dx > 80) {
      await goBack(card)
    }
  })

  card.addEventListener('pointercancel', () => {
    startX = null; dir = null
    card.style.transform = ''; card.style.opacity = ''
  })
}

// ─── Keyboard shortcuts ───────────────────────────────────────────────────────
document.addEventListener('keydown', e => {
  if (e.target.matches('input, textarea, select, [contenteditable]')) return
  if (e.metaKey || e.ctrlKey || e.altKey) return
  if (!currentCard) return
  if (e.key === 'ArrowLeft' || e.key === 'j') {
    e.preventDefault()
    db.put('seen', { id: currentCard.dataset.title + '#' + currentCard.dataset.anchor, action: 'skip', seenAt: Date.now() })
      .then(() => nextCard(currentCard))
  } else if (e.key === 'ArrowRight' || e.key === 'h') {
    e.preventDefault()
    goBack(currentCard)
  } else if (e.key === 's') {
    currentCard.querySelector('[data-action="save"]')?.click()
  } else if (e.key === 'k') {
    currentCard.querySelector('[data-action="know"]')?.click()
  } else if (e.key === 'l') {
    currentCard.querySelector('[data-action="like"]')?.click()
  } else if (e.key === 'o') {
    currentCard.querySelector('[data-action="open"]')?.click()
  }
})

// ─── Helpers ──────────────────────────────────────────────────────────────────
function styleMenuBtns(container) {
  container.querySelectorAll('.menu-btn').forEach(b => {
    Object.assign(b.style, { display:'block', width:'100%', padding:'7px 8px',
      background:'none', border:'none', cursor:'pointer', textAlign:'left',
      color:'var(--text)', borderRadius:'4px', fontFamily:'var(--sans)', fontSize:'0.95em' })
    b.addEventListener('mouseover', () => b.style.background = 'var(--surface)')
    b.addEventListener('mouseout', () => b.style.background = 'none')
  })
}

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

function escHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
function escAttr(str) { return escHtml(str) }
function wait(ms) { return new Promise(r => setTimeout(r, ms)) }

// ─── Toast notifications ──────────────────────────────────────────────────────
let toastTimer = null

export function showToast(msg, duration = 2000) {
  const toast = getOrCreateToast()
  clearTimeout(toastTimer)
  toast.style.pointerEvents = 'none'
  toast.textContent = msg
  toast.style.opacity = '1'
  toastTimer = setTimeout(() => { toast.style.opacity = '0' }, duration)
}

function showToastWithUndo(msg, onUndo) {
  const toast = getOrCreateToast()
  clearTimeout(toastTimer)
  toast.style.pointerEvents = 'auto'
  toast.innerHTML = `<span>${escHtml(msg)}</span><button style="background:none;border:none;color:inherit;font:inherit;font-size:0.9em;text-decoration:underline;cursor:pointer;padding:0;margin-left:12px;">Undo</button>`
  toast.style.opacity = '1'
  toast.querySelector('button').addEventListener('click', () => {
    clearTimeout(toastTimer)
    toast.style.opacity = '0'
    toast.style.pointerEvents = 'none'
    onUndo()
  }, { once: true })
  toastTimer = setTimeout(() => { toast.style.opacity = '0'; toast.style.pointerEvents = 'none' }, 4000)
}

function getOrCreateToast() {
  let toast = document.getElementById('toast')
  if (!toast) {
    toast = document.createElement('div')
    toast.id = 'toast'
    toast.style.cssText = `
      position:fixed; bottom:calc(var(--nav-h) + 12px + var(--safe-bot)); left:50%;
      transform:translateX(-50%); background:var(--text); color:var(--bg);
      padding:8px 18px; border-radius:20px; font-size:0.85em; font-family:var(--sans);
      z-index:200; opacity:0; transition:opacity 0.2s;
      max-width:90vw; display:flex; align-items:center; white-space:nowrap;`
    document.body.appendChild(toast)
  }
  return toast
}
