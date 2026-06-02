// Client rent roll → canonical Argus schema (Pear → Apple).
//
// One Claude call. The prompt encodes every rule from the Word doc spec so the
// model produces the *exact same shape* as our Argus parser. After we have
// matching shapes on both sides, reconciliation is pure JS.

import Anthropic from '@anthropic-ai/sdk'
import { normalizeSuite } from './argus.js'

const client = new Anthropic()

const SYSTEM = `You are a senior commercial real estate paralegal. Convert a CLIENT (source) rent roll into the ARGUS canonical schema for apples-to-apples reconciliation.

═══ ARGUS CANONICAL SCHEMA (target) ═══
Each tenant:
{
  "name": "Academy Sports",
  "suite": "820",
  "leaseStart": "8/1/2022",      // M/D/YYYY
  "leaseEnd":   "7/31/2037",
  "sqft": 54408,                  // Initial Area only — NOT building share %
  "baseRent": {
    "psfAnnual":    9.25,         // $/SF/year — PRIMARY
    "annualTotal":  503274,       // $/year
    "psfMonthly":   0.77,         // $/SF/month
    "monthlyTotal": 41940         // $/month
  },                              // All four are equivalent. Fill what you can. Leave others null.
  "rentSteps": [
    { "effectiveDate": "Aug-2027", "psfAnnual": 10.00, "psfMonthly": 0.83, "monthlyTotal": 45340 }
  ],
  "freeRent": [
    { "startDate": "May-2026", "months": 3, "abatementPct": null }
    // OR: { "startDate": "May-2026", "months": null, "abatementPct": 0.5 } for 50% abatement
  ],
  "percentRent": {                // null if client RR doesn't show % rent at all
    "breakpoint":  null,          // dollar amount, e.g. 500000
    "overagePct":  null,          // decimal, e.g. 0.06 for 6%
    "salesVolume": null           // optional, usually null on client RRs
  },
  "isOption": false,              // true if this is a renewal-option block (rents fall outside lease end date)
  "isVacant": false,              // true for vacant suites (often 0 SF or labeled VACANT/VACANT-FLEX)
  "isReabsorbed": false           // rare — only if the source explicitly marks reabsorbed
}

═══ CLIENT RR FORMATS YOU WILL ENCOUNTER ═══

Format A — single-row per tenant (tab/column separated):
  Tenant Name | Suite | SF | Lease Start | Lease End | Rent PSF | Annual Rent
  Trivial — one row per tenant.

Format B — itemized per-charge multi-row (modern accounting systems):
  Each tenant has a base-rent row followed by separate rows for CAM, Tax, Insurance, Management.
  CONSOLIDATE back to one record. Use only the BASE RENT row for annualTotal / monthlyTotal.

Format C — suite-on-its-own-line stacked fields (LEGACY accounting systems — VERY COMMON):
Input snippet:
  003
  MAE JA HAN, 800
  5/1/1992 34,400 4/30/2027 43.00
  5/1/2026 35,432  44.29
   55.32 8,502
  004
  EXEL SHOE REPAIR INC., 500
  4/1/1997 23,695 4/30/2029 47.39
  5/1/2026 24,285  48.57

Rules for Format C:
- A standalone numeric/short-alphanumeric line ("003", "099", "1A") = SUITE NUMBER.
- Next text line = TENANT NAME, often ending ", <SQFT>" — strip the comma.
- Next "M/D/YYYY <num> M/D/YYYY <num>" line = LEASE LINE: start, annualTotal, end, psfAnnual.
- Subsequent "M/D/YYYY <num> <num>" lines = RENT STEPS (date, annualTotal, psfAnnual).
- Trailing "<num> <num>" = Total Rent PSF + Security Deposit — IGNORE.

EXPECTED OUTPUT for the snippet above:
{ "tenants": [
  { "suite": "003", "name": "MAE JA HAN", "sqft": 800, "leaseStart": "5/1/1992", "leaseEnd": "4/30/2027",
    "baseRent": { "psfAnnual": 43.00, "annualTotal": 34400 },
    "rentSteps": [{ "effectiveDate": "5/1/2026", "psfAnnual": 44.29, "annualTotal": 35432 }] },
  { "suite": "004", "name": "EXEL SHOE REPAIR INC.", "sqft": 500, "leaseStart": "4/1/1997", "leaseEnd": "4/30/2029",
    "baseRent": { "psfAnnual": 47.39, "annualTotal": 23695 },
    "rentSteps": [{ "effectiveDate": "5/1/2026", "psfAnnual": 48.57, "annualTotal": 24285 }] }
]}

If you detect Format C, NEVER return an empty tenants array — every standalone suite number IS a tenant.

═══ EXTRACTION RULES (from the spec) ═══

PROPERTY TOTAL SF:
- Often shown at end of client RR ("Totals:") — capture as topLevelTotalSF if present.
- Otherwise leave null; the reconciler will sum tenants.

PER-TENANT (col-by-col Argus rules):

1. TENANT NAME / SUITE / DATES:
   - Look for headers matching "Tenant", "Suite"/"Unit"/"Space", "From"/"Begin"/"Start", "To"/"End"/"Expiration".
   - Do NOT treat per-charge dates (CAM start, tax recovery period) as lease dates.
   - If a tenant appears multiple times with later dates whose rent falls OUTSIDE the main lease expiration,
     that block is a renewal OPTION — emit it but mark isOption:true.

2. SF (Initial Area only, not building share %):
   - Find the SF column. If a tenant is split across charge rows, count the SF once.
   - 0-SF entries like "Antenna" or subtenants → mark them but keep sqft: 0.

3. CURRENT BASE RENT (4 equivalent representations — emit whatever you can confirm):
   - psfAnnual (Rent/SF/yr)
   - annualTotal (Rent/yr or Annual Rent)
   - psfMonthly (Rent/SF/mo)
   - monthlyTotal (Rent/mo or Monthly Rent)
   - These should be internally consistent. If you see contradictions (e.g. $12/SF/yr but $1.50/SF/mo
     which would equal $18/SF/yr), report the values as-given; the reconciler will flag the conflict.
   - $0.02/SF or less differences are rounding — emit precise values you observe.
   - Charge codes: Base Rent codes usually start with R / B / M. EXCLUDE codes like CAM, TAX, INS, SEC, REC,
     OPERATING EXPENSE, MANAGEMENT, INSURANCE, SPRINKLER, CONTAINER, LATE CHARGE.

4. RENT STEPS (effective dates + amounts):
   - Each row under a tenant block with a future date and a rent amount is a step.
   - Capture the date and at least ONE of psfAnnual / psfMonthly / monthlyTotal / annualTotal.
   - Negative numbers (e.g. "(338.80)") are abatements/credits, NOT rent steps.

5. FREE RENT:
   - Client RRs use varied codes — there's no universal name. Per spec:
     • BASE RENT codes typically start with "R", "B", or "M" (e.g. "rent", "base", "min rent", "monthly").
     • EXCLUDE codes for non-rent items: "CAM", "TAX", "INS", "SEC", "REC", "OPEX", "MGMT".
     • Free-rent codes you might see: "rabt", "abate", "free rent", "free", "abatement".
   - Format 1: date + months (e.g. "May 2026 - 3 months" = May/June/July free).
   - Format 2: date + decimal abatement (e.g. "May 2026 - 0.5" = 50% off May).
   - Negative numbers in a parenthesized amount, like "(338.80)", under a base-rent code are credits
     / abatements — treat them as abatement entries, NOT as rent steps.

6. % RENT (BREAKPOINT + OVERAGE %):
   - Only emit percentRent if client RR explicitly shows breakpoint or overage %.
   - "Overage %" may be labeled "Percent", "Percentage", "% Rent", "% of Sales", "Overage Pct".
   - Tenant Sales Volume — IGNORE entirely (do NOT compare).
   - If client doesn't show % rent at all, set percentRent: null (reconciler will produce a single
     note, not per-tenant findings).

OUTPUT (strict JSON, no markdown, no prose):
{
  "property": "string or null",
  "topLevelTotalSF": <number or null>,    // if client RR has an explicit total row
  "tenants": [ ... ]
}

CRITICAL:
- NEVER return an empty tenants array if the file has any tenant-looking content.
- If the format is unusual, identify what you can (suite + name at minimum).
- Skip subtotal rows, header rows, page headers, run-date/report-printed lines.`

function stripFences(t) {
  return String(t || '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim()
}

const NOISE_PATTERNS = [
  /^\s*MONTHLY\s+(CAM|RE\s*TAX|TAX|MGMT|MANAGEMENT|INS|INSURANCE)\b/i,
  /^\s*SEMI\s*ANNUAL\s+(TAX|RE\s*TAX)/i,
  /^\s*ESTIMATED?\s+(CAM|TAX|INSURANCE|MANAGEMENT|MGMT)/i,
  /^\s*EST\s+(CAM|TAX|INS|MGMT|MANAGEMENT)/i,
  /^\s*ANNUAL\s+(CAM|RE\s*TAX|TAX|MGMT)/i,
  /^\s*QUARTERLY\s+(CAM|TAX|MGMT)/i,
  /^\s*LATE\s+CHARGE\b/i,
  /^\s*SPRINKLER\b/i,
  /^\s*CONTAINER\s+(CHARGE|#)/i,
  /^\s*SUFF\s+CNTY\s+WTR/i,
  /^\s*SCWA\b/i,
  /^\s*SIGN\s+(CHARGE|FEE|RENT)/i,
  /^\s*UTILITY\s+(CHARGE|FEE|RECOVERY)/i,
  /^\s*WATER\s+#/i,
  /^\s*GAS\s+#/i,
  /^\s*Page\s+\d+\s+of\s+\d+/i,
  /^\s*Report\s+(Generated|Date|Printed):/i,
  /^\s*Run\s+(Date|Time):/i,
]

function preprocess(text) {
  const lines = text.split('\n')
  const kept = []
  let lastBlank = false
  for (const ln of lines) {
    if (NOISE_PATTERNS.some(re => re.test(ln))) continue
    const blank = !ln.trim()
    if (blank && lastBlank) continue
    kept.push(ln)
    lastBlank = blank
  }
  return kept.join('\n')
}

/**
 * @param {{ parsed: object, filename: string, model?: string }} args
 * @returns {Promise<{ property:string|null, topLevelTotalSF:number|null, tenants:object[] }>}
 */
export async function normalizeClient({ parsed, filename, model = 'claude-sonnet-4-6' }) {
  const raw = parsed?.text || ''
  if (!raw || /^\[SCANNED/i.test(raw)) return { property: null, topLevelTotalSF: null, tenants: [] }

  const text = preprocess(raw)
  const chunks = text.length > 90000 ? splitOnBlanks(text, 90000) : [text]

  const allTenants = []
  let property = null, topLevelTotalSF = null

  for (let i = 0; i < chunks.length; i++) {
    const partLabel = chunks.length > 1 ? ` [part ${i + 1}/${chunks.length}]` : ''
    const out = await callNormalizer({ chunk: chunks[i], partLabel, filename, parsed, model })
    if (!property        && out?.property)        property = out.property
    if (topLevelTotalSF == null && out?.topLevelTotalSF) topLevelTotalSF = out.topLevelTotalSF
    if (Array.isArray(out?.tenants)) allTenants.push(...out.tenants)
  }

  return {
    property,
    topLevelTotalSF,
    tenants: allTenants.map(cleanTenant).filter(t => t.name || t.suite),
  }
}

// ═══ SPECIAL MODE: ensemble standardization ═══════════════════════════════
// The single most error-prone step is turning the messy client RR into the
// Argus schema — and every false discrepancy downstream is really an
// extraction mistake here. Special mode runs the standardization TWICE,
// independently, and only trusts what BOTH passes agree on. Where they
// disagree (per tenant), a single third "tie-breaker" call re-reads the raw
// source for just those disputed tenants and decides the truth. The agreed +
// tie-broken result then flows into the same deterministic reconcile().
//
// Cost: 2 full passes always, + 1 tie-breaker call only when there are
// disagreements (and only the disputed tenants are sent to it — never the
// whole document re-done from scratch).
export async function normalizeClientEnsemble({ parsed, filename, model = 'claude-sonnet-4-6', onStage } = {}) {
  onStage?.('passes')
  // Two independent passes in parallel — separate calls, no shared context.
  const [passA, passB] = await Promise.all([
    normalizeClient({ parsed, filename, model }),
    normalizeClient({ parsed, filename, model }),
  ])
  onStage?.('compare')

  const keyOf = t => t.suiteKey || t.suite || simplifyName(t.name) || ''
  const bByKey = new Map(passB.tenants.map(t => [keyOf(t), t]))
  const usedB = new Set()
  const agreed = []
  const disputes = []

  for (const a of passA.tenants) {
    const k = keyOf(a)
    const b = bByKey.get(k)
    if (b) {
      usedB.add(k)
      if (tenantsAgree(a, b)) agreed.push(a)
      else disputes.push({ key: k, suite: a.suite || b.suite, a, b })
    } else {
      disputes.push({ key: k, suite: a.suite, a, b: null })   // present in A only
    }
  }
  for (const b of passB.tenants) {
    const k = keyOf(b)
    if (!usedB.has(k)) disputes.push({ key: k, suite: b.suite, a: null, b })   // present in B only
  }

  let resolved = []
  if (disputes.length) {
    onStage?.('tiebreak', { count: disputes.length })
    try {
      resolved = await tieBreakDisputes({ parsed, filename, model, disputes })
    } catch (e) {
      console.warn('[ensemble] tie-break failed — falling back to whichever pass found each disputed tenant:', e.message)
      resolved = disputes.map(d => d.a || d.b).filter(Boolean)
    }
  }

  // Assemble: agreed tenants first, then tie-broken ones (resolved overrides by key).
  // Disputed keys the tie-breaker omitted are intentionally dropped (judged noise).
  const finalByKey = new Map()
  for (const t of agreed) finalByKey.set(keyOf(t), t)
  for (const t of resolved) finalByKey.set(keyOf(t), t)

  console.log(`[ensemble] passA=${passA.tenants.length} passB=${passB.tenants.length} agreed=${agreed.length} disputed=${disputes.length} resolved=${resolved.length}`)

  return {
    property: passA.property || passB.property || null,
    topLevelTotalSF: passA.topLevelTotalSF ?? passB.topLevelTotalSF ?? null,
    tenants: [...finalByKey.values()],
    _ensemble: {
      passA: passA.tenants.length, passB: passB.tenants.length,
      agreed: agreed.length, disputed: disputes.length, resolved: resolved.length,
    },
  }
}

// Re-read the raw source for ONLY the disputed tenants and decide the truth.
// One call, given both candidate extractions per disputed suite + the full
// source as ground truth.
async function tieBreakDisputes({ parsed, filename, model, disputes }) {
  const text = preprocess(parsed?.text || '')
  const list = disputes.map((d, i) => ({
    item: i + 1,
    suite: d.suite || null,
    extractionA: d.a,
    extractionB: d.b,
  }))
  const prompt = `Two INDEPENDENT extractions of the SAME client rent roll disagree on the tenants listed below. Using the RAW SOURCE as ground truth, return the CORRECT version of each listed suite.

For each item you get Extraction A and Extraction B (one may be null if only one pass found that tenant). Decide field-by-field which is right, or produce the correct values if BOTH are wrong. Pay special attention to the fields these passes most often get wrong: SF, base rent (and which charge code is base rent vs CAM/TAX/INS), lease dates, and RENT STEPS (effective date + amount, in the same representation Argus uses).

If a listed suite is NOT actually a real tenant in the source (a header, subtotal, or noise line), OMIT it from your output.

Use the EXACT Argus canonical schema from the system prompt. Output strict JSON only:
{ "tenants": [ /* one corrected tenant object per real disputed suite, each including its "suite" */ ] }

===== DISPUTED TENANTS (A vs B) =====
${JSON.stringify(list, null, 2)}

===== RAW CLIENT RENT ROLL (ground truth) =====
${text}

Return JSON only.`

  const resp = await client.messages.create({
    model, max_tokens: 16000, system: SYSTEM,
    messages: [{ role: 'user', content: prompt }],
  })
  const out = parseJsonSafely(stripFences(resp.content[0]?.text || '{}'))
  return Array.isArray(out?.tenants)
    ? out.tenants.map(cleanTenant).filter(t => t.name || t.suite)
    : []
}

// ── Agreement helpers (used to decide which tenants need a tie-breaker) ──
function simplifyName(s) {
  return String(s || '').toLowerCase()
    .replace(/\b(llc|inc|corp|corporation|ltd|co|company|the|of|and)\b/g, '')
    .replace(/[^a-z0-9]/g, '')
}
function nameClose(a, b) {
  const x = simplifyName(a), y = simplifyName(b)
  if (!x || !y) return false
  if (x === y) return true
  const s = x.length < y.length ? x : y, l = x.length < y.length ? y : x
  return s.length >= 4 && l.includes(s)
}
function dnorm(s) { return String(s || '').toLowerCase().replace(/[\s,\/\-]+/g, '') }
function numClose(a, b, tol) {
  if (a == null && b == null) return true
  if (a == null || b == null) return false
  return Math.abs(a - b) <= tol
}
function psfOf(t) {
  const b = t?.baseRent || {}
  if (b.psfAnnual != null) return b.psfAnnual
  if (b.annualTotal != null && t.sqft) return b.annualTotal / t.sqft
  if (b.psfMonthly != null) return b.psfMonthly * 12
  if (b.monthlyTotal != null && t.sqft) return (b.monthlyTotal * 12) / t.sqft
  return null
}
function stepPsf(s, sqft) {
  if (s == null) return null
  if (s.psfAnnual != null) return s.psfAnnual
  if (s.annualTotal != null && sqft) return s.annualTotal / sqft
  if (s.psfMonthly != null) return s.psfMonthly * 12
  if (s.monthlyTotal != null && sqft) return (s.monthlyTotal * 12) / sqft
  return null
}
function stepsAgree(a, b, sqftA, sqftB) {
  const A = (a || []).map(s => ({ d: dnorm(s.effectiveDate), p: stepPsf(s, sqftA) })).sort((x, y) => x.d.localeCompare(y.d))
  const B = (b || []).map(s => ({ d: dnorm(s.effectiveDate), p: stepPsf(s, sqftB) })).sort((x, y) => x.d.localeCompare(y.d))
  if (A.length !== B.length) return false
  for (let i = 0; i < A.length; i++) {
    if (A[i].d !== B[i].d) return false
    if (!numClose(A[i].p, B[i].p, 0.02)) return false
  }
  return true
}
// Two extractions "agree" when the fields that drive findings match within the
// same tolerances reconcile() uses. Anything else → send to the tie-breaker.
function tenantsAgree(a, b) {
  if (!nameClose(a.name, b.name) && simplifyName(a.name) !== simplifyName(b.name)) return false
  if (!numClose(a.sqft, b.sqft, 1)) return false
  if (dnorm(a.leaseStart) !== dnorm(b.leaseStart)) return false
  if (dnorm(a.leaseEnd) !== dnorm(b.leaseEnd)) return false
  if (!numClose(psfOf(a), psfOf(b), 0.02)) return false
  if (!stepsAgree(a.rentSteps, b.rentSteps, a.sqft, b.sqft)) return false
  return true
}

async function callNormalizer({ chunk, partLabel, filename, parsed, model }) {
  const basePrompt = `Convert this CLIENT rent roll into the Argus canonical schema. File: ${filename}${partLabel}.
Format: ${parsed?.type}.

===== RAW CLIENT RENT ROLL${partLabel} =====
${chunk}

Return JSON only.`

  let resp = await client.messages.create({
    model, max_tokens: 16000, system: SYSTEM,
    messages: [{ role: 'user', content: basePrompt }],
  })
  let parsedJson = parseJsonSafely(stripFences(resp.content[0]?.text || '{}'))

  // Retry once with a stronger framing if we got nothing back but the input clearly has tenant content.
  const hasTenantContent = chunk.length > 500 && /\b(suite|tenant|lease|annual|monthly|rent|sf)\b/i.test(chunk)
  if ((!parsedJson || !parsedJson.tenants?.length) && hasTenantContent) {
    console.log('[normalizer] empty response on first pass — retrying with hard constraint')
    const stricter = basePrompt + `

ATTENTION: A previous attempt returned 0 tenants. The text above does contain rent-roll content. Identify EVERY tenant — at minimum capture name and suite if other fields are uncertain. Do not return an empty tenants array. Suite numbers may appear on their own line followed by tenant name on the next line (Format C). Treat numeric-only lines (e.g. "003", "028", "099") as suite numbers when the line below is a tenant name.`
    resp = await client.messages.create({
      model, max_tokens: 16000, system: SYSTEM,
      messages: [{ role: 'user', content: stricter }],
    })
    parsedJson = parseJsonSafely(stripFences(resp.content[0]?.text || '{}'))
  }
  return parsedJson
}

function cleanTenant(t) {
  const suite = t.suite != null ? String(t.suite).trim() : null
  return {
    name: t.name ? String(t.name).trim() : null,
    suite,
    suiteKey: normalizeSuite(suite),
    leaseStart: t.leaseStart || null,
    leaseEnd:   t.leaseEnd   || null,
    sqft: toNum(t.sqft),
    baseRent: {
      psfAnnual:    toNum(t.baseRent?.psfAnnual),
      annualTotal:  toNum(t.baseRent?.annualTotal),
      psfMonthly:   toNum(t.baseRent?.psfMonthly),
      monthlyTotal: toNum(t.baseRent?.monthlyTotal),
    },
    rentSteps: Array.isArray(t.rentSteps) ? t.rentSteps.map(s => ({
      effectiveDate: s.effectiveDate || null,
      psfAnnual:     toNum(s.psfAnnual),
      psfMonthly:    toNum(s.psfMonthly),
      monthlyTotal:  toNum(s.monthlyTotal),
      annualTotal:   toNum(s.annualTotal),
    })) : [],
    freeRent: Array.isArray(t.freeRent) ? t.freeRent.map(f => ({
      startDate:     f.startDate || null,
      months:        f.months != null ? Number(f.months) : null,
      abatementPct:  f.abatementPct != null ? Number(f.abatementPct) : null,
    })) : [],
    percentRent: t.percentRent ? {
      breakpoint:  toNum(t.percentRent.breakpoint),
      overagePct:  toNum(t.percentRent.overagePct),
      salesVolume: t.percentRent.salesVolume || null,
    } : null,
    isOption: !!t.isOption,
    isVacant: !!t.isVacant,
    isReabsorbed: !!t.isReabsorbed,
  }
}

function parseJsonSafely(s) {
  try { return JSON.parse(s) } catch {}
  const m = s.match(/\{[\s\S]*\}/)
  if (m) { try { return JSON.parse(m[0]) } catch {} }
  return null
}

function splitOnBlanks(text, size) {
  const out = []
  let i = 0
  while (i < text.length) {
    const end = Math.min(i + size, text.length)
    if (end === text.length) { out.push(text.slice(i)); break }
    let split = text.lastIndexOf('\n\n', end)
    if (split < i + size * 0.5) split = end
    out.push(text.slice(i, split))
    i = split
  }
  return out
}

function toNum(v) {
  if (v == null || v === '') return null
  if (typeof v === 'number') return isFinite(v) ? v : null
  const n = parseFloat(String(v).replace(/[$,\s]/g, '').replace(/^\((.*)\)$/, '-$1'))
  return isFinite(n) ? n : null
}
