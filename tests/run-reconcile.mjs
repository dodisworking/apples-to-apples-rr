// ─────────────────────────────────────────────────────────────────────────
// Reconcile-engine test loop (NO API KEY NEEDED).
//
// Runs reconcile() against the secret answer key in tests/cases/reconcile-cases.mjs
// and scores every finding: TRUE POSITIVE / FALSE POSITIVE / FALSE NEGATIVE.
//
//   node tests/run-reconcile.mjs            # summary + any FP/FN
//   node tests/run-reconcile.mjs --verbose  # also print every emitted finding
//
// Exit code 0 = pristine (no FP, no FN). Non-zero = regressions remain.
// ─────────────────────────────────────────────────────────────────────────

import { reconcile } from '../lib/reconcile.js'
import { normalizeSuite } from '../lib/argus.js'
import { CASES } from './cases/reconcile-cases.mjs'

const VERBOSE = process.argv.includes('--verbose')
const k = (suite, field) => `${normalizeSuite(String(suite))}::${field}`

const C = {
  reset: '\x1b[0m', red: '\x1b[31m', grn: '\x1b[32m', yel: '\x1b[33m',
  cyan: '\x1b[36m', dim: '\x1b[2m', bold: '\x1b[1m',
}
const ok = s => `${C.grn}${s}${C.reset}`
const bad = s => `${C.red}${s}${C.reset}`
const warn = s => `${C.yel}${s}${C.reset}`

let totalTP = 0, totalFP = 0, totalFN = 0, failedCases = 0

for (const tc of CASES) {
  const result = reconcile({ argus: tc.argus, client: tc.client, learnings: [] })

  // Collect what the engine emitted, as (suiteKey::field) → details.
  const emitted = new Map()
  for (const m of result.matches) {
    for (const d of m.diffs || []) {
      if (d.suppressed) continue
      const key = k(m.suiteKey ?? m.suite, d.field)
      if (!emitted.has(key)) emitted.set(key, { suite: m.suite, field: d.field, sevs: [], flags: m.flags })
      emitted.get(key).sevs.push(d.severity)
    }
  }

  // Expected sets.
  const mustFlag = new Set((tc.expect.findings || []).map(f => k(f.suite, f.field)))
  const soft = new Set((tc.expect.allowSoft || []).map(f => k(f.suite, f.field)))
  const expectArgusOnly = new Set((tc.expect.argusOnly || []).map(s => normalizeSuite(String(s))))
  const expectClientOnly = new Set((tc.expect.clientOnly || []).map(s => normalizeSuite(String(s))))
  // presence findings are expected via argusOnly/clientOnly lists → add to mustFlag
  for (const s of expectArgusOnly) mustFlag.add(`${s}::tenant_presence`)
  for (const s of expectClientOnly) mustFlag.add(`${s}::tenant_presence`)

  const tp = [], fp = [], fn = []
  for (const [key, info] of emitted) {
    if (mustFlag.has(key)) tp.push({ key, info })
    else if (soft.has(key)) { /* neutral — neither rewarded nor penalized */ }
    else fp.push({ key, info })
  }
  for (const key of mustFlag) if (!emitted.has(key)) fn.push(key)

  // Verify argusOnly/clientOnly are actually classified as such (not just any finding).
  const presenceMismatch = []
  for (const m of result.matches) {
    const sk = normalizeSuite(String(m.suiteKey ?? m.suite))
    if (m.flags?.argusOnly && !expectArgusOnly.has(sk)) presenceMismatch.push(`${m.suite} flagged argus-only but not expected`)
    if (m.flags?.clientOnly && !expectClientOnly.has(sk)) presenceMismatch.push(`${m.suite} flagged client-only but not expected`)
    if (expectArgusOnly.has(sk) && !m.flags?.argusOnly) presenceMismatch.push(`${m.suite} expected argus-only but wasn't`)
    if (expectClientOnly.has(sk) && !m.flags?.clientOnly) presenceMismatch.push(`${m.suite} expected client-only but wasn't`)
  }

  // Top-level note assertions (e.g. one-sided % rent → single note, not per-suite findings).
  const noteMisses = []
  for (const sub of (tc.expect.notesInclude || [])) {
    if (!(result.notes || []).some(n => n.includes(sub))) noteMisses.push(sub)
  }

  totalTP += tp.length; totalFP += fp.length; totalFN += fn.length
  const pass = fp.length === 0 && fn.length === 0 && presenceMismatch.length === 0 && noteMisses.length === 0
  if (!pass) failedCases++

  console.log(`\n${C.bold}${pass ? ok('✓ PASS') : bad('✗ FAIL')}${C.reset}  ${tc.name}`)
  console.log(`  ${C.dim}TP ${tp.length} · FP ${fp.length} · FN ${fn.length}${C.reset}`)

  if (fp.length) {
    console.log(`  ${bad('FALSE POSITIVES')} (engine flagged a non-issue):`)
    for (const { key, info } of fp) console.log(`    • ${key}  [${info.sevs.join(',')}]`)
  }
  if (fn.length) {
    console.log(`  ${bad('FALSE NEGATIVES')} (engine missed a real issue):`)
    for (const key of fn) console.log(`    • ${key}`)
  }
  if (presenceMismatch.length) {
    console.log(`  ${bad('PRESENCE MISCLASSIFICATION')}:`)
    for (const p of presenceMismatch) console.log(`    • ${p}`)
  }
  if (noteMisses.length) {
    console.log(`  ${bad('MISSING TOP-LEVEL NOTE')}:`)
    for (const n of noteMisses) console.log(`    • expected a note containing "${n}"`)
  }
  if (VERBOSE && emitted.size) {
    console.log(`  ${C.dim}all emitted:${C.reset}`)
    for (const [key, info] of emitted) console.log(`    ${C.dim}· ${key} [${info.sevs.join(',')}]${C.reset}`)
  }
}

console.log(`\n${C.bold}═══ SUMMARY ═══${C.reset}`)
console.log(`  cases:           ${CASES.length}  (${failedCases ? bad(failedCases + ' failing') : ok('all passing')})`)
console.log(`  true positives:  ${totalTP}`)
console.log(`  false positives: ${totalFP ? bad(totalFP) : ok(0)}`)
console.log(`  false negatives: ${totalFN ? bad(totalFN) : ok(0)}`)

if (totalFP === 0 && totalFN === 0 && failedCases === 0) {
  console.log(`\n${ok('PRISTINE — no false positives, no false negatives.')}`)
  process.exit(0)
} else {
  console.log(`\n${warn('Regressions remain — fix lib/reconcile.js and re-run.')}`)
  process.exit(1)
}
