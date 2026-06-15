// ─────────────────────────────────────────────────────────────────────────
// Shared fixture builders — turn canonical-schema tenants into real files.
//   • buildArgusRows  → the 5-row Argus "Lease Summary Report" layout (xlsx)
//   • buildClientRows → a simple client rent-roll grid (xlsx)
//   • writeXlsx / slug helpers
// Used by both gen-fixtures.mjs (xlsx client) and gen-pdf-fixtures.mjs (pdf client).
// ─────────────────────────────────────────────────────────────────────────

import ExcelJS from 'exceljs'

export const COLS = 18
export const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
const blankRow = () => Array(COLS).fill('')

// ── Argus Lease Summary Report rows (matches lib/argus.js layout) ──
export function buildArgusRows(property, tenants) {
  const rows = []
  rows.push(['Lease Summary Report', ...Array(COLS - 1).fill('')])
  rows.push([property, ...Array(COLS - 1).fill('')])
  rows.push(['As of 1/1/2026', ...Array(COLS - 1).fill('')])
  rows.push(['All Tenants', ...Array(COLS - 1).fill('')])
  rows.push(blankRow())
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
    r0[0] = `${n}. ${t.name}`
    r1[0] = `Suite: ${t.suite ?? ''}`
    if (t.leaseStart && t.leaseEnd) r2[0] = `${t.leaseStart} - ${t.leaseEnd}`
    r3[0] = '10 yr'
    r4[0] = 'In-Place'
    if (t.sqft != null) r0[1] = t.sqft
    r1[1] = ''
    r0[2] = t.isOption ? 'Option' : 'Base'
    if (t.baseRent?.psfAnnual != null)    r0[3] = t.baseRent.psfAnnual
    if (t.baseRent?.annualTotal != null)  r1[3] = t.baseRent.annualTotal
    if (t.baseRent?.psfMonthly != null)   r2[3] = t.baseRent.psfMonthly
    if (t.baseRent?.monthlyTotal != null) r3[3] = t.baseRent.monthlyTotal
    const blockRows = [r0, r1, r2, r3, r4]
    ;(t.rentSteps || []).forEach((s, i) => {
      const rr = blockRows[i] || blockRows[blockRows.length - 1]
      if (s.effectiveDate) rr[4] = s.effectiveDate
      if (s.psfAnnual != null) rr[5] = s.psfAnnual
      if (s.psfMonthly != null) rr[6] = s.psfMonthly
    })
    ;(t.freeRent || []).forEach((f, i) => {
      const rr = blockRows[i] || blockRows[blockRows.length - 1]
      if (f.startDate) rr[8] = f.startDate
      if (f.months != null) rr[9] = f.months
      else if (f.abatementPct != null) rr[9] = f.abatementPct
    })
    if (t.percentRent) {
      if (t.percentRent.breakpoint != null) r1[10] = t.percentRent.breakpoint
      if (t.percentRent.overagePct != null) r2[10] = t.percentRent.overagePct
    }
    if (t.isReabsorbed) r0[17] = 'Reabsorb'
    rows.push(r0, r1, r2, r3, r4, blankRow())
  }
  return rows
}

// ── Simple client rent-roll grid (xlsx) ──
export function buildClientRows(property, tenants) {
  const rows = []
  rows.push([`${property} — Rent Roll`, '', '', '', '', '', '', '', ''])
  rows.push(['As of January 1, 2026', '', '', '', '', '', '', '', ''])
  rows.push([])
  rows.push(['Unit', 'Tenant Name', 'Sq. Ft.', 'Lease Start', 'Lease End', 'Base Rent', 'Rent Basis', 'Rent Steps', '% Rent'])
  for (const t of tenants) {
    if (t.isOption) continue
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
    // % rent: show breakpoint + overage when the lease has it (so two-sided
    // percentage-rent discrepancies are testable, not just one-sided notes).
    const pr = t.percentRent
      ? `Breakpoint $${Number(t.percentRent.breakpoint).toLocaleString('en-US')}; Overage ${Math.round((t.percentRent.overagePct || 0) * 100)}%`
      : ''
    rows.push([
      t.suite ?? '', t.name ?? '', t.sqft ?? '',
      t.leaseStart ?? '', t.leaseEnd ?? '',
      amount, basis, steps + (free ? `  |  Free Rent: ${free}` : ''), pr,
    ])
  }
  return rows
}

export async function writeXlsx(file, rows) {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('Sheet1')
  for (const r of rows) ws.addRow(r)
  await wb.xlsx.writeFile(file)
}
