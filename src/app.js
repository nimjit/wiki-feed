import { open, db } from './db.js'
import { init as initRouter } from './router.js'

// Register service worker
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(e => {
      console.warn('SW registration failed:', e)
    })
  })
}

// Apply saved theme + font size before render to avoid flash
async function applyStoredPrefs() {
  // Use localStorage as a fast sync read for visual prefs (avoids IDB async flash)
  const theme = localStorage.getItem('wf-theme') || 'light'
  const size  = parseInt(localStorage.getItem('wf-fontsize') || '18')
  document.documentElement.dataset.theme = theme
  document.documentElement.style.fontSize = size + 'px'
}

async function main() {
  applyStoredPrefs()
  await open()

  // Mirror prefs to localStorage for fast next-load read
  db.getSetting('theme', 'light').then(t => localStorage.setItem('wf-theme', t))
  db.getSetting('fontSize', 18).then(s => localStorage.setItem('wf-fontsize', String(s)))

  initRouter()
}

main().catch(e => {
  document.body.innerHTML = `<div style="padding:40px; font-family:sans-serif; color:#c00;">
    <b>WikiFeed failed to start:</b><br>${e.message}
  </div>`
})
