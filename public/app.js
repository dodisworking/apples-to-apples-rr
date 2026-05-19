// Apples to Apples — front-end driver
//
// Flow: upload → detect → process (SSE) → review (side-by-side + drawer + PDF preview)

const $ = (s) => document.querySelector(s)
const state = {
  fileA: null, fileB: null,
  argusFile: null, clientFile: null,
  argusSlot: null, clientSlot: null,
  detection: null,
  result: null,
  excelBase64: null, excelFilename: null,
  mode: 'regular',
  reviews: {},                  // keyed by suiteKey
  currentFilter: 'all',
  currentView: 'as-argus',
  activeIdx: -1,
  abort: null,
}

// ═══ Stage routing ════════════════════════════════════
function showStage(id) {
  document.querySelectorAll('.stage').forEach(s => s.classList.remove('active'))
  $('#' + id).classList.add('active')
  window.scrollTo({ top: 0, behavior: 'smooth' })
}

// ═══ Upload ═══════════════════════════════════════════
function wireDrop(slotId, inputId, nameId, key) {
  const slot = $(slotId), input = $(inputId), name = $(nameId)
  input.addEventListener('change', (e) => handleFile(e.target.files[0], key, slot, name))
  slot.addEventListener('dragover',  (e) => { e.preventDefault(); slot.classList.add('dragover') })
  slot.addEventListener('dragleave', () => slot.classList.remove('dragover'))
  slot.addEventListener('drop', (e) => {
    e.preventDefault()
    slot.classList.remove('dragover')
    const f = e.dataTransfer.files[0]
    if (f) handleFile(f, key, slot, name)
  })
}
function handleFile(file, key, slot, nameEl) {
  if (!file) return
  if (!/\.(pdf|xlsx|xls)$/i.test(file.name)) {
    alert('Only PDF or XLSX please.')
    return
  }
  state[key] = file
  slot.classList.add('filled')
  nameEl.textContent = file.name
  $('#goDetect').disabled = !(state.fileA && state.fileB)
}
wireDrop('#slotA', '#inputA', '#nameA', 'fileA')
wireDrop('#slotB', '#inputB', '#nameB', 'fileB')

// ═══ Continue → goes straight into analysis ══════════
// Trust the slot labels: Apple slot (A) = Argus, Pear slot (B) = Client.
// Auto-detect runs only as a silent sanity check — if a high-confidence mismatch
// is found (e.g. user dropped argus in the pear slot) we show a one-tap swap before
// committing tokens to the analysis.
$('#goDetect').addEventListener('click', async () => {
  const btn = $('#goDetect')
  btn.disabled = true; btn.textContent = 'Sniffing…'

  // Default: trust the slot labels
  state.argusFile  = state.fileA
  state.clientFile = state.fileB

  // Silent sanity check — only block on STRONG disagreement
  try {
    const [a, b] = await Promise.all([toB64(state.fileA), toB64(state.fileB)])
    const resp = await fetch('/api/detect', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fileA: { name: state.fileA.name, base64: a },
        fileB: { name: state.fileB.name, base64: b },
      }),
    })
    if (resp.ok) {
      const data = await resp.json()
      const aScore = data.detection?.A?.score ?? 0
      const bScore = data.detection?.B?.score ?? 0
      // Only intervene if files look CLEARLY swapped — B is much more Argus-y than A
      // (≥ 8-point swing). Otherwise the slot labels win.
      if (bScore - aScore >= 8) {
        const ok = confirm(
          `Heads up — your 🍐 Pears file ("${state.fileB.name}") looks like an Argus rent roll, ` +
          `and your 🍎 Apples file ("${state.fileA.name}") doesn't. Swap them before analyzing?`
        )
        if (ok) { state.argusFile = state.fileB; state.clientFile = state.fileA }
      }
    }
  } catch { /* silent — don't block analysis on detect failure */ }

  btn.disabled = false; btn.textContent = 'Continue →'
  startAnalysis()
})

async function startAnalysis() {
  state.mode = document.querySelector('input[name=mode]:checked')?.value || 'regular'
  showStage('stage-process')
  updateProgress({ stage: 'starting', pct: 3, msg: 'Heating up…' })
  startTimers()
  state.abort = new AbortController()
  try {
    const [argusB64, clientB64] = await Promise.all([toB64(state.argusFile), toB64(state.clientFile)])
    const resp = await fetch('/api/compare', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        argus:  { name: state.argusFile.name,  base64: argusB64  },
        client: { name: state.clientFile.name, base64: clientB64 },
        mode: state.mode,
      }),
      signal: state.abort.signal,
    })
    if (!resp.ok || !resp.body) throw new Error(`HTTP ${resp.status}: ${await resp.text()}`)
    await consumeSSE(resp.body)
  } catch (e) {
    if (e.name !== 'AbortError') {
      alert('Compare failed: ' + e.message)
      showStage('stage-upload')
    }
  } finally {
    stopTimers()
  }
}

function renderConfirm() {
  const d = state.detection
  $('#argusFilename').textContent  = d?.[state.argusSlot]?.filename || '—'
  $('#clientFilename').textContent = d?.[state.clientSlot]?.filename || '—'
  $('#argusHits').innerHTML  = hitsHtml(d?.[state.argusSlot])
  $('#clientHits').innerHTML = hitsHtml(d?.[state.clientSlot])
}
function hitsHtml(x) {
  if (!x) return ''
  const a = (x.argusHits  || []).slice(0, 3).map(h => `✓ ${h.replace(/\\\\/g, '')}`).join('<br>')
  const c = (x.clientHits || []).slice(0, 3).map(h => `○ ${h.replace(/\\\\/g, '')}`).join('<br>')
  return [a, c].filter(Boolean).join('<br>') + `<div style="margin-top:6px;color:#9ca3af">score: ${x.score}</div>`
}

$('#swap').addEventListener('click', () => {
  ;[state.argusSlot, state.clientSlot] = [state.clientSlot, state.argusSlot]
  ;[state.argusFile, state.clientFile] = [state.clientFile, state.argusFile]
  renderConfirm()
})
$('#backToUpload').addEventListener('click', () => showStage('stage-upload'))

// ═══ Process / Compare ════════════════════════════════
let elapsedTimer = null, stallTimer = null, processStart = 0, lastProgress = 0
const STALL_MS = 240000

// (Old goCompare confirm-stage button removed — Continue now starts analysis directly.)
$('#goCompare')?.addEventListener('click', startAnalysis)
$('#cancelProcess').addEventListener('click', () => {
  if (!state.abort) return
  state.abort.abort()
  stopTimers()
  showStage('stage-upload')
})
function startTimers() {
  processStart = lastProgress = Date.now()
  elapsedTimer = setInterval(() => {
    const s = Math.round((Date.now() - processStart) / 1000)
    $('#processElapsed').textContent = `${s}s${s > 120 ? ' · dense files take up to 2 min' : ''}`
  }, 1000)
  stallTimer = setInterval(() => {
    if (Date.now() - lastProgress > STALL_MS) {
      state.abort?.abort()
      stopTimers()
      alert('Stalled — no progress in 4 minutes. Try again.')
      showStage('stage-upload')
    }
  }, 5000)
}
function stopTimers() {
  if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = null }
  if (stallTimer)   { clearInterval(stallTimer);   stallTimer = null }
}

async function consumeSSE(stream) {
  const reader = stream.getReader()
  const dec = new TextDecoder()
  let buf = ''
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    let idx
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const raw = buf.slice(0, idx); buf = buf.slice(idx + 2)
      let ev = 'message', data = ''
      for (const ln of raw.split('\n')) {
        if (ln.startsWith('event:')) ev = ln.slice(6).trim()
        else if (ln.startsWith('data:')) data += ln.slice(5).trim()
      }
      if (!data) continue
      let p
      try { p = JSON.parse(data) } catch { continue }
      if (ev === 'progress') { lastProgress = Date.now(); updateProgress(p) }
      else if (ev === 'complete') { lastProgress = Date.now(); onComplete(p); return }
      else if (ev === 'error') { alert('Kitchen error: ' + p.error); showStage('stage-upload'); return }
    }
  }
}

// Walk the spec's check order: Property Size → Col 1 → Col 4 → Cols 5-7 → Col 9 → Col 10.
const STAGE_TO_HEADLINE = {
  'parsing-argus':   { label: 'PARSING ARGUS (APPLE)', morph: 'stage-1' },
  'parsing-client':  { label: 'READING CLIENT (PEAR)', morph: 'stage-1' },
  'normalizing':     { label: 'PEAR → APPLE',          morph: 'stage-2' },
  'check-totals':    { label: 'CHECK: PROPERTY SIZE',  morph: 'stage-2' },
  'check-suite':     { label: 'CHECK: COL 1 — TENANT / SUITE / DATES', morph: 'stage-3' },
  'check-baserent':  { label: 'CHECK: COL 4 — BASE RENT',  morph: 'stage-3' },
  'check-steps':     { label: 'CHECK: COL 5-7 — RENT STEPS', morph: 'stage-3' },
  'check-freerent':  { label: 'CHECK: COL 9 — FREE RENT',  morph: 'stage-3' },
  'check-pctrent':   { label: 'CHECK: COL 10 — % RENT',    morph: 'stage-3' },
  'reconciling':     { label: 'MATCHING & DIFFING',    morph: 'stage-3' },
  'rendering':       { label: 'PLATING REPORT',        morph: 'stage-done' },
}

function updateProgress({ stage, pct, msg }) {
  const info = STAGE_TO_HEADLINE[stage] || { label: 'WORKING', morph: 'stage-1' }
  $('#processStage').textContent = info.label
  $('#processMessage').textContent = msg || ''
  $('#processFill').style.width = Math.min(100, Math.max(0, pct || 0)) + '%'
  $('#processHeadline').textContent = info.label + '…'
  const morph = $('#morphFruit')
  morph.className = 'big-fruit morph ' + info.morph
}

// ═══ Complete → render review ════════════════════════
function onComplete(payload) {
  state.result = payload.result
  state.excelBase64 = payload.excelBase64
  state.excelFilename = payload.excelFilename
  renderReview()
  showStage('stage-review')
  // Cleanup pdf cache for new run
  pdfCache.clear()
}

function renderReview() {
  const r = state.result, s = r.summary || {}, t = r.totals || {}
  $('#propertyName').textContent = r.property || 'Property'
  $('#propertyMeta').innerHTML =
    `Argus total: <b>${fmtNum(t.argus)}</b> SF · ` +
    `Client total: <b>${fmtNum(t.client)}</b> SF` +
    (t.clientReported ? ` (client reported: <b>${fmtNum(t.clientReported)}</b>)` : '') +
    ` · ${r.argusTenants.length} Argus tenants · ${r.clientTenants.length} client tenants`

  const stats = [
    { n: s.matched   || 0, l: 'Matched' },
    { n: s.clean     || 0, l: 'Clean', cls: 'green' },
    { n: s.withDiffs || 0, l: 'With diffs', cls: (s.withDiffs || 0) ? 'red' : '' },
    { n: s.argusOnly || 0, l: 'Argus only', cls: (s.argusOnly || 0) ? 'orange' : '' },
    { n: s.clientOnly|| 0, l: 'Client only', cls: (s.clientOnly|| 0) ? 'orange' : '' },
    { n: s.highSeverityCount || 0, l: 'HIGH findings', cls: (s.highSeverityCount || 0) ? 'red' : '' },
  ]
  if (s.learningsApplied) {
    stats.push({ n: s.learningsApplied, l: '🧠 Learnings applied', cls: 'green' })
  }
  $('#reviewStats').innerHTML = stats.map(x =>
    `<div class="stat-pill ${x.cls || ''}"><div class="n">${x.n}</div><div class="l">${x.l}</div></div>`
  ).join('')

  // Top notes
  $('#notesBar').innerHTML = (r.notes || []).map(n => `<div class="note-item">${escape(n)}</div>`).join('')

  renderTable()
  renderFindingsSidebar()
  wireToolbar()
}

// ═══ Flat findings queue (every finding across every tenant) ════
//
// Each entry: { matchIdx, fieldKey, label, severity, argusValue, clientValue,
//               tenantLabel, isMissing, suiteKey, verdict }
function buildFindingsList() {
  const out = []
  ;(state.result.matches || []).forEach((m, matchIdx) => {
    const tenantLabel = `Suite ${m.suite || '—'} · ${m.argus?.name || m.client?.name || '(?)'}`
    const suiteKey = m.suiteKey || m.suite
    if (m.flags?.argusOnly) {
      out.push({
        matchIdx, fieldKey: 'tenant_presence',
        label: 'Missing from client RR',
        severity: 'HIGH', isMissing: true,
        argusValue: m.argus?.name || '—', clientValue: '— (not found)',
        tenantLabel, suiteKey,
      })
    } else if (m.flags?.clientOnly) {
      out.push({
        matchIdx, fieldKey: 'tenant_presence',
        label: 'Missing from Argus RR',
        severity: 'HIGH', isMissing: true,
        argusValue: '— (not found)', clientValue: m.client?.name || '—',
        tenantLabel, suiteKey,
      })
    } else {
      for (const d of (m.diffs || [])) {
        out.push({
          matchIdx, fieldKey: d.field,
          label: d.label || d.field,
          severity: d.severity || 'LOW',
          isMissing: false,
          argusValue: d.argusValue, clientValue: d.clientValue,
          tenantLabel, suiteKey,
        })
      }
    }
  })
  return out
}

state.findingsFilter = 'all'
state.findingsQuery = ''

function getFindingsView() {
  const all = buildFindingsList()
  const reviews = state.reviews || {}
  const verdictOf = (f) => {
    const r = reviews[f.suiteKey]
    if (!r || typeof r !== 'object') return null
    if ('verdict' in r && !Object.values(r).some(v => v && typeof v === 'object' && 'verdict' in v)) return r.verdict
    return r[f.fieldKey]?.verdict || null
  }
  const fv = state.findingsFilter
  const q = (state.findingsQuery || '').toLowerCase()
  return all
    .map(f => ({ ...f, verdict: verdictOf(f) }))
    .filter(f => {
      if (fv === 'HIGH' || fv === 'MEDIUM' || fv === 'LOW') {
        if (f.severity !== fv) return false
      } else if (fv === 'missing') {
        if (!f.isMissing) return false
      } else if (fv === 'unreviewed') {
        if (f.verdict) return false
      }
      if (q) {
        const blob = (f.label + ' ' + f.tenantLabel + ' ' + f.argusValue + ' ' + f.clientValue).toLowerCase()
        if (!blob.includes(q)) return false
      }
      return true
    })
}

function renderFindingsSidebar() {
  const list = getFindingsView()
  const all = buildFindingsList()
  const reviewed = all.filter(f => {
    const r = state.reviews?.[f.suiteKey]
    if (!r || typeof r !== 'object') return false
    if ('verdict' in r && !Object.values(r).some(v => v && typeof v === 'object' && 'verdict' in v)) return !!r.verdict
    return !!(r[f.fieldKey]?.verdict)
  }).length

  $('#findingsSidebarMeta').textContent =
    `${list.length} of ${all.length} shown · ${reviewed}/${all.length} reviewed`

  const html = list.map((f, i) => {
    const v = f.verdict
    const verdictBadge = v === 'good' ? '👍' : v === 'bad' ? '👎' : ''
    const cls = [
      'findings-row',
      f.isMissing ? 'missing' : f.severity,
      v ? 'verdict-' + v : '',
      state.activeIdx === f.matchIdx && state.activeFieldKey === f.fieldKey ? 'selected' : '',
    ].join(' ')
    return `
      <div class="${cls}" data-match="${f.matchIdx}" data-field="${escape(f.fieldKey)}">
        <div class="fr-top">
          <span class="fr-sev">${f.severity}</span>
          <span class="fr-label">${escape(f.label)}</span>
          <span class="fr-verdict">${verdictBadge}</span>
        </div>
        <div class="fr-tenant">${escape(f.tenantLabel)}</div>
        <div class="fr-vals">${escape(f.argusValue)} → ${escape(f.clientValue)}</div>
      </div>`
  }).join('')

  $('#findingsSidebarList').innerHTML = html || '<div style="padding:20px;color:#9ca3af;font-size:12px;text-align:center">(no findings match this filter)</div>'

  // Filter chips
  document.querySelectorAll('#findingsFilterChips .chip-sm').forEach(c => {
    c.onclick = () => {
      document.querySelectorAll('#findingsFilterChips .chip-sm').forEach(x => x.classList.remove('active'))
      c.classList.add('active')
      state.findingsFilter = c.dataset.fs
      renderFindingsSidebar()
    }
  })
  $('#findingsSearch').oninput = (e) => {
    state.findingsQuery = e.target.value
    renderFindingsSidebar()
  }

  // Click → open drawer at that tenant, expand that field
  $('#findingsSidebarList').onclick = (e) => {
    const row = e.target.closest('.findings-row[data-match]')
    if (!row) return
    const matchIdx = parseInt(row.dataset.match, 10)
    const fieldKey = row.dataset.field
    state.activeFieldKey = fieldKey
    openDrawer(matchIdx)
    // After openDrawer renders the body, expand the target finding card
    requestAnimationFrame(() => {
      const card = document.querySelector(`.finding-card[data-field="${cssEscape(fieldKey)}"]`)
      if (card) {
        card.classList.add('expanded')
        card.scrollIntoView({ block: 'center', behavior: 'smooth' })
        const grid = document.getElementById('previewGrid')
        if (grid?.hidden) {
          grid.hidden = false
          document.getElementById('togglePreview').textContent = '🫣 Hide sources'
        }
      }
    })
  }
}

function cssEscape(s) {
  return String(s ?? '').replace(/[^a-zA-Z0-9_-]/g, c => '\\' + c)
}

function renderTable() {
  const matches = (state.result.matches || []).filter(passesFilter)

  const header = `
    <div class="sbs-row hdr">
      <div class="cell">Suite</div>
      <div class="cell">Tenant — Argus</div>
      <div class="cell">Tenant — Client</div>
      <div class="cell right">SF — Argus</div>
      <div class="cell right">SF — Client</div>
      <div class="cell">Start — Argus</div>
      <div class="cell">Start — Client</div>
      <div class="cell">End — Argus</div>
      <div class="cell">End — Client</div>
      <div class="cell right">$/SF/yr — Argus</div>
      <div class="cell right">$/SF/yr — Client</div>
      <div class="cell">Steps — Argus</div>
      <div class="cell">Steps — Client</div>
      <div class="cell">Free Rent — Argus</div>
      <div class="cell">Free Rent — Client</div>
      <div class="cell">% Rent — Argus</div>
      <div class="cell">% Rent — Client</div>
      <div class="cell center">Status</div>
    </div>`

  const rows = matches.map((m, idx) => {
    const a = m.argus, c = m.client
    const flagged = new Set((m.diffs || []).map(d => d.field))
    const rowClass = m.flags?.clean ? 'row-clean' :
                     (m.flags?.argusOnly || m.flags?.clientOnly) ? 'row-only' :
                     'row-diffs'
    const status = m.flags?.argusOnly ? 'argusOnly' :
                   m.flags?.clientOnly ? 'clientOnly' :
                   m.flags?.clean ? 'match' : 'diffs'
    const statusLabel = m.flags?.argusOnly ? 'Argus only' :
                        m.flags?.clientOnly ? 'Client only' :
                        m.flags?.clean ? 'Match' : 'Diffs'

    const aPsf = bestPsf(a)
    const cPsf = bestPsf(c)
    const aSteps = fmtStepsShort(a?.rentSteps)
    const cSteps = fmtStepsShort(c?.rentSteps)
    const aFR = fmtFreeRent(a?.freeRent)
    const cFR = fmtFreeRent(c?.freeRent)
    const aPR = fmtPctRent(a?.percentRent)
    const cPR = fmtPctRent(c?.percentRent)

    const cell = (val, opts = {}) => {
      const cls = ['cell', opts.side || '', opts.cls || '', opts.flag ? 'diff' : ''].filter(Boolean).join(' ')
      return `<div class="${cls}">${escape(val ?? '—')}</div>`
    }

    return `
      <div class="sbs-row ${rowClass}" data-idx="${state.result.matches.indexOf(m)}">
        ${cell(m.suite)}
        ${cell(a?.name,   { side: 'apple', flag: flagged.has('tenant_name') })}
        ${cell(c?.name,   { side: 'pear',  flag: flagged.has('tenant_name') })}
        ${cell(fmtNum(a?.sqft), { side: 'apple', cls: 'right', flag: flagged.has('sqft') })}
        ${cell(fmtNum(c?.sqft), { side: 'pear',  cls: 'right', flag: flagged.has('sqft') })}
        ${cell(a?.leaseStart, { side: 'apple', flag: flagged.has('lease_start') })}
        ${cell(c?.leaseStart, { side: 'pear',  flag: flagged.has('lease_start') })}
        ${cell(a?.leaseEnd,   { side: 'apple', flag: flagged.has('lease_end') })}
        ${cell(c?.leaseEnd,   { side: 'pear',  flag: flagged.has('lease_end') })}
        ${cell(aPsf != null ? '$' + aPsf.toFixed(2) : null, { side: 'apple', cls: 'right', flag: flagged.has('base_rent_psf') || flagged.has('base_rent_annual') })}
        ${cell(cPsf != null ? '$' + cPsf.toFixed(2) : null, { side: 'pear',  cls: 'right', flag: flagged.has('base_rent_psf') || flagged.has('base_rent_annual') })}
        ${cell(aSteps, { side: 'apple', cls: 'steps', flag: hasAny(flagged, ['rent_step_date','rent_step_amount','rent_steps_count']) })}
        ${cell(cSteps, { side: 'pear',  cls: 'steps', flag: hasAny(flagged, ['rent_step_date','rent_step_amount','rent_steps_count']) })}
        ${cell(aFR, { side: 'apple', cls: 'free-rent', flag: hasAny(flagged, ['free_rent','free_rent_count']) })}
        ${cell(cFR, { side: 'pear',  cls: 'free-rent', flag: hasAny(flagged, ['free_rent','free_rent_count']) })}
        ${cell(aPR, { side: 'apple', cls: 'pct-rent', flag: hasAny(flagged, ['pct_rent_breakpoint','pct_rent_overage']) })}
        ${cell(cPR, { side: 'pear',  cls: 'pct-rent', flag: hasAny(flagged, ['pct_rent_breakpoint','pct_rent_overage']) })}
        <div class="cell center"><span class="status-pill ${status}">${escape(statusLabel)}</span></div>
      </div>`
  }).join('')

  $('#sbsTable').innerHTML = header + rows
  $('#sbsTable').onclick = (e) => {
    const row = e.target.closest('.sbs-row[data-idx]')
    if (!row) return
    openDrawer(parseInt(row.dataset.idx, 10))
  }
}

function passesFilter(m) {
  switch (state.currentFilter) {
    case 'all':        return true
    case 'diffs':      return !m.flags?.clean && !m.flags?.argusOnly && !m.flags?.clientOnly
    case 'argusOnly':  return !!m.flags?.argusOnly
    case 'clientOnly': return !!m.flags?.clientOnly
    case 'clean':      return !!m.flags?.clean
    default: return true
  }
}

function wireToolbar() {
  document.querySelectorAll('#filterChips .chip').forEach(c => {
    c.onclick = () => {
      document.querySelectorAll('#filterChips .chip').forEach(x => x.classList.remove('active'))
      c.classList.add('active')
      state.currentFilter = c.dataset.filter
      renderTable()
    }
  })
  document.querySelectorAll('input[name=view]').forEach(r => {
    r.onchange = () => {
      state.currentView = document.querySelector('input[name=view]:checked').value
      // The view toggle changes the drawer behavior — re-open if active
      if ($('#drawer').getAttribute('aria-hidden') === 'false') openDrawer(state.activeIdx)
    }
  })
}

// ═══ Drawer ══════════════════════════════════════════
$('#drawerScrim').addEventListener('click', closeDrawer)
$('#drawerClose').addEventListener('click', closeDrawer)
$('#drawerPrev').addEventListener('click', () => nav(-1))
$('#drawerNext').addEventListener('click', () => nav(+1))
document.querySelectorAll('.btn-review').forEach(b => {
  b.addEventListener('click', () => setVerdict(b.dataset.verdict === 'none' ? null : b.dataset.verdict))
})
$('#reviewNote').addEventListener('input', (e) => {
  if (state.activeIdx < 0) return
  const m = state.result.matches[state.activeIdx]
  if (!m) return
  const key = m.suiteKey || m.suite
  const r = state.reviews[key] || {}
  // Legacy tenant-level note (used when tenant is argus/client-only)
  if (typeof r === 'object' && !r.verdict && !r.note && !('_tenantNote' in r)) r._tenantNote = ''
  r._tenantNote = e.target.value
  state.reviews[key] = r
  persistLearnings()
})

// Delegated handlers for finding cards (Google Docs comments style):
//  - clicking the header expands/collapses
//  - clicking 'Show in source' auto-opens the source preview pane below and scrolls there
//  - clicking accept/reject/clear records the verdict per-field
document.getElementById('drawerBody')?.addEventListener('click', (e) => {
  const card = e.target.closest('.finding-card')
  if (!card) return

  // 'Show in source' button
  if (e.target.closest('[data-jump]')) {
    e.stopPropagation()
    const grid = document.getElementById('previewGrid')
    if (grid?.hidden) {
      grid.hidden = false
      document.getElementById('togglePreview').textContent = '🫣 Hide sources'
    }
    document.getElementById('drawerPreview')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    return
  }

  // Verdict buttons
  const btn = e.target.closest('.finding-btn')
  if (btn) {
    e.stopPropagation()
    const field = card.dataset.field
    if (state.activeIdx < 0) return
    const m = state.result.matches[state.activeIdx]
    const key = m.suiteKey || m.suite
    state.reviews[key] = state.reviews[key] || {}
    if ('verdict' in state.reviews[key]) {
      const legacy = state.reviews[key]
      state.reviews[key] = { _tenantNote: legacy.note || '', __legacyVerdict: legacy.verdict }
    }
    const verdict = btn.dataset.verdict === 'none' ? null : btn.dataset.verdict
    state.reviews[key][field] = state.reviews[key][field] || { verdict: null, note: '' }
    state.reviews[key][field].verdict = verdict
    card.querySelectorAll('.finding-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.verdict === verdict)
    })
    card.classList.remove('verdict-good', 'verdict-bad')
    if (verdict) card.classList.add('verdict-' + verdict)
    persistLearnings()
    return
  }

  // Header / value rows toggle expand
  if (e.target.closest('[data-toggle]')) {
    card.classList.toggle('expanded')
    // When opening a finding card, auto-show sources too
    if (card.classList.contains('expanded')) {
      const grid = document.getElementById('previewGrid')
      if (grid?.hidden) {
        grid.hidden = false
        document.getElementById('togglePreview').textContent = '🫣 Hide sources'
      }
    }
  }
})

document.getElementById('drawerBody')?.addEventListener('input', (e) => {
  if (!e.target.classList?.contains('finding-note')) return
  const card = e.target.closest('.finding-card')
  if (!card) return
  const field = card.dataset.field
  if (state.activeIdx < 0) return
  const m = state.result.matches[state.activeIdx]
  const key = m.suiteKey || m.suite
  state.reviews[key] = state.reviews[key] || {}
  state.reviews[key][field] = state.reviews[key][field] || { verdict: null, note: '' }
  state.reviews[key][field].note = e.target.value
  persistLearnings()
})
document.addEventListener('keydown', (e) => {
  if ($('#drawer').getAttribute('aria-hidden') !== 'false') return
  if (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT') return
  if (e.key === 'Escape') closeDrawer()
  else if (e.key === 'j' || e.key === 'ArrowDown') nav(+1)
  else if (e.key === 'k' || e.key === 'ArrowUp')   nav(-1)
  else if (e.key === 'g') setVerdict('good')
  else if (e.key === 'b') setVerdict('bad')
})

function openDrawer(idx) {
  const m = state.result.matches[idx]
  if (!m) return
  state.activeIdx = idx
  const key = m.suiteKey || m.suite
  const review = state.reviews[key] || {}
  const legacyVerdict = (typeof review === 'object' && 'verdict' in review) ? review.verdict : null
  const legacyNote    = (typeof review === 'object' && '_tenantNote' in review) ? review._tenantNote
                     : (typeof review === 'object' && 'note' in review)        ? review.note : ''

  $('#drawerTitle').innerHTML = `Suite <b>${escape(m.suite || '—')}</b> · ${escape(m.argus?.name || m.client?.name || '—')}`
  $('#drawerBody').innerHTML = renderDrawerBody(m)

  // Tenant-level review controls in the drawer foot:
  // Only show when there's no per-finding to attach to (argusOnly/clientOnly or clean match).
  // When there ARE diffs, each finding has its own accept/reject card.
  const hasDiffs = (m.diffs || []).length > 0
  const showTenantLevel = m.flags?.argusOnly || m.flags?.clientOnly || !hasDiffs
  const foot = document.querySelector('.drawer-foot')
  if (foot) {
    const buttons = foot.querySelector('.review-buttons')
    const note    = foot.querySelector('.review-note')
    if (buttons) buttons.style.display = showTenantLevel ? 'flex' : 'none'
    if (note)    note.style.display    = showTenantLevel ? 'block' : 'none'
  }
  document.querySelectorAll('.btn-review').forEach(b => {
    b.classList.toggle('active', b.dataset.verdict === legacyVerdict)
  })
  $('#reviewNote').value = legacyNote || ''

  $('#previewGrid').hidden = true
  $('#togglePreview').textContent = '📄 Show sources'

  $('#drawer').setAttribute('aria-hidden', 'false')
  requestAnimationFrame(() => renderSourcePreviews(m))
}

function closeDrawer() {
  $('#drawer').setAttribute('aria-hidden', 'true')
  renderTable()   // re-render so verdicts/notes are picked up if they affect display later
}

function nav(d) {
  // Walk the FLAT findings list — prev/next jumps to the next finding, not the
  // next tenant. This is what the paralegal asked for: sequential top-to-bottom
  // review of every comment regardless of which tenant it belongs to.
  const list = getFindingsView()
  if (!list.length) return
  let cur = list.findIndex(f => f.matchIdx === state.activeIdx && f.fieldKey === state.activeFieldKey)
  if (cur < 0) cur = list.findIndex(f => f.matchIdx === state.activeIdx)
  if (cur < 0) cur = 0
  const next = (cur + d + list.length) % list.length
  const target = list[next]
  state.activeFieldKey = target.fieldKey
  openDrawer(target.matchIdx)
  requestAnimationFrame(() => {
    const card = document.querySelector(`.finding-card[data-field="${cssEscape(target.fieldKey)}"]`)
    if (card) {
      card.classList.add('expanded')
      card.scrollIntoView({ block: 'center', behavior: 'smooth' })
    }
  })
}

function setVerdict(v) {
  if (state.activeIdx < 0) return
  const m = state.result.matches[state.activeIdx]
  const key = m.suiteKey || m.suite
  const r = state.reviews[key] || { verdict: null, note: '' }
  r.verdict = v
  state.reviews[key] = r
  document.querySelectorAll('.btn-review').forEach(b => b.classList.toggle('active', b.dataset.verdict === v))
  persistLearnings()
}

// Debounced persistence — every time a review changes, save to the server so
// future runs on the same property auto-apply the call.
let _persistTimer = null
function persistLearnings() {
  // Re-render the sidebar immediately so verdict badges update in real time
  if (document.getElementById('findingsSidebarList')) renderFindingsSidebar()
  clearTimeout(_persistTimer)
  _persistTimer = setTimeout(async () => {
    try {
      const property = state.result?.property
      if (!property) return
      const resp = await fetch('/api/learn', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ property, matches: state.result.matches, reviews: state.reviews }),
      })
      const data = await resp.json().catch(() => null)
      if (data?.stats) {
        const h = $('#health')
        if (h) {
          const old = h.textContent
          h.textContent = `🧠 ${data.stats.total} learning(s) saved`
          setTimeout(() => { h.textContent = old }, 1800)
        }
      }
    } catch (e) { /* silent */ }
  }, 600)
}

function renderDrawerBody(m) {
  const a = m.argus, c = m.client
  const diffs = m.diffs || []
  const flagged = new Set(diffs.map(d => d.field))
  const suiteKey = m.suiteKey || m.suite || ''
  const reviews = state.reviews[suiteKey] || {}

  const status =
    m.flags?.argusOnly  ? '<div class="note-item">This tenant is in Argus but <b>not found</b> in the client RR.</div>' :
    m.flags?.clientOnly ? '<div class="note-item">This tenant is in the client RR but <b>not found</b> in Argus.</div>' : ''

  // Each finding gets a Google-Docs-style comment card. Collapsed by default —
  // click the header to expand: shows the full paragraph explanation, auto-opens
  // the source previews, and scrolls into view.
  const diffList = diffs.length ? `
    <div class="findings-list">
      ${diffs.map((d, fi) => {
        const fkey = d.field || ('idx' + fi)
        const fr = (reviews && typeof reviews === 'object' && reviews[fkey]) || {}
        const v = fr.verdict || null
        return `
        <div class="finding-card sev-${d.severity || 'LOW'} ${d.suppressed ? 'suppressed' : ''} ${d.confirmed ? 'confirmed' : ''} ${v ? 'verdict-' + v : ''}"
             data-field="${escape(fkey)}">
          <div class="finding-head" data-toggle="1">
            <span class="finding-sev">${d.severity || 'LOW'}</span>
            <span class="finding-label">${escape(d.label || d.field)}</span>
            ${d.suppressed ? '<span class="badge muted">muted</span>' : ''}
            ${d.confirmed ? '<span class="badge good">confirmed</span>' : ''}
            ${v === 'good' ? '<span class="badge good">\u{1F44D}</span>' : ''}
            ${v === 'bad'  ? '<span class="badge muted">\u{1F44E}</span>' : ''}
            <span class="finding-toggle">▾</span>
          </div>
          <div class="finding-vals" data-toggle="1">
            <div class="fv apple">🍎 <b>${escape(d.argusValue)}</b></div>
            <div class="fv pear">🍐 <b>${escape(d.clientValue)}</b></div>
          </div>
          <div class="finding-body">
            ${d.explain ? `<div class="finding-explain">${escape(d.explain)}</div>` : ''}
            ${d.rule    ? `<div class="finding-rule"><b>Rule fired:</b> ${escape(d.rule)}</div>` : ''}
            ${d.suppressedReason ? `<div class="finding-rule" style="color:#16a34a">🧠 ${escape(d.suppressedReason)}</div>` : ''}
            ${d.confirmedNote    ? `<div class="finding-rule" style="color:#16a34a">🧠 ${escape(d.confirmedNote)}</div>`    : ''}
            <div class="finding-actions">
              <button class="finding-btn good ${v === 'good' ? 'active' : ''}" data-verdict="good"    title="Confirm real discrepancy">👍 Confirm</button>
              <button class="finding-btn bad  ${v === 'bad'  ? 'active' : ''}" data-verdict="bad"     title="Reject as false positive">👎 Reject</button>
              <button class="finding-btn clear"                                  data-verdict="none">↺ Clear</button>
              <button class="finding-btn jump"                                   data-jump="1" title="Show in source">🔍 Show in source</button>
            </div>
            <textarea class="finding-note" placeholder="Note (optional)…">${escape(fr.note || '')}</textarea>
          </div>
        </div>`}).join('')}
    </div>` : '<div style="color:#6b7280;font-size:13px;margin-bottom:14px">No field-level diffs — clean match.</div>'

  const field = (label, v, key) => `
    <div class="field-row ${flagged.has(key) ? 'flagged' : ''}">
      <div class="label">${label}</div>
      <div class="value">${escape(v ?? '—')}</div>
    </div>`

  const sideCard = (who, t) => {
    if (!t) return `<div class="evidence-card ${who}"><div class="side-label">${who === 'apple' ? '🍎 APPLE · ARGUS' : '🍐 PEAR · CLIENT'}</div><div style="color:#9ca3af;font-size:12px">Not present in this rent roll.</div></div>`
    const psf = bestPsf(t)
    const annual = t.baseRent?.annualTotal ?? (psf != null && t.sqft ? psf * t.sqft : null)
    return `
      <div class="evidence-card ${who}">
        <div class="side-label">${who === 'apple' ? '🍎 APPLE · ARGUS' : '🍐 PEAR · CLIENT'}</div>
        ${field('Tenant', t.name, 'tenant_name')}
        ${field('Suite', t.suite, 'suite')}
        ${field('SF', t.sqft != null ? Number(t.sqft).toLocaleString() : null, 'sqft')}
        ${field('Lease Start', t.leaseStart, 'lease_start')}
        ${field('Lease End', t.leaseEnd, 'lease_end')}
        ${field('$/SF/yr', psf != null ? '$' + psf.toFixed(2) : null, 'base_rent_psf')}
        ${field('Annual Rent', annual != null ? '$' + Number(annual).toLocaleString(undefined, { maximumFractionDigits: 0 }) : null, 'base_rent_annual')}
        ${field('Rent Steps', (t.rentSteps || []).length + ' step(s)', 'rent_steps_count')}
        ${field('Free Rent', fmtFreeRent(t.freeRent), 'free_rent')}
        ${field('% Rent', fmtPctRent(t.percentRent), 'pct_rent_breakpoint')}
      </div>`
  }

  return `
    ${status}
    ${diffList}
    <div class="evidence-grid">
      ${sideCard('apple', a)}
      ${sideCard('pear',  c)}
    </div>`
}

// ═══ Full-screen PDF Cross-Reference Reviewer ════════
$('#openPdfReviewer').addEventListener('click', () => openPdfReviewer(0))
$('#pdfReviewerClose').addEventListener('click', () => $('#pdfReviewer').setAttribute('aria-hidden', 'true'))
$('#pdfPrev').addEventListener('click', () => stepReviewer(-1))
$('#pdfNext').addEventListener('click', () => stepReviewer(+1))
$('#pdfMatchSelector').addEventListener('change', (e) => openPdfReviewer(parseInt(e.target.value, 10)))

// Side-focus — click "⛶ Expand" on either side to maximize it; click again to restore 50/50
state.focusSide = null
document.getElementById('pdfReviewerBody')?.addEventListener('click', (e) => {
  const btn = e.target.closest('.side-focus-btn')
  if (!btn) return
  const which = btn.dataset.focus
  const body = document.getElementById('pdfReviewerBody')
  if (state.focusSide === which) {
    state.focusSide = null
    body.classList.remove('focus-apple', 'focus-pear')
    btn.textContent = '⛶ Expand'
  } else {
    state.focusSide = which
    body.classList.remove('focus-apple', 'focus-pear')
    body.classList.add('focus-' + which)
    // Reset all expand buttons, then mark the active one as "Restore"
    document.querySelectorAll('.side-focus-btn').forEach(b => { b.textContent = b.dataset.focus === which ? '✕ Close fullscreen' : '⛶ Expand' })
  }
  // Re-render the visible side(s) so canvas/table picks up the new width.
  if (state.activeIdx >= 0) {
    const m = state.result.matches[state.activeIdx]
    if (state.focusSide !== 'pear')  renderReviewerSide('argus',  $('#pdfRevArgus'),  m, state.result.argusTenants)
    if (state.focusSide !== 'apple') renderReviewerSide('client', $('#pdfRevClient'), m, state.result.clientTenants)
  }
})

// Zoom controls — multiply both PDF and XLSX renders by this factor
state.pdfZoom = 1.0   // 1.0 = fit (PDF default 1.7x baseline; XLSX default 1.0x)
$('#pdfZoomIn')   .addEventListener('click', () => setPdfZoom(Math.min(3.5, state.pdfZoom * 1.25)))
$('#pdfZoomOut')  .addEventListener('click', () => setPdfZoom(Math.max(0.5, state.pdfZoom / 1.25)))
$('#pdfZoomReset').addEventListener('click', () => setPdfZoom(1.0))
function setPdfZoom(z) {
  state.pdfZoom = z
  $('#pdfZoomLabel').textContent = Math.round(z * 100) + '%'
  if (state.activeIdx >= 0) {
    const m = state.result.matches[state.activeIdx]
    renderReviewerSide('argus',  $('#pdfRevArgus'),  m, state.result.argusTenants)
    renderReviewerSide('client', $('#pdfRevClient'), m, state.result.clientTenants)
  }
}

document.addEventListener('keydown', (e) => {
  if ($('#pdfReviewer').getAttribute('aria-hidden') !== 'false') return
  if (e.target.tagName === 'SELECT' || e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return
  if (e.key === 'Escape') $('#pdfReviewer').setAttribute('aria-hidden', 'true')
  else if (e.key === 'j' || e.key === 'ArrowDown' || e.key === 'ArrowRight') stepReviewer(+1)
  else if (e.key === 'k' || e.key === 'ArrowUp'   || e.key === 'ArrowLeft')  stepReviewer(-1)
})

function stepReviewer(delta) {
  const list = reviewerList()
  if (!list.length) return
  let cur = list.findIndex(i => i === state.activeIdx)
  if (cur < 0) cur = 0
  const next = (cur + delta + list.length) % list.length
  openPdfReviewer(list[next])
}

// Which matches show up in the reviewer's selector. Defaults to all non-clean rows.
function reviewerList() {
  return (state.result.matches || [])
    .map((m, i) => ({ m, i }))
    .filter(({ m }) => !m.flags?.clean)   // skip clean matches — nothing to review
    .map(({ i }) => i)
}

// Pear view toggle — "Original" or "As Apple" (Argus template layout)
state.pearView = 'original'
document.addEventListener('change', (e) => {
  if (e.target?.name !== 'pearView') return
  state.pearView = e.target.value
  document.querySelectorAll('.pvt-opt').forEach(l => l.classList.toggle('active', l.querySelector('input')?.checked))
  // Re-render the client side
  if (state.activeIdx >= 0) {
    const m = state.result.matches[state.activeIdx]
    renderReviewerSide('client', document.getElementById('pdfRevClient'), m, state.result.clientTenants)
  }
})

async function openPdfReviewer(idx) {
  const list = reviewerList()
  if (!list.length) { alert('Every tenant matched cleanly — nothing to review.'); return }
  if (!list.includes(idx)) idx = list[0]
  state.activeIdx = idx
  const pos = list.indexOf(idx) + 1
  $('#pdfPosition').textContent = `${pos} / ${list.length}`

  // Populate selector
  const sel = $('#pdfMatchSelector')
  sel.innerHTML = list.map(i => {
    const m = state.result.matches[i]
    const label = `Suite ${m.suite} — ${m.argus?.name || m.client?.name || '(?)'} · ${matchSummary(m)}`
    return `<option value="${i}" ${i === idx ? 'selected' : ''}>${escape(label)}</option>`
  }).join('')

  // Foot: list of diffs
  const m = state.result.matches[idx]
  $('#pdfReviewerFoot').innerHTML = renderReviewerFoot(m)

  $('#pdfReviewer').setAttribute('aria-hidden', 'false')

  // Render both sides
  await Promise.all([
    renderReviewerSide('argus',  $('#pdfRevArgus'),  m, state.result.argusTenants),
    renderReviewerSide('client', $('#pdfRevClient'), m, state.result.clientTenants),
  ])
}

function matchSummary(m) {
  if (m.flags?.argusOnly) return 'ARGUS ONLY'
  if (m.flags?.clientOnly) return 'CLIENT ONLY'
  if (m.flags?.clean) return 'MATCH'
  const high = m.diffs.filter(d => d.severity === 'HIGH').length
  return high ? `${high} HIGH · ${m.diffs.length} diff(s)` : `${m.diffs.length} diff(s)`
}

function renderReviewerFoot(m) {
  if (m.flags?.clean) return `<div class="empty-foot">✓ Every field matches on this tenant.</div>`
  if (m.flags?.argusOnly) return `<div class="empty-foot" style="color:#c2410c">⚠ Tenant <b>${escape(m.argus?.name)}</b> appears in Argus but no match was found in the client RR.</div>`
  if (m.flags?.clientOnly) return `<div class="empty-foot" style="color:#c2410c">⚠ Tenant <b>${escape(m.client?.name)}</b> appears in the client RR but no match was found in Argus.</div>`
  return `<ul class="diff-list">${(m.diffs || []).map(d => `
    <li class="sev-${d.severity}">
      <span class="diff-sev">${d.severity}</span>
      <div class="diff-label">${escape(d.label)}</div>
      <div class="diff-values"><b>🍎 Argus:</b> ${escape(d.argusValue)} · <b>🍐 Client:</b> ${escape(d.clientValue)}</div>
      ${d.rule ? `<div class="diff-rule">${escape(d.rule)}</div>` : ''}
    </li>`).join('')}</ul>`
}

async function renderReviewerSide(side, host, match, tenants) {
  host.innerHTML = '<div style="padding:20px;color:#9ca3af">Loading…</div>'
  const tenant = side === 'argus' ? match.argus : match.client
  if (!tenant) {
    host.innerHTML = `<div style="padding:20px;color:#9ca3af">Tenant not present on this side.</div>`
    return
  }

  // If a specific finding is active, target that finding's value for precise highlight.
  let targetValue = null
  if (state.activeFieldKey && state.activeFieldKey !== 'tenant_presence') {
    const diff = (match.diffs || []).find(d => d.field === state.activeFieldKey)
    if (diff) targetValue = side === 'argus' ? diff.argusValue : diff.clientValue
  }

  // Client "View as Apple" — render the client's normalized tenant in the
  // Argus 5-row template layout for direct visual comparison with the Apple side.
  if (side === 'client' && state.pearView === 'as-apple') {
    host.innerHTML = renderClientAsApple(tenant, match)
    return
  }

  let entry
  try { entry = await loadPdfDoc(side) } catch (e) { entry = null }

  if (entry?.type === 'pdf') {
    const loc = await locateInPdf(entry, tenant, { targetValue })
    if (!loc) {
      host.innerHTML = `<div style="padding:20px;color:#9ca3af">Couldn't locate "${escape(tenant?.name || match.suite || '')}" in this PDF.</div>`
      return
    }
    const page = await entry.pdfDoc.getPage(loc.page)
    // Big-enough default + zoomable
    const scale = 1.9 * (state.pdfZoom || 1.0)
    const vp = page.getViewport({ scale })
    const canvas = document.createElement('canvas')
    canvas.width = vp.width; canvas.height = vp.height
    await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise
    host.innerHTML = ''
    host.style.position = 'relative'
    host.appendChild(canvas)
    const rect = document.createElement('div')
    rect.className = 'hl-rect'
    rect.style.left = (canvas.offsetLeft + loc.rect.x * scale) + 'px'
    rect.style.top  = (canvas.offsetTop  + loc.rect.y * scale) + 'px'
    rect.style.width  = (loc.rect.w * scale) + 'px'
    rect.style.height = (loc.rect.h * scale) + 'px'
    host.appendChild(rect)
    host.scrollTop = Math.max(0, (canvas.offsetTop + loc.rect.y * scale) - 80)
  } else {
    // XLSX side → render the actual sheet as a styled table with tenant rows highlighted.
    // When a specific finding is active, also pinpoint the cell holding its value.
    const sheets = side === 'argus' ? state.result.argusSheets : state.result.clientSheets
    if (sheets?.length) {
      renderXlsxSheet(host, sheets[0], match, side, tenants || [], { targetValue })
    } else {
      host.innerHTML = renderArgusCard(side, tenant, match)
    }
  }
}

// ─── XLSX → styled HTML table renderer (faithful to original Excel) ─
// Uses cell-level styles extracted server-side (fills, fonts, alignment,
// borders, column widths, merged cells, number formats). Looks like
// opening the workbook in Excel.
function renderXlsxSheet(host, sheet, match, side, tenants, opts = {}) {
  const rows = sheet.rows || []
  if (!rows.length) {
    host.innerHTML = '<div style="padding:20px;color:#9ca3af">(empty sheet)</div>'
    return
  }
  const styled = sheet.styled || { colWidths: [], rowHeights: [], merges: [], cells: [] }
  const styledCells = styled.cells || []
  const merges = styled.merges || []
  const targetValue = opts.targetValue || null
  const valueNeedles = targetValue ? buildValueNeedles(targetValue) : []

  // Build a covered map for merged cells (suppresses rendering of cells inside a merge except the top-left)
  const covered = new Set()
  const mergeAt = new Map()    // "r,c" → { rowSpan, colSpan }
  for (const m of merges) {
    mergeAt.set(`${m.top},${m.left}`, { rowSpan: m.bottom - m.top + 1, colSpan: m.right - m.left + 1 })
    for (let r = m.top; r <= m.bottom; r++) {
      for (let c = m.left; c <= m.right; c++) {
        if (r === m.top && c === m.left) continue
        covered.add(`${r},${c}`)
      }
    }
  }

  // Identify the active tenant's row block
  const tenant = side === 'argus' ? match.argus : match.client
  const blockStart = side === 'argus' ? (tenant?._argusBlockRow ?? -1) : findClientBlockRow(rows, tenant)
  const blockEnd = blockStart >= 0 ? blockStart + 5 : -1

  const colCount = Math.max(...rows.map(r => r.length))

  // colgroup for column widths (Excel char-width → pixels approx)
  const zoom = state.pdfZoom || 1.0
  let html = `<div class="xlsx-sheet" style="font-size:${Math.round(11 * zoom)}px"><table class="xlsx-table"><colgroup>`
  html += '<col class="xlsx-col-rownum">'
  for (let c = 0; c < colCount; c++) {
    const w = styled.colWidths?.[c]
    const px = w ? Math.round(w * 7.5 * zoom) : Math.round(80 * zoom)
    html += `<col style="width:${px}px">`
  }
  html += '</colgroup><tbody>'

  rows.forEach((row, rIdx) => {
    const isInBlock = blockStart >= 0 && rIdx >= blockStart && rIdx <= blockEnd
    const rowClass = [
      isInBlock ? 'xlsx-active-block' : '',
      rIdx === blockStart ? 'xlsx-block-start' : '',
      rIdx === blockEnd   ? 'xlsx-block-end'   : '',
    ].filter(Boolean).join(' ')
    const rh = styled.rowHeights?.[rIdx]
    const rowStyle = rh ? ` style="height:${Math.round(rh * 1.3)}px"` : ''
    html += `<tr class="${rowClass}" data-row="${rIdx + 1}"${rowStyle}>`
    html += `<th class="xlsx-rownum">${rIdx + 1}</th>`
    for (let c = 0; c < colCount; c++) {
      if (covered.has(`${rIdx},${c}`)) continue
      const merge = mergeAt.get(`${rIdx},${c}`)
      const styleObj = styledCells[rIdx]?.[c] || {}
      const raw = row[c]
      const text = raw == null || raw === '' ? '' : (typeof raw === 'number' ? fmtCell(raw, styleObj.fmt) : String(raw))
      const css = cellCss(styleObj)
      const mergeAttr = merge ? ` rowspan="${merge.rowSpan}" colspan="${merge.colSpan}"` : ''
      // Pinpoint highlight: if this cell contains the active finding's target value,
      // mark it with a red outline + pulse — the precise red box on the cell.
      let cellHit = ''
      if (valueNeedles.length && isInBlock && raw != null && raw !== '') {
        const cellText = String(raw)
        if (valueNeedles.some(n => cellText.includes(n))) cellHit = ' xlsx-cell-hit'
      }
      html += `<td${mergeAttr} class="${cellHit.trim()}"${css ? ` style="${css}"` : ''}>${escape(text)}</td>`
    }
    html += '</tr>'
  })
  html += '</tbody></table></div>'

  host.innerHTML = html
  host.style.position = 'relative'

  if (blockStart >= 0) {
    // Prefer scrolling the highlighted cell into view if we found one; else the block row
    setTimeout(() => {
      const hit = host.querySelector('.xlsx-cell-hit')
      const target = hit || host.querySelector(`tr[data-row="${blockStart + 1}"]`)
      if (target) target.scrollIntoView({ block: 'center', behavior: 'instant' })
    }, 50)
  }
}

function cellCss(s) {
  if (!s) return ''
  const css = []
  if (s.bg) css.push('background:' + s.bg)
  if (s.f?.c) css.push('color:' + s.f.c)
  if (s.f?.n) css.push('font-family:"' + s.f.n + '",sans-serif')
  if (s.f?.s) css.push('font-size:' + (s.f.s) + 'pt')
  if (s.f?.b) css.push('font-weight:700')
  if (s.f?.i) css.push('font-style:italic')
  if (s.a?.h) css.push('text-align:' + s.a.h)
  if (s.a?.v) css.push('vertical-align:' + s.a.v)
  if (s.brd) {
    if (s.brd.t) css.push('border-top:1px solid #6b7280')
    if (s.brd.b) css.push('border-bottom:1px solid #6b7280')
    if (s.brd.l) css.push('border-left:1px solid #6b7280')
    if (s.brd.r) css.push('border-right:1px solid #6b7280')
  }
  return css.join(';')
}

function findClientBlockRow(rows, tenant) {
  if (!tenant?.suite && !tenant?.name) return -1
  const suiteStr = (tenant.suite || '').toString().replace(/[^a-z0-9]/gi, '').toLowerCase()
  const nameTok = tenant.name ? tenant.name.split(/[\s,]/).find(w => w.length > 3)?.toLowerCase() : null
  for (let i = 0; i < rows.length; i++) {
    const joined = rows[i].map(c => String(c ?? '')).join(' ').toLowerCase()
    if (suiteStr && new RegExp(`(^|[^a-z0-9])${suiteStr}([^a-z0-9]|$)`).test(joined.replace(/[^a-z0-9 ]/gi, ''))) return i
    if (nameTok && joined.includes(nameTok)) return i
  }
  return -1
}

function fmtCell(n, fmt) {
  if (fmt === 'money') return '$' + Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  if (fmt === 'pct')   return (n * 100).toFixed(2) + '%'
  if (Number.isInteger(n)) return n.toLocaleString()
  return Number(n).toLocaleString(undefined, { maximumFractionDigits: 4 })
}

// "View as Apple" — render a client tenant in the Argus 5-row template layout.
// Mirrors the actual Argus rent roll's column-by-column structure so a paralegal
// can visually compare client vs argus in the SAME format.
function renderClientAsApple(t, m) {
  const flagged = new Set((m.diffs || []).map(d => d.field))
  const psf = bestPsf(t)
  const annualTotal  = t.baseRent?.annualTotal  ?? (psf != null && t.sqft ? psf * t.sqft : null)
  const psfMonthly   = t.baseRent?.psfMonthly   ?? (psf != null ? psf / 12 : null)
  const monthlyTotal = t.baseRent?.monthlyTotal ?? (annualTotal != null ? annualTotal / 12 : null)
  const fc = (key) => flagged.has(key) ? 'flagged' : ''

  // Argus's 5-row block by column:
  //   Col 1: Tenant Name / Suite: NNN / lease dates / lease term / tenure
  //   Col 2: SF / Building Share %
  //   Col 3: Status / Contract / Lease Type / category
  //   Col 4: psfAnnual / annualTotal / psfMonthly / monthlyTotal / Rental Value
  //   Cols 5–7: rent steps (date / $/SF/yr / $/SF/mo)
  //   Cols 9-10: free rent
  //   Col 11: % rent
  const steps = t.rentSteps || []
  const freeRent = (t.freeRent || [])
  const pr = t.percentRent

  const stepRows = []
  const stepMax = Math.max(1, steps.length, freeRent.length)
  for (let i = 0; i < stepMax; i++) {
    const s = steps[i] || {}
    const fr = freeRent[i] || {}
    stepRows.push(`
      <tr>
        <td class="apple-c1"></td>
        <td class="apple-c2"></td>
        <td class="apple-c3"></td>
        <td class="apple-c4"></td>
        <td class="apple-c5 ${fc('rent_step_date')}">${escape(s.effectiveDate || '')}</td>
        <td class="apple-c6 ${fc('rent_step_amount')}">${s.psfAnnual != null ? '$' + s.psfAnnual.toFixed(2) : ''}</td>
        <td class="apple-c7 ${fc('rent_step_amount')}">${s.psfMonthly != null ? '$' + s.psfMonthly.toFixed(2) : (s.psfAnnual != null ? '$' + (s.psfAnnual/12).toFixed(2) : '')}</td>
        <td class="apple-c9 ${fc('free_rent')}">${escape(fr.startDate || '')}</td>
        <td class="apple-c10 ${fc('free_rent')}">${fr.months != null ? fr.months + ' mo' : (fr.abatementPct != null ? (fr.abatementPct * 100).toFixed(0) + '%' : '')}</td>
      </tr>`)
  }

  return `
    <div class="apple-template">
      <div class="apple-template-banner">
        🍎 <b>Client viewed as Argus template</b> — same data, Argus layout
      </div>
      <table class="apple-template-table">
        <thead>
          <tr>
            <th>General Tenant Information</th>
            <th>SF / BS%</th>
            <th>Status</th>
            <th>Rent Details</th>
            <th colspan="3">Rent Changes (Col 5–7)</th>
            <th colspan="2">Free Rent (Col 9)</th>
          </tr>
          <tr class="apple-subhead">
            <th></th>
            <th>Initial Area</th>
            <th>Contract</th>
            <th>Rate Per Year</th>
            <th>Date</th><th>$/SF-Annual</th><th>$/SF-Monthly</th>
            <th>Date</th><th>Months / %</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td class="apple-c1 ${fc('tenant_name')}"><b>${escape(t.name || '—')}</b></td>
            <td class="apple-c2 ${fc('sqft')}">${t.sqft != null ? Number(t.sqft).toLocaleString() : ''}</td>
            <td class="apple-c3">Base</td>
            <td class="apple-c4 ${fc('base_rent_psf') || fc('base_rent_annual')}">${psf != null ? '$' + psf.toFixed(2) : '—'}</td>
            <td class="apple-c5"></td><td class="apple-c6"></td><td class="apple-c7"></td>
            <td class="apple-c9"></td><td class="apple-c10"></td>
          </tr>
          <tr>
            <td class="apple-c1">Suite: <b>${escape(t.suite || '—')}</b></td>
            <td></td>
            <td>Contract</td>
            <td class="${fc('base_rent_annual')}">${annualTotal != null ? '$' + Number(annualTotal).toLocaleString(undefined, { maximumFractionDigits: 0 }) : '—'}</td>
            <td></td><td></td><td></td><td></td><td></td>
          </tr>
          <tr>
            <td class="apple-c1 ${fc('lease_start') || fc('lease_end')}">${escape((t.leaseStart || '—') + ' – ' + (t.leaseEnd || '—'))}</td>
            <td></td>
            <td>—</td>
            <td>${psfMonthly != null ? '$' + psfMonthly.toFixed(2) : '—'}</td>
            <td></td><td></td><td></td><td></td><td></td>
          </tr>
          <tr>
            <td class="apple-c1">—</td>
            <td></td>
            <td>—</td>
            <td>${monthlyTotal != null ? '$' + Number(monthlyTotal).toLocaleString(undefined, { maximumFractionDigits: 0 }) : '—'}</td>
            <td></td><td></td><td></td><td></td><td></td>
          </tr>
          <tr>
            <td class="apple-c1">Freehold</td>
            <td></td>
            <td></td>
            <td>${annualTotal != null ? '$' + Number(annualTotal).toLocaleString(undefined, { maximumFractionDigits: 0 }) : '—'}</td>
            <td></td><td></td><td></td><td></td><td></td>
          </tr>
          ${stepRows.join('')}
          ${pr ? `<tr>
            <td colspan="3"><b>% Rent</b></td>
            <td class="${fc('pct_rent_breakpoint')}" colspan="2">BP: ${pr.breakpoint != null ? '$' + Number(pr.breakpoint).toLocaleString() : '—'}</td>
            <td class="${fc('pct_rent_overage')}" colspan="2">Ov: ${pr.overagePct != null ? (pr.overagePct * 100).toFixed(2) + '%' : '—'}</td>
            <td></td><td></td>
          </tr>` : ''}
        </tbody>
      </table>
    </div>`
}

function renderArgusCard(side, t, m) {
  const flagged = new Set((m.diffs || []).map(d => d.field))
  const psf = bestPsf(t)
  const annual = t.baseRent?.annualTotal ?? (psf != null && t.sqft ? psf * t.sqft : null)
  const monthly = t.baseRent?.monthlyTotal ?? (annual != null ? annual / 12 : null)
  const row = (k, v, key) => `
    <div class="arow ${flagged.has(key) ? 'flagged' : ''}">
      <div class="k">${escape(k)}</div>
      <div class="v">${escape(v ?? '—')}</div>
    </div>`
  return `
    <div class="argus-card">
      <h3>${side === 'argus' ? '🍎' : '🍐'} ${escape(t.name || '—')}</h3>
      ${row('Suite', t.suite, 'suite')}
      ${row('SF', t.sqft != null ? Number(t.sqft).toLocaleString() : null, 'sqft')}
      ${row('Lease Start', t.leaseStart, 'lease_start')}
      ${row('Lease End', t.leaseEnd, 'lease_end')}
      ${row('$/SF/yr', psf != null ? '$' + psf.toFixed(2) : null, 'base_rent_psf')}
      ${row('Annual Rent', annual != null ? '$' + annual.toLocaleString(undefined, { maximumFractionDigits: 0 }) : null, 'base_rent_annual')}
      ${row('$/SF/mo', psf != null ? '$' + (psf / 12).toFixed(2) : null, 'base_rent_psf')}
      ${row('Monthly Rent', monthly != null ? '$' + monthly.toLocaleString(undefined, { maximumFractionDigits: 0 }) : null, 'base_rent_annual')}
      ${row('Rent Steps', (t.rentSteps || []).length + ' step(s): ' + fmtStepsShort(t.rentSteps).replace(/\n/g, '  ·  '), 'rent_steps_count')}
      ${row('Free Rent', fmtFreeRent(t.freeRent), 'free_rent')}
      ${row('% Rent', fmtPctRent(t.percentRent), 'pct_rent_breakpoint')}
    </div>`
}

// ═══ Source preview (PDF render + red rectangle) ═════
const pdfCache = new Map()

$('#togglePreview').addEventListener('click', () => {
  const grid = $('#previewGrid')
  grid.hidden = !grid.hidden
  $('#togglePreview').textContent = grid.hidden ? '📄 Show sources' : '🫣 Hide sources'
})

async function loadPdfDoc(side) {
  if (pdfCache.has(side)) return pdfCache.get(side)
  if (typeof window.pdfjsLib === 'undefined') return null

  const file = side === 'argus' ? state.argusFile : state.clientFile
  if (!file) return null
  const isPdf = /\.pdf$/i.test(file.name)
  if (!isPdf) { pdfCache.set(side, { type: 'xlsx', file }); return pdfCache.get(side) }
  const buf = await file.arrayBuffer()
  const pdfDoc = await window.pdfjsLib.getDocument({ data: buf }).promise
  const entry = { type: 'pdf', pdfDoc, index: new Map() }
  pdfCache.set(side, entry)
  return entry
}

// Locate a tenant + (optionally) a specific field value in the PDF.
//
// Two-phase search:
//  1. Find the TENANT'S row vertically (page + y-band) using suite # or name tokens.
//  2. If a target value is provided (e.g. the client value of the active finding),
//     search WITHIN that y-band ± 30pt for the value text and return a tight box
//     around it. Otherwise return the row-level box.
//
// This makes the red rectangle point at the exact cell that caused the discrepancy,
// not just the whole tenant row.
async function locateInPdf(entry, tenant, opts = {}) {
  if (entry.type !== 'pdf' || !tenant) return null
  const targetValue = opts.targetValue || null

  const suiteStr = tenant.suite ? String(tenant.suite).replace(/[^a-z0-9]/gi, '') : ''
  const suiteRe = suiteStr ? new RegExp(`(^|\\s|#)0*${escapeRe(suiteStr)}\\b`, 'i') : null

  const nameCandidates = []
  if (tenant.name) {
    const norm = tenant.name.replace(/[,&]/g, ' ').replace(/\s+/g, ' ').trim()
    const tokens = norm.split(' ').filter(w => w.length > 2)
    if (tokens.length >= 2) nameCandidates.push(tokens.slice(0, 2).join(' '))
    for (const t of tokens) if (t.length > 3 && !nameCandidates.includes(t)) nameCandidates.push(t)
  }

  const pdfDoc = entry.pdfDoc
  for (let p = 1; p <= pdfDoc.numPages; p++) {
    const page = await pdfDoc.getPage(p)
    const viewport = page.getViewport({ scale: 1.0 })
    const tc = await page.getTextContent()

    // Phase 1: find the tenant's anchor item (first item that matches suite or name).
    let anchor = null
    const matchesAnchor = (s) => {
      if (suiteRe && suiteRe.test(s)) return true
      return nameCandidates.some(c => new RegExp(escapeRe(c).replace(/\s+/g, '\\s*'), 'i').test(s))
    }
    for (const item of tc.items) {
      if (matchesAnchor(item.str)) {
        const tr = window.pdfjsLib.Util.transform(viewport.transform, item.transform)
        anchor = { x: tr[4], y: tr[5] - item.height, w: item.width, h: item.height }
        break
      }
    }
    if (!anchor) continue

    // Phase 2: if we have a target value, search within ±60pt vertical band of the anchor.
    if (targetValue) {
      const valueNeedles = buildValueNeedles(targetValue)
      const band = { yMin: anchor.y - 30, yMax: anchor.y + anchor.h + 30 }
      const valueHits = []
      for (const item of tc.items) {
        const tr = window.pdfjsLib.Util.transform(viewport.transform, item.transform)
        const top = tr[5] - item.height
        if (top < band.yMin || top > band.yMax) continue
        const s = item.str
        if (valueNeedles.some(n => s.includes(n))) {
          valueHits.push({ x: tr[4], y: top, w: item.width, h: item.height })
        }
      }
      if (valueHits.length) {
        const box = union(valueHits)
        box.x -= 4; box.y -= 3; box.w += 8; box.h += 6
        return { page: p, rect: box, precision: 'value' }
      }
    }

    // Fall back: tenant row-level box (wide horizontal sweep)
    const box = {
      x: Math.max(0, anchor.x - 8),
      y: anchor.y - 4,
      w: Math.min(viewport.width - Math.max(0, anchor.x - 8), anchor.w + viewport.width * 0.7),
      h: anchor.h + 8,
    }
    return { page: p, rect: box, precision: 'row' }
  }
  return null
}

// Build a list of substrings to search for given a finding's value string.
// Handles things like "$503,274" → ["503,274", "503274", "503274.00"], etc.
function buildValueNeedles(v) {
  if (v == null || v === '' || v === '—') return []
  const s = String(v).trim()
  const out = new Set([s])
  // Strip $ and currency formatting
  const stripped = s.replace(/[$,]/g, '').replace(/\s+/g, '')
  if (stripped) out.add(stripped)
  // Remove "/SF/yr", "/SF/mo", "/yr", "/mo" suffixes
  const noUnit = stripped.replace(/\/?(SF\/yr|SF\/mo|yr|mo|sf|psf|annual|monthly)$/i, '')
  if (noUnit && noUnit !== stripped) out.add(noUnit)
  // Number without decimal (e.g. "503274" from "503,274.00")
  const num = parseFloat(stripped)
  if (isFinite(num)) {
    out.add(String(Math.round(num)))
    out.add(num.toFixed(2))
    out.add(num.toLocaleString('en-US'))
    out.add(num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }))
  }
  return Array.from(out).filter(x => x && x.length >= 2)
}

function union(boxes) {
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity
  for (const b of boxes) {
    x1 = Math.min(x1, b.x); y1 = Math.min(y1, b.y)
    x2 = Math.max(x2, b.x + b.w); y2 = Math.max(y2, b.y + b.h)
  }
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 }
}
function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }

async function renderSourcePreviews(m) {
  await Promise.all([
    renderSide('argus',  $('#previewArgus'),  m, state.result.argusTenants),
    renderSide('client', $('#previewClient'), m, state.result.clientTenants),
  ])
}

async function renderSide(side, host, match, tenants) {
  host.innerHTML = '<div class="preview-placeholder">Loading…</div>'
  const tenant = side === 'argus' ? match.argus : match.client
  if (!tenant && ((side === 'argus' && match.flags?.clientOnly) || (side === 'client' && match.flags?.argusOnly))) {
    host.innerHTML = '<div class="preview-placeholder">Not present on this side.</div>'
    return
  }
  // Field-level target so red box hits the SPECIFIC value, not just the row
  let targetValue = null
  if (state.activeFieldKey && state.activeFieldKey !== 'tenant_presence') {
    const diff = (match.diffs || []).find(d => d.field === state.activeFieldKey)
    if (diff) targetValue = side === 'argus' ? diff.argusValue : diff.clientValue
  }

  let entry
  try { entry = await loadPdfDoc(side) } catch (e) { entry = null }
  if (!entry) { host.innerHTML = '<div class="preview-placeholder">Source not loaded — re-upload to see preview.</div>'; return }
  if (entry.type === 'xlsx') return renderXlsxRow(host, tenant, match)

  const loc = await locateInPdf(entry, tenant, { targetValue })
  if (!loc) { host.innerHTML = `<div class="preview-placeholder">Couldn't locate "${escape(tenant?.name || match.suite || '')}" in this PDF.</div>`; return }

  const page = await entry.pdfDoc.getPage(loc.page)
  const scale = 1.3
  const vp = page.getViewport({ scale })
  const canvas = document.createElement('canvas')
  canvas.width = vp.width; canvas.height = vp.height
  await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise
  host.innerHTML = ''
  host.style.position = 'relative'
  host.appendChild(canvas)

  const rect = document.createElement('div')
  rect.className = 'hl-rect'
  rect.style.left   = (canvas.offsetLeft + loc.rect.x * scale) + 'px'
  rect.style.top    = (canvas.offsetTop  + loc.rect.y * scale) + 'px'
  rect.style.width  = (loc.rect.w * scale) + 'px'
  rect.style.height = (loc.rect.h * scale) + 'px'
  host.appendChild(rect)
  host.scrollTop = Math.max(0, (canvas.offsetTop + loc.rect.y * scale) - 40)
}

function renderXlsxRow(host, tenant, match) {
  if (!tenant) { host.innerHTML = '<div class="preview-placeholder">Not present.</div>'; return }
  const flagged = new Set((match.diffs || []).map(d => d.field))
  const psf = bestPsf(tenant)
  const ann = tenant.baseRent?.annualTotal ?? (psf != null && tenant.sqft ? psf * tenant.sqft : null)
  const rows = [
    ['Suite', tenant.suite, 'suite'],
    ['Tenant', tenant.name, 'tenant_name'],
    ['SF', tenant.sqft != null ? Number(tenant.sqft).toLocaleString() : '—', 'sqft'],
    ['Lease Start', tenant.leaseStart, 'lease_start'],
    ['Lease End', tenant.leaseEnd, 'lease_end'],
    ['$/SF/yr', psf != null ? '$' + psf.toFixed(2) : '—', 'base_rent_psf'],
    ['Annual Rent', ann != null ? '$' + ann.toLocaleString(undefined,{maximumFractionDigits:0}) : '—', 'base_rent_annual'],
  ]
  host.innerHTML = `
    <div class="preview-xlsx-row">
      <table>
        ${rows.map(([k, v, key]) => `<tr class="${flagged.has(key) ? 'flagged' : ''}"><th>${escape(k)}</th><td>${escape(v ?? '—')}</td></tr>`).join('')}
      </table>
    </div>
    <div class="preview-placeholder" style="margin:0">XLSX source — values shown in place of a page render.</div>`
}

// ═══ Download Excel ══════════════════════════════════
$('#downloadXlsx').addEventListener('click', async () => {
  const btn = $('#downloadXlsx')
  const original = btn.textContent
  const hasReviews = Object.values(state.reviews || {}).some(r => r?.verdict || r?.note)
  try {
    if (hasReviews) {
      btn.disabled = true; btn.textContent = '📝 Embedding your reviews…'
      const resp = await fetch('/api/export', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ payload: state.result, reviews: state.reviews }),
      })
      if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${await resp.text()}`)
      const data = await resp.json()
      saveXlsx(data.excelBase64, data.excelFilename || state.excelFilename)
    } else {
      saveXlsx(state.excelBase64, state.excelFilename)
    }
  } catch (e) {
    alert('Download failed: ' + e.message)
  } finally {
    btn.disabled = false; btn.textContent = original
  }
})
function saveXlsx(b64, name) {
  const blob = b64ToBlob(b64, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = name || 'rent-roll.xlsx'
  document.body.appendChild(a); a.click(); a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}

$('#restart').addEventListener('click', () => {
  state.fileA = state.fileB = state.argusFile = state.clientFile = null
  state.argusSlot = state.clientSlot = state.detection = null
  state.result = state.excelBase64 = null
  state.reviews = {}
  $('#slotA').classList.remove('filled'); $('#slotB').classList.remove('filled')
  $('#nameA').textContent = ''; $('#nameB').textContent = ''
  $('#inputA').value = '';      $('#inputB').value = ''
  $('#goDetect').disabled = true
  pdfCache.clear()
  showStage('stage-upload')
})

// ═══ Helpers ═════════════════════════════════════════
function toB64(file) {
  return new Promise((res, rej) => {
    const r = new FileReader()
    r.onload  = () => res(String(r.result).split(',')[1])
    r.onerror = rej
    r.readAsDataURL(file)
  })
}
function b64ToBlob(b64, mime) {
  const bin = atob(b64); const len = bin.length; const bytes = new Uint8Array(len)
  for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i)
  return new Blob([bytes], { type: mime })
}
function escape(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]) }
function fmtNum(n) { return n == null ? '—' : Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 }) }
function bestPsf(t) {
  if (!t) return null
  const br = t.baseRent || {}
  if (br.psfAnnual != null && br.psfAnnual > 0) return br.psfAnnual
  if (br.annualTotal != null && t.sqft)         return br.annualTotal / t.sqft
  if (br.psfMonthly  != null)                   return br.psfMonthly * 12
  if (br.monthlyTotal!= null && t.sqft)         return (br.monthlyTotal * 12) / t.sqft
  return null
}
function fmtStepsShort(arr) {
  if (!arr?.length) return '—'
  return arr.map(s => `${s.effectiveDate || '?'}: $${(s.psfAnnual ?? (s.psfMonthly ? s.psfMonthly * 12 : null) ?? 0).toFixed(2)}`).join('\n')
}
function fmtFreeRent(arr) {
  if (!arr?.length) return '—'
  return arr.map(f => `${f.startDate || '?'}: ${f.months != null ? f.months + ' mo' : ((f.abatementPct || 0) * 100).toFixed(0) + '%'}`).join('\n')
}
function fmtPctRent(pr) {
  if (!pr) return '—'
  const bp = pr.breakpoint != null ? '$' + Number(pr.breakpoint).toLocaleString() : '—'
  const ov = pr.overagePct != null ? (pr.overagePct * 100).toFixed(2) + '%' : '—'
  return `BP: ${bp}\nOv: ${ov}`
}
function hasAny(set, keys) { return keys.some(k => set.has(k)) }

// Health
fetch('/api/health')
  .then(r => r.json())
  .then(() => $('#health').textContent = '🟢 kitchen online')
  .catch(() => $('#health').textContent = '🔴 offline')
