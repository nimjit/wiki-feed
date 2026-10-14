// IndexedDB wrapper — promise-based, minimal
// Stores: follows, seen, saved, graph, settings

const DB_NAME = 'wikifeed'
const DB_VERSION = 1

let _db = null

export function open() {
  if (_db) return Promise.resolve(_db)
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = e => {
      const d = e.target.result
      if (!d.objectStoreNames.contains('follows'))
        d.createObjectStore('follows', { keyPath: 'id' })
      if (!d.objectStoreNames.contains('seen'))
        d.createObjectStore('seen', { keyPath: 'id' })
      if (!d.objectStoreNames.contains('saved')) {
        const s = d.createObjectStore('saved', { keyPath: 'id' })
        s.createIndex('savedAt', 'savedAt')
      }
      if (!d.objectStoreNames.contains('graph'))
        d.createObjectStore('graph', { keyPath: 'id' })
      if (!d.objectStoreNames.contains('settings'))
        d.createObjectStore('settings', { keyPath: 'id' })
    }
    req.onsuccess = e => { _db = e.target.result; resolve(_db) }
    req.onerror = e => reject(e.target.error)
  })
}

function store(name, mode = 'readonly') {
  return _db.transaction(name, mode).objectStore(name)
}

export const db = {
  get(name, id) {
    return new Promise((res, rej) => {
      const r = store(name).get(id)
      r.onsuccess = e => res(e.target.result)
      r.onerror = e => rej(e.target.error)
    })
  },
  put(name, value) {
    return new Promise((res, rej) => {
      const r = store(name, 'readwrite').put(value)
      r.onsuccess = e => res(e.target.result)
      r.onerror = e => rej(e.target.error)
    })
  },
  delete(name, id) {
    return new Promise((res, rej) => {
      const r = store(name, 'readwrite').delete(id)
      r.onsuccess = () => res()
      r.onerror = e => rej(e.target.error)
    })
  },
  getAll(name) {
    return new Promise((res, rej) => {
      const r = store(name).getAll()
      r.onsuccess = e => res(e.target.result)
      r.onerror = e => rej(e.target.error)
    })
  },
  async getSetting(key, def = null) {
    const row = await this.get('settings', key)
    return row != null ? row.value : def
  },
  putSetting(key, value) {
    return this.put('settings', { id: key, value })
  },

  // Export all user data as JSON
  async exportAll() {
    const [follows, seen, saved, settings] = await Promise.all([
      this.getAll('follows'), this.getAll('seen'),
      this.getAll('saved'), this.getAll('settings'),
    ])
    return JSON.stringify({ follows, seen, saved, settings, exportedAt: Date.now() }, null, 2)
  },

  // Import from exported JSON (merge, not replace)
  async importAll(jsonStr) {
    const data = JSON.parse(jsonStr)
    const stores = ['follows', 'seen', 'saved', 'settings']
    for (const name of stores) {
      for (const row of (data[name] || [])) {
        await this.put(name, row)
      }
    }
  },
}
