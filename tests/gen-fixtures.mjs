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
import ExcelJS from 'exceljs'
import { CASES } from './cases/reconcile-cases.mjs'
import { parseXlsx } from '../lib/parsers.js'
import { parseArgusFromSheets } from '../lib/argus.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIX = path.join(__dirname, 'fixtures')
const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
const COLS = 18
const blankRow = () => Array(COLS).fill('')

// ── Build the Argus Lease Summary Report rows (matches lib/argus.js layout) ──
function buildArgusRows(property, tenants) {
  const rows = []
  rows.push(['Lease Summary Report', ...Array(COLS - 1).fill('')])
  rows.push([property, ...Array(COLS - 1).fill('')])
  rows.push(['As of 1/1/2026', ...Array(COLS - 1).fill('')])
  rows.push(['All Tenants', ...Array(COLS - 1).fill('')])
  rows.push(blankRow())
  // header block (rows 5-6) — must contain "Building Share" for sheet detection
  const h1 = blankRow()
  h1[0] = 'General Tenant Info'; h1[1] = 'Initial Area'; h1[2] = 'Status'; h1[3] = 'Rent Details'
  h1[4] = 'Rent Step Date'; h1[5] = 'Step $/SF/Yr'; h1[6] = 'Step $/SF/Mo'; h1[8] = 'Free Rent Date'
  h1[9] = 'Free Rent'; h1[10] = '% Rent'; h1[17] = 'Renewal Assumption'
  rows.push(h1)
  const h2 = blankRow(); h2[1] = 'Building Share %'; rows.push(h2)
  rows.push(blankRow()); rows.push(blankRow()); rows.push(blankRow()); rows.push(blankRow())
  rows.push(blankRow()) // index 11 (blank) — data begins at index 12

  let n = 0
  for (const t of tenants) {
    n++
    const r0 = blankRow(), r1 = blankRow(), r2 = blankRow(), r3 = blankRow(), r4 = blankRow()
    // Col 0 stacked id
    r0[0] = `${n}. ${t.name}`
    r1[0] = `Suite: ${t.suite ?? ''}`
    if (t.leaseStart && t.leaseEnd) r2[0] = `${t.leaseStart} - ${t.leaseEnd}`
    r3[0] = '10 yr'           // lease term (cosmetic)
    r4[0] = 'In-Place'        // tenure (cosmetic)
    // Col 1 SF / building share
    if (t.sqft != null) r0[1] = t.sqft
    r1[1] = ''               // building share % (ignored by reconcile)
    // Col 2 status
    r0[2] = t.isOption ? 'Option' : 'Base'
    // Col 3 base rent (four equivalent reps)
    if (t.baseRent?.psfAnnual != null)    r0[3] = t.baseRent.psfAnnual
    if (t.baseRent?.annualTotal != null)  r1[3] = t.baseRent.annualTotal
    if (t.baseRent?.psfMonthly != null)   r2[3] = t.baseRent.psfMonthly
    if (t.baseRent?.monthlyTotal != null) r3[3] = t.baseRent.monthlyTotal
    // Cols 4-6 rent steps (one per row, top-down)
    const blockRows = [r0, r1, r2, r3, r4]
    ;(t.rentSteps || []).forEach((s, i) => {
      const rr = blockRows[i] || blockRows[blockRows.length - 1]
      if (s.effectiveDate) rr[4] = s.effectiveDate
      if (s.psfAnnual != null) rr[5] = s.psfAnnual
      if (s.psfMonthly != null) rr[6] = s.psfMonthly
    })
    // Cols 8-9 free rent (first period on r0; additional on following rows)
    ;(t.freeRent || []).forEach((f, i) => {
      const rr = blockRows[i] || blockRows[blockRows.length - 1]
      if (f.startDate) rr[8] = f.startDate
      if (f.months != null) rr[9] = f.months
      else if (f.abatementPct != null) rr[9] = f.abatementPct
    })
    // Col 10 % rent: row0 salesVolume(blank), row1 breakpoint, row2 overage
    if (t.percentRent) {
      if (t.percentRent.breakpoint != null) r1[10] = t.percentRent.breakpoint
      if (t.percentRent.overagePct != null) r2[10] = t.percentRent.overagePct
    }
    // Col 17 reabsorbed
    if (t.isReabsorbed) r0[17] = 'Reabsorb'
    rows.push(r0, r1, r2, r3, r4, blankRow())
  }
  return rows
}

// ── Build the client rent roll (different layout + representation) ──
function buildClientRows(property, tenants) {
  const rows = []
  rows.push([`${property} — Rent Roll`, '', '', '', '', '', '', ''])
  rows.push(['As of January 1, 2026', '', '', '', '', '', '', ''])
  rows.push([])
  rows.push(['Unit', 'Tenant Name', 'Sq. Ft.', 'Lease Start', 'Lease End', 'Base Rent', 'Rent Basis', 'Rent Steps'])
  for (const t of tenants) {
    if (t.isOption) continue // client rolls usually omit option blocks
    const br = t.baseRent || {}
    let amount = '', basis = ''
    if (br.monthlyTotal != null)      { amount = br.monthlyTotal; basis = '$/month' }
    else if (br.annualTotal != null)  { amount = br.annualTotal;  basis = '$/year' }
    else if (br.psfMonthly != null)   { amount = br.psfMonthly;   basis = '$/SF/month' }
    else if (br.psfAnnual != null)    { amount = br.psfAnnual;    basis = '$/SF/year' }
    const steps = (t.rentSteps || []).map(s => {
      if (s.monthlyTotal != null) return `${s.effectiveDate}: $${s.monthlyTotal}/mo`
      if (s.annualTotal != null)  return `${s.effectiveDate}: $${s.annualTotal}/yr`
      if (s.psfMonthly != null)   return `${s.effectiveDate}: $${s.psfMonthly}/SF/mo`
      if (s.psfAnnual != null)    return `${s.effectiveDate}: $${s.psfAnnual}/SF/yr`
      return s.effectiveDate || ''
    }).join('; ')
    const free = (t.freeRent || []).map(f =>
      `${f.startDate}: ${f.months != null ? f.months + ' months free' : (f.abatementPct * 100) + '% abatement'}`
    ).join('; ')
    rows.push([
      t.suite ?? '', t.name ?? '', t.sqft ?? '',
      t.leaseStart ?? '', t.leaseEnd ?? '',
      amount, basis, steps + (free ? `  |  Free Rent: ${free}` : ''),
    ])
  }
  return rows
}

async function writeXlsx(file, rows) {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('Sheet1')
  for (const r of rows) ws.addRow(r)
  await wb.xlsx.writeFile(file)
}

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
