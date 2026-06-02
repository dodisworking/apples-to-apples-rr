// Excel writer — 3 sheets:
//   1) "Apples to Apples"  — side-by-side reconciliation with ✓/✗ per field + Evidence + Your Review
//   2) "Argus RR"          — Argus tenants as parsed
//   3) "Client RR (as Argus)" — client tenants normalized into Argus shape
//
// Color palette and helpers are intentionally simple — focus is correctness of the data.

import ExcelJS from 'exceljs'

// Palette
const NAVY        = 'FF0F172A'
const WHITE       = 'FFFFFFFF'
const GRAY_BG     = 'FFF8FAFC'
const LIGHT_GRN   = 'FFD1FAE5'
const LIGHT_RED   = 'FFFEE2E2'
const LIGHT_ORG   = 'FFFED7AA'
const MATCH_GRN   = 'FF059669'
const MISS_RED    = 'FFDC2626'
const ARGUS_HDR   = 'FF1E3A5F'    // apple red navy
const CLIENT_HDR  = 'FF14532D'    // pear green
const PIZZA_RED   = 'FFB91C1C'

function cell(ws, r, c, value, opts = {}) {
  const cl = ws.getRow(r).getCell(c)
  cl.value = value
  if (opts.fill) cl.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: opts.fill } }
  cl.font = { name: 'Calibri', size: opts.size || 10, bold: !!opts.bold, color: { argb: opts.color || 'FF111827' } }
  cl.alignment = { vertical: 'middle', horizontal: opts.align || 'left', wrapText: !!opts.wrap }
  cl.border = {
    top:    { style: 'thin', color: { argb: 'FFE5E7EB' } },
    bottom: { style: 'thin', color: { argb: 'FFE5E7EB' } },
    left:   { style: 'thin', color: { argb: 'FFE5E7EB' } },
    right:  { style: 'thin', color: { argb: 'FFE5E7EB' } },
  }
}

const fmtNum   = v => v == null ? '—' : Number(v).toLocaleString('en-US', { maximumFractionDigits: 0 })
const fmtMoney = v => v == null ? '—' : '$' + Number(v).toLocaleString('en-US', { maximumFractionDigits: 0 })
const fmtPsf   = v => v == null ? '—' : '$' + Number(v).toFixed(2) + '/SF'
const fmtSteps = arr => !arr?.length ? '—' : arr.map(s => `${s.effectiveDate || '?'}: ${fmtPsf(s.psfAnnual ?? (s.psfMonthly ? s.psfMonthly * 12 : null))}`).join('\n')
const fmtFreeRent = arr => !arr?.length ? '—' : arr.map(f => `${f.startDate || '?'}: ${f.months != null ? `${f.months} mo` : ((f.abatementPct || 0) * 100).toFixed(0) + '%'}`).join('\n')
const fmtPctRent = pr => !pr ? '—' : `BP: ${fmtMoney(pr.breakpoint)}, Ov: ${pr.overagePct != null ? (pr.overagePct * 100).toFixed(2) + '%' : '—'}`

export async function buildExcel(result) {
  const wb = new ExcelJS.Workbook()
  wb.creator = 'Apples to Apples — Rent Roll Reconciler'
  wb.created = new Date()

  buildReviewReportSheet(wb, result)        // Primary review & learning sheet
  buildA2ASheet(wb, result)
  buildArgusSheet(wb, result.argusTenants || [], result.property)
  buildClientSheet(wb, result.clientTenants || [], result.property)

  return Buffer.from(await wb.xlsx.writeBuffer())
}

// ─── AI Findings & Reviews — the learning-loop sheet ─────────
//
// One row PER FINDING with the AI's full reasoning + the paralegal's review.
// Designed to be:
//   (a) human-readable as an audit log
//   (b) machine-readable for re-ingest into the learnings store
//   (c) shareable back to Claude so it can extract patterns from rejected
//       findings and adjust the rules
function buildReviewReportSheet(wb, data) {
  const ws = wb.addWorksheet('AI Findings & Reviews', {
    tabColor: { argb: '7C3AED' },
    views: [{ state: 'frozen', ySplit: 3 }],
  })

  // Column definitions
  const cols = [
    { h: '#',                 w:  5 },
    { h: 'Status',            w: 14 },   // CONFIRMED / REJECTED / PENDING
    { h: 'Severity',          w: 10 },
    { h: 'Suite',             w: 10 },
    { h: 'Tenant (Argus)',    w: 28 },
    { h: 'Tenant (Client)',   w: 28 },
    { h: 'Field',             w: 22 },
    { h: 'Argus value',       w: 26 },
    { h: 'Client value',      w: 26 },
    { h: 'AI rule fired',     w: 50 },
    { h: 'AI explanation',    w: 70 },
    { h: 'Reviewer verdict',  w: 18 },
    { h: 'Reviewer comment',  w: 50 },
    { h: 'Suggested pattern (fill in to teach the AI)', w: 60 },
  ]
  ws.columns = cols.map(c => ({ width: c.w }))

  // Title
  ws.mergeCells(1, 1, 1, cols.length)
  cell(ws, 1, 1, `AI Findings & Reviews — ${data.property || 'Property'}`, {
    fill: NAVY, color: WHITE, bold: true, size: 13, align: 'center',
  })
  ws.getRow(1).height = 26

  // Instructions row
  ws.mergeCells(2, 1, 2, cols.length)
  cell(ws, 2, 1,
    'One row per AI finding. Fill the "Reviewer verdict" column with CONFIRMED or REJECTED. ' +
    'For REJECTED rows, write WHY in "Reviewer comment" and (optionally) describe the rule the AI should learn in "Suggested pattern". ' +
    'Re-upload via Apples-to-Apples or share this file back so the AI can incorporate the learnings.',
    { fill: GRAY_BG, color: 'FF374151', size: 10, align: 'left', wrap: true }
  )
  ws.getRow(2).height = 36

  // Header row
  cols.forEach((c, i) => cell(ws, 3, i + 1, c.h, {
    fill: NAVY, color: WHITE, bold: true, size: 10, align: 'center',
  }))
  ws.getRow(3).height = 20

  // Data rows — one per finding
  let r = 4
  let findingNum = 0
  for (const m of data.matches || []) {
    const reviewMap = m.review || {}
    // Per-finding shape: { field: { verdict, note }, ... }
    // Legacy shape:     { verdict, note }
    const reviewFor = (field) => {
      if (typeof reviewMap !== 'object') return {}
      const perField = reviewMap[field]
      if (perField && (perField.verdict || perField.note)) return perField
      // Fallback to legacy tenant-level only for tenant_presence
      if (field === 'tenant_presence' && (reviewMap.verdict || reviewMap.note)) {
        return { verdict: reviewMap.verdict, note: reviewMap.note }
      }
      return {}
    }

    // Build the list of findings for this match
    const findings = []
    if (m.flags?.argusOnly) {
      findings.push({
        field: 'tenant_presence',
        label: 'Missing from client RR',
        severity: 'HIGH',
        argusValue: m.argus?.name || '—',
        clientValue: '(not found)',
        rule: 'Tenant present in Argus has no match in client RR (by suite, SF, or name)',
        explain: `The tenant "${m.argus?.name || ''}" at Suite ${m.suite || '?'} appears in the Argus rent roll but Todd could not find a matching tenant in the client rent roll using suite number, square-footage tolerance, or fuzzy name matching. Likely causes: (a) the client RR is from a different period and the tenant moved out / hasn't moved in yet, (b) the client RR uses a completely different naming convention that defeated fuzzy matching, (c) the tenant has been combined or split with another suite on the client side.`,
      })
    } else if (m.flags?.clientOnly) {
      findings.push({
        field: 'tenant_presence',
        label: 'Missing from Argus RR',
        severity: 'HIGH',
        argusValue: '(not found)',
        clientValue: m.client?.name || '—',
        rule: 'Tenant present in client RR has no match in Argus (by suite, SF, or name)',
        explain: `The tenant "${m.client?.name || ''}" at Suite ${m.suite || '?'} appears in the client rent roll but Todd could not find a matching tenant in the Argus rent roll. Likely causes: (a) Argus underwriting hasn't been updated for this lease yet, (b) the client RR has subtenants or storage suites Argus excluded, (c) different naming convention defeated matching. Often these are real issues worth flagging to the deal team.`,
      })
    } else {
      for (const d of (m.diffs || [])) {
        findings.push({
          field: d.field,
          label: d.label || d.field,
          severity: d.severity || 'LOW',
          argusValue: d.argusValue,
          clientValue: d.clientValue,
          rule: d.rule || '',
          explain: d.explain || '',
          suppressed: d.suppressed,
          suppressedReason: d.suppressedReason,
          confirmed: d.confirmed,
        })
      }
    }

    for (const f of findings) {
      findingNum++
      const rev = reviewFor(f.field)
      const status = rev.verdict === 'good' ? 'CONFIRMED'
                   : rev.verdict === 'bad'  ? 'REJECTED'
                   : 'PENDING'
      const statusFill = status === 'CONFIRMED' ? LIGHT_GRN
                       : status === 'REJECTED'  ? LIGHT_RED
                       : LIGHT_ORG
      const statusClr  = status === 'CONFIRMED' ? MATCH_GRN
                       : status === 'REJECTED'  ? MISS_RED
                       : 'FFC2410C'
      const sevFill = f.severity === 'HIGH'   ? LIGHT_RED
                    : f.severity === 'MEDIUM' ? LIGHT_ORG
                    : 'FFFEF9C3'

      const tenantA = m.argus?.name  || ''
      const tenantC = m.client?.name || ''

      const vals = [
        { v: findingNum,                                       align: 'center', bold: true },
        { v: status,           fill: statusFill, color: statusClr, bold: true, align: 'center' },
        { v: f.severity,       fill: sevFill,                  bold: true, align: 'center' },
        { v: m.suite ?? '—',                                   align: 'center' },
        { v: tenantA,          fill: 'FFFEF2F2' },
        { v: tenantC,          fill: 'FFF0FDF4' },
        { v: f.label,                                          bold: true },
        { v: String(f.argusValue ?? ''),  fill: 'FFFEF2F2' },
        { v: String(f.clientValue ?? ''), fill: 'FFF0FDF4' },
        { v: f.rule || '',                                     wrap: true, size: 9 },
        { v: f.explain || '',                                  wrap: true, size: 9 },
        { v: rev.verdict === 'good' ? '👍 CONFIRMED' : rev.verdict === 'bad' ? '👎 REJECTED' : '⏳ NOT REVIEWED',
          fill: rev.verdict === 'good' ? LIGHT_GRN : rev.verdict === 'bad' ? LIGHT_RED : LIGHT_ORG,
          color: rev.verdict === 'good' ? MATCH_GRN : rev.verdict === 'bad' ? MISS_RED : 'FFC2410C',
          bold: true, align: 'center', size: 11 },
        // Reviewer's words — loud when the finding was rejected so the reason is unmissable.
        { v: rev.verdict === 'bad'
              ? (rev.note ? `❌ REJECTED — reviewer says:\n"${rev.note}"` : '❌ REJECTED — ⚠️ no reason given')
              : rev.verdict === 'good'
              ? (rev.note ? `✅ Confirmed. Note: ${rev.note}` : '✅ Confirmed')
              : (rev.note || ''),
          fill: rev.verdict === 'bad' ? LIGHT_RED : rev.verdict === 'good' ? LIGHT_GRN : undefined,
          color: rev.verdict === 'bad' ? MISS_RED : undefined,
          bold: rev.verdict === 'bad', wrap: true },
        { v: '',                                               wrap: true, fill: 'FFFFFBEB' },   // user-fillable
      ]

      vals.forEach((cfg, i) => cell(ws, r, i + 1, cfg.v, {
        fill: cfg.fill, color: cfg.color, bold: cfg.bold,
        align: cfg.align || 'left', wrap: cfg.wrap, size: cfg.size,
      }))

      // Row height grows with the longest wrapped text (rule / explain / reviewer comment)
      const longest = Math.max(
        Math.ceil((f.rule || '').length / 60),
        Math.ceil((f.explain || '').length / 80),
        Math.ceil((rev.note || '').length / 50) + 1,
        1
      )
      ws.getRow(r).height = Math.min(180, Math.max(18, longest * 16))
      r++
    }
  }

  if (findingNum === 0) {
    ws.mergeCells(r, 1, r, cols.length)
    cell(ws, r, 1, 'No findings — every tenant matched cleanly.', { fill: LIGHT_GRN, color: MATCH_GRN, bold: true, align: 'center' })
  }

  ws.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 }
}

// ─── Apples to Apples (main) ────────────────────────────────
function buildA2ASheet(wb, data) {
  const ws = wb.addWorksheet('Apples to Apples', {
    tabColor: { argb: 'B91C1C' },
    views: [{ state: 'frozen', ySplit: 4 }],
  })

  const colWidths = [
    10, 12,                            // 1 suite, 2 matchedBy
    28, 28, 6,                         // 3-5 tenant name
    11, 11, 6,                         // 6-8 SF
    13, 13, 6,                         // 9-11 lease start
    13, 13, 6,                         // 12-14 lease end
    14, 14, 6,                         // 15-17 base rent $/SF/yr
    30, 30, 6,                         // 18-20 rent steps
    20, 20, 6,                         // 21-23 free rent
    22, 22, 6,                         // 24-26 % rent (breakpoint + overage)
    13, 60,                            // 27-28 status + evidence
    14, 40,                            // 29-30 your review + note
  ]
  ws.columns = colWidths.map(w => ({ width: w }))

  // Title
  ws.mergeCells(1, 1, 1, colWidths.length)
  cell(ws, 1, 1, `APPLES TO APPLES — ${data.property || 'Rent Roll'} · Argus vs Client reconciliation`,
    { fill: NAVY, color: WHITE, bold: true, size: 13, align: 'center' })
  ws.getRow(1).height = 28

  // Property totals row
  const t = data.totals || {}
  const totalLine = `Argus total: ${fmtNum(t.argus)} SF  ·  Client total: ${fmtNum(t.client)} SF  ·  Reported: ${fmtNum(t.clientReported)}  ·  Diff: ${t.diff == null ? '—' : (t.diff > 0 ? '+' : '') + fmtNum(t.diff) + ' SF'}`
  ws.mergeCells(2, 1, 2, colWidths.length)
  cell(ws, 2, 1, totalLine, { fill: t.diff && Math.abs(t.diffPct || 0) > 0.001 ? LIGHT_RED : LIGHT_GRN, size: 10, bold: true, align: 'center' })
  ws.getRow(2).height = 20

  // Group header row
  const groupHdr = [
    { col: 1,  span: 2, label: 'IDENTIFIER',   fill: NAVY },
    { col: 3,  span: 3, label: 'TENANT NAME',  fill: ARGUS_HDR },
    { col: 6,  span: 3, label: 'SQUARE FT',    fill: ARGUS_HDR },
    { col: 9,  span: 3, label: 'LEASE START',  fill: ARGUS_HDR },
    { col: 12, span: 3, label: 'LEASE END',    fill: ARGUS_HDR },
    { col: 15, span: 3, label: 'BASE RENT',    fill: ARGUS_HDR },
    { col: 18, span: 3, label: 'RENT STEPS',   fill: ARGUS_HDR },
    { col: 21, span: 3, label: 'FREE RENT',    fill: ARGUS_HDR },
    { col: 24, span: 3, label: '% RENT',       fill: ARGUS_HDR },
    { col: 27, span: 1, label: 'STATUS',       fill: PIZZA_RED },
    { col: 28, span: 1, label: 'EVIDENCE',     fill: PIZZA_RED },
    { col: 29, span: 1, label: 'YOUR REVIEW',  fill: 'FF065F46' },
    { col: 30, span: 1, label: 'YOUR NOTE',    fill: 'FF065F46' },
  ]
  for (const g of groupHdr) {
    if (g.span > 1) ws.mergeCells(3, g.col, 3, g.col + g.span - 1)
    cell(ws, 3, g.col, g.label, { fill: g.fill, color: WHITE, bold: true, size: 9, align: 'center' })
  }
  ws.getRow(3).height = 18

  // Field header row
  const fieldHdr = [
    'Suite', 'Matched By',
    'Argus', 'Client', '✓',
    'Argus SF', 'Client SF', '✓',
    'Argus Start', 'Client Start', '✓',
    'Argus End', 'Client End', '✓',
    'Argus $/SF/yr', 'Client $/SF/yr', '✓',
    'Argus Steps', 'Client Steps', '✓',
    'Argus Free Rent', 'Client Free Rent', '✓',
    'Argus % Rent', 'Client % Rent', '✓',
    'Status', 'Evidence',
    'Review', 'Note',
  ]
  fieldHdr.forEach((h, i) => cell(ws, 4, i + 1, h, { fill: NAVY, color: WHITE, bold: true, size: 9, align: 'center' }))
  ws.getRow(4).height = 18

  // Data rows
  let r = 5
  for (const m of data.matches || []) {
    const a = m.argus, c = m.client
    const diffs = m.diffs || []
    const hasField = k => diffs.some(d => d.field === k || d.field.startsWith(k))
    const ok = k => !hasField(k)
    const tick = v => v ? '✓' : '✗'
    const tickFill = v => v ? LIGHT_GRN : LIGHT_RED
    const tickClr  = v => v ? MATCH_GRN : MISS_RED

    const rowFill = m.flags?.clean ? LIGHT_GRN :
                    (m.flags?.argusOnly || m.flags?.clientOnly) ? LIGHT_ORG : LIGHT_RED

    const status = m.flags?.argusOnly ? 'ARGUS ONLY' :
                   m.flags?.clientOnly ? 'CLIENT ONLY' :
                   m.flags?.clean ? 'MATCH' : 'DIFFERENCES'
    const statusClr = m.flags?.clean ? MATCH_GRN :
                      (m.flags?.argusOnly || m.flags?.clientOnly) ? 'FFC2410C' : MISS_RED

    const aPsf = a?.baseRent?.psfAnnual ?? (a?.baseRent?.annualTotal && a?.sqft ? a.baseRent.annualTotal / a.sqft : null)
    const cPsf = c?.baseRent?.psfAnnual ?? (c?.baseRent?.annualTotal && c?.sqft ? c.baseRent.annualTotal / c.sqft : null)

    const evidence = diffs.length
      ? diffs.map(d => `• ${d.label}: Argus = "${d.argusValue}" · Client = "${d.clientValue}" [${d.severity}]`).join('\n')
      : ''

    const vals = [
      { v: m.suite ?? '—' },
      { v: m.matchedBy ?? '—' },
      { v: a?.name ?? '—' },
      { v: c?.name ?? '—' },
      { v: tick(ok('tenant_name')), fill: tickFill(ok('tenant_name')), color: tickClr(ok('tenant_name')), bold: true, align: 'center' },
      { v: fmtNum(a?.sqft), align: 'right' },
      { v: fmtNum(c?.sqft), align: 'right' },
      { v: tick(ok('sqft')), fill: tickFill(ok('sqft')), color: tickClr(ok('sqft')), bold: true, align: 'center' },
      { v: a?.leaseStart ?? '—', align: 'center' },
      { v: c?.leaseStart ?? '—', align: 'center' },
      { v: tick(ok('lease_start')), fill: tickFill(ok('lease_start')), color: tickClr(ok('lease_start')), bold: true, align: 'center' },
      { v: a?.leaseEnd ?? '—', align: 'center' },
      { v: c?.leaseEnd ?? '—', align: 'center' },
      { v: tick(ok('lease_end')), fill: tickFill(ok('lease_end')), color: tickClr(ok('lease_end')), bold: true, align: 'center' },
      { v: aPsf != null ? '$' + aPsf.toFixed(2) : '—', align: 'right' },
      { v: cPsf != null ? '$' + cPsf.toFixed(2) : '—', align: 'right' },
      { v: tick(ok('base_rent_psf') && ok('base_rent_annual')), fill: tickFill(ok('base_rent_psf') && ok('base_rent_annual')), color: tickClr(ok('base_rent_psf') && ok('base_rent_annual')), bold: true, align: 'center' },
      { v: fmtSteps(a?.rentSteps), wrap: true },
      { v: fmtSteps(c?.rentSteps), wrap: true },
      { v: tick(ok('rent_step') && ok('rent_steps_count')), fill: tickFill(ok('rent_step') && ok('rent_steps_count')), color: tickClr(ok('rent_step') && ok('rent_steps_count')), bold: true, align: 'center' },
      { v: fmtFreeRent(a?.freeRent), wrap: true },
      { v: fmtFreeRent(c?.freeRent), wrap: true },
      { v: tick(ok('free_rent') && ok('free_rent_count')), fill: tickFill(ok('free_rent') && ok('free_rent_count')), color: tickClr(ok('free_rent') && ok('free_rent_count')), bold: true, align: 'center' },
      { v: fmtPctRent(a?.percentRent), wrap: true },
      { v: fmtPctRent(c?.percentRent), wrap: true },
      { v: tick(ok('pct_rent_breakpoint') && ok('pct_rent_overage')), fill: tickFill(ok('pct_rent_breakpoint') && ok('pct_rent_overage')), color: tickClr(ok('pct_rent_breakpoint') && ok('pct_rent_overage')), bold: true, align: 'center' },
      { v: status, bold: true, color: statusClr, align: 'center' },
      { v: evidence, wrap: true },
      // Per-tenant review roll-up — counts per-field verdicts when available
      ...reviewRollupCells(m),
    ]
    vals.forEach((o, i) => cell(ws, r, i + 1, o.v, {
      fill: o.fill || rowFill,
      color: o.color, bold: o.bold,
      align: o.align || 'left', wrap: o.wrap,
    }))

    const evLines = evidence.split('\n').length
    ws.getRow(r).height = Math.min(160, Math.max(20, evLines * 14))
    r++
  }

  if ((data.matches || []).length === 0) {
    ws.mergeCells(r, 1, r, colWidths.length)
    cell(ws, r, 1, '(no tenants reconciled)', { fill: GRAY_BG, color: 'FF6B7280', align: 'center' })
  }

  // Notes at the bottom
  if (data.notes?.length) {
    r++
    ws.mergeCells(r, 1, r, colWidths.length)
    cell(ws, r, 1, '─── NOTES ───', { fill: NAVY, color: WHITE, bold: true, align: 'center' })
    for (const n of data.notes) {
      r++
      ws.mergeCells(r, 1, r, colWidths.length)
      cell(ws, r, 1, '• ' + n, { fill: GRAY_BG, align: 'left' })
    }
  }

  ws.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 }
}

// Per-tenant review roll-up for the main sheet. Returns the two cell configs
// for "Your Review" + "Your Note" columns, handling both per-field shape
// (new) and legacy tenant-level shape.
function reviewRollupCells(m) {
  const r = m.review || {}
  // Per-field: { field1: { verdict, note }, field2: { ... } }
  const entries = Object.entries(r).filter(([, v]) =>
    v && typeof v === 'object' && ('verdict' in v || 'note' in v)
  )
  if (entries.length) {
    const good = entries.filter(([, x]) => x.verdict === 'good').length
    const bad  = entries.filter(([, x]) => x.verdict === 'bad').length
    const notes = entries.filter(([, x]) => x.note).map(([f, x]) => `[${f}] ${x.note}`).join('\n')
    const total = (m.diffs || []).length || entries.length
    const parts = []
    if (good) parts.push(`👍 ${good}`)
    if (bad)  parts.push(`👎 ${bad}`)
    const pending = total - good - bad
    if (pending > 0) parts.push(`• ${pending} pending`)
    return [
      { v: parts.join(' · '),
        fill: good && !bad ? LIGHT_GRN : bad && !good ? LIGHT_RED : undefined,
        bold: true, align: 'center' },
      { v: notes, wrap: true },
    ]
  }
  // Legacy tenant-level
  return [
    { v: r.verdict === 'good' ? '👍 Real' : r.verdict === 'bad' ? '👎 False positive' : '',
      fill: r.verdict === 'good' ? LIGHT_GRN : r.verdict === 'bad' ? LIGHT_RED : undefined,
      color: r.verdict === 'good' ? MATCH_GRN : r.verdict === 'bad' ? MISS_RED : undefined,
      bold: true, align: 'center' },
    { v: r.note || r._tenantNote || '', wrap: true },
  ]
}

// ─── Argus sheet ──────────────────────────────────────────
function buildArgusSheet(wb, tenants, property) {
  buildTenantSheet(wb, 'Argus RR', '1E3A5F', tenants, property, 'Parsed directly from the Argus Lease Summary Report (deterministic).')
}

function buildClientSheet(wb, tenants, property) {
  buildTenantSheet(wb, 'Client RR (as Argus)', '14532D', tenants, property, 'Translated from client RR into the Argus canonical schema.')
}

function buildTenantSheet(wb, title, tabColor, tenants, property, sourceLabel) {
  const ws = wb.addWorksheet(title, { tabColor: { argb: tabColor }, views: [{ state: 'frozen', ySplit: 3 }] })
  const cols = [
    { h: 'Suite', w: 10 },
    { h: 'Tenant Name', w: 32 },
    { h: 'SF', w: 11 },
    { h: 'Lease Start', w: 13 },
    { h: 'Lease End', w: 13 },
    { h: '$/SF/yr', w: 12 },
    { h: 'Annual Rent', w: 14 },
    { h: '$/SF/mo', w: 12 },
    { h: 'Monthly Rent', w: 14 },
    { h: 'Rent Steps', w: 38 },
    { h: 'Free Rent', w: 22 },
    { h: '% Rent', w: 24 },
    { h: 'Option?', w: 9 },
    { h: 'Vacant?', w: 9 },
  ]
  ws.columns = cols.map(c => ({ width: c.w }))

  ws.mergeCells(1, 1, 1, cols.length)
  cell(ws, 1, 1, `${title} — ${property || 'Rent Roll'}`, { fill: NAVY, color: WHITE, bold: true, size: 13, align: 'center' })
  ws.getRow(1).height = 26

  ws.mergeCells(2, 1, 2, cols.length)
  cell(ws, 2, 1, sourceLabel, { fill: GRAY_BG, color: 'FF374151', size: 9, align: 'center' })

  cols.forEach((c, i) => cell(ws, 3, i + 1, c.h, { fill: NAVY, color: WHITE, bold: true, align: 'center' }))
  ws.getRow(3).height = 20

  tenants.forEach((t, idx) => {
    const r = 4 + idx
    const fill = t.isVacant ? 'FFFEF3C7' : (idx % 2 === 0 ? WHITE : GRAY_BG)
    const psfA = t.baseRent?.psfAnnual ?? (t.baseRent?.annualTotal && t.sqft ? t.baseRent.annualTotal / t.sqft : null)
    const psfM = t.baseRent?.psfMonthly ?? (psfA != null ? psfA / 12 : null)
    const aT = t.baseRent?.annualTotal ?? (psfA != null && t.sqft ? psfA * t.sqft : null)
    const mT = t.baseRent?.monthlyTotal ?? (aT != null ? aT / 12 : null)
    const vals = [
      { v: t.suite ?? '—' },
      { v: t.name ?? '—' },
      { v: fmtNum(t.sqft), align: 'right' },
      { v: t.leaseStart ?? '—', align: 'center' },
      { v: t.leaseEnd ?? '—', align: 'center' },
      { v: psfA != null ? '$' + psfA.toFixed(2) : '—', align: 'right' },
      { v: fmtMoney(aT), align: 'right' },
      { v: psfM != null ? '$' + psfM.toFixed(2) : '—', align: 'right' },
      { v: fmtMoney(mT), align: 'right' },
      { v: fmtSteps(t.rentSteps), wrap: true },
      { v: fmtFreeRent(t.freeRent), wrap: true },
      { v: fmtPctRent(t.percentRent), wrap: true },
      { v: t.isOption ? 'Y' : '', align: 'center' },
      { v: t.isVacant ? 'Y' : '', align: 'center' },
    ]
    vals.forEach((o, i) => cell(ws, r, i + 1, o.v, { fill, align: o.align, wrap: o.wrap }))
    const stepLines = (fmtSteps(t.rentSteps).match(/\n/g) || []).length + 1
    ws.getRow(r).height = Math.min(90, Math.max(18, stepLines * 14))
  })

  if (!tenants.length) {
    ws.mergeCells(4, 1, 4, cols.length)
    cell(ws, 4, 1, '(no tenants parsed)', { fill: GRAY_BG, color: 'FF6B7280', align: 'center' })
  }
}
