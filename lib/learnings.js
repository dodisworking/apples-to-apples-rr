// Persistent learning store. When a paralegal marks 👎 + note on a finding,
// the next reconciliation for the same property auto-suppresses (or downgrades)
// identical findings so Todd "remembers" the call.
//
// Storage: a single JSON file on disk. Path defaults to outputs/learnings.json
// (relative to repo root) or honors PERSIST_DIR for Railway volume mounts.

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const PERSIST_DIR = process.env.PERSIST_DIR
  ? path.resolve(process.env.PERSIST_DIR)
  : path.resolve(process.cwd(), 'outputs')

const LEARNINGS_PATH = path.join(PERSIST_DIR, 'learnings.json')

function ensureDir() {
  if (!fs.existsSync(PERSIST_DIR)) fs.mkdirSync(PERSIST_DIR, { recursive: true })
}

export function loadAll() {
  try {
    ensureDir()
    if (!fs.existsSync(LEARNINGS_PATH)) return []
    const raw = fs.readFileSync(LEARNINGS_PATH, 'utf8')
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr : []
  } catch (e) {
    console.warn('[learnings] load failed:', e.message)
    return []
  }
}

export function saveAll(arr) {
  try {
    ensureDir()
    fs.writeFileSync(LEARNINGS_PATH, JSON.stringify(arr, null, 2))
  } catch (e) {
    console.warn('[learnings] save failed:', e.message)
  }
}

/**
 * Add or update a learning. Keyed by (property, suiteKey, field) so repeated
 * reviews of the same field on the same tenant overwrite rather than duplicate.
 *
 * @param {{
 *   property: string,
 *   suite: string, suiteKey: string,
 *   tenantName?: string,
 *   field: string,
 *   verdict: 'good'|'bad'|null,
 *   note?: string,
 *   argusValue?: string, clientValue?: string,
 * }} entry
 */
export function record(entry) {
  if (!entry?.property || !entry?.suiteKey || !entry?.field) return null
  const all = loadAll()
  const idx = all.findIndex(l =>
    l.property === entry.property &&
    l.suiteKey === entry.suiteKey &&
    l.field === entry.field
  )
  const now = new Date().toISOString()
  const record = {
    id: idx >= 0 ? all[idx].id : crypto.randomUUID(),
    property: entry.property,
    suite: entry.suite,
    suiteKey: entry.suiteKey,
    tenantName: entry.tenantName || null,
    field: entry.field,
    verdict: entry.verdict || null,
    note: entry.note || '',
    argusValue: entry.argusValue || null,
    clientValue: entry.clientValue || null,
    createdAt: idx >= 0 ? all[idx].createdAt : now,
    updatedAt: now,
  }
  // verdict=null means user cleared their review — drop it from the store
  if (!record.verdict && !record.note) {
    if (idx >= 0) { all.splice(idx, 1); saveAll(all) }
    return null
  }
  if (idx >= 0) all[idx] = record
  else all.push(record)
  saveAll(all)
  return record
}

/** Bulk record from the client-side reviews map. */
export function recordBulk({ property, matches, reviews }) {
  if (!property || !reviews) return 0
  let n = 0
  for (const m of matches || []) {
    const key = m.suiteKey || m.suite
    const r = reviews[key]
    if (!r || (!r.verdict && !r.note)) continue
    // Each match might have multiple diffs — record per-field for the active diffs.
    // For tenants flagged as a whole (argusOnly / clientOnly), use 'tenant_presence'.
    const fields = m.flags?.argusOnly || m.flags?.clientOnly
      ? ['tenant_presence']
      : (m.diffs || []).map(d => d.field)
    for (const field of (fields.length ? fields : ['_whole_row'])) {
      const diff = (m.diffs || []).find(d => d.field === field)
      const rec = record({
        property,
        suite: m.suite,
        suiteKey: m.suiteKey || m.suite,
        tenantName: m.argus?.name || m.client?.name,
        field,
        verdict: r.verdict,
        note: r.note,
        argusValue: diff?.argusValue,
        clientValue: diff?.clientValue,
      })
      if (rec) n++
    }
  }
  return n
}

/** Return the subset of learnings relevant to a property. */
export function forProperty(property) {
  if (!property) return []
  return loadAll().filter(l => l.property === property)
}

/** Stats for the UI badge. */
export function stats() {
  const all = loadAll()
  return {
    total: all.length,
    bad: all.filter(l => l.verdict === 'bad').length,
    good: all.filter(l => l.verdict === 'good').length,
    properties: [...new Set(all.map(l => l.property))].length,
  }
}
