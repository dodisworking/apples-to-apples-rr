// Reconciliation engine (Apples to Apples).
//
// Inputs: two canonical schemas (Argus = source of truth, Client = source under review).
// Output: { property, totals, matches[], notes[] }
//
// Rules (from the spec doc):
//   1. Property Total SF:
//      - Sum all NON-option, NON-contract-renewal, NON-reabsorbed tenants on each side.
//      - Compare to topLevelTotalSF if client surfaced one.
//   2. Suite-by-Suite (Col 1):
//      - Match on suite key first → SF (within 1%) → fuzzy name.
//      - Compare: tenant name, suite, lease start, lease end.
//   3. Base Rent (Col 4):
//      - Use psfAnnual when available, else derive from totals/SF.
//      - Ignore differences ≤ $0.02/SF (rounding).
//   4. Rent Steps (Cols 5-7):
//      - Pair by index OR by closest effective date.
//      - Compare date AND amount (either $/SF/yr or total).
//   5. Free Rent (Col 9):
//      - Match by start date. Compare months OR abatementPct.
//   6. % Rent (Col 10):
//      - Only emit per-tenant findings if BOTH sides have % rent.
//      - If Argus has it but client doesn't, emit a single note (top-level).
//   7. Misc Rent (Col 11) → IGNORE entirely.

const PSF_EPS         = 0.02       // dollars/SF — rounding noise
const RENT_PCT_EPS    = 0.005      // 0.5% — totals
const SF_PCT_EPS      = 0.005      // 0.5% — SF tolerance for matching
const DATE_DAYS_EPS   = 1          // 1 day — date drift tolerance

/**
 * @param {object} args
 * @param {object} args.argus     — parsed Argus { property, tenants[], totalSF }
 * @param {object} args.client    — normalized client { property, tenants[], topLevelTotalSF }
 * @param {object[]} [args.learnings] — optional prior reviews to suppress known false positives
 */
export function reconcile({ argus, client, learnings = [] }) {
  // 1) Match — operate ONLY on non-option, non-contract-renewal tenants
  const argusActive  = (argus.tenants  || []).filter(t => !t.isOption && !t.isContractRenewal && !t.isReabsorbed)
  const clientActive = (client.tenants || []).filter(t => !t.isOption)

  const { matched, argusOnly, clientOnly } = matchTenants(argusActive, clientActive)

  // Index learnings by (suiteKey, field) for O(1) lookup
  const learningIndex = new Map()
  for (const l of learnings || []) {
    const key = `${l.suiteKey}::${l.field}`
    learningIndex.set(key, l)
  }
  let learningsAppliedCount = 0

  // 2) Diff each matched pair
  const matches = []
  for (const pair of matched) {
    let diffs = compareTenants(pair.argus, pair.client)
    const suiteKey = pair.argus.suiteKey || pair.client.suiteKey
    // Apply learnings — annotate diffs that were previously rejected
    for (const d of diffs) {
      const lkey = `${suiteKey}::${d.field}`
      const l = learningIndex.get(lkey)
      if (l && l.verdict === 'bad') {
        d.suppressed = true
        d.suppressedReason = `Previously marked false positive on ${new Date(l.updatedAt).toLocaleDateString()}${l.note ? ' — "' + l.note + '"' : ''}`
        d.severity = 'LOW'   // downgrade; user can still see it but it doesn't pile up as HIGH
        learningsAppliedCount++
      } else if (l && l.verdict === 'good') {
        d.confirmed = true
        d.confirmedNote = `Confirmed real discrepancy on ${new Date(l.updatedAt).toLocaleDateString()}${l.note ? ' — "' + l.note + '"' : ''}`
      }
    }
    // For UI purposes, "clean" considers only non-suppressed diffs
    const activeDiffs = diffs.filter(d => !d.suppressed)
    matches.push({
      suite: pair.argus.suite || pair.client.suite,
      suiteKey,
      argus: pair.argus, client: pair.client,
      matchedBy: pair.matchedBy,
      diffs,
      flags: { argusOnly: false, clientOnly: false, clean: activeDiffs.length === 0 },
    })
  }
  for (const t of argusOnly) {
    matches.push({
      suite: t.suite, suiteKey: t.suiteKey,
      argus: t, client: null,
      matchedBy: 'argus-only',
      diffs: [{
        field: 'tenant_presence', severity: 'HIGH',
        argusValue: t.name, clientValue: '— (not found)',
        label: 'Missing from client RR',
        rule: 'Tenant present in Argus has no match in client RR (by suite, SF, or name)',
      }],
      flags: { argusOnly: true, clientOnly: false, clean: false },
    })
  }
  for (const t of clientOnly) {
    matches.push({
      suite: t.suite, suiteKey: t.suiteKey,
      argus: null, client: t,
      matchedBy: 'client-only',
      diffs: [{
        field: 'tenant_presence', severity: 'HIGH',
        argusValue: '— (not found)', clientValue: t.name,
        label: 'Missing from Argus RR',
        rule: 'Tenant present in client RR has no match in Argus (by suite, SF, or name)',
      }],
      flags: { argusOnly: false, clientOnly: true, clean: false },
    })
  }

  // 3) Sort in Argus order:
  //    - Matched + Argus-only rows ordered by the Argus tenant's row index (preserves Argus's
  //      alphabetical-by-tenant-name ordering inside the rent roll).
  //    - Client-only rows go at the end, ordered by suite.
  matches.sort((a, b) => {
    const ai = a.argus?._argusBlockRow
    const bi = b.argus?._argusBlockRow
    if (ai != null && bi != null) return ai - bi
    if (ai != null) return -1
    if (bi != null) return 1
    return naturalCompare(a.suite, b.suite)
  })

  // 4) Property totals
  const argusTotal  = argus.totalSF
  const clientTotal = sumActiveSF(clientActive)
  const totals = {
    argus: argusTotal,
    client: clientTotal,
    clientReported: client.topLevelTotalSF || null,
    diff: argusTotal && clientTotal ? argusTotal - clientTotal : null,
    diffPct: argusTotal && clientTotal ? (argusTotal - clientTotal) / argusTotal : null,
  }

  // 5) Top-level notes
  const notes = []
  if (argus.tenants?.some(t => t.percentRent) && !client.tenants?.some(t => t.percentRent)) {
    notes.push('Percentage Rent Data was Not Reconciled')
  }
  if (totals.diff != null && Math.abs(totals.diff) > 0 && Math.abs(totals.diffPct) > 0.001) {
    const sign = totals.diff > 0 ? '+' : ''
    notes.push(`Property Total SF differs: Argus = ${fmtNum(totals.argus)} vs Client = ${fmtNum(totals.client)} (${sign}${fmtNum(totals.diff)} SF)`)
  }

  // 6) Summary stats
  const summary = {
    matched: matched.length,
    clean: matches.filter(m => m.flags.clean).length,
    withDiffs: matches.filter(m => !m.flags.clean && !m.flags.argusOnly && !m.flags.clientOnly).length,
    argusOnly: argusOnly.length,
    clientOnly: clientOnly.length,
    total: matches.length,
    highSeverityCount: matches.reduce((n, m) => n + m.diffs.filter(d => d.severity === 'HIGH' && !d.suppressed).length, 0),
    learningsApplied: learningsAppliedCount,
  }

  return {
    property: argus.property || client.property,
    totals, notes, matches, summary,
  }
}

// ─── Matcher ───────────────────────────────────────────────
function matchTenants(argus, client) {
  const usedA = new Set(), usedC = new Set()
  const matched = []

  // Pass 1: exact suite key
  const cBySuite = new Map(client.filter(t => t.suiteKey).map(t => [t.suiteKey, t]))
  for (const a of argus) {
    if (!a.suiteKey) continue
    const c = cBySuite.get(a.suiteKey)
    if (c && !usedC.has(c)) {
      matched.push({ argus: a, client: c, matchedBy: 'suite' })
      usedA.add(a); usedC.add(c)
    }
  }

  // Pass 2: SF tolerance (within 0.5%)
  for (const a of argus) {
    if (usedA.has(a) || !a.sqft) continue
    const c = client.find(cc =>
      !usedC.has(cc) && cc.sqft && Math.abs(cc.sqft - a.sqft) / a.sqft < SF_PCT_EPS
    )
    if (c) {
      matched.push({ argus: a, client: c, matchedBy: 'sqft' })
      usedA.add(a); usedC.add(c)
    }
  }

  // Pass 3: fuzzy name
  for (const a of argus) {
    if (usedA.has(a) || !a.name) continue
    const aTok = tokenize(a.name)
    let best = null, bestScore = 0
    for (const c of client) {
      if (usedC.has(c) || !c.name) continue
      const score = jaccard(aTok, tokenize(c.name))
      if (score > bestScore) { best = c; bestScore = score }
    }
    if (best && bestScore >= 0.5) {
      matched.push({ argus: a, client: best, matchedBy: 'name' })
      usedA.add(a); usedC.add(best)
    }
  }

  const argusOnly  = argus.filter(a => !usedA.has(a))
  const clientOnly = client.filter(c => !usedC.has(c))
  return { matched, argusOnly, clientOnly }
}

function tokenize(s) {
  return new Set(
    String(s).toLowerCase()
      .replace(/\b(llc|inc|corp|corporation|ltd|co|company|the|of|and)\b/g, ' ')
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 1)
  )
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0
  let inter = 0
  for (const x of a) if (b.has(x)) inter++
  return inter / (a.size + b.size - inter)
}

// ─── Per-tenant comparison ─────────────────────────────────
function compareTenants(a, c) {
  const diffs = []

  // Tenant name
  if (a.name && c.name) {
    const aN = simplifyName(a.name), cN = simplifyName(c.name)
    if (aN !== cN) {
      diffs.push({
        field: 'tenant_name', severity: containsToken(aN, cN) ? 'LOW' : 'MEDIUM',
        label: 'Tenant Name',
        argusValue: a.name, clientValue: c.name,
        rule: 'Tenant names normalized (LLC/Inc/Corp stripped) do not match',
      })
    }
  }

  // Suite (only flag if both present and disagree after normalization)
  if (a.suiteKey && c.suiteKey && a.suiteKey !== c.suiteKey) {
    diffs.push({
      field: 'suite', severity: 'LOW',
      label: 'Suite / Unit',
      argusValue: a.suite, clientValue: c.suite,
      rule: 'Suite identifiers normalize to different values',
    })
  }

  // SF
  if (a.sqft && c.sqft) {
    const pct = Math.abs(a.sqft - c.sqft) / a.sqft
    if (pct > SF_PCT_EPS) {
      diffs.push({
        field: 'sqft', severity: pct > 0.02 ? 'HIGH' : 'MEDIUM',
        label: 'Square Footage',
        argusValue: fmtNum(a.sqft) + ' SF', clientValue: fmtNum(c.sqft) + ' SF',
        rule: 'Initial Area mismatch beyond 0.5% tolerance',
      })
    }
  }

  // Lease dates
  for (const [field, label, aV, cV] of [
    ['lease_start', 'Lease Start', a.leaseStart, c.leaseStart],
    ['lease_end',   'Lease End',   a.leaseEnd,   c.leaseEnd],
  ]) {
    if (!aV || !cV) continue
    const days = daysBetween(aV, cV)
    if (days == null) {
      if (aV !== cV) diffs.push({ field, severity: 'MEDIUM', label, argusValue: aV, clientValue: cV, rule: 'Could not parse both dates — string compare' })
    } else if (days > DATE_DAYS_EPS) {
      diffs.push({
        field, severity: days > 30 ? 'HIGH' : 'MEDIUM',
        label, argusValue: aV, clientValue: cV,
        rule: `Dates differ by ${Math.round(days)} day(s)`,
      })
    }
  }

  // Base rent — compare on $/SF/yr (the spec's preferred axis), with $0.02 tolerance
  const aPsf = bestPsfAnnual(a, a.sqft)
  const cPsf = bestPsfAnnual(c, c.sqft)
  if (aPsf != null && cPsf != null && Math.abs(aPsf - cPsf) > PSF_EPS) {
    diffs.push({
      field: 'base_rent_psf',
      severity: Math.abs(aPsf - cPsf) > 0.50 ? 'HIGH' : Math.abs(aPsf - cPsf) > 0.10 ? 'MEDIUM' : 'LOW',
      label: 'Base Rent $/SF/yr',
      argusValue: '$' + aPsf.toFixed(2) + '/SF/yr',
      clientValue: '$' + cPsf.toFixed(2) + '/SF/yr',
      rule: 'Current base rent differs beyond $0.02/SF/yr rounding tolerance',
    })
  }

  // Also flag annual total drift if BOTH have it (catches scenarios where PSF agrees but total doesn't)
  const aTot = a.baseRent?.annualTotal ?? (aPsf != null && a.sqft ? aPsf * a.sqft : null)
  const cTot = c.baseRent?.annualTotal ?? (cPsf != null && c.sqft ? cPsf * c.sqft : null)
  if (aTot && cTot && a.sqft && c.sqft && Math.abs(a.sqft - c.sqft) / a.sqft < SF_PCT_EPS) {
    const drift = Math.abs(aTot - cTot) / aTot
    if (drift > RENT_PCT_EPS && Math.abs(aTot - cTot) > 50) {
      diffs.push({
        field: 'base_rent_annual', severity: drift > 0.05 ? 'HIGH' : 'MEDIUM',
        label: 'Base Rent (annual total)',
        argusValue: fmtMoney(aTot), clientValue: fmtMoney(cTot),
        rule: 'Annual base rent total differs >0.5% with matching SF — beyond rounding',
      })
    }
  }

  // Rent steps — pair by index, validate date AND amount
  const aSteps = a.rentSteps || []
  const cSteps = c.rentSteps || []
  const pairs = pairRentSteps(aSteps, cSteps)
  if (pairs.unpairedA.length || pairs.unpairedC.length) {
    diffs.push({
      field: 'rent_steps_count', severity: 'HIGH',
      label: 'Rent Step Count',
      argusValue: `${aSteps.length} step(s)`, clientValue: `${cSteps.length} step(s)`,
      rule: 'Different number of rent steps recorded',
    })
  }
  pairs.matched.forEach(({ aS, cS, idx }) => {
    const days = daysBetween(aS.effectiveDate, cS.effectiveDate, true)
    if (days != null && days > DATE_DAYS_EPS) {
      diffs.push({
        field: 'rent_step_date',
        severity: days > 30 ? 'HIGH' : 'MEDIUM',
        label: `Rent Step #${idx + 1} Date`,
        argusValue: aS.effectiveDate, clientValue: cS.effectiveDate,
        rule: 'Rent step effective date differs',
      })
    }
    const aAmt = bestStepPsfAnnual(aS, a.sqft)
    const cAmt = bestStepPsfAnnual(cS, c.sqft)
    if (aAmt != null && cAmt != null && Math.abs(aAmt - cAmt) > PSF_EPS) {
      diffs.push({
        field: 'rent_step_amount', severity: 'HIGH',
        label: `Rent Step #${idx + 1} Amount`,
        argusValue: '$' + aAmt.toFixed(2) + '/SF/yr',
        clientValue: '$' + cAmt.toFixed(2) + '/SF/yr',
        rule: 'Rent step amount differs beyond $0.02/SF/yr',
      })
    }
  })

  // Free rent
  const aFR = a.freeRent || [], cFR = c.freeRent || []
  if (aFR.length || cFR.length) {
    if (aFR.length !== cFR.length) {
      diffs.push({
        field: 'free_rent_count', severity: 'MEDIUM',
        label: 'Free Rent Period Count',
        argusValue: `${aFR.length} period(s)`, clientValue: `${cFR.length} period(s)`,
        rule: 'Different number of free-rent periods recorded',
      })
    }
    const len = Math.min(aFR.length, cFR.length)
    for (let i = 0; i < len; i++) {
      const aF = aFR[i], cF = cFR[i]
      if (aF.months !== cF.months || aF.abatementPct !== cF.abatementPct || aF.startDate !== cF.startDate) {
        diffs.push({
          field: 'free_rent', severity: 'MEDIUM',
          label: `Free Rent #${i + 1}`,
          argusValue: `${aF.startDate || '?'}: ${aF.months ? aF.months + ' mo' : ((aF.abatementPct ?? 0) * 100).toFixed(0) + '%'}`,
          clientValue: `${cF.startDate || '?'}: ${cF.months ? cF.months + ' mo' : ((cF.abatementPct ?? 0) * 100).toFixed(0) + '%'}`,
          rule: 'Free rent period differs',
        })
      }
    }
  }

  // % Rent — only flag if BOTH sides have it
  if (a.percentRent && c.percentRent) {
    const aBp = a.percentRent.breakpoint, cBp = c.percentRent.breakpoint
    if (aBp != null && cBp != null && Math.abs(aBp - cBp) > 1) {
      diffs.push({
        field: 'pct_rent_breakpoint', severity: 'MEDIUM',
        label: '% Rent Breakpoint',
        argusValue: fmtMoney(aBp), clientValue: fmtMoney(cBp),
        rule: 'Percentage rent breakpoint differs',
      })
    }
    const aOv = a.percentRent.overagePct, cOv = c.percentRent.overagePct
    if (aOv != null && cOv != null && Math.abs(aOv - cOv) > 0.0005) {
      diffs.push({
        field: 'pct_rent_overage', severity: 'MEDIUM',
        label: '% Rent Overage %',
        argusValue: (aOv * 100).toFixed(2) + '%', clientValue: (cOv * 100).toFixed(2) + '%',
        rule: 'Percentage rent overage % differs',
      })
    }
  }

  return diffs
}

// ─── Helpers ───────────────────────────────────────────────
function bestPsfAnnual(t, sqft) {
  const br = t.baseRent || {}
  if (br.psfAnnual != null && br.psfAnnual > 0) return br.psfAnnual
  if (br.annualTotal != null && sqft) return br.annualTotal / sqft
  if (br.psfMonthly != null) return br.psfMonthly * 12
  if (br.monthlyTotal != null && sqft) return (br.monthlyTotal * 12) / sqft
  return null
}

function bestStepPsfAnnual(s, sqft) {
  if (s.psfAnnual    != null) return s.psfAnnual
  if (s.annualTotal  != null && sqft) return s.annualTotal / sqft
  if (s.psfMonthly   != null) return s.psfMonthly * 12
  if (s.monthlyTotal != null && sqft) return (s.monthlyTotal * 12) / sqft
  return null
}

function pairRentSteps(a, c) {
  // Pair by index; report leftover on either side as unpaired
  const matched = []
  const len = Math.min(a.length, c.length)
  for (let i = 0; i < len; i++) matched.push({ aS: a[i], cS: c[i], idx: i })
  return { matched, unpairedA: a.slice(len), unpairedC: c.slice(len) }
}

function sumActiveSF(tenants) {
  return tenants.filter(t => !t.isOption && !t.isReabsorbed && t.sqft).reduce((n, t) => n + t.sqft, 0)
}

function simplifyName(s) {
  return String(s).toLowerCase()
    .replace(/\b(llc|inc|corp|corporation|ltd|co|company|the|of|and|#\d+)\b/g, '')
    .replace(/[^a-z0-9]/g, '')
}
function containsToken(a, b) {
  const s = a.length < b.length ? a : b
  const l = a.length < b.length ? b : a
  return l.includes(s) && s.length >= 4
}

function daysBetween(a, b, allowMonthYear = false) {
  const da = parseDate(a, allowMonthYear), db = parseDate(b, allowMonthYear)
  if (!da || !db) return null
  return Math.abs((da - db) / (1000 * 60 * 60 * 24))
}
function parseDate(s, allowMonthYear = false) {
  if (!s) return null
  const str = String(s).trim()
  const slashy = str.match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/)
  if (slashy) {
    let [, mo, d, y] = slashy
    y = +y; if (y < 100) y += 2000
    const dt = new Date(y, +mo - 1, +d)
    return isNaN(dt) ? null : dt
  }
  if (allowMonthYear) {
    const my = str.match(/^([A-Za-z]{3})-?(\d{4})$/) || str.match(/^([A-Za-z]{3,9})\s+(\d{4})$/)
    if (my) {
      const months = { jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11 }
      const m = months[my[1].slice(0, 3).toLowerCase()]
      if (m != null) return new Date(+my[2], m, 1)
    }
  }
  return null
}

function naturalCompare(a, b) {
  return String(a ?? '').localeCompare(String(b ?? ''), undefined, { numeric: true, sensitivity: 'base' })
}

function fmtNum(n) { return n == null ? '—' : Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 }) }
function fmtMoney(n) { return n == null ? '—' : '$' + Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 }) }
