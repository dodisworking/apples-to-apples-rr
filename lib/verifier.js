// ─── Second-pass AI verifier ────────────────────────────────
// After reconcile() produces findings, we don't trust them blindly. This
// module sends each tenant's full Apple + Pear context AND its findings
// to Claude Haiku for a cross-check pass. False positives get suppressed
// (with reasoning); confirmed ones get a confidence stamp.
//
// Why this matters: the deterministic reconciler can't see context like
// "the client just shows monthly total while Argus shows annual" or "the
// PSF includes CAM on one side". Claude reads both rows side-by-side and
// catches those false alarms.
//
// Runs ALWAYS regardless of model mode (dumb/regular/deluxe) — verifier
// uses Haiku (fast, cheap) so it doesn't blow up the bill.

import Anthropic from '@anthropic-ai/sdk'

const ai = new Anthropic()
const VERIFIER_MODEL = 'claude-haiku-4-5'

// Cap concurrency so we don't hammer the API. Most rent rolls have 30-50
// tenants but only a handful with findings — 4 in flight is a fine balance
// between throughput and rate-limit safety.
const MAX_CONCURRENT = 4

const SYSTEM_PROMPT = `You are a senior real-estate paralegal verifying a rent-roll reconciliation.

THE MISSION: For each Argus tenant, the program needs to know exactly:
  (1) what doesn't match against the Client rent roll,
  (2) what's missing from one side or the other,
  (3) where in the source documents to look.

The whole "Apples to Apples" idea is that rent rolls are NOT standardized across formats. You MUST translate values to a common axis before declaring a discrepancy. Where the deterministic reconciler flagged a finding, your job is to do the second-pass translation and decide REAL vs FALSE POSITIVE.

═══════════════════════════════════════════════════════════════════════
RENT ROLL VALIDATION SPEC (this is the source of truth — apply it strictly)
═══════════════════════════════════════════════════════════════════════

ARGUS RENT ROLL LAYOUT — each tenant is a 5-row block:
  Col 0: tenant info (name row 0, suite row 1, lease dates row 2, term row 3, tenure row 4)
  Col 1: Initial Area row 0 (SF), Building Share % row 1 — IGNORE Building Share %
  Col 2: Status, Lease Type
  Col 3: Base Rent — FIVE representations: $/SF/yr, $/yr, $/SF/mo, $/mo, Rental Value/yr.
         The first 4 are equivalent (different representations of the same number).
         IGNORE the 5th (Rental Value/yr).
  Cols 4-7: Rent steps. Col 4 = step date. Col 5 = $/SF/yr step amount. Col 6 = $/SF/mo step amount. Cols 5 and 6 are equivalent — use one.
  Cols 8-9: Free Rent. Col 8 = start date. Col 9 = months (integer) OR fractional abatement (decimal, 0.5 = 50%).
  Col 10: % Rent — Sales Volume row 0 (often null), Breakpoint row 1, Overage % row 2.
  Col 11: Misc Rent — IGNORE THIS COLUMN ENTIRELY.
  Right-most col: Renewal Assumption — used to detect "Reabsorbed" suites which are EXCLUDED from totals.

═══ Property Total SF ═══
- Sum of Col 1 row 0 across all included tenants.
- EXCLUDE: reabsorbed suites, Option/Contract Renewal lines (those have "(Option ...)" or "(Contract Renewal ...)" in the name).
- EXCLUDE: Building Share % (Col 1 row 1).
- 0-SF antenna/telecom/subtenant suites can be excluded.

═══ Tenant Name / Suite / Lease Dates (Col 0) ═══
- Source RR may show RENEWAL OPTION rows with dates BEYOND the main lease expiration — these are NOT a discrepancy. DEFER renewal options.
- DBA vs legal name is a FALSE POSITIVE (e.g. "Academy Sports" vs "ACADEMY SPORTS + OUTDO STORE LLC" — same business).
- Store-number appendage is a FALSE POSITIVE ("Dollar General" vs "DOLLAR GENERAL #9621").
- Apostrophe / trailing 's' / case differences are FALSE POSITIVES.

═══ Base Rent (Col 4 — FOUR equivalent reps) ═══
- $0.02/SF or less = rounding error, FALSE POSITIVE.
- The 4 reps ($/SF/yr, $/yr, $/SF/mo, $/mo) MUST all reconcile to the same value. If client RR shows only one of them, translate using SF and compare to the matching Argus axis. Equivalence means the finding is a FALSE POSITIVE.
- Easiest comparison axis: total $/yr or $/SF/yr.
- Compute the translation yourself when needed. Example: Argus $25.00/SF/yr × 12,000 SF = $300,000/yr. If client shows $300,000 annual, that's the SAME value → FALSE POSITIVE on the "base_rent_psf" finding.

═══ Rent Steps (Cols 5-7) ═══
- Source RR may show step amounts in any of: $/yr, $/mo, $/SF/yr, $/SF/mo. TRANSLATE before comparing. If they reconcile, FALSE POSITIVE.
- Date alignment: a client step date may anchor to lease anniversary (e.g. Aug 1) while Argus anchors to a calendar/fiscal date (e.g. Jan 1). >30 days apart → REAL. ≤30 days but clearly the same step → REAL but LOWER severity. Within ±1 day → FALSE POSITIVE.

═══ Free Rent (Col 9) ═══
- Two forms: (a) date + integer months ("May 2026 – 3" = May, June, July free) (b) date + decimal abatement ("May 2026 – 0.5" = 50% abatement that month).
- Source RR may use rent codes. Base rent codes typically start with R, B, or M. EXCLUDE codes: CAM, TAX, INS, SEC, REC — those are NOT base rent.
- If the source doesn't mention free rent at all and Argus shows nothing material, FALSE POSITIVE.

═══ % Rent (Col 10) ═══
- ONLY validate Breakpoint and Overage %. Sometimes "Overage %" is labeled "Percent" or "Percentage" on source.
- IGNORE Sales Volume entirely — that's never on source rolls. Do NOT flag it.
- If source has no % rent data at all, FALSE POSITIVE with reasoning "% rent not reconciled — not on source".

═══ Misc Rent (Col 11) ═══
IGNORE entirely. Any finding here is a FALSE POSITIVE.

═══ All other Argus columns ═══
IGNORE.

═══════════════════════════════════════════════════════════════════════

INPUT (you'll receive JSON):
  - argus: full tenant data
  - client: full tenant data (normalized into Argus shape)
  - findings: list of flagged discrepancies with their values + the reconciler's rule

OUTPUT FORMAT (JSON only, no preamble, no markdown):
{
  "verdicts": [
    {
      "field": "<the field key from the finding>",
      "verdict": "confirmed" | "false_positive",
      "confidence": <number 0..1>,
      "reasoning": "<one or two sentences. SHOW YOUR MATH when translating units.>",
      "argusLocation": "<e.g. 'Col 3 row 0 — $/SF/yr'>",
      "clientLocation": "<e.g. 'Annual Rent column on the BARBERITOS row'>"
    }
  ]
}

Be precise. When you translate units to compare, show the arithmetic in the reasoning. When you suppress a finding, the user must trust your math.`

// Build the user message for one tenant.
function buildPrompt(match) {
  const a = match.argus || {}
  const c = match.client || {}
  const findings = (match.diffs || [])
    .filter(d => !d.suppressed)   // skip already-suppressed (learning loop) findings
    .map(d => ({
      field: d.field,
      label: d.label,
      severity: d.severity,
      argus: d.argusValue,
      client: d.clientValue,
      rule: d.rule,
      // Where the value lives — the reconciler already mapped this
      argusLocation:  d._loc?.argus?.label || null,
      clientHeader:   d._loc?.clientHeader || null,
    }))
  if (!findings.length) return null
  return JSON.stringify({
    suite: match.suite,
    matchedBy: match.matchedBy,
    matchScore: match.matchScore,
    argus: pickFields(a),
    client: pickFields(c),
    findings,
  }, null, 2)
}

function pickFields(t) {
  return {
    name:        t.name ?? null,
    suite:       t.suite ?? null,
    sqft:        t.sqft ?? null,
    leaseStart:  t.leaseStart ?? null,
    leaseEnd:    t.leaseEnd ?? null,
    baseRent:    t.baseRent ?? null,
    rentSteps:   t.rentSteps ?? null,
    freeRent:    t.freeRent ?? null,
    percentRent: t.percentRent ?? null,
    status:      t.status ?? null,
    leaseType:   t.leaseType ?? null,
  }
}

// Verify a single tenant's findings via Claude. Returns a map field → verdict.
async function verifyMatch(match) {
  const prompt = buildPrompt(match)
  if (!prompt) return null
  try {
    const resp = await ai.messages.create({
      model: VERIFIER_MODEL,
      max_tokens: 1500,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: prompt }],
    })
    const text = resp.content?.[0]?.text || ''
    // Strip any stray code fence Claude might wrap the JSON in
    const cleaned = text.replace(/```json\s*|\s*```/g, '').trim()
    const parsed = JSON.parse(cleaned)
    const verdicts = Array.isArray(parsed.verdicts) ? parsed.verdicts : []
    const byField = {}
    for (const v of verdicts) {
      if (v?.field) byField[v.field] = v
    }
    return byField
  } catch (e) {
    console.warn(`[verifier] ${match.suite || match.argus?.name || '(unknown)'}: ${e.message}`)
    return null
  }
}

// Concurrency-limited worker pool. Returns once all items processed.
async function runPool(items, worker) {
  const results = new Array(items.length)
  let idx = 0
  async function next() {
    while (idx < items.length) {
      const i = idx++
      try { results[i] = await worker(items[i], i) }
      catch (e) { results[i] = null }
    }
  }
  await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENT, items.length) }, next))
  return results
}

// ─── Orphan reunification ─────────────────────────────────
// The deterministic matcher leaves leftovers: tenants on Argus with no
// client pair (argusOnly) and tenants on Client with no Argus pair
// (clientOnly). The matcher is per-pair and can't see the cross-roll
// picture; Claude can. We send BOTH lists in one call and ask Claude
// to identify pairs the matcher missed — typically DBA vs legal name,
// suite renumbers, or store-number variants the Levenshtein scoring
// scored below threshold.

const REUNIFY_SYSTEM = `You are a senior real-estate paralegal looking at a rent roll reconciliation.

The deterministic matcher has already paired most Argus tenants with their Client counterparts. You are seeing the leftovers — tenants that did NOT pair on either side.

ARGUS ORPHANS: tenants in Argus with no Client pair.
CLIENT ORPHANS: tenants in Client with no Argus pair.

Your job: identify pairs the matcher missed. Common reasons the matcher missed them:
  - DBA vs legal name ("Joe's Coffee" vs "JBC Holdings LLC dba Joe's Coffee")
  - Store number variation ("Walgreens" vs "WALGREENS #4521", "Dollar General" vs "DOLLAR GENERAL #9621")
  - Suite renumbering after a tenant move
  - Heavily abbreviated names ("CVS Pharmacy" vs "CVS")
  - Punctuation / spelling differences large enough that string distance failed
  - Apostrophes, hyphens, trailing "s" ("Barberito's" vs "BARBERITOS")
  - Apparel/restaurant chains with brand + outlet suffix ("ACADEMY SPORTS + OUTDO" — outdoor)

DO NOT PAIR:
  - Argus tenants whose name contains "(Option ...)" or "(Contract Renewal ...)" — these are NOT separate tenants, they're future-option lines for the same lease. They should remain orphan and get filtered as renewal-option false positives downstream.
  - Two different businesses just because they have similar SF.

To validate a candidate pair, prefer two-signal confirmation:
  - Strong name similarity AND matching SF (±2%)
  - OR strong name similarity AND same suite
  - OR exact suite match with at least plausibly-related names

Return a JSON object — no preamble, no markdown:
{
  "pairs": [
    {
      "argusName": "<exact name from ARGUS ORPHANS>",
      "argusSuite": "<exact suite from ARGUS ORPHANS or null>",
      "clientName": "<exact name from CLIENT ORPHANS>",
      "clientSuite": "<exact suite from CLIENT ORPHANS or null>",
      "confidence": <0..1>,
      "reasoning": "<one sentence — say which signals confirmed>"
    }
  ]
}

If no genuine pairs exist, return { "pairs": [] }.`

function summarizeForReunify(t) {
  return {
    name: t.name ?? null,
    suite: t.suite ?? null,
    sqft: t.sqft ?? null,
    leaseStart: t.leaseStart ?? null,
    leaseEnd: t.leaseEnd ?? null,
    annualRent: t.baseRent?.annualTotal ?? null,
    psf: t.baseRent?.psfAnnual ?? null,
    leaseType: t.leaseType ?? null,
    status: t.status ?? null,
  }
}

// Returns { pairs: [{argus, client, confidence, reasoning}, ...] } where
// argus and client are the actual tenant objects (looked up by name).
export async function reunifyOrphans(argusOnly, clientOnly) {
  if (!argusOnly?.length || !clientOnly?.length) return { pairs: [] }

  const prompt = JSON.stringify({
    argusOrphans: argusOnly.map(summarizeForReunify),
    clientOrphans: clientOnly.map(summarizeForReunify),
  }, null, 2)

  try {
    const resp = await ai.messages.create({
      model: VERIFIER_MODEL,
      max_tokens: 2000,
      system: REUNIFY_SYSTEM,
      messages: [{ role: 'user', content: prompt }],
    })
    const text = (resp.content?.[0]?.text || '').replace(/```json\s*|\s*```/g, '').trim()
    const parsed = JSON.parse(text)
    const rawPairs = Array.isArray(parsed.pairs) ? parsed.pairs : []

    // Resolve names back to actual tenant objects. Match by exact name first,
    // then case-insensitive, then suite-only.
    const findOne = (arr, name, suite) => {
      if (!name && !suite) return null
      const lc = String(name || '').toLowerCase()
      return arr.find(t => t.name === name)
          || arr.find(t => String(t.name || '').toLowerCase() === lc)
          || (suite ? arr.find(t => String(t.suite || '') === String(suite)) : null)
          || null
    }
    const pairs = []
    const usedA = new Set(), usedC = new Set()
    for (const p of rawPairs) {
      const conf = typeof p.confidence === 'number' ? p.confidence : 0
      if (conf < 0.6) continue   // reasonable floor — paralegal still has final say
      const a = findOne(argusOnly, p.argusName, p.argusSuite)
      const c = findOne(clientOnly, p.clientName, p.clientSuite)
      if (!a || !c) continue
      if (usedA.has(a) || usedC.has(c)) continue
      usedA.add(a); usedC.add(c)
      pairs.push({ argus: a, client: c, confidence: conf, reasoning: p.reasoning || '' })
    }
    return { pairs }
  } catch (e) {
    console.warn(`[reunify] failed: ${e.message}`)
    return { pairs: [] }
  }
}

// Public entry — verify every tenant's findings in parallel.
// onProgress(done, total) called after each tenant for SSE updates.
export async function verifyFindings(matches, onProgress) {
  const withFindings = matches
    .map((m, idx) => ({ m, idx }))
    .filter(({ m }) => (m.diffs || []).some(d => !d.suppressed))

  if (!withFindings.length) {
    return { matches, stats: { reviewed: 0, falsePositives: 0, confirmed: 0 } }
  }

  let done = 0
  let falsePositives = 0
  let confirmed = 0

  const verdicts = await runPool(withFindings, async ({ m }) => {
    const result = await verifyMatch(m)
    done++
    if (onProgress) onProgress(done, withFindings.length)
    return result
  })

  // Apply verdicts back onto the matches in place.
  // False positives are REMOVED from m.diffs entirely so the user doesn't
  // see them in the findings list. They're stashed on m.aiRemoved so the
  // Excel report + drawer banner can still expose what was filtered (for
  // transparency and so the user can override if they disagree).
  for (let i = 0; i < withFindings.length; i++) {
    const { idx } = withFindings[i]
    const byField = verdicts[i]
    if (!byField) continue
    const m = matches[idx]
    const keep = []
    const removed = []
    for (const d of (m.diffs || [])) {
      const v = byField[d.field]
      if (!v) { keep.push(d); continue }
      d.aiVerifier = {
        verdict: v.verdict,
        confidence: v.confidence ?? null,
        reasoning: v.reasoning || '',
        argusLocation: v.argusLocation || '',
        clientLocation: v.clientLocation || '',
      }
      if (v.verdict === 'false_positive') {
        // Drop from active findings entirely; archive on the match.
        removed.push({
          field: d.field,
          label: d.label,
          severity: d.severity,
          argusValue: d.argusValue,
          clientValue: d.clientValue,
          rule: d.rule,
          explain: d.explain,
          aiReasoning: v.reasoning || '',
          aiConfidence: v.confidence ?? null,
        })
        falsePositives++
      } else {
        if (v.verdict === 'confirmed') confirmed++
        keep.push(d)
      }
    }
    m.diffs = keep
    if (removed.length) {
      m.aiRemoved = (m.aiRemoved || []).concat(removed)
      // If we just emptied out every diff, set the clean flag so the UI
      // shows the tenant as a green check instead of an empty card.
      if (!keep.length) {
        m.flags = m.flags || {}
        m.flags.clean = true
        m.flags.cleanedByAi = true
      }
    }
  }

  return {
    matches,
    stats: { reviewed: withFindings.length, falsePositives, confirmed },
  }
}
