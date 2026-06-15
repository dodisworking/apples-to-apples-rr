// ─────────────────────────────────────────────────────────────────────────
// Generate REAL fixture files from the canonical answer key (tests/cases).
//
// For each case we emit, under tests/fixtures/<slug>/ :
//   argus.xlsx   — a faithful Argus "Lease Summary Report" (5-row tenant blocks)
//                  that lib/argus.js parses deterministically.
//   client.xlsx  — the SAME leases in a different client layout (different base-
//                  rent representation + date formats) — the messy side Claude
//                  must standardize.
//   truth.json   — the answer key (expect{}) for this property.
//
// Then we ROUND-TRIP the generated argus.xlsx back through the real parser and
// assert it reconstructs the intended canonical tenants. This validates fixture
// realism WITHOUT any API key. (The client.xlsx side is exercised by run-e2e.mjs,
// which needs the Anthropic key / a deployed URL.)
//
//   node tests/gen-fixtures.mjs
// ─────────────────────────────────────────────────────────────────────────

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CASES } from './cases/reconcile-cases.mjs'
import { parseXlsx } from '../lib/parsers.js'
import { parseArgusFromSheets } from '../lib/argus.js'
// Single source of truth for the fixture row builders — shared with the PDF
// generator so the xlsx + pdf client rolls never drift apart (the % rent column
// regression came from this file keeping its own stale copy of buildClientRows).
import { buildArgusRows, buildClientRows, writeXlsx, slug } from './lib/fixture-builders.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIX = path.join(__dirname, 'fixtures')

// ── Round-trip self-check: parse generated argus.xlsx and compare to intent ──
async function verifyArgus(file, expectedTenants) {
  const buf = await fs.readFile(file)
  const parsed = await parseXlsx(buf)
  const out = parseArgusFromSheets(parsed.sheets)
  const want = expectedTenants.filter(t => !t.isOption && !t.isReabsorbed)
  const got = out.tenants.filter(t => !t.isOption && !t.isReabsorbed)
  const problems = []
  if (got.length !== want.length) problems.push(`tenant count: got ${got.length}, want ${want.length}`)
  for (const w of want) {
    const g = got.find(x => x.suiteKey === w.suiteKey && (x.name || '').toLowerCase().startsWith((w.name || '').toLowerCase().slice(0, 6)))
    if (!g) { problems.push(`missing ${w.suite} ${w.name}`); continue }
    if ((g.sqft ?? null) !== (w.sqft ?? null)) problems.push(`${w.suite} sqft: got ${g.sqft}, want ${w.sqft}`)
    if (g.leaseStart !== w.leaseStart) problems.push(`${w.suite} leaseStart: got ${g.leaseStart}, want ${w.leaseStart}`)
    if (g.leaseEnd !== w.leaseEnd) problems.push(`${w.suite} leaseEnd: got ${g.leaseEnd}, want ${w.leaseEnd}`)
    if ((g.rentSteps?.length || 0) !== (w.rentSteps?.length || 0)) problems.push(`${w.suite} step count: got ${g.rentSteps?.length}, want ${w.rentSteps?.length}`)
  }
  return problems
}

let totalProblems = 0
const manifest = []
for (const tc of CASES) {
  const dir = path.join(FIX, slug(tc.argus.property))
  await fs.mkdir(dir, { recursive: true })
  const argusRows = buildArgusRows(tc.argus.property, tc.argus.tenants)
  const clientRows = buildClientRows(tc.argus.property, tc.client.tenants)
  const argusFile = path.join(dir, 'argus.xlsx')
  const clientFile = path.join(dir, 'client.xlsx')
  await writeXlsx(argusFile, argusRows)
  await writeXlsx(clientFile, clientRows)
  await fs.writeFile(path.join(dir, 'truth.json'), JSON.stringify({
    name: tc.name, property: tc.argus.property, expect: tc.expect,
  }, null, 2))

  const problems = await verifyArgus(argusFile, tc.argus.tenants)
  totalProblems += problems.length
  console.log(`${problems.length ? '✗' : '✓'} ${tc.argus.property}  (${path.relative(process.cwd(), dir)})`)
  for (const p of problems) console.log(`    · ${p}`)
  manifest.push({ property: tc.argus.property, dir: path.relative(FIX, dir), argus: 'argus.xlsx', client: 'client.xlsx', truth: 'truth.json' })
}
await fs.writeFile(path.join(FIX, 'manifest.json'), JSON.stringify(manifest, null, 2))

console.log(`\nGenerated ${CASES.length} fixture pair(s) → ${path.relative(process.cwd(), FIX)}`)
console.log(totalProblems === 0
  ? '✓ Argus round-trip self-check PASSED — generated files parse back to intent.'
  : `✗ ${totalProblems} round-trip problem(s) — fix buildArgusRows.`)
process.exit(totalProblems === 0 ? 0 : 1)
