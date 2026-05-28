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

const SYSTEM_PROMPT = `You are a senior real-estate paralegal QA-checking a rent-roll reconciliation.

You will be given:
  - One tenant's data from Argus (the source-of-truth)
  - The same tenant's data from the client's rent roll (normalized into Argus shape)
  - A list of FINDINGS our deterministic reconciler flagged for this tenant

Your job: decide for EACH finding whether it is a REAL discrepancy or a FALSE POSITIVE.

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

Return a JSON object — no preamble, no markdown fences:

{
  "verdicts": [
    {
      "field": "<the field key from the finding>",
      "verdict": "confirmed" | "false_positive",
      "confidence": <number 0..1>,
      "reasoning": "<one or two sentences a paralegal could read>"
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
  for (let i = 0; i < withFindings.length; i++) {
    const { idx } = withFindings[i]
    const byField = verdicts[i]
    if (!byField) continue
    const m = matches[idx]
    for (const d of (m.diffs || [])) {
      const v = byField[d.field]
      if (!v) continue
      d.aiVerifier = {
        verdict: v.verdict,
        confidence: v.confidence ?? null,
        reasoning: v.reasoning || '',
      }
      if (v.verdict === 'false_positive') {
        d.suppressed = true
        d.suppressedReason = `🤖 AI verifier: ${v.reasoning || 'false positive'}`
        d.severity = 'LOW'
        falsePositives++
      } else if (v.verdict === 'confirmed') {
        confirmed++
      }
    }
  }

  return {
    matches,
    stats: { reviewed: withFindings.length, falsePositives, confirmed },
  }
}
