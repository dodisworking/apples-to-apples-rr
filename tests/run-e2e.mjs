// ─────────────────────────────────────────────────────────────────────────
// FULL end-to-end test (NEEDS A RUNNING SERVER + ANTHROPIC KEY).
//
// POSTs every generated fixture pair (tests/fixtures/<slug>/argus.xlsx +
// client.xlsx) to /api/compare, parses the SSE stream, and scores the
// reconciliation result.matches against the secret answer key (truth.json) with
// the SAME TP/FP/FN logic as run-reconcile.mjs.
//
// This exercises the WHOLE pipeline — including the Claude client-standardization
// layer (lib/client.js), which is the main source of real-world false positives
// that the pure-JS run-reconcile.mjs can't reach.
//
//   BASE=http://localhost:3790 node tests/run-e2e.mjs           # local server
//   BASE=https://<your-app>.up.railway.app node tests/run-e2e.mjs   # deployed
//   MODE=deluxe BASE=... node tests/run-e2e.mjs                 # pick model tier
//
// Exit code 0 = pristine (no FP, no FN across every fixture). Non-zero = work left.
// ─────────────────────────────────────────────────────────────────────────

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalizeSuite } from '../lib/argus.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIX = path.join(__dirname, 'fixtures')
const BASE = process.env.BASE || 'http://localhost:3790'
const MODE = process.env.MODE || 'regular'

const C = {
  reset: '\x1b[0m', red: '\x1b[31m', grn: '\x1b[32m', yel: '\x1b[33m',
  cyan: '\x1b[36m', dim: '\x1b[2m', bold: '\x1b[1m',
}
const ok = s => `${C.grn}${s}${C.reset}`
const bad = s => `${C.red}${s}${C.reset}`
const warn = s => `${C.yel}${s}${C.reset}`
const k = (suite, field) => `${normalizeSuite(String(suite))}::${field}`

async function toB64(p) { return (await fs.readFile(p)).toString('base64') }

// Stream /api/compare and return the final `complete` payload's result, or throw.
async function compare(argusFile, clientFile) {
  const argus  = { name: path.basename(argusFile),  base64: await toB64(argusFile)  }
  const client = { name: path.basename(clientFile), base64: await toB64(clientFile) }
  const resp = await fetch(`${BASE}/api/compare`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ argus, client, mode: MODE }),
  })
  if (!resp.ok || !resp.body) throw new Error(`HTTP ${resp.status}: ${await resp.text().catch(() => '')}`)

  const reader = resp.body.getReader()
  const dec = new TextDecoder()
  let buf = '', result = null, err = null
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    let idx
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const raw = buf.slice(0, idx); buf = buf.slice(idx + 2)
      let ev = 'message', data = ''
      for (const ln of raw.split('\n')) {
        if (ln.startsWith('event:')) ev = ln.slice(6).trim()
        else if (ln.startsWith('data:')) data += ln.slice(5).trim()
      }
      if (!data) continue
      const p = JSON.parse(data)
      if (ev === 'complete') result = p.result
      else if (ev === 'error') err = p.error
    }
  }
  if (err) throw new Error(err)
  if (!result) throw new Error('stream ended with no complete event')
  return result
}

// Score one result against its truth.json `expect` — identical logic to run-reconcile.
function score(result, expect) {
  const emitted = new Map()
  for (const m of result.matches || []) {
    for (const d of m.diffs || []) {
      if (d.suppressed) continue
      const key = k(m.suiteKey ?? m.suite, d.field)
      if (!emitted.has(key)) emitted.set(key, { sevs: [] })
      emitted.get(key).sevs.push(d.severity)
    }
  }
  const mustFlag = new Set((expect.findings || []).map(f => k(f.suite, f.field)))
  const soft = new Set((expect.allowSoft || []).map(f => k(f.suite, f.field)))
  const expectArgusOnly = new Set((expect.argusOnly || []).map(s => normalizeSuite(String(s))))
  const expectClientOnly = new Set((expect.clientOnly || []).map(s => normalizeSuite(String(s))))
  for (const s of expectArgusOnly) mustFlag.add(`${s}::tenant_presence`)
  for (const s of expectClientOnly) mustFlag.add(`${s}::tenant_presence`)

  const tp = [], fp = [], fn = []
  for (const [key, info] of emitted) {
    if (mustFlag.has(key)) tp.push({ key, info })
    else if (soft.has(key)) { /* neutral */ }
    else fp.push({ key, info })
  }
  for (const key of mustFlag) if (!emitted.has(key)) fn.push(key)

  const presenceMismatch = []
  for (const m of result.matches || []) {
    const sk = normalizeSuite(String(m.suiteKey ?? m.suite))
    if (m.flags?.argusOnly && !expectArgusOnly.has(sk)) presenceMismatch.push(`${m.suite} flagged argus-only but not expected`)
    if (m.flags?.clientOnly && !expectClientOnly.has(sk)) presenceMismatch.push(`${m.suite} flagged client-only but not expected`)
    if (expectArgusOnly.has(sk) && !m.flags?.argusOnly) presenceMismatch.push(`${m.suite} expected argus-only but wasn't`)
    if (expectClientOnly.has(sk) && !m.flags?.clientOnly) presenceMismatch.push(`${m.suite} expected client-only but wasn't`)
  }
  const noteMisses = []
  for (const sub of (expect.notesInclude || [])) {
    if (!(result.notes || []).some(n => n.includes(sub))) noteMisses.push(sub)
  }
  return { tp, fp, fn, presenceMismatch, noteMisses }
}

// ── main ──
let manifest
try {
  manifest = JSON.parse(await fs.readFile(path.join(FIX, 'manifest.json'), 'utf8'))
} catch {
  console.error(bad('No fixtures found. Run `node tests/gen-fixtures.mjs` first.'))
  process.exit(2)
}

console.log(`${C.bold}E2E against ${BASE}${C.reset}  (mode=${MODE}, ${manifest.length} fixtures)\n`)

let totalTP = 0, totalFP = 0, totalFN = 0, failedCases = 0, errored = 0
for (const entry of manifest) {
  const dir = path.join(FIX, entry.dir)
  const truth = JSON.parse(await fs.readFile(path.join(dir, entry.truth), 'utf8'))
  let result
  try {
    result = await compare(path.join(dir, entry.argus), path.join(dir, entry.client))
  } catch (e) {
    errored++; failedCases++
    console.log(`${bad('✗ ERROR')}  ${truth.property}\n    ${e.message}`)
    continue
  }
  const { tp, fp, fn, presenceMismatch, noteMisses } = score(result, truth.expect || {})
  totalTP += tp.length; totalFP += fp.length; totalFN += fn.length
  const pass = fp.length === 0 && fn.length === 0 && presenceMismatch.length === 0 && noteMisses.length === 0
  if (!pass) failedCases++

  console.log(`${C.bold}${pass ? ok('✓ PASS') : bad('✗ FAIL')}${C.reset}  ${truth.property}`)
  console.log(`  ${C.dim}TP ${tp.length} · FP ${fp.length} · FN ${fn.length}${C.reset}`)
  if (fp.length) { console.log(`  ${bad('FALSE POSITIVES')}:`); for (const { key, info } of fp) console.log(`    • ${key}  [${info.sevs.join(',')}]`) }
  if (fn.length) { console.log(`  ${bad('FALSE NEGATIVES')}:`); for (const key of fn) console.log(`    • ${key}`) }
  if (presenceMismatch.length) { console.log(`  ${bad('PRESENCE MISCLASSIFICATION')}:`); for (const p of presenceMismatch) console.log(`    • ${p}`) }
  if (noteMisses.length) { console.log(`  ${bad('MISSING NOTE')}:`); for (const n of noteMisses) console.log(`    • expected note containing "${n}"`) }
  console.log('')
}

console.log(`${C.bold}═══ E2E SUMMARY ═══${C.reset}`)
console.log(`  fixtures:        ${manifest.length}  (${failedCases ? bad(failedCases + ' failing') : ok('all passing')}${errored ? bad(', ' + errored + ' errored') : ''})`)
console.log(`  true positives:  ${totalTP}`)
console.log(`  false positives: ${totalFP ? bad(totalFP) : ok(0)}`)
console.log(`  false negatives: ${totalFN ? bad(totalFN) : ok(0)}`)

if (totalFP === 0 && totalFN === 0 && failedCases === 0) {
  console.log(`\n${ok('PRISTINE — full pipeline made no false positives and missed nothing.')}`)
  process.exit(0)
} else {
  console.log(`\n${warn('Regressions remain — inspect FP/FN above and tune lib/client.js or lib/reconcile.js.')}`)
  process.exit(1)
}
