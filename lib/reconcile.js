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
// Run/as-of date proxy. The rolls don't carry an explicit as-of date in the
// canonical schema, and they're compared close to when they're generated, so
// "now" is the best available reference for the lease-start carve-out below.
const RUN_DATE        = new Date()

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

  // Cross-tenant document-coverage signal. An actual in-place rent roll often
  // doesn't itemize concessions, while a forecast/valuation model assigns free
  // rent to most speculative leases. Count, among MATCHED pairs, how many
  // tenants each side itemizes free rent for. If one side covers far fewer
  // tenants than the other (< 1/3), that document under-reports concessions, so
  // a per-tenant "1 vs 0" count gap is a coverage difference (noise), NOT a
  // dropped concession. When coverage is comparable, an absence on one tenant
  // is meaningful and still flags (e.g. the deal team genuinely dropped one).
  let argusFRtenants = 0, clientFRtenants = 0
  for (const pair of matched) {
    if ((pair.argus.freeRent  || []).length) argusFRtenants++
    if ((pair.client.freeRent || []).length) clientFRtenants++
  }
  const COVERAGE_MIN = 1 / 3
  const ctx = {
    clientUnderReportsFreeRent: argusFRtenants > 0 && (clientFRtenants / argusFRtenants) < COVERAGE_MIN,
    argusUnderReportsFreeRent:  clientFRtenants > 0 && (argusFRtenants / clientFRtenants) < COVERAGE_MIN,
  }

  // 2) Diff each matched pair
  const matches = []
  for (const pair of matched) {
    let diffs = compareTenants(pair.argus, pair.client, ctx)
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
        _loc: { argus: { label: `Argus block at row ${t._argusBlockRow}` }, clientHeader: null, argusAbsoluteRow: t._argusBlockRow },
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
        _loc: { argus: null, clientHeader: 'Tenant', argusAbsoluteRow: null },
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
//
// Strategy: for every Argus tenant, score every candidate client tenant
// across THREE signals (name similarity, suite, square footage). The best-
// scoring pair wins, then we lock both sides and move on.
//
// Combined score:
//   nameSim        × 0.55   — primary signal, drives matching when both
//                              have names. Uses character-level similarity
//                              so "Barberito's" ≈ "BARBERITOS" (0.91), not 0.
//   suiteExactBoost × 0.30  — adds a strong nudge if suites match exactly
//   sfMatchBoost    × 0.15  — adds a small nudge if SF matches within 0.5%
//
// Threshold 0.45 keeps obvious non-matches out; the name score alone of
// 0.85 with no other signal already clears the bar.
function matchTenants(argus, client) {
  const usedA = new Set(), usedC = new Set()
  const matched = []
  const pairs = []  // {a, c, score, nameSim, parts, matchedBy}

  // Score every (argus, client) pair once.
  for (const a of argus) {
    for (const c of client) {
      const nameSim = (a.name && c.name) ? nameSimilarity(a.name, c.name) : 0
      const suiteOk = (a.suiteKey && c.suiteKey && a.suiteKey === c.suiteKey) ? 1 : 0
      const sfOk = (a.sqft && c.sqft && Math.abs(c.sqft - a.sqft) / a.sqft < SF_PCT_EPS) ? 1 : 0
      const score = nameSim * 0.55 + suiteOk * 0.30 + sfOk * 0.15
      pairs.push({ a, c, score, nameSim, suiteOk, sfOk })
    }
  }

  // Greedy: highest score first, lock both sides as we go.
  pairs.sort((x, y) => y.score - x.score)
  for (const p of pairs) {
    if (p.score < 0.45) break
    if (usedA.has(p.a) || usedC.has(p.c)) continue
    const matchedBy = p.suiteOk ? 'suite'
                    : p.nameSim >= 0.75 ? 'name'
                    : p.sfOk ? 'sqft'
                    : 'combined'
    matched.push({
      argus: p.a, client: p.c, matchedBy,
      matchScore: Math.round(p.score * 100) / 100,
      matchDetail: {
        name: Math.round(p.nameSim * 100) / 100,
        suite: p.suiteOk, sf: p.sfOk,
      },
    })
    usedA.add(p.a); usedC.add(p.c)
  }

  // Final fallback: suite-exact match for anything still unmatched (catches
  // tenants whose names differ wildly but who share a suite — keeps the
  // old behaviour as a safety net).
  const cBySuite = new Map(client.filter(t => t.suiteKey && !usedC.has(t)).map(t => [t.suiteKey, t]))
  for (const a of argus) {
    if (usedA.has(a) || !a.suiteKey) continue
    const c = cBySuite.get(a.suiteKey)
    if (c && !usedC.has(c)) {
      matched.push({ argus: a, client: c, matchedBy: 'suite-fallback', matchScore: 0.3 })
      usedA.add(a); usedC.add(c)
    }
  }

  const argusOnly  = argus.filter(a => !usedA.has(a))
  const clientOnly = client.filter(c => !usedC.has(c))
  return { matched, argusOnly, clientOnly }
}

// Character-level name similarity in [0, 1].
// Normalizes both sides (lowercase, strip corp suffixes, strip non-alphanum,
// collapse whitespace) then uses Levenshtein distance / max length.
//
//   "Barberito's"        vs "BARBERITOS"            → 0.91 (drop one char)
//   "Academy Sports"     vs "ACADEMY SPORTS + OUTDO"→ 0.61 (substring)
//   "Dollar General LLC" vs "DOLLAR GENERAL #9621"  → 0.79 (number suffix)
//   "Barberito's"        vs "BLACK TIE FORMALWEAR"  → 0.10 (clearly different)
//
// Falls back to substring-containment boost when one is a prefix/contains
// the other — so a stripped DBA always reads close to the legal name.
function normalizeName(s) {
  return String(s || '').toLowerCase()
    .replace(/\b(llc|inc|corp|corporation|ltd|co|company|the|of|and|store|#\s*\d+|dba)\b/g, ' ')
    .replace(/[^a-z0-9]/g, '')
    .trim()
}
function levenshtein(a, b) {
  if (a === b) return 0
  if (!a.length) return b.length
  if (!b.length) return a.length
  let prev = new Array(b.length + 1)
  for (let j = 0; j <= b.length; j++) prev[j] = j
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost)
    }
    prev = cur
  }
  return prev[b.length]
}
function nameSimilarity(a, b) {
  const na = normalizeName(a), nb = normalizeName(b)
  if (!na || !nb) return 0
  if (na === nb) return 1
  const maxLen = Math.max(na.length, nb.length)
  const lev = 1 - levenshtein(na, nb) / maxLen
  // Substring containment bonus — DBA vs legal name often differs only by
  // suffix/prefix. We average the raw Levenshtein with a containment score.
  const contains = na.includes(nb) || nb.includes(na)
    ? Math.min(na.length, nb.length) / maxLen
    : 0
  return Math.max(lev, contains)
}

// Token jaccard kept for backwards compat with anything that imports it.
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
// Each finding (diff) carries a `_loc` field locating it in the source:
//   - argus: { col, rowOffset, label } — column index and within-block row
//     offset for the Argus 5-row tenant block, so the UI can highlight
//     the exact cell without text-matching
//   - clientHeader: name of the column header the value sits under in
//     the client RR ('Area', 'Annual', 'Exp. Date', etc.) — helps the
//     PDF locator find the value even when the printed format differs.
const ARGUS_LOC = {
  tenant_name:         { col: 0, rowOffset: 0, label: 'Tenant Name (Col 0 row 0)' },
  suite:               { col: 0, rowOffset: 1, label: 'Suite (Col 0 row 1)' },
  lease_start:         { col: 0, rowOffset: 2, label: 'Lease dates (Col 0 row 2)' },
  lease_end:           { col: 0, rowOffset: 2, label: 'Lease dates (Col 0 row 2)' },
  sqft:                { col: 1, rowOffset: 0, label: 'Initial Area (Col 1 row 0)' },
  base_rent_psf:       { col: 3, rowOffset: 0, label: '$/SF/yr (Col 3 row 0)' },
  base_rent_annual:    { col: 3, rowOffset: 1, label: '$/yr (Col 3 row 1)' },
  rent_steps_count:    { col: 4, rowOffset: 0, label: 'Rent steps (Cols 4–6)' },
  rent_step_date:      { col: 4, rowOffset: 0, label: 'Rent step date (Col 4)' },
  rent_step_amount:    { col: 5, rowOffset: 0, label: 'Rent step amount (Cols 5–6)' },
  rent_step_unmatched: { col: 4, rowOffset: 0, label: 'Rent step (Cols 4–6)' },
  free_rent_count:     { col: 8, rowOffset: 0, label: 'Free rent (Cols 8–9)' },
  free_rent:           { col: 8, rowOffset: 0, label: 'Free rent (Cols 8–9)' },
  pct_rent_breakpoint: { col: 10, rowOffset: 1, label: '% rent breakpoint (Col 10 row 1)' },
  pct_rent_overage:    { col: 10, rowOffset: 2, label: '% rent overage (Col 10 row 2)' },
}
const CLIENT_HEADER = {
  tenant_name:         'Tenant',
  suite:               'Suite/Unit',
  lease_start:         'Lease Start / Commencement',
  lease_end:           'Exp. Date / Lease End',
  sqft:                'Area / Sq Ft',
  base_rent_psf:       'Rent per Sq Ft / $/SF',
  base_rent_annual:    'Annual / Annual Rent',
  rent_steps_count:    'Rent escalations',
  rent_step_date:      'Escalation date',
  rent_step_amount:    'New rent / Escalation amount',
  rent_step_unmatched: 'Rent escalations',
  free_rent_count:     'Free rent / Abatement',
  free_rent:           'Free rent / Abatement',
  pct_rent_breakpoint: 'Sales Volume / Breakpoint',
  pct_rent_overage:    'Overage %',
}
function loc(field) {
  return {
    argus: ARGUS_LOC[field] || null,
    clientHeader: CLIENT_HEADER[field] || null,
  }
}

// External entry — used by the server's orphan reunifier when Claude
// suggests a pair the deterministic matcher missed.
export function compareTenantsExternal(a, c) {
  const diffs = compareTenants(a, c)
  return {
    suite: a?.suite || c?.suite || null,
    suiteKey: a?.suiteKey || c?.suiteKey || null,
    argus: a,
    client: c,
    diffs,
    flags: {},
  }
}

function compareTenants(a, c, ctx = {}) {
  const diffs = []

  // Tenant name
  if (a.name && c.name) {
    const aN = simplifyName(a.name), cN = simplifyName(c.name)
    if (aN !== cN) {
      const isSubset = containsToken(aN, cN)
      diffs.push({
        field: 'tenant_name', severity: isSubset ? 'LOW' : 'MEDIUM',
        label: 'Tenant Name',
        argusValue: a.name, clientValue: c.name,
        rule: 'Tenant names normalized (LLC/Inc/Corp stripped) do not match',
        explain: isSubset
          ? `The two names share a common stem but one side has extra words. Argus uses a short DBA ("${a.name}") while the client RR uses the legal name or includes a #store number ("${c.name}"). This is usually fine — verify in the lease.`
          : `The names look different even after stripping LLC/Inc/Corp/etc. Possibilities: (a) tenant assignment to a different operator on one side, (b) suite mis-mapped between the two rent rolls, (c) client RR shows the property owner / billing name and Argus shows the DBA. Check the lease abstract.`,
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
        explain: `Square footage differs by ${(pct * 100).toFixed(2)}% (${fmtNum(Math.abs(a.sqft - c.sqft))} SF). Possibilities: (a) BOMA remeasurement applied on one side, (b) expansion/contraction not propagated to both rolls yet, (c) sub-tenant SF folded into the prime tenant on one side, (d) common-area allocation differs. Per the spec, the Argus 'Initial Area' column is the source of truth — exclude Building Share %.`,
      })
    }
  }

  // Lease dates
  for (const [field, label, aV, cV] of [
    ['lease_start', 'Lease Start', a.leaseStart, c.leaseStart],
    ['lease_end',   'Lease End',   a.leaseEnd,   c.leaseEnd],
  ]) {
    if (!aV || !cV) continue
    // allowMonthYear=true so ISO ("2032-07-31"), month-name ("December 31, 2031"),
    // and "Mon-YYYY" dates all parse — otherwise identical dates in a different
    // format become a phantom "could not parse" finding.
    const days = daysBetween(aV, cV, true)
    const explain = (kind, daysOff) => kind === 'start'
      ? `Lease commencement differs by ${daysOff} day(s). Common causes: (a) Argus uses the rent-commencement date, client RR uses the lease-execution date (or vice-versa), (b) a delivery / possession date moved and only one side was updated, (c) renewal option period bleed-through — the client RR may be reflecting a renewal start while Argus shows the original term. Check the lease for the controlling commencement clause.`
      : `Lease expiration differs by ${daysOff} day(s). Common causes: (a) renewal option exercised in one source but not the other, (b) the client RR is reflecting a holdover end while Argus shows the original term end, (c) lease amendment extended the term on one side. Confirm against the most recent amendment.`
    if (days == null) {
      if (aV !== cV) diffs.push({ field, severity: 'MEDIUM', label, argusValue: aV, clientValue: cV, rule: 'Could not parse both dates — string compare', explain: 'The dates are formatted differently on the two sides and we could not parse one of them. Confirm visually that the dates actually agree.' })
    } else if (days > DATE_DAYS_EPS) {
      const finding = {
        field, severity: days > 30 ? 'HIGH' : 'MEDIUM',
        label, argusValue: aV, clientValue: cV,
        rule: `Dates differ by ${Math.round(days)} day(s)`,
        explain: explain(field === 'lease_start' ? 'start' : 'end', Math.round(days)),
      }
      // Lease-start carve-out (per spec): a commencement date that's already well
      // in the past doesn't matter — the lease is in place on both rolls and a
      // small start-date disagreement has no bearing on current/future economics.
      // So if BOTH sides' start dates fall > 3 months before the run date, treat
      // the difference as noise (auto-suppress, kept for audit). Lease END dates
      // and rent-step dates are NEVER relaxed this way — they stay critical.
      if (field === 'lease_start') {
        const sa = parseDate(aV, true), sc = parseDate(cV, true)
        const cutoff = new Date(RUN_DATE.getTime() - 92 * 24 * 60 * 60 * 1000) // ~3 months
        const aOld = sa && sa < cutoff
        const cOld = sc && sc < cutoff
        if (aOld && cOld) {
          finding.severity = 'LOW'
          finding.suppressed = true
          finding.suppressedReason = 'Lease commenced more than 3 months before the run date, so a start-date difference no longer affects current or future rent — ignored per reconciliation policy.'
        }
      }
      diffs.push(finding)
    }
  }

  // Base rent — compare on $/SF/yr (the spec's preferred axis), with $0.02 tolerance.
  //
  // Per the spec, Col 4 is the CURRENT base rent only. A very common false
  // positive: one roll lists the CURRENT rate while the other lists a future
  // STEPPED rate as its "current" rent (or rounds differently). Before we flag
  // a base-rent difference, we cross-check whether the disagreeing value shows
  // up as a rent step on the OTHER side. If it does, the two rolls are really
  // telling the same rent schedule at different points in time — we keep the
  // finding (so it's auditable) but downgrade it to LOW and explain the timing.
  const aPsf = bestPsfAnnual(a, a.sqft)
  const cPsf = bestPsfAnnual(c, c.sqft)
  // Every rate each roll expresses (current base + each step), translated to
  // $/SF/yr. Used to recognise current-vs-stepped representations.
  const aRates = allRatesPsf(a, a.sqft)
  const cRates = allRatesPsf(c, c.sqft)
  // Does one roll's CURRENT rent equal a scheduled step on the OTHER roll?
  const baseExplainedByStep =
    aPsf != null && cPsf != null && Math.abs(aPsf - cPsf) > PSF_EPS &&
    (matchesAnyRate(cPsf, aRates) || matchesAnyRate(aPsf, cRates))
  if (aPsf != null && cPsf != null && Math.abs(aPsf - cPsf) > PSF_EPS) {
    const delta = Math.abs(aPsf - cPsf)
    const clientMatchesArgusStep = matchesAnyRate(cPsf, aRates)
    const argusMatchesClientStep = matchesAnyRate(aPsf, cRates)
    const explainedByStep = clientMatchesArgusStep || argusMatchesClientStep
    diffs.push({
      field: 'base_rent_psf',
      severity: explainedByStep ? 'LOW' : delta > 0.50 ? 'HIGH' : delta > 0.10 ? 'MEDIUM' : 'LOW',
      stepReconciled: explainedByStep || undefined,
      label: 'Base Rent $/SF/yr',
      argusValue: '$' + aPsf.toFixed(2) + '/SF/yr',
      clientValue: '$' + cPsf.toFixed(2) + '/SF/yr',
      rule: explainedByStep
        ? 'Base rent differs, but the value matches a rent step on the other roll (current-vs-stepped representation)'
        : 'Current base rent differs beyond $0.02/SF/yr rounding tolerance',
      explain: explainedByStep
        ? `Base rent differs by $${delta.toFixed(2)}/SF/yr, BUT one roll's current rate equals a scheduled rent step on the other roll (${clientMatchesArgusStep ? `client's $${cPsf.toFixed(2)} = an Argus step` : `Argus's $${aPsf.toFixed(2)} = a client step`}). This is almost certainly the same lease shown at different points on the rent schedule — one roll printed the current rate, the other printed a post-escalation rate. Confirm the effective dates line up; if so this is NOT a discrepancy.`
        : `Base rent differs by $${delta.toFixed(2)}/SF/yr (above the $0.02 rounding floor). Likely causes: (a) escalation date hit on one side but not the other — check whether either rent matches the next step rate, (b) one source is showing total gross rent including CAM/tax while the other is base-only, (c) lease amendment changed the rate on one side. The spec says any of the four base-rent representations ($/SF/yr, $/yr, $/SF/mo, $/mo) should reconcile to the same value — use the total or PSF/yr.`,
    })
  }

  // Also flag annual total drift if BOTH have it (catches scenarios where PSF agrees but total doesn't).
  // Skip when the base difference is already explained by a rent step — otherwise
  // we'd double-report the same current-vs-stepped representation.
  const aTot = a.baseRent?.annualTotal ?? (aPsf != null && a.sqft ? aPsf * a.sqft : null)
  const cTot = c.baseRent?.annualTotal ?? (cPsf != null && c.sqft ? cPsf * c.sqft : null)
  if (!baseExplainedByStep && aTot && cTot && a.sqft && c.sqft && Math.abs(a.sqft - c.sqft) / a.sqft < SF_PCT_EPS) {
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

  // ─── Rent steps (Argus Cols 5-7) ─────────────────────────────
  // Per the spec: "Source Rent Rolls are going to differ significantly with how
  // rent steps are presented. It is possible that rent step dates will align
  // with yearly amounts, monthly amounts, $/SF/yr or $/SF/mo. … if the source
  // Rent Roll reflects dates with any one or more of these data points we can
  // translate if necessary."
  //
  // So we (1) match steps by EFFECTIVE DATE — never by list position — and
  // (2) translate every amount to a single axis ($/SF/yr) before comparing.
  // We do NOT flag a bare count mismatch: one roll often lists only the next
  // step, repeats the current rent as a step, or folds a step into base rent.
  // Only steps that match by date but disagree on amount are real findings;
  // steps with no date counterpart surface as LOW so the verifier/user can
  // judge them in context instead of piling up as HIGH false positives.
  const aSteps = a.rentSteps || []
  const cSteps = c.rentSteps || []
  const pairs = pairRentSteps(aSteps, cSteps, a.sqft, c.sqft)

  pairs.matched.forEach(({ aS, cS, idx, daysApart, aPsf: aAmt, cPsf: cAmt }) => {
    // Dates were already confirmed to be the same step (within the matching
    // window). Only note a date difference if it's a meaningful drift (>30d)
    // — anniversary-vs-calendar anchoring inside the window is not a finding.
    if (daysApart != null && daysApart > 30) {
      diffs.push({
        field: 'rent_step_date',
        severity: 'MEDIUM',
        label: `Rent Step #${idx + 1} Date`,
        argusValue: aS.effectiveDate, clientValue: cS.effectiveDate,
        rule: 'Rent step effective date differs',
        explain: `The two rolls place rent step #${idx + 1} ${Math.round(daysApart)} day(s) apart. Most common cause: one side anchors to the lease anniversary (e.g. Aug 1) while the other anchors to the calendar/fiscal year start (e.g. Jan 1). Check the lease for the exact escalation language.`,
      })
    }
    if (aAmt != null && cAmt != null && Math.abs(aAmt - cAmt) > PSF_EPS) {
      const delta = Math.abs(aAmt - cAmt)
      diffs.push({
        field: 'rent_step_amount',
        severity: delta > 0.50 ? 'HIGH' : delta > 0.10 ? 'MEDIUM' : 'LOW',
        label: `Rent Step #${idx + 1} Amount`,
        argusValue: '$' + aAmt.toFixed(2) + '/SF/yr',
        clientValue: '$' + cAmt.toFixed(2) + '/SF/yr',
        rule: 'Rent step amount differs beyond $0.02/SF/yr (after translating to a common axis)',
        explain: `Rent step #${idx + 1} (both rolls agree on its date) disagrees on amount — Argus $${aAmt.toFixed(2)}/SF/yr vs client $${cAmt.toFixed(2)}/SF/yr, a $${delta.toFixed(2)} gap. Both values are already translated to $/SF/yr, so this is not a $/mo-vs-$/yr units issue. Likely: (a) the step rate was amended on one side only, or (b) CPI projection vs a fixed step. Verify against the lease rent schedule.`,
      })
    }
  })

  // Steps present on one roll with no date counterpart on the other. These are
  // usually presentation differences (the spec warns of this), so they are LOW.
  //
  // CRITICAL noise control: emit at most ONE finding per tenant per side — never
  // one-row-per-step. A forecast/valuation Argus model routinely projects a full
  // 10-year escalation ladder, while an *actual* in-place rent roll often lists
  // no steps at all. Emitting a row per orphan step turns a single "this roll
  // carries no schedule" fact into dozens of LOW findings that bury the real
  // discrepancies. When the OTHER side has zero steps, this is almost certainly
  // a document-type difference (actual vs. forecast) — auto-suppress it so it's
  // available for audit but doesn't inflate the count.
  const fmtStepList = (steps) => {
    const dates = steps.map(s => s.effectiveDate || '?')
    return dates.length <= 4
      ? dates.join(', ')
      : `${dates.slice(0, 3).join(', ')} … +${dates.length - 3} more (through ${dates[dates.length - 1]})`
  }
  if (pairs.unpairedA.length) {
    const clientHasNoSteps = cSteps.length === 0
    const n = pairs.unpairedA.length
    diffs.push({
      field: 'rent_step_unmatched', severity: 'LOW',
      label: n === 1 ? 'Rent Step only on Argus' : `${n} Rent Steps only on Argus`,
      argusValue: fmtStepList(pairs.unpairedA),
      clientValue: clientHasNoSteps ? '— (client roll lists no rent steps)' : '— (no steps at these dates)',
      rule: 'Argus lists rent step(s) with no matching-date step on the client roll',
      explain: clientHasNoSteps
        ? `Argus carries a ${n}-step escalation schedule but the client roll lists no rent steps for this tenant at all. This is almost always a document-type difference: an Argus valuation/forecast model projects future escalations, while an actual in-place rent roll typically shows only current rent. Not a real discrepancy unless the lease itself has these steps and the client roll dropped them.`
        : `Argus shows ${n} rent step(s) with no same-date counterpart on the client roll. Frequently a presentation difference — the client roll may list only the next step or fold escalations into current base rent. Verify against the lease schedule.`,
      ...(clientHasNoSteps ? {
        suppressed: true,
        suppressedReason: 'Client roll carries no escalation schedule — Argus forecast steps have nothing to compare against (actual-vs-forecast).',
      } : {}),
    })
  }
  if (pairs.unpairedC.length) {
    const argusHasNoSteps = aSteps.length === 0
    const n = pairs.unpairedC.length
    diffs.push({
      field: 'rent_step_unmatched', severity: 'LOW',
      label: n === 1 ? 'Rent Step only on client RR' : `${n} Rent Steps only on client RR`,
      argusValue: argusHasNoSteps ? '— (Argus lists no rent steps)' : '— (no steps at these dates)',
      clientValue: fmtStepList(pairs.unpairedC),
      rule: 'Client roll lists rent step(s) with no matching-date step on Argus',
      explain: argusHasNoSteps
        ? `The client roll lists a ${n}-step escalation schedule but Argus shows no rent steps for this tenant. Often a document-type difference, or Argus expresses escalations as current base rent. Verify against the lease before treating as real.`
        : `The client roll shows ${n} rent step(s) with no same-date counterpart in Argus. Often a presentation difference, or a renewal-option escalation beyond lease expiration. Verify against the lease.`,
      ...(argusHasNoSteps ? {
        suppressed: true,
        suppressedReason: 'Argus carries no escalation schedule — client steps have nothing to compare against.',
      } : {}),
    })
  }

  // Free rent
  const aFR = a.freeRent || [], cFR = c.freeRent || []
  if (aFR.length || cFR.length) {
    if (aFR.length !== cFR.length) {
      // Systematic-absence guard: if one side lists free rent here but carries
      // NO free-rent data anywhere in its roll, this is a document-coverage
      // difference (the roll just doesn't itemize concessions), not a dropped
      // concession. Suppress so it's available for audit but doesn't pile up.
      const clientAbsent = cFR.length === 0 && ctx.clientUnderReportsFreeRent === true
      const argusAbsent  = aFR.length === 0 && ctx.argusUnderReportsFreeRent === true
      const systematic = clientAbsent || argusAbsent
      diffs.push({
        field: 'free_rent_count', severity: 'MEDIUM',
        label: 'Free Rent Period Count',
        argusValue: `${aFR.length} period(s)`, clientValue: `${cFR.length} period(s)`,
        rule: 'Different number of free-rent periods recorded',
        ...(systematic ? {
          severity: 'LOW',
          suppressed: true,
          suppressedReason: clientAbsent
            ? 'Client roll itemizes concessions for far fewer tenants than Argus — this document under-reports free rent (not a dropped concession).'
            : 'Argus itemizes concessions for far fewer tenants than the client roll — Argus under-reports free rent here.',
        } : {}),
      })
    }
    const len = Math.min(aFR.length, cFR.length)
    for (let i = 0; i < len; i++) {
      const aF = aFR[i], cF = cFR[i]
      // Compare start dates by PARSED value, not raw string — "May-2026" and
      // "5/1/2026" are the same date in different formats and must not flag.
      const frDays = daysBetween(aF.startDate, cF.startDate, true)
      const dateDiffers = (aF.startDate && cF.startDate)
        ? (frDays == null ? aF.startDate !== cF.startDate : frDays > DATE_DAYS_EPS)
        : (aF.startDate || '') !== (cF.startDate || '')
      const monthsDiffer = (aF.months ?? null) !== (cF.months ?? null)
      const pctDiffer = (aF.abatementPct ?? null) !== (cF.abatementPct ?? null)
      if (dateDiffers || monthsDiffer || pctDiffer) {
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

  // Stamp every diff with location metadata so the verifier prompt + the
  // frontend highlighter both have coordinates to work with, and so the
  // Excel report can say WHERE each finding lives in the source.
  for (const d of diffs) {
    if (!d._loc) d._loc = loc(d.field)
    // Also expose the Argus block row at the diff level (it was only on
    // the tenant before) — the UI builds an exact cell from this.
    if (d._loc && a?._argusBlockRow != null) {
      d._loc.argusAbsoluteRow = a._argusBlockRow + (d._loc.argus?.rowOffset ?? 0)
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

// Every rate a tenant expresses — current base rent plus each rent step —
// translated to a single $/SF/yr axis. Used to recognise when one roll's
// "current" rent is actually a future stepped rate on the other roll.
function allRatesPsf(t, sqft) {
  const out = []
  const base = bestPsfAnnual(t, sqft)
  if (base != null) out.push(base)
  for (const s of (t.rentSteps || [])) {
    const p = bestStepPsfAnnual(s, sqft)
    if (p != null) out.push(p)
  }
  return out
}

// Is `value` ($/SF/yr) equal to any rate in `rates` within the $0.02/SF floor?
function matchesAnyRate(value, rates) {
  if (value == null) return false
  return rates.some(r => r != null && Math.abs(r - value) <= PSF_EPS)
}

// Pair rent steps by EFFECTIVE DATE (never by list position) and translate
// each amount to $/SF/yr. Two steps are "the same step" when their dates fall
// within RENT_STEP_DATE_WINDOW_DAYS of each other — this absorbs the common
// anniversary-vs-calendar anchoring drift while still keeping genuinely
// different annual steps (~365 days apart) separate.
//
// Returns:
//   matched:    [{ aS, cS, idx, daysApart, aPsf, cPsf }]
//   unpairedA:  Argus steps with no date counterpart on the client
//   unpairedC:  client steps with no date counterpart on Argus
const RENT_STEP_DATE_WINDOW_DAYS = 45
function pairRentSteps(aSteps, cSteps, aSqft, cSqft) {
  const A = aSteps.map((s, i) => ({ s, i, date: parseDate(s.effectiveDate, true), psf: bestStepPsfAnnual(s, aSqft) }))
  const C = cSteps.map((s, i) => ({ s, i, date: parseDate(s.effectiveDate, true), psf: bestStepPsfAnnual(s, cSqft) }))

  // If neither side carries parseable dates we can't date-match. Before falling
  // back to index pairing, try matching on the exact (normalized) effective-date
  // STRING — this rescues label-style steps like "Year 3" / "Month 13" that the
  // date parser can't turn into a Date but that still name the same step. Only
  // when even that fails do we resort to position.
  const aHasDates = A.some(x => x.date)
  const cHasDates = C.some(x => x.date)
  if (!aHasDates || !cHasDates) {
    const key = s => String(s?.effectiveDate ?? '').toLowerCase().replace(/[\s,\/\-]+/g, ' ').trim()
    const matched = []
    const usedC = new Set()
    for (const a of A) {
      const ak = key(a.s)
      if (!ak) continue
      const hit = C.find(c => !usedC.has(c.i) && key(c.s) === ak)
      if (hit) {
        usedC.add(hit.i)
        matched.push({ aS: a.s, cS: hit.s, idx: matched.length, daysApart: null, aPsf: a.psf, cPsf: hit.psf })
      }
    }
    if (matched.length) {
      const matchedA = new Set(matched.map(m => m.aS))
      return {
        matched,
        unpairedA: A.filter(x => !matchedA.has(x.s)).map(x => x.s),
        unpairedC: C.filter(x => !usedC.has(x.i)).map(x => x.s),
      }
    }
    // No string matches at all — last-resort index pairing (still translating
    // amounts to a common axis so reps like $/mo vs $/SF/yr reconcile).
    const len = Math.min(A.length, C.length)
    for (let i = 0; i < len; i++) {
      matched.push({ aS: A[i].s, cS: C[i].s, idx: i, daysApart: null, aPsf: A[i].psf, cPsf: C[i].psf })
    }
    return { matched, unpairedA: A.slice(len).map(x => x.s), unpairedC: C.slice(len).map(x => x.s) }
  }

  const matched = []
  const usedC = new Set()
  for (const a of A) {
    if (!a.date) continue
    let best = null, bestDays = Infinity
    for (const c of C) {
      if (usedC.has(c.i) || !c.date) continue
      const days = Math.abs((a.date - c.date) / 86400000)
      if (days < bestDays) { bestDays = days; best = c }
    }
    if (best && bestDays <= RENT_STEP_DATE_WINDOW_DAYS) {
      usedC.add(best.i)
      matched.push({ aS: a.s, cS: best.s, idx: matched.length, daysApart: bestDays, aPsf: a.psf, cPsf: best.psf })
    }
  }
  const matchedA = new Set(matched.map(m => m.aS))
  const unpairedA = A.filter(x => !matchedA.has(x.s)).map(x => x.s)
  const unpairedC = C.filter(x => !usedC.has(x.i)).map(x => x.s)
  return { matched, unpairedA, unpairedC }
}

function sumActiveSF(tenants) {
  return tenants.filter(t => !t.isOption && !t.isReabsorbed && t.sqft).reduce((n, t) => n + t.sqft, 0)
}

function simplifyName(s) {
  return String(s).toLowerCase()
    .replace(/#\s*\d+/g, ' ')   // store numbers like "#9621" (no word boundary before '#')
    .replace(/\b(llc|inc|corp|corporation|ltd|co|company|the|of|and|dba)\b/g, '')
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
const MONTHS = { jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11 }
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
    // Normalise any separator (dash, comma, slash, multiple spaces) to a single
    // space so we handle every variant the parsers emit or Claude returns:
    // "Aug-2027", "August-2027", "August 2027", "Aug 1, 2027", "1 August 2027",
    // "2027-08-01". (Argus's normalizeStepDate turns "August 2027" into
    // "August-2027", which the old 3-letter-only regex silently failed to parse.)
    const norm = str.replace(/[,\/\-]+/g, ' ').replace(/\s+/g, ' ').trim()
    // Month [day] year  e.g. "August 2027" or "Aug 1 2027"
    let m = norm.match(/^([A-Za-z]{3,9})\s+(?:(\d{1,2})\s+)?(\d{4})$/)
    if (m && MONTHS[m[1].slice(0, 3).toLowerCase()] != null) {
      return new Date(+m[3], MONTHS[m[1].slice(0, 3).toLowerCase()], m[2] ? +m[2] : 1)
    }
    // day Month year  e.g. "1 August 2027"
    m = norm.match(/^(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{4})$/)
    if (m && MONTHS[m[2].slice(0, 3).toLowerCase()] != null) {
      return new Date(+m[3], MONTHS[m[2].slice(0, 3).toLowerCase()], +m[1])
    }
    // ISO-ish  e.g. "2027 08 01" (from "2027-08-01")
    m = norm.match(/^(\d{4})\s+(\d{1,2})\s+(\d{1,2})$/)
    if (m) { const dt = new Date(+m[1], +m[2] - 1, +m[3]); if (!isNaN(dt)) return dt }
    // numeric month/year  e.g. "8 2027" (from "8/2027")
    m = norm.match(/^(\d{1,2})\s+(\d{4})$/)
    if (m) return new Date(+m[2], +m[1] - 1, 1)
  }
  return null
}

function naturalCompare(a, b) {
  return String(a ?? '').localeCompare(String(b ?? ''), undefined, { numeric: true, sensitivity: 'base' })
}

function fmtNum(n) { return n == null ? '—' : Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 }) }
function fmtMoney(n) { return n == null ? '—' : '$' + Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 }) }
