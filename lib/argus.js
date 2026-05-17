// Deterministic Argus Lease Summary Report parser.
//
// Layout (consistent across every Argus export):
//   Rows 1–4  : title, property name, "As of …", scope
//   Row  5    : blank
//   Rows 6–11 : multi-row group + sub headers (General Tenant Info | Rent Details | CPI |
//               Free Rent | % Rent | Misc Rent | Recovery | TI | LC | Incentives | SecDep | Renewal)
//   Row  12   : blank
//   Row  13+  : data — each tenant block = 5 contentful rows + 1 blank, more rows if rent steps
//
// Tenant block columns (1-based per Argus rules in TEST_PLAN):
//   Col 1 : Tenant Name / Suite / Lease Dates / Lease Term / Tenure (stacked vertically across 5 rows)
//   Col 2 : Initial Area (SF) row0 / Building Share % row1
//   Col 3 : Base/Option/Contract (row0), Contract (row1), Lease Type (row2), Tenure category (row3)
//   Col 4 : Rate/Yr (row0), Amount/Yr (row1), Rate/Mo (row2), Amount/Mo (row3), Rental Value/Yr (row4)
//   Col 5 : Rent Step Date (multiple rows)
//   Col 6 : Rent Step $/SF Annual
//   Col 7 : Rent Step $/SF Monthly
//   Col 8 : CPI Type
//   Col 9 : Free Rent Date
//   Col 10: Free Rent Months or Abatement Decimal
//   Col 11: % Rent — Sales Volume (row0), Breakpoint (row1), Overage % / Cap (row2)
//   Col 12: Miscellaneous Rent — IGNORE per rules
//   Cols 13–17: Recovery / TI / LC / Incentives / Security Deposit — IGNORE per rules
//   Col 18: Renewal Assumption — contains "Reabsorb" for reabsorbed suites
//
// Exclusion rules per Word doc:
//   - Tenant name contains "(Option N)" or "(Contract Renewal)" → option block, exclude from SF total
//   - Right-most col (Renewal Assumption) contains "Reabsorb" → reabsorbed, exclude

export function parseArgusFromSheets(sheets) {
  const ws = pickArgusSheet(sheets)
  if (!ws) return { property: null, tenants: [], totalSF: 0 }

  const property = extractPropertyName(ws.rows)
  const tenants = extractTenants(ws.rows)
  const totalSF = tenants
    .filter(t => !t.isOption && !t.isContractRenewal && !t.isReabsorbed && t.sqft)
    .reduce((sum, t) => sum + t.sqft, 0)

  return { property, tenants, totalSF }
}

function pickArgusSheet(sheets) {
  if (!sheets?.length) return null
  for (const s of sheets) {
    const blob = s.rows.slice(0, 12).map(r => r.join(' ')).join(' ').toLowerCase()
    if (/lease summary report|rental value per year|building share/i.test(blob)) return s
  }
  return sheets[0]
}

function extractPropertyName(rows) {
  // Row 2 typically: "BRX UW - Stanford Station (v3)" or "Mayfair Shopping Center - BRX UW - ..."
  for (let r = 1; r < Math.min(6, rows.length); r++) {
    for (const cell of rows[r] || []) {
      const t = String(cell ?? '').trim()
      if (!t || t.length < 4 || t.length > 120) continue
      if (/^lease summary report$/i.test(t)) continue
      if (/^as of/i.test(t)) continue
      if (/^all tenants/i.test(t)) continue
      // Split on " - " — pick the longest segment that isn't BRX UW or version notation
      const parts = t.split(/ - |- /).map(s => s.trim()).filter(Boolean)
      let best = null
      for (const seg of parts) {
        if (seg.length < 5) continue
        if (/^(brx|uw|v\d|before|after|amounts|measures|in sf|in usd)/i.test(seg)) continue
        if (/^\(.+\)$/.test(seg)) continue
        const clean = seg.replace(/\s*\(.*?\)\s*$/, '').trim()
        if (!clean) continue
        if (!best || clean.length > best.length) best = clean
      }
      if (best) return best
    }
  }
  return null
}

function extractTenants(rows) {
  // Data starts after the header block. Find the first row whose col 0 matches "N. ..."
  let startRow = -1
  for (let r = 11; r < rows.length; r++) {
    const c0 = String(rows[r]?.[0] ?? '').trim()
    if (/^\d+\.\s+\S/.test(c0)) { startRow = r; break }
  }
  if (startRow < 0) return []

  const tenants = []
  let r = startRow
  while (r < rows.length) {
    const c0 = String(rows[r]?.[0] ?? '').trim()
    if (!/^\d+\.\s+\S/.test(c0)) { r++; continue }

    // Block extends until next tenant header or until we've consumed 15 rows
    let end = r + 1
    while (end < rows.length && !/^\d+\.\s+\S/.test(String(rows[end]?.[0] ?? '').trim())) {
      end++
      if (end - r > 18) break
    }
    const block = rows.slice(r, end)
    const t = parseBlock(block, r)
    if (t) tenants.push(t)
    r = end
  }
  return tenants
}

function parseBlock(block, blockStartRow) {
  if (!block?.length) return null
  const row = (i) => block[i] || []

  // ─── Col 1: tenant id / suite / dates / term / tenure ──────────
  const nameRaw = String(row(0)[0] ?? '').trim()
  const name = nameRaw.replace(/^\d+\.\s*/, '').trim()

  const suiteRaw = String(row(1)[0] ?? '').trim()
  const suiteMatch = suiteRaw.match(/Suite:\s*(.+?)\s*$/i)
  const suite = suiteMatch ? suiteMatch[1].trim() : suiteRaw || null

  const datesRaw = String(row(2)[0] ?? '').trim()
  const datesMatch = datesRaw.match(/(\d{1,2}\/\d{1,2}\/\d{2,4})\s*[-–]\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/)
  const leaseStart = datesMatch?.[1] || null
  const leaseEnd   = datesMatch?.[2] || null
  const leaseTerm  = String(row(3)[0] ?? '').trim() || null
  const tenure     = String(row(4)[0] ?? '').trim() || null

  // ─── Col 2: SF (row0) and Building Share % (row1) ─────────────
  const sqft          = toNumber(row(0)[1])
  const buildingShare = toNumber(row(1)[1])

  // ─── Col 3: Status / Contract / Lease Type / Tenure category ─
  const status    = String(row(0)[2] ?? '').trim() || null
  const leaseType = String(row(2)[2] ?? '').trim() || null
  const category  = String(row(3)[2] ?? '').trim() || null

  // ─── Col 4: Base Rent (4 equivalent representations) ─────────
  const psfAnnual    = toNumber(row(0)[3])
  const annualTotal  = toNumber(row(1)[3])
  const psfMonthly   = toNumber(row(2)[3])
  const monthlyTotal = toNumber(row(3)[3])

  // ─── Cols 5–7: Rent Steps ────────────────────────────────────
  const rentSteps = []
  for (const r of block) {
    const dateRaw = String(r[4] ?? '').trim()
    if (!dateRaw) continue
    if (!isRentStepDate(dateRaw)) continue
    rentSteps.push({
      effectiveDate: normalizeStepDate(dateRaw),
      psfAnnual: toNumber(r[5]),
      psfMonthly: toNumber(r[6]),
    })
  }

  // ─── Col 9–10: Free Rent ─────────────────────────────────────
  const freeRent = []
  for (const r of block) {
    const dateRaw = String(r[8] ?? '').trim()
    if (!dateRaw || /^none$/i.test(dateRaw)) continue
    const rightRaw = String(r[9] ?? '').trim()
    if (!rightRaw) continue
    const months = parseInt(rightRaw, 10)
    const decimal = parseFloat(rightRaw)
    if (rightRaw.includes('.') && !isNaN(decimal) && decimal < 1) {
      freeRent.push({ startDate: normalizeStepDate(dateRaw), months: null, abatementPct: decimal })
    } else if (!isNaN(months) && months > 0) {
      freeRent.push({ startDate: normalizeStepDate(dateRaw), months, abatementPct: null })
    }
  }

  // ─── Col 11: % Rent (Sales Volume / Breakpoint / Overage %) ──
  const salesVolume = String(row(0)[10] ?? '').trim()
  const breakpoint  = toNumber(row(1)[10])
  const overagePct  = toNumber(row(2)[10])
  const hasPercentRent = (breakpoint || overagePct) && !/^n\/a$/i.test(String(row(0)[10] ?? '').trim())
  const percentRent = hasPercentRent ? {
    salesVolume: /^n\/a$/i.test(salesVolume) ? null : salesVolume || null,
    breakpoint, overagePct,
  } : null

  // ─── Col 18: Renewal Assumption — detect reabsorbed ──────────
  const renewalAssumption = String(row(0)[17] ?? '').trim()
  const isReabsorbed = /reabsorb/i.test(renewalAssumption) || /reabsorb/i.test(String(row(1)[17] ?? '')) || /reabsorb/i.test(String(row(2)[17] ?? ''))

  // ─── Status flags from tenant name + status col ──────────────
  const isOption          = /\(option\s*\d+\)/i.test(name)              || /^option$/i.test(status || '')
  const isContractRenewal = /\(contract\s+renewal\s*\d*\)/i.test(name)  || /contract\s+renewal/i.test(status || '')
  const isVacant          = /^zz\s*vacant/i.test(name)

  return {
    name, suite,
    suiteKey: normalizeSuite(suite),
    leaseStart, leaseEnd, leaseTerm, tenure,
    sqft, buildingShare,
    status, leaseType, category,
    baseRent: { psfAnnual, annualTotal, psfMonthly, monthlyTotal },
    rentSteps, freeRent, percentRent,
    isOption, isContractRenewal, isVacant, isReabsorbed,
    _argusBlockRow: blockStartRow,  // 0-based source row for debugging / preview
  }
}

// ─── Helpers ──────────────────────────────────────────────────
export function normalizeSuite(s) {
  if (!s) return null
  return String(s).toLowerCase()
    .replace(/^(suite|ste|unit|space|st)[\s#:.]*/i, '')
    .replace(/[^a-z0-9]/g, '')
    .replace(/^0+(?=\d)/, '')        // strip leading zeros only when followed by digit (keeps "0" itself)
    .trim() || null
}

function isRentStepDate(s) {
  return /^[A-Za-z]{3}-\d{4}$/.test(s) ||                     // Aug-2027
         /^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(s) ||             // 8/1/2027
         /^[A-Za-z]{3,9}\s+\d{4}$/.test(s)                    // August 2027
}

function normalizeStepDate(s) {
  return s.replace(/\s+/g, '-')
}

function toNumber(v) {
  if (v == null || v === '') return null
  if (typeof v === 'number') return isFinite(v) ? v : null
  const cleaned = String(v).replace(/[$,\s]/g, '').replace(/%$/, '')
  const n = parseFloat(cleaned)
  return isFinite(n) ? n : null
}
