// ─────────────────────────────────────────────────────────────────────────
// Client rent-roll PDF layouts — several genuinely different "messy" formats so
// the pipeline must standardize varied real-world presentations, not one shape.
//
// buildClientPdf(property, tenants, styleIndex) → { pdf: Buffer, needles: [] }
//   `needles` = strings that MUST survive PDF→text extraction (name, base-rent
//   amount, each step amount, free-rent) — used by the no-API round-trip check.
//
// Styles (cycled by index):
//   0  Standard grid           (Suite | Tenant | SF | Comm | Exp | Rate | Steps)
//   1  Stacked cards           (per-tenant block of label: value lines)
//   2  Abbreviated + footnotes (Ste/RSF/LCD/LXD/Min Rent; steps in a NOTES list)
//   3  Two-line compact        (tenant line + detail line + steps line)
// ─────────────────────────────────────────────────────────────────────────

import { buildPdf, layoutTable } from './minipdf.mjs'

const money = n => '$' + Number(n).toLocaleString('en-US')
const psf = n => Number.isInteger(Number(n)) ? String(n) : Number(n).toFixed(2)
const sf = n => Number(n).toLocaleString('en-US')

// Pick the base-rent representation present in the canonical tenant (mirrors the
// xlsx client builder) and return a display string + the raw needle substring.
function baseRent(t) {
  const br = t.baseRent || {}
  if (br.monthlyTotal != null) return { str: `${money(br.monthlyTotal)}/mo`, needle: money(br.monthlyTotal) }
  if (br.annualTotal != null)  return { str: `${money(br.annualTotal)}/yr`, needle: money(br.annualTotal) }
  if (br.psfMonthly != null)   return { str: `$${psf(br.psfMonthly)}/SF/mo`, needle: `$${psf(br.psfMonthly)}` }
  if (br.psfAnnual != null)    return { str: `$${psf(br.psfAnnual)}/SF/yr`, needle: `$${psf(br.psfAnnual)}` }
  return { str: '', needle: null }
}

function stepStrs(t) {
  return (t.rentSteps || []).map(s => {
    if (s.monthlyTotal != null) return { str: `${s.effectiveDate} → ${money(s.monthlyTotal)}/mo`, needle: money(s.monthlyTotal) }
    if (s.annualTotal != null)  return { str: `${s.effectiveDate} → ${money(s.annualTotal)}/yr`, needle: money(s.annualTotal) }
    if (s.psfMonthly != null)   return { str: `${s.effectiveDate} → $${psf(s.psfMonthly)}/SF/mo`, needle: `$${psf(s.psfMonthly)}` }
    if (s.psfAnnual != null)    return { str: `${s.effectiveDate} → $${psf(s.psfAnnual)}/SF/yr`, needle: `$${psf(s.psfAnnual)}` }
    return { str: s.effectiveDate || '', needle: s.effectiveDate }
  })
}

function freeStrs(t) {
  return (t.freeRent || []).map(f => {
    const desc = f.months != null ? `${f.months} mo free` : `${Math.round((f.abatementPct || 0) * 100)}% abated`
    return { str: `${f.startDate}: ${desc}`, needle: desc }
  })
}

// % rent (breakpoint + overage) — rendered so two-sided percentage-rent
// discrepancies are testable, not just one-sided notes. needle = breakpoint $.
function pctStr(t) {
  if (!t.percentRent) return { str: '', needle: null }
  const bp = money(t.percentRent.breakpoint)
  const ov = Math.round((t.percentRent.overagePct || 0) * 100)
  return { str: `% Rent: breakpoint ${bp} @ ${ov}%`, needle: bp }
}

const active = tenants => tenants.filter(t => !t.isOption)

// ── Style 0 — standard grid ──────────────────────────────────────────────
function style0(property, tenants) {
  const needles = []
  const cols = [{ x: 40 }, { x: 85 }, { x: 250 }, { x: 300 }, { x: 365 }, { x: 430 }, { x: 510 }]
  const rows = []
  for (const t of active(tenants)) {
    const br = baseRent(t); const steps = stepStrs(t); const free = freeStrs(t); const pct = pctStr(t)
    needles.push(t.name, br.needle, ...steps.map(s => s.needle), ...free.map(f => f.needle), pct.needle)
    const stepCol = [...steps.map(s => s.str), ...free.map(f => `Free: ${f.str}`), pct.str].filter(Boolean).join('  ')
    rows.push([t.suite ?? '', t.name ?? '', sf(t.sqft), t.leaseStart ?? '', t.leaseEnd ?? '', br.str, stepCol])
  }
  const pages = layoutTable({
    titleLines: [{ text: `${property} — Rent Roll` }, { text: 'As of January 1, 2026', size: 9, font: undefined, gap: 18 }],
    header: ['Suite', 'Tenant', 'SF', 'Commence', 'Expire', 'Base Rent', 'Escalations / Free Rent'],
    rows, cols, fontSize: 8,
  })
  return { pdf: buildPdf(pages), needles }
}

// ── Style 1 — stacked cards ──────────────────────────────────────────────
function style1(property, tenants) {
  const needles = []
  let items = [], y = 740
  const push = (text, opts = {}) => { items.push({ x: opts.x ?? 40, y, text, size: opts.size ?? 9, font: opts.font }); y -= (opts.gap ?? 14) }
  const pages = []
  const nl = (n = 14) => { y -= n; if (y < 70) { pages.push(items); items = []; y = 740 } }
  push(`${property}`, { size: 14, font: 'bold', gap: 16 })
  push(`Rent Roll — effective 01/01/2026`, { size: 9, gap: 20 })
  for (const t of active(tenants)) {
    if (y < 140) { pages.push(items); items = []; y = 740 }
    const br = baseRent(t); const steps = stepStrs(t); const free = freeStrs(t); const pct = pctStr(t)
    needles.push(t.name, br.needle, ...steps.map(s => s.needle), ...free.map(f => f.needle), pct.needle)
    push(`Suite ${t.suite ?? ''} — ${t.name ?? ''}`, { size: 11, font: 'bold' })
    push(`Rentable Area: ${sf(t.sqft)} SF`, { x: 60 })
    push(`Lease Term: ${t.leaseStart ?? ''} to ${t.leaseEnd ?? ''}`, { x: 60 })
    push(`Base Rent: ${br.str}`, { x: 60 })
    if (steps.length) push(`Escalations: ${steps.map(s => s.str).join('; ')}`, { x: 60 })
    if (free.length) push(`Free Rent: ${free.map(f => f.str).join('; ')}`, { x: 60 })
    if (pct.str) push(pct.str, { x: 60 })
    nl(8)
  }
  pages.push(items)
  return { pdf: buildPdf(pages), needles }
}

// ── Style 2 — abbreviated columns + footnoted steps ──────────────────────
function style2(property, tenants) {
  const needles = []
  const cols = [{ x: 40 }, { x: 80 }, { x: 250 }, { x: 300 }, { x: 360 }, { x: 420 }, { x: 500 }]
  const rows = []
  const notes = []
  let noteN = 0
  for (const t of active(tenants)) {
    const br = baseRent(t); const steps = stepStrs(t); const free = freeStrs(t); const pct = pctStr(t)
    needles.push(t.name, br.needle, ...steps.map(s => s.needle), ...free.map(f => f.needle), pct.needle)
    let ref = ''
    if (steps.length || free.length || pct.str) {
      noteN++
      ref = `(${noteN})`
      const parts = [...steps.map(s => s.str), ...free.map(f => `free rent ${f.str}`), ...(pct.str ? [pct.str] : [])]
      notes.push(`(${noteN}) Ste ${t.suite}: ${parts.join('; ')}`)
    }
    rows.push([t.suite ?? '', t.name ?? '', sf(t.sqft), t.leaseStart ?? '', t.leaseEnd ?? '', `${br.str} ${ref}`.trim()])
  }
  const pages = layoutTable({
    titleLines: [{ text: `${property} Rent Roll` }],
    header: ['Ste', 'Tenant', 'RSF', 'LCD', 'LXD', 'Min Rent'],
    rows, cols, fontSize: 8,
  })
  // append notes to the last page
  let last = pages[pages.length - 1]
  let y = (last.length ? Math.min(...last.map(i => i.y)) : 700) - 26
  last.push({ x: 40, y, text: 'NOTES — Rent Steps & Concessions', size: 9, font: 'bold' }); y -= 16
  for (const n of notes) {
    if (y < 60) { last = []; pages.push(last); y = 740 }
    last.push({ x: 40, y, text: n, size: 8 }); y -= 12
  }
  return { pdf: buildPdf(pages), needles }
}

// ── Style 3 — two-line compact ───────────────────────────────────────────
function style3(property, tenants) {
  const needles = []
  let items = [], y = 740
  const pages = []
  const line = (text, opts = {}) => {
    if (y < 60) { pages.push(items); items = []; y = 740 }
    items.push({ x: opts.x ?? 40, y, text, size: opts.size ?? 9, font: opts.font }); y -= (opts.gap ?? 12)
  }
  line(`${property}  |  Rent Roll  |  1/1/2026`, { size: 12, font: 'bold', gap: 20 })
  for (const t of active(tenants)) {
    const br = baseRent(t); const steps = stepStrs(t); const free = freeStrs(t); const pct = pctStr(t)
    needles.push(t.name, br.needle, ...steps.map(s => s.needle), ...free.map(f => f.needle), pct.needle)
    line(`#${t.suite ?? ''}  ${t.name ?? ''}`, { font: 'bold' })
    line(`${sf(t.sqft)} SF  |  ${t.leaseStart ?? ''}–${t.leaseEnd ?? ''}  |  ${br.str}`, { x: 60 })
    if (steps.length) line(`Steps: ${steps.map(s => s.str).join(' , ')}`, { x: 60 })
    if (free.length) line(`Free Rent: ${free.map(f => f.str).join(' , ')}`, { x: 60 })
    if (pct.str) line(pct.str, { x: 60 })
    y -= 4
  }
  pages.push(items)
  return { pdf: buildPdf(pages), needles }
}

const STYLES = [style0, style1, style2, style3]
export const STYLE_NAMES = ['standard-grid', 'stacked-cards', 'abbrev-footnotes', 'two-line-compact']

export function buildClientPdf(property, tenants, styleIndex = 0) {
  const fn = STYLES[styleIndex % STYLES.length]
  const { pdf, needles } = fn(property, tenants)
  return { pdf, needles: needles.filter(Boolean), style: STYLE_NAMES[styleIndex % STYLES.length] }
}
