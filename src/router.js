// Screen routing + non-feed screens

import { db } from './db.js'
import * as api from './api.js'
import { initFeed, showToast } from './renderer.js'

const SCREENS = ['feed', 'saved', 'threads', 'settings']

export function navigate(name) {
  SCREENS.forEach(s => {
    document.getElementById('screen-' + s)?.classList.toggle('active', s === name)
    document.getElementById('nav-' + s)?.classList.toggle('active', s === name)
  })
  if (name === 'feed')     initFeed()
  if (name === 'saved')    renderSaved()
  if (name === 'threads')  renderThreads()
  if (name === 'settings') renderSettings()
}

export function init() {
  // Nav buttons
  SCREENS.forEach(name => {
    document.getElementById('nav-' + name)?.addEventListener('click', () => navigate(name))
  })
  // Start on feed — navigate() calls initFeed() already
  navigate('feed')
}

// ─── Saved screen ─────────────────────────────────────────────────────────────
async function renderSaved() {
  const el = document.getElementById('saved-list')
  if (!el) return
  el.innerHTML = ''

  const items = await db.getAll('saved')
  items.sort((a, b) => b.savedAt - a.savedAt)

  if (items.length === 0) {
    el.innerHTML = `<div class="empty-state"><h3>Nothing saved yet</h3><p>Tap Save on a card to add it here.</p></div>`
    return
  }

  items.forEach(item => {
    const div = document.createElement('div')
    div.className = 'saved-item'
    const date = new Date(item.savedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
    div.innerHTML = `
      <button class="saved-item-del" data-id="${item.id}">Remove</button>
      <div class="saved-item-title">${escHtml(item.title)}</div>
      <div class="saved-item-section">${escHtml(item.heading)}</div>
      <div class="saved-item-date">${date}</div>`
    div.querySelector('.saved-item-del').addEventListener('click', async e => {
      e.stopPropagation()
      await db.delete('saved', item.id)
      div.remove()
    })
    div.addEventListener('click', e => {
      if (e.target.closest('.saved-item-del')) return
      showSavedDetail(item)
    })
    el.appendChild(div)
  })
}

function showSavedDetail(item) {
  const overlay = document.createElement('div')
  overlay.style.cssText = `
    position:fixed; inset:0; background:var(--bg); z-index:50;
    overflow-y:auto;
    padding: calc(env(safe-area-inset-top, 0px) + 14px) 20px calc(env(safe-area-inset-bottom, 0px) + 80px);`
  overlay.innerHTML = `
    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:16px;">
      <button id="saved-back" style="
        display:flex; align-items:center; gap:6px; background:none; border:none;
        cursor:pointer; color:var(--accent); font-size:0.95em;
        font-family:var(--sans); padding:0;">
        ← Back
      </button>
      <button id="saved-remove" style="
        background:none; border:1px solid var(--border); border-radius:12px;
        padding:4px 12px; font-size:0.8em; font-family:var(--sans);
        color:var(--text-dim); cursor:pointer;">
        Remove
      </button>
    </div>
    <div style="font-family:var(--sans); font-size:0.8em; text-transform:uppercase;
      letter-spacing:0.08em; color:var(--accent); margin-bottom:8px;">${escHtml(item.title)}</div>
    <h2 style="font-family:var(--serif); font-size:1.4em; margin-bottom:16px; line-height:1.35;">${escHtml(item.heading)}</h2>
    <div style="font-family:var(--serif); font-size:1em; line-height:1.75; color:var(--text);">${item.html || escHtml(item.text || '')}</div>
    <div style="margin-top:20px;">
      <a href="${item.url}" target="_blank" rel="noopener"
        style="color:var(--accent); font-family:var(--sans); font-size:0.9em;">
        Open in Wikipedia ↗
      </a>
    </div>`
  overlay.querySelector('#saved-back').addEventListener('click', () => overlay.remove())
  overlay.querySelector('#saved-remove').addEventListener('click', async () => {
    await db.delete('saved', item.id)
    overlay.remove()
    renderSaved()
  })
  document.body.appendChild(overlay)
}

// ─── Threads screen ───────────────────────────────────────────────────────────
async function renderThreads() {
  const followList = document.getElementById('follows-list')
  if (!followList) return
  followList.innerHTML = ''

  const follows = await db.getAll('follows')

  if (follows.length === 0) {
    followList.innerHTML = `<div class="empty-state" style="height:auto; padding:20px 18px;">
      <p>No followed articles yet. Search for an article to start.</p>
    </div>`
  } else {
    follows.sort((a, b) => b.addedAt - a.addedAt)
    follows.forEach(f => {
      const div = document.createElement('div')
      div.className = 'thread-item'
      div.innerHTML = `
        <span class="thread-title">${escHtml(f.id)}</span>
        <span class="thread-type">${f.type === 'like' ? 'liked' : f.type}</span>
        <button class="thread-del-btn" data-id="${escAttr(f.id)}">Unfollow</button>`
      div.querySelector('.thread-del-btn').addEventListener('click', async () => {
        await db.delete('follows', f.id)
        div.remove()
        showToast(`Unfollowed ${f.id}`)
      })
      followList.appendChild(div)
    })
  }

  // Search
  const input = document.getElementById('follow-search')
  const resultsEl = document.getElementById('follow-results')
  const goBtn = document.getElementById('follow-go')

  if (!input || !resultsEl || !goBtn) return

  let searchTimeout = null
  input.addEventListener('input', () => {
    clearTimeout(searchTimeout)
    searchTimeout = setTimeout(() => runSearch(input.value.trim(), resultsEl), 350)
  })
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') runSearch(input.value.trim(), resultsEl)
  })
  goBtn.addEventListener('click', () => runSearch(input.value.trim(), resultsEl))
}

async function runSearch(query, resultsEl) {
  if (!query) { resultsEl.innerHTML = ''; return }
  resultsEl.innerHTML = `<div style="padding:12px 18px; color:var(--text-dim); font-size:0.9em;">Searching…</div>`
  try {
    const results = await api.searchArticles(query)
    resultsEl.innerHTML = ''
    if (results.length === 0) {
      resultsEl.innerHTML = `<div style="padding:12px 18px; color:var(--text-dim);">No results.</div>`
      return
    }
    results.forEach(r => {
      const div = document.createElement('div')
      div.className = 'result-item'
      div.innerHTML = `
        <button class="result-follow-btn" data-title="${escAttr(r.title)}">Follow</button>
        <div class="result-title">${escHtml(r.title)}</div>
        <div class="result-desc">${escHtml(r.description)}</div>`
      div.querySelector('.result-follow-btn').addEventListener('click', async () => {
        await db.put('follows', { id: r.title, type: 'seed', addedAt: Date.now() })
        showToast(`Now following: ${r.title}`)
        renderThreads()
        document.getElementById('follow-search').value = ''
        resultsEl.innerHTML = ''
      })
      resultsEl.appendChild(div)
    })
  } catch (e) {
    resultsEl.innerHTML = `<div style="padding:12px 18px; color:var(--text-dim);">Search failed. Try again.</div>`
  }
}

// ─── Settings screen ──────────────────────────────────────────────────────────
async function renderSettings() {
  // Theme
  const theme = await db.getSetting('theme', 'dark')
  document.querySelectorAll('.theme-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.theme === theme)
    btn.addEventListener('click', async () => {
      const t = btn.dataset.theme
      document.documentElement.dataset.theme = t
      await db.putSetting('theme', t)
      document.querySelectorAll('.theme-btn').forEach(b => b.classList.toggle('active', b.dataset.theme === t))
    })
  })

  // Font size
  const sizeEl = document.getElementById('font-size-display')
  const updateSize = async (delta) => {
    const cur = parseInt(getComputedStyle(document.documentElement).fontSize)
    const next = Math.max(14, Math.min(24, cur + delta))
    document.documentElement.style.fontSize = next + 'px'
    if (sizeEl) sizeEl.textContent = next + 'px'
    await db.putSetting('fontSize', next)
  }
  document.getElementById('font-dec')?.addEventListener('click', () => updateSize(-1))
  document.getElementById('font-inc')?.addEventListener('click', () => updateSize(1))
  const savedSize = await db.getSetting('fontSize', 18)
  document.documentElement.style.fontSize = savedSize + 'px'
  if (sizeEl) sizeEl.textContent = savedSize + 'px'

  // Export
  document.getElementById('btn-export')?.addEventListener('click', async () => {
    const json = await db.exportAll()
    const blob = new Blob([json], { type: 'application/json' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = 'wikifeed-backup.json'
    a.click()
  })

  // Import
  document.getElementById('btn-import')?.addEventListener('click', () => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.json'
    input.addEventListener('change', async () => {
      const file = input.files[0]
      if (!file) return
      const text = await file.text()
      try {
        await db.importAll(text)
        showToast('Data imported')
        navigate('feed')
        initFeed()
      } catch (e) {
        showToast('Import failed: invalid file')
      }
    })
    input.click()
  })
}

function escHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
function escAttr(str) { return escHtml(str) }
