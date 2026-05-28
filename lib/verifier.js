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

You will be given ONE matched pair (Argus tenant + Client tenant) plus a list of FINDINGS the deterministic reconciler flagged. Your job is to QA each finding so the program reports only REAL discrepancies and tells the user precisely where to look.

For each finding, decide REAL vs FALSE POSITIVE.

A finding is a FALSE POSITIVE when:
  - The Argus and Client values are economically equivalent (e.g. $25.00/SF/yr × 12,000 SF = $300,000 annual; the two sides may show different representations of the same lease)
  - The mismatch is purely a formatting / rounding artifact within reason
  - One side legitimately lacks the data point (e.g. client doesn't itemize rent steps but the totals reconcile) and the other inferred null
  - The Argus shows a "future" value (a step that hasn't kicked in) while client shows current (or vice versa) — and that's expected
  - The dates differ by ≤ 1 day and look like a timezone or month-end vs first-of-next-month convention
  - The client tenant name is the legal name and Argus is the DBA (or vice versa) — both clearly the same business

A finding is REAL (confirmed) when:
  - The numbers genuinely don't reconcile across either side's representation
  - A required date is materially different (>1 day)
  - A rent step or free-rent period is missing on one side
  - The tenant names look like different businesses entirely
  - A field present on one side has no equivalent value on the other (it IS missing)

For REAL findings, also tell the user WHERE to look. The Argus rent roll is structured as a 5-row block per tenant with these column positions:
  Col 0: tenant info (name, suite, dates, term, tenure)
  Col 1: Initial Area (SF), Building Share %
  Col 2: Status / Lease Type
  Col 3: Base Rent (4 reps: $/SF/yr, $/yr, $/SF/mo, $/mo)
  Cols 4-7: Rent steps (date, $/SF-Annual, $/SF-Monthly)
  Cols 8-9: Free rent
  Col 10: % rent breakpoint / overage %

The Client rent roll is a free-form table. Describe the column header you'd expect to find the value under ("Area", "Annual Rent", "Exp. Date", etc.).

Return a JSON object — no preamble, no markdown fences:

{
  "verdicts": [
    {
      "field": "<the field key from the finding>",
      "verdict": "confirmed" | "false_positive",
      "confidence": <number 0..1>,
      "reasoning": "<one or two sentences a paralegal could read>",
      "argusLocation": "<short text describing where in Argus the value lives (e.g. 'Col 4 row 0 — $/SF/yr')>",
      "clientLocation": "<short text describing the client column header to look under (e.g. 'Annual column on the BARBERITOS row')>"
    }
  ]
}

Be conservative — only mark a false positive when you can clearly explain why the two values represent the same thing.`

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
  - Store number variation ("Walgreens" vs "WALGREENS #4521")
  - Suite renumbering after a tenant move
  - Heavily abbreviated names ("CVS Pharmacy" vs "CVS")
  - Punctuation / spelling differences large enough that string distance failed

A pair is only valid if you are confident they refer to the SAME business location. Don't pair two restaurants just because they have similar SF.

Return a JSON object — no preamble, no markdown:
{
  "pairs": [
    {
      "argusName": "<exact name from ARGUS ORPHANS>",
      "argusSuite": "<exact suite from ARGUS ORPHANS or null>",
      "clientName": "<exact name from CLIENT ORPHANS>",
      "clientSuite": "<exact suite from CLIENT ORPHANS or null>",
      "confidence": <0..1>,
      "reasoning": "<one sentence>"
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
