// ─────────────────────────────────────────────────────────────────────────
// Generate PDF-client fixtures from the canonical answer key (tests/cases).
//
// Same leases as gen-fixtures.mjs, but the CLIENT side is a messy PDF rent roll
// (4 genuinely different layouts cycled by case) instead of a tidy xlsx grid.
// This pressure-tests the whole pipeline's PDF path: pdf-parse extraction +
// Claude standardization of varied real-world presentations.
//
// For each case we emit, under tests/fixtures-pdf/<slug>/ :
//   argus.xlsx   — faithful Argus "Lease Summary Report" (lib/argus.js parses it)
//   client.pdf   — the SAME leases, rendered in one of 4 messy PDF styles
//   truth.json   — the answer key (expect{}) for this property
//
// Two NO-API self-checks run on every generated file:
//   1. Argus round-trip — parse argus.xlsx back, assert it reconstructs intent.
//   2. PDF round-trip   — pdf-parse client.pdf, assert every `needle` (tenant
//      name, base-rent amount, each step amount, free-rent) survives extraction.
// Both run WITHOUT an Anthropic key. (The Claude standardization of the PDF is
// exercised by run-e2e.mjs against a running server / deployed URL.)
//
//   node tests/gen-pdf-fixtures.mjs
// ─────────────────────────────────────────────────────────────────────────

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CASES } from './cases/reconcile-cases.mjs'
import { buildArgusRows, writeXlsx, slug } from './lib/fixture-builders.mjs'
import { buildClientPdf } from './lib/pdf-layouts.mjs'
import { parseXlsx, parsePdf } from '../lib/parsers.js'
import { parseArgusFromSheets } from '../lib/argus.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIX = path.join(__dirname, 'fixtures-pdf')

// ── Argus round-trip self-check (identical intent to gen-fixtures.mjs) ──
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

// ── PDF round-trip self-check: every needle must survive pdf-parse extraction ──
async function verifyPdf(file, needles) {
  const buf = await fs.readFile(file)
  const parsed = await parsePdf(buf)
  if (parsed.error) return [`pdf-parse error: ${parsed.error}`]
  if (parsed.scanned) return [`extracted text too short (${parsed.text.length} chars) — looks scanned`]
  // pdf-parse can drop spaces between runs; compare on a whitespace-stripped copy.
  const hay = parsed.text.replace(/\s+/g, '')
  const problems = []
  for (const n of needles) {
    const needle = String(n).replace(/\s+/g, '')
    if (needle && !hay.includes(needle)) problems.push(`needle missing from PDF text: "${n}"`)
  }
  return problems
}

let totalProblems = 0
const manifest = []
let i = 0
for (const tc of CASES) {
  const styleIndex = i++ // cycle the 4 PDF layouts across cases
  const dir = path.join(FIX, slug(tc.argus.property))
  await fs.mkdir(dir, { recursive: true })

  const argusRows = buildArgusRows(tc.argus.property, tc.argus.tenants)
  const argusFile = path.join(dir, 'argus.xlsx')
  await writeXlsx(argusFile, argusRows)

  const { pdf, needles, style } = buildClientPdf(tc.argus.property, tc.client.tenants, styleIndex)
  const clientFile = path.join(dir, 'client.pdf')
  await fs.writeFile(clientFile, pdf)

  await fs.writeFile(path.join(dir, 'truth.json'), JSON.stringify({
    name: tc.name, property: tc.argus.property, clientStyle: style, expect: tc.expect,
  }, null, 2))

  const argusProblems = await verifyArgus(argusFile, tc.argus.tenants)
  const pdfProblems = await verifyPdf(clientFile, needles)
  const problems = [...argusProblems, ...pdfProblems]
  totalProblems += problems.length
  console.log(`${problems.length ? '✗' : '✓'} ${tc.argus.property}  [${style}]  (${path.relative(process.cwd(), dir)})`)
  for (const p of problems) console.log(`    · ${p}`)

  manifest.push({ property: tc.argus.property, dir: path.relative(FIX, dir), argus: 'argus.xlsx', client: 'client.pdf', truth: 'truth.json', style })
}
await fs.writeFile(path.join(FIX, 'manifest.json'), JSON.stringify(manifest, null, 2))

console.log(`\nGenerated ${CASES.length} PDF fixture pair(s) → ${path.relative(process.cwd(), FIX)}`)
console.log(totalProblems === 0
  ? '✓ Argus + PDF round-trip self-checks PASSED — files parse back to intent and every needle survives extraction.'
  : `✗ ${totalProblems} round-trip problem(s) — fix buildArgusRows / pdf-layouts.`)
process.exit(totalProblems === 0 ? 0 : 1)
