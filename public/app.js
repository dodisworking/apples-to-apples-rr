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
  debugLog: [],                  // ring buffer of [A2A] events for copy-paste troubleshooting
}

// ═══ Diagnostic logger ════════════════════════════════
// Every meaningful pipeline event is tagged [A2A] and pushed into state.debugLog.
// User can press the "Copy logs" button in the reviewer header to grab the
// last ~200 events as plain text for sharing.
function log(tag, data) {
  const t = new Date().toISOString().slice(11, 23)   // HH:MM:SS.mmm
  let payload = ''
  try {
    payload = data == null ? '' : (typeof data === 'string' ? data : JSON.stringify(data))
  } catch (e) { payload = String(data) }
  const line = `[${t}] [A2A] ${tag}${payload ? ' ' + payload : ''}`
  console.log(line)
  state.debugLog.push(line)
  if (state.debugLog.length > 400) state.debugLog.shift()
}
window.__a2aLogs = () => state.debugLog.join('\n')
window.__a2aCopyLogs = async () => {
  const text = state.debugLog.join('\n')
  try { await navigator.clipboard.writeText(text); console.log('[A2A] logs copied — ' + state.debugLog.length + ' lines') }
  catch (e) { console.log('[A2A] copy failed, here are the logs:\n' + text) }
}

// Capture unhandled errors and promise rejections — these are the things
// that silently leave the UI stuck on a Loading… spinner.
window.addEventListener('error', (e) => {
  log('window.error', { msg: e.message, src: e.filename + ':' + e.lineno + ':' + e.colno })
})
window.addEventListener('unhandledrejection', (e) => {
  log('window.unhandledrejection', { reason: String(e.reason), stack: e.reason?.stack?.slice(0, 300) })
})
log('boot', { ua: navigator.userAgent.slice(0, 80), date: new Date().toISOString() })

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
  'reunify':         { label: 'AI REUNIFYING ORPHANS', morph: 'stage-3' },
  'reunify-done':    { label: 'AI REUNIFIED',          morph: 'stage-3' },
  'verifying':       { label: 'AI VERIFIER PASS',      morph: 'stage-3' },
  'verifying-done':  { label: 'AI VERIFIED',           morph: 'stage-3' },
  'verifying-skip':  { label: 'AI VERIFIER SKIPPED',   morph: 'stage-3' },
  'rendering':       { label: 'PLATING REPORT',        morph: 'stage-done' },
}

function updateProgress({ stage, pct, msg }) {
  const info = STAGE_TO_HEADLINE[stage] || { label: 'WORKING' }
  const stageEl    = document.getElementById('processStage');    if (stageEl)    stageEl.textContent    = info.label
  const msgEl      = document.getElementById('processMessage');  if (msgEl)      msgEl.textContent      = msg || ''
  const fillEl     = document.getElementById('processFill');     if (fillEl)     fillEl.style.width     = Math.min(100, Math.max(0, pct || 0)) + '%'
  const headlineEl = document.getElementById('processHeadline'); if (headlineEl) headlineEl.textContent = info.label + '…'
  // (The pear-to-apple morph runs as a pure CSS loop — no JS class manipulation
  //  needed. Previously this referenced a #morphFruit element that no longer
  //  exists, throwing a TypeError on every progress event and stranding the
  //  user on the processing screen. Defensive lookups above prevent that.)
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
  // Land the reviewer straight into the guided suite-by-suite cross-reference
  // (the side-by-side table stays behind it as an overview / fallback).
  setTimeout(() => { try { openGuided(0) } catch (e) { log('openGuided.error', { msg: String(e) }) } }, 50)
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

  // Click → open drawer at that tenant, select that field
  $('#findingsSidebarList').onclick = (e) => {
    const row = e.target.closest('.findings-row[data-match]')
    if (!row) return
    const matchIdx = parseInt(row.dataset.match, 10)
    const fieldKey = row.dataset.field
    state.activeFieldKey = fieldKey
    openDrawer(matchIdx)
    // After openDrawer renders the body, select the target finding card,
    // expand its explanation, and light up the matching evidence rows.
    requestAnimationFrame(() => {
      const card = document.querySelector(`.finding-card[data-field="${cssEscape(fieldKey)}"]`)
      if (card) {
        card.classList.add('expanded', 'active-finding')
        card.scrollIntoView({ block: 'center', behavior: 'smooth' })
        // Light up the evidence rows
        document.querySelectorAll(`.evidence-card .field-row[data-field="${cssEscape(fieldKey)}"]`)
          .forEach(r => r.classList.add('active-field'))
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

// Delegated handlers for the drawer:
//  - clicking 📊/📄 open-original opens the uploaded file in a new tab
//  - clicking 🔍 Cross-reference opens the full-screen reviewer
//  - clicking 👍/👎/↺ on a finding records the verdict per-field
//  - clicking the ▾ chevron expands the AI explanation paragraph
//  - clicking the head/values area of a finding HIGHLIGHTS that field's row
//    in the apple/pear evidence cards below (so user sees what's being compared)
document.getElementById('drawerBody')?.addEventListener('click', (e) => {
  // 📊/📄 Open original file in a new tab
  const openBtn = e.target.closest('[data-open-original]')
  if (openBtn) {
    e.stopPropagation()
    const which = openBtn.dataset.openOriginal
    const file = which === 'argus' ? state.argusFile : state.clientFile
    if (!file) { alert('Original file not available — re-upload to enable.'); return }
    const url = URL.createObjectURL(file)
    window.open(url, '_blank')
    setTimeout(() => URL.revokeObjectURL(url), 60_000)
    return
  }

  // 🔍 Open the full-screen cross-reference reviewer
  if (e.target.closest('#drawerOpenReviewer')) {
    e.stopPropagation()
    openPdfReviewer(state.activeIdx, state.activeFieldKey)
    return
  }

  // ↺ Restore an AI-removed false-positive finding
  const restoreBtn = e.target.closest('[data-restore-field]')
  if (restoreBtn) {
    e.stopPropagation()
    const field = restoreBtn.dataset.restoreField
    if (state.activeIdx < 0) return
    const m = state.result.matches[state.activeIdx]
    const removed = (m.aiRemoved || []).find(r => r.field === field)
    if (removed) {
      // Move it back into m.diffs (with a tag so user knows they overrode the verifier)
      m.diffs = m.diffs || []
      m.diffs.push({
        ...removed,
        aiOverridden: true,
        suppressedReason: null,
      })
      m.aiRemoved = m.aiRemoved.filter(r => r.field !== field)
      // If diffs is no longer empty, drop the cleanedByAi flag
      if (m.diffs.length && m.flags?.cleanedByAi) {
        m.flags.cleanedByAi = false
        m.flags.clean = false
      }
      log('drawer.restoreAiRemoved', { field })
      openDrawer(state.activeIdx)
      renderTable()
    }
    return
  }

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

  // Verdict buttons (Confirm / Reject / Clear)
  const btn = e.target.closest('.finding-btn')
  if (btn && btn.dataset.verdict) {
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

  // ▾ chevron toggles the explain paragraph
  if (e.target.closest('[data-toggle]')) {
    e.stopPropagation()
    card.classList.toggle('expanded')
    return
  }

  // Click head or values area → highlight that finding's field row in the
  // apple/pear evidence cards below. This is the "show me what's being
  // compared" interaction.
  if (e.target.closest('[data-select]')) {
    const field = card.dataset.field
    state.activeFieldKey = field
    // Mark the card as the active finding
    document.querySelectorAll('.finding-card.active-finding').forEach(c => c.classList.remove('active-finding'))
    card.classList.add('active-finding')
    // Light up the corresponding rows in both evidence cards
    document.querySelectorAll('.evidence-card .field-row.active-field').forEach(r => r.classList.remove('active-field'))
    const rows = document.querySelectorAll(`.evidence-card .field-row[data-field="${cssEscape(field)}"]`)
    rows.forEach(r => r.classList.add('active-field'))
    if (rows[0]) rows[0].scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    // Also re-render source previews with the new active field so the red box
    // in the source documents jumps to the right cell.
    if (state.result?.matches?.[state.activeIdx]) {
      requestAnimationFrame(() => renderSourcePreviews(state.result.matches[state.activeIdx]))
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
  // Auto-activate the first finding if none chosen yet — drives the
  // sticky finding card and the active-cell highlight on both sources.
  const firstActive = (m.diffs || []).find(d => !d.suppressed)?.field
  if (!state.activeFieldKey || !(m.diffs || []).some(d => d.field === state.activeFieldKey)) {
    state.activeFieldKey = firstActive || null
  }
  const key = m.suiteKey || m.suite
  const review = state.reviews[key] || {}
  const legacyVerdict = (typeof review === 'object' && 'verdict' in review) ? review.verdict : null
  const legacyNote    = (typeof review === 'object' && '_tenantNote' in review) ? review._tenantNote
                     : (typeof review === 'object' && 'note' in review)        ? review.note : ''

  $('#drawerTitle').innerHTML = `Suite <b>${escape(m.suite || '—')}</b> · ${escape(m.argus?.name || m.client?.name || '—')}${renderMatchBadge(m)}`
  $('#drawerBody').innerHTML = renderDrawerBody(m)
  // Apply the active-finding class to the just-rendered card so the
  // sticky-at-top styling kicks in immediately.
  if (state.activeFieldKey) {
    const card = document.querySelector(`.finding-card[data-field="${cssEscape(state.activeFieldKey)}"]`)
    card?.classList.add('active-finding')
    // Also light up the matching evidence rows
    document.querySelectorAll(`.evidence-card .field-row[data-field="${cssEscape(state.activeFieldKey)}"]`)
      .forEach(r => r.classList.add('active-field'))
  }

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

  // Source previews are now VISIBLE BY DEFAULT — the whole point of this
  // tool is "argus on left, client on right, with highlights".
  $('#previewGrid').hidden = false
  $('#togglePreview').textContent = '🫣 Hide sources'

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
  // Keep the guided bar's progress + Next/Export gating in sync with verdicts.
  if (state.guided?.active) refreshGuided()
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

// Compact "matched by" badge shown beside the tenant name in the drawer.
// Tells the paralegal HOW these two rows got paired and how confident the
// matcher was, so they can sanity-check before trusting the comparison.
function renderMatchBadge(m) {
  if (m.flags?.argusOnly || m.flags?.clientOnly) {
    return ` <span class="match-badge solo" title="No pair found in the other rent roll">⚠ unmatched</span>`
  }
  const by = m.matchedBy || '?'
  const score = m.matchScore != null ? Math.round(m.matchScore * 100) + '%' : ''
  const labels = {
    suite: '🔑 by suite',
    name: '🅰 by name',
    sqft: '📏 by SF',
    combined: '🔗 combined',
    'suite-fallback': '🔑 suite (fallback)',
    'ai-reunified': '🤖 AI-reunified',
  }
  const cls = m.matchScore >= 0.75 ? 'strong' : m.matchScore >= 0.55 ? 'medium' : 'weak'
  const detail = m.aiReunified?.reasoning
    || (m.matchDetail
      ? `name ${Math.round((m.matchDetail.name || 0) * 100)}% · suite ${m.matchDetail.suite ? '✓' : '✗'} · SF ${m.matchDetail.sf ? '✓' : '✗'}`
      : '')
  return ` <span class="match-badge ${cls}" title="${escape(detail)}">${labels[by] || by} ${score}</span>`
}

// AI verifier badge — shown on each finding when the second-pass Claude
// review has classified it. Confirmed = "🤖 real ✓ 92%", false_positive =
// "🤖 false positive 88%".
function renderAiBadge(av) {
  if (!av || !av.verdict) return ''
  const pct = av.confidence != null ? Math.round(av.confidence * 100) + '%' : ''
  if (av.verdict === 'false_positive') {
    return `<span class="badge ai-fp" title="${escape(av.reasoning || 'flagged as false positive by AI verifier')}">🤖 false positive ${pct}</span>`
  }
  if (av.verdict === 'confirmed') {
    return `<span class="badge ai-confirmed" title="${escape(av.reasoning || 'confirmed real discrepancy by AI verifier')}">🤖 real ${pct}</span>`
  }
  return ''
}

function renderDrawerBody(m) {
  const a = m.argus, c = m.client
  const diffs = m.diffs || []
  const flagged = new Set(diffs.map(d => d.field))
  const suiteKey = m.suiteKey || m.suite || ''
  const reviews = state.reviews[suiteKey] || {}

  const status =
    m.flags?.argusOnly  ? '<div class="note-item">This tenant is in Argus but <b>not found</b> in the client RR.</div>' :
    m.flags?.clientOnly ? '<div class="note-item">This tenant is in the client RR but <b>not found</b> in Argus.</div>' :
    m.flags?.cleanedByAi && (m.aiRemoved?.length) ? `<div class="note-item ai-cleaned">✓ Clean after AI second-pass — ${m.aiRemoved.length} false-positive finding${m.aiRemoved.length === 1 ? '' : 's'} removed by verifier.</div>` :
    ''

  // AI-removed false positives — collapsible block so user knows what was
  // filtered AND can restore any they disagree with. Click any item to
  // re-instate it as a regular finding.
  const aiRemovedBlock = m.aiRemoved?.length ? `
    <details class="ai-removed-block">
      <summary>🤖 <b>${m.aiRemoved.length}</b> false-positive finding${m.aiRemoved.length === 1 ? '' : 's'} removed by AI verifier <span style="color:#6b7280;font-weight:400">— click to see what was filtered</span></summary>
      <div class="ai-removed-list">
        ${m.aiRemoved.map((r, ri) => `
          <div class="ai-removed-item" data-removed-idx="${ri}">
            <div class="ai-removed-head">
              <span class="finding-sev sev-${r.severity || 'LOW'}">${r.severity || 'LOW'}</span>
              <span class="ai-removed-label">${escape(r.label || r.field)}</span>
              <button class="ai-restore-btn" data-restore-field="${escape(r.field)}" title="Restore this as a real finding">↺ Restore</button>
            </div>
            <div class="ai-removed-vals">🍎 ${escape(r.argusValue)} · 🍐 ${escape(r.clientValue)}</div>
            <div class="ai-removed-reason">🤖 ${escape(r.aiReasoning || '')}${r.aiConfidence != null ? ` <span style="color:#6b7280">(${Math.round(r.aiConfidence * 100)}% confident)</span>` : ''}</div>
          </div>`).join('')}
      </div>
    </details>` : ''

  // Each finding gets a Google-Docs-style comment card.
  // Confirm/Reject buttons are ALWAYS visible (no expand needed). Click the
  // body of a card to highlight the matching field rows in the evidence cards
  // below — so the user can see exactly what's being compared.
  // Click the small chevron to reveal the AI's explain/rule paragraph + note.
  const diffList = diffs.length ? `
    <div class="findings-list">
      ${diffs.map((d, fi) => {
        const fkey = d.field || ('idx' + fi)
        const fr = (reviews && typeof reviews === 'object' && reviews[fkey]) || {}
        const v = fr.verdict || null
        return `
        <div class="finding-card sev-${d.severity || 'LOW'} ${d.suppressed ? 'suppressed' : ''} ${d.confirmed ? 'confirmed' : ''} ${v ? 'verdict-' + v : ''} ${d.aiVerifier ? 'ai-' + d.aiVerifier.verdict : ''}"
             data-field="${escape(fkey)}">
          <div class="finding-head" data-select="1">
            <span class="finding-sev">${d.severity || 'LOW'}</span>
            <span class="finding-label">${escape(d.label || d.field)}</span>
            ${d.aiVerifier ? renderAiBadge(d.aiVerifier) : ''}
            ${d.suppressed && !d.aiVerifier ? '<span class="badge muted">muted</span>' : ''}
            ${d.confirmed ? '<span class="badge good">confirmed</span>' : ''}
            ${v === 'good' ? '<span class="badge good">\u{1F44D}</span>' : ''}
            ${v === 'bad'  ? '<span class="badge muted">\u{1F44E}</span>' : ''}
            <span class="finding-toggle" data-toggle="1" title="Show explanation">▾</span>
          </div>
          <div class="finding-vals" data-select="1">
            <div class="fv apple">🍎 <b>${escape(d.argusValue)}</b></div>
            <div class="fv pear">🍐 <b>${escape(d.clientValue)}</b></div>
          </div>
          <div class="finding-actions">
            <button class="finding-btn good ${v === 'good' ? 'active' : ''}" data-verdict="good"    title="Confirm real discrepancy">👍 Confirm</button>
            <button class="finding-btn bad  ${v === 'bad'  ? 'active' : ''}" data-verdict="bad"     title="Reject as false positive">👎 Reject</button>
            <button class="finding-btn clear"                                  data-verdict="none">↺ Clear</button>
            <button class="finding-btn jump"                                   data-jump="1" title="Show in source">🔍 Show in source</button>
          </div>
          <div class="finding-body">
            ${d.explain ? `<div class="finding-explain">${escape(d.explain)}</div>` : ''}
            ${d.rule    ? `<div class="finding-rule"><b>Rule fired:</b> ${escape(d.rule)}</div>` : ''}
            ${d.aiVerifier ? `<div class="finding-rule ai-verifier-note ${d.aiVerifier.verdict}">🤖 <b>AI verifier (${Math.round((d.aiVerifier.confidence || 0) * 100)}%):</b> ${escape(d.aiVerifier.reasoning || '')}</div>` : ''}
            ${d.suppressedReason && !d.aiVerifier ? `<div class="finding-rule" style="color:#16a34a">🧠 ${escape(d.suppressedReason)}</div>` : ''}
            ${d.confirmedNote    ? `<div class="finding-rule" style="color:#16a34a">🧠 ${escape(d.confirmedNote)}</div>`    : ''}
            <textarea class="finding-note" placeholder="Note (optional)…">${escape(fr.note || '')}</textarea>
          </div>
        </div>`}).join('')}
    </div>` : '<div style="color:#6b7280;font-size:13px;margin-bottom:14px">No field-level diffs — clean match.</div>'

  const field = (label, v, key) => `
    <div class="field-row ${flagged.has(key) ? 'flagged' : ''}" data-field="${escape(key)}">
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

  // Open-original buttons — let the paralegal pop the actual Argus Excel and
  // Client PDF/XLSX in a new tab so they can see the full source files in
  // their native viewer alongside the review.
  const openButtons = `
    <div class="drawer-open-row">
      <button class="drawer-open-btn apple" data-open-original="argus" title="Open the uploaded Argus Excel">📊 Open Argus Excel</button>
      <button class="drawer-open-btn pear"  data-open-original="client" title="Open the uploaded client rent roll">📄 Open Client RR</button>
      <button class="drawer-open-btn alt"   id="drawerOpenReviewer" title="Open full cross-reference reviewer">🔍 Cross-reference</button>
    </div>`

  return `
    ${openButtons}
    ${status}
    ${diffList}
    ${aiRemovedBlock}
    <div class="evidence-grid">
      ${sideCard('apple', a)}
      ${sideCard('pear',  c)}
    </div>`
}

// ═══ Full-screen PDF Cross-Reference Reviewer ════════
$('#openPdfReviewer').addEventListener('click', () => openGuided(0))
$('#pdfReviewerClose').addEventListener('click', () => closeReviewer())
$('#pdfPrev').addEventListener('click', () => stepReviewer(-1))
$('#pdfNext').addEventListener('click', () => stepReviewer(+1))
$('#pdfMatchSelector').addEventListener('change', (e) => {
  const findings = buildFindingsList()
  const f = findings[parseInt(e.target.value, 10)]
  if (f) openPdfReviewer(f.matchIdx, f.fieldKey)
})

// 👁 Hide/show highlight overlay
state.highlightHidden = false
document.getElementById('toggleHighlight')?.addEventListener('click', () => {
  state.highlightHidden = !state.highlightHidden
  document.body.classList.toggle('no-highlight', state.highlightHidden)
  const btn = document.getElementById('toggleHighlight')
  if (btn) btn.textContent = state.highlightHidden ? '👁 Show highlight' : '👁 Hide highlight'
})
// Keyboard shortcut H toggles highlight while reviewer is open
document.addEventListener('keydown', (e) => {
  if ($('#pdfReviewer').getAttribute('aria-hidden') !== 'false') return
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return
  if (e.key === 'h' || e.key === 'H') document.getElementById('toggleHighlight')?.click()
})

// 📋 Copy diagnostic logs to clipboard
document.getElementById('copyDebugLogs')?.addEventListener('click', async () => {
  const btn = document.getElementById('copyDebugLogs')
  const text = state.debugLog.join('\n')
  try {
    await navigator.clipboard.writeText(text || '(no logs yet)')
    const orig = btn.textContent
    btn.textContent = `✓ Copied ${state.debugLog.length} lines`
    setTimeout(() => { btn.textContent = orig }, 1800)
  } catch (e) {
    // Fallback: show a textarea modal the user can copy from manually
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);width:80vw;height:60vh;z-index:99999;padding:12px;font:11px/1.4 ui-monospace,monospace;background:#111;color:#eee;border:1px solid #555;border-radius:8px'
    document.body.appendChild(ta)
    ta.select()
    ta.addEventListener('blur', () => ta.remove(), { once: true })
  }
})

// Side-focus — clicking ANYWHERE on the side header bar (or the ⛶ button, or
// pressing 1/2 on the keyboard) toggles fullscreen for that side. The whole
// label bar is interactive so it's hard to miss.
state.focusSide = null

function setFocusSide(which) {
  const body = document.getElementById('pdfReviewerBody')
  if (!body) return
  if (state.focusSide === which) which = null   // toggle off
  state.focusSide = which
  body.classList.remove('focus-apple', 'focus-pear')
  if (which) body.classList.add('focus-' + which)

  // The grid-template-columns CSS transition takes ~250ms. Wait for it to
  // finish before re-rendering, so the canvas container has its FINAL width
  // when we compute fit-scale. Without this delay, the PDF re-renders at
  // the still-shrinking pre-transition width.
  const doRender = () => {
    if (state.activeIdx < 0) return
    const m = state.result.matches[state.activeIdx]
    if (state.focusSide !== 'pear')  renderReviewerSide('argus',  $('#pdfRevArgus'),  m, state.result.argusTenants)
    if (state.focusSide !== 'apple') renderReviewerSide('client', $('#pdfRevClient'), m, state.result.clientTenants)
  }
  setTimeout(doRender, 280)
}

document.getElementById('pdfReviewerBody')?.addEventListener('click', (e) => {
  // 📥 Open original file in a new tab
  const openBtn = e.target.closest('[data-open-original]')
  if (openBtn) {
    e.stopPropagation()
    const which = openBtn.dataset.openOriginal
    const file = which === 'argus' ? state.argusFile : state.clientFile
    if (!file) { alert('Original file not available — re-upload to enable.'); return }
    const url = URL.createObjectURL(file)
    window.open(url, '_blank')
    setTimeout(() => URL.revokeObjectURL(url), 60_000)
    return
  }
  // Side focus — works from the ⛶ button OR clicking anywhere on the label bar
  const labelOrBtn = e.target.closest('[data-focus]')
  if (!labelOrBtn) return
  // Don't trigger when the click was inside the pear-view-toggle (which has its own behavior)
  if (e.target.closest('.pear-view-toggle')) return
  setFocusSide(labelOrBtn.dataset.focus)
})

// Keyboard shortcuts: 1 = Apple fullscreen, 2 = Pear fullscreen, 0 = split
document.addEventListener('keydown', (e) => {
  if ($('#pdfReviewer').getAttribute('aria-hidden') !== 'false') return
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return
  if (e.key === '1') { e.preventDefault(); setFocusSide('apple') }
  else if (e.key === '2') { e.preventDefault(); setFocusSide('pear') }
  else if (e.key === '0') { e.preventDefault(); setFocusSide(null) }
})

// Per-side zoom — independent argus and client zoom factors
state.zoomArgus  = 1.0
state.zoomClient = 1.0

function setSideZoom(side, mult) {
  const key = side === 'argus' ? 'zoomArgus' : 'zoomClient'
  if (mult === 'fit') state[key] = 1.0
  else state[key] = Math.max(0.4, Math.min(4.0, state[key] * mult))
  const lbl = document.querySelector(`[data-zoom-label="${side === 'argus' ? 'argus' : 'client'}"]`)
  if (lbl) lbl.textContent = Math.round(state[key] * 100) + '%'
  if (state.activeIdx >= 0) {
    const m = state.result.matches[state.activeIdx]
    const which = side === 'argus' ? 'argus' : 'client'
    const host = document.getElementById(which === 'argus' ? 'pdfRevArgus' : 'pdfRevClient')
    renderReviewerSide(which, host, m, which === 'argus' ? state.result.argusTenants : state.result.clientTenants)
  }
}

// Wire per-side +/−/fit buttons (delegated on the reviewer body)
document.getElementById('pdfReviewerBody')?.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-side-zoom]')
  if (!btn) return
  e.stopPropagation()
  const side = btn.dataset.sideZoom   // 'argus' | 'client'
  const dir = btn.dataset.dir          // 'in' | 'out' | 'fit'
  setSideZoom(side, dir === 'in' ? 1.25 : dir === 'out' ? 0.8 : 'fit')
})

// Delegated handlers for the cross-reference foot:
//   - clicking 👍 / 👎 / ↺ records the verdict per-field (same store as drawer)
//   - clicking ANYWHERE else on the card selects that finding as active,
//     which re-renders both sides with the precise red box on the new field.
//
// The whole card is clickable so the user doesn't have to hunt for a magic
// hot zone — match the visual affordance (cursor:pointer on the whole li).
document.getElementById('pdfReviewerFoot')?.addEventListener('click', (e) => {
  const li = e.target.closest('li[data-field]')
  if (!li) return
  const fkey = li.dataset.field
  log('foot.click', { fkey, target: e.target.tagName + '.' + (e.target.className || '').slice(0, 40) })

  // Clicking inside the note field must NOT re-render the foot (it would blow
  // away focus mid-typing) — let the textarea handle its own input.
  if (e.target.closest('.finding-note')) return

  // Verdict buttons get their own behavior (don't trigger the select)
  const btn = e.target.closest('.finding-btn')
  if (btn && btn.dataset.verdict) {
    e.stopPropagation()
    log('foot.verdict', { fkey, verdict: btn.dataset.verdict })
    if (state.activeIdx < 0) return
    const m = state.result.matches[state.activeIdx]
    const key = m.suiteKey || m.suite
    state.reviews[key] = state.reviews[key] || {}
    if ('verdict' in state.reviews[key]) {
      const legacy = state.reviews[key]
      state.reviews[key] = { _tenantNote: legacy.note || '', __legacyVerdict: legacy.verdict }
    }
    const verdict = btn.dataset.verdict === 'none' ? null : btn.dataset.verdict
    state.reviews[key][fkey] = state.reviews[key][fkey] || { verdict: null, note: '' }
    state.reviews[key][fkey].verdict = verdict
    persistLearnings()
    // Re-render the foot so badges/active states update; the canvases stay put
    $('#pdfReviewerFoot').innerHTML = renderReviewerFoot(m)
    return
  }

  // Anywhere else on the card → make this the active finding and re-render
  // both PDF/XLSX sides with the new pinpoint.
  if (state.activeFieldKey === fkey && li.classList.contains('active-finding')) {
    log('foot.select.noop', { fkey, reason: 'already active' })
    return
  }
  log('foot.select', { fkey, prevField: state.activeFieldKey })
  state.activeFieldKey = fkey
  // Update the selector dropdown to reflect the new active finding
  const sel = $('#pdfMatchSelector')
  if (sel) {
    const findings = buildFindingsList()
    const idx = findings.findIndex(f => f.matchIdx === state.activeIdx && f.fieldKey === fkey)
    if (idx >= 0) sel.value = String(idx)
  }
  if (state.activeIdx >= 0) {
    const m = state.result.matches[state.activeIdx]
    Promise.all([
      renderReviewerSide('argus',  $('#pdfRevArgus'),  m, state.result.argusTenants),
      renderReviewerSide('client', $('#pdfRevClient'), m, state.result.clientTenants),
    ]).catch(e => log('foot.select.renderError', { msg: String(e) }))
    $('#pdfReviewerFoot').innerHTML = renderReviewerFoot(m)
    // Scroll the newly active card into view in case the user clicked near
    // the edge — keeps the UI predictable after re-render.
    requestAnimationFrame(() => {
      const newLi = document.querySelector(`#pdfReviewerFoot li[data-field="${cssEscape(fkey)}"]`)
      newLi?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    })
  } else {
    log('foot.select.noActiveIdx', {})
  }
})

// Persist a comment typed on a cross-reference foot card into the same
// per-field review store the drawer uses, so it exports with the report.
document.getElementById('pdfReviewerFoot')?.addEventListener('input', (e) => {
  const ta = e.target.closest('.finding-note')
  if (!ta) return
  if (state.activeIdx < 0) return
  const fkey = ta.dataset.field
  const m = state.result.matches[state.activeIdx]
  const key = m.suiteKey || m.suite
  state.reviews[key] = state.reviews[key] || {}
  if ('verdict' in state.reviews[key]) {
    const legacy = state.reviews[key]
    state.reviews[key] = { _tenantNote: legacy.note || '', __legacyVerdict: legacy.verdict }
  }
  state.reviews[key][fkey] = state.reviews[key][fkey] || { verdict: null, note: '' }
  state.reviews[key][fkey].note = ta.value
  persistLearnings()
})

// Global zoom kept for back-compat with the existing pdfZoom references
state.pdfZoom = 1.0   // 1.0 = fit baseline
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
  if (e.key === 'Escape') closeReviewer()
  else if (e.key === 'j' || e.key === 'ArrowDown' || e.key === 'ArrowRight') stepReviewer(+1)
  else if (e.key === 'k' || e.key === 'ArrowUp'   || e.key === 'ArrowLeft')  stepReviewer(-1)
})

function stepReviewer(delta) {
  // In guided mode, arrows move the highlight BETWEEN the findings of the
  // CURRENT suite only (so the reviewer can eyeball each flagged value) — they
  // never jump suites, which would bypass the confirm/reject gate.
  if (state.guided?.active) {
    const sf = suiteFindings(state.activeIdx)
    if (!sf.length) return
    let cur = sf.findIndex(f => f.fieldKey === state.activeFieldKey)
    if (cur < 0) cur = 0
    const f = sf[(cur + delta + sf.length) % sf.length]
    selectGuidedFinding(f.fieldKey)
    return
  }
  // Free mode: walk the FLAT findings list (one step per finding).
  const findings = buildFindingsList()
  if (!findings.length) return
  let cur = findings.findIndex(f => f.matchIdx === state.activeIdx && f.fieldKey === state.activeFieldKey)
  if (cur < 0) cur = findings.findIndex(f => f.matchIdx === state.activeIdx)
  if (cur < 0) cur = 0
  const next = (cur + delta + findings.length) % findings.length
  const f = findings[next]
  openPdfReviewer(f.matchIdx, f.fieldKey)
}

// Set the active finding within the current guided suite and re-pinpoint both
// sides (no suite change, no selector rebuild).
function selectGuidedFinding(fkey) {
  if (state.activeIdx < 0) return
  state.activeFieldKey = fkey
  const m = state.result.matches[state.activeIdx]
  $('#pdfReviewerFoot').innerHTML = renderReviewerFoot(m)
  Promise.all([
    renderReviewerSide('argus',  $('#pdfRevArgus'),  m, state.result.argusTenants),
    renderReviewerSide('client', $('#pdfRevClient'), m, state.result.clientTenants),
  ]).catch(e => log('selectGuidedFinding.renderError', { msg: String(e) }))
  requestAnimationFrame(() => {
    document.querySelector(`#pdfReviewerFoot li[data-field="${cssEscape(fkey)}"]`)
      ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  })
}

// Which matches show up in the reviewer's selector. Defaults to all non-clean rows.
function reviewerList() {
  return (state.result.matches || [])
    .map((m, i) => ({ m, i }))
    .filter(({ m }) => !m.flags?.clean)   // skip clean matches — nothing to review
    .map(({ i }) => i)
}

// ═══ Guided suite-by-suite review ═══════════════════════
// The primary reviewer experience: walk every flagged tenant IN ORDER, one
// suite at a time, in the cross-reference (apple↔pear) layout. The reviewer
// must confirm 👍 or reject 👎 EVERY finding on a suite before "Next suite"
// unlocks — nothing can be skipped. When every finding across every suite is
// decided, "Export Result" produces a feedback file (what the AI got right vs.
// wrong, plus the reviewer's comments) to hand back for tuning the model.
state.guided = { active: false, pos: 0, order: [] }

// Resolve a finding's verdict from the per-field (or legacy per-tenant) store.
function findingVerdict(f) {
  const r = state.reviews?.[f.suiteKey]
  if (!r || typeof r !== 'object') return null
  if ('verdict' in r && !Object.values(r).some(v => v && typeof v === 'object' && 'verdict' in v)) return r.verdict
  return r[f.fieldKey]?.verdict || null
}
// Ordered list of matchIdx that carry at least one finding (skips clean tenants).
function guidedOrder() {
  const order = [], seen = new Set()
  for (const f of buildFindingsList()) {
    if (!seen.has(f.matchIdx)) { seen.add(f.matchIdx); order.push(f.matchIdx) }
  }
  return order
}
function suiteFindings(matchIdx) { return buildFindingsList().filter(f => f.matchIdx === matchIdx) }
function suiteDecided(matchIdx) { return suiteFindings(matchIdx).every(f => !!findingVerdict(f)) }
function allFindingsDecided() { return buildFindingsList().every(f => !!findingVerdict(f)) }

async function openGuided(pos = 0) {
  const order = guidedOrder()
  state.guided = { active: true, pos: Math.max(0, Math.min(pos, Math.max(0, order.length - 1))), order }
  $('#pdfReviewer').setAttribute('aria-hidden', 'false')
  $('#pdfReviewer').classList.add('guided-mode')
  $('#guidedBar').hidden = false
  wirePdfDivider()

  if (!order.length) {
    $('#pdfReviewerFoot').innerHTML = `<div class="empty-foot">✓ Every tenant matched cleanly — no findings to review. You can export an empty result for the record.</div>`
    $('#pdfRevArgus').innerHTML = $('#pdfRevClient').innerHTML = '<div style="padding:20px;color:#9ca3af">No discrepancies to show.</div>'
    refreshGuided()
    return
  }

  const matchIdx = order[state.guided.pos]
  const first = suiteFindings(matchIdx)[0]
  state.activeIdx = matchIdx
  state.activeFieldKey = first?.fieldKey || null
  const m = state.result.matches[matchIdx]
  $('#pdfReviewerFoot').innerHTML = renderReviewerFoot(m)
  refreshGuided()

  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))
  await Promise.all([
    renderReviewerSide('argus',  $('#pdfRevArgus'),  m, state.result.argusTenants),
    renderReviewerSide('client', $('#pdfRevClient'), m, state.result.clientTenants),
  ])
}

// Recompute the guided bar: progress, suite label, and gating of Next/Export.
function refreshGuided() {
  if (!state.guided?.active) return
  const order = state.guided.order
  const all = buildFindingsList()
  const total = all.length
  const decided = all.filter(f => !!findingVerdict(f)).length
  const pos = state.guided.pos

  $('#guidedCount').textContent = `${decided} / ${total} findings reviewed`
  $('#guidedFill').style.width = total ? Math.round(decided / total * 100) + '%' : '100%'

  const prevBtn = $('#guidedPrev'), nextBtn = $('#guidedNext'), exportBtn = $('#guidedExport')
  const hint = $('#guidedHint')

  if (!order.length) {
    $('#guidedSuiteLabel').textContent = 'No findings'
    prevBtn.disabled = true
    nextBtn.hidden = true
    exportBtn.hidden = false
    exportBtn.disabled = false
    exportBtn.textContent = '✅ Export Result'
    if (hint) hint.textContent = 'Nothing flagged — export the clean result.'
    return
  }

  const matchIdx = order[pos]
  const suiteOpen = suiteFindings(matchIdx).filter(f => !findingVerdict(f)).length
  const suiteOk = suiteOpen === 0
  const isLast = pos >= order.length - 1
  const everything = allFindingsDecided()

  $('#guidedSuiteLabel').textContent = `Suite ${pos + 1} / ${order.length}`
  prevBtn.disabled = pos <= 0

  // Next: only on non-final suites, only once this suite is fully decided.
  nextBtn.hidden = isLast
  nextBtn.disabled = !suiteOk
  nextBtn.textContent = suiteOk ? 'Next suite →' : `Decide ${suiteOpen} more →`

  // Export: surfaces on the final suite, enabled only when ALL suites are done.
  exportBtn.hidden = !isLast
  exportBtn.disabled = !everything
  exportBtn.textContent = everything ? '✅ Export Result' : `Decide ${total - decided} more to export`

  if (hint) {
    hint.textContent = suiteOk
      ? (isLast
          ? (everything ? 'All findings reviewed — export your result.' : `Go back and finish the ${total - decided} skipped finding(s) to export.`)
          : 'Suite complete — continue to the next one.')
      : `Confirm 👍 or reject 👎 the ${suiteOpen} remaining finding(s) on this suite to continue.`
  }
}

function guidedNext() {
  if (!state.guided?.active) return
  const order = state.guided.order
  if (!order.length) return
  if (!suiteDecided(order[state.guided.pos])) return
  if (state.guided.pos < order.length - 1) openGuided(state.guided.pos + 1)
}
function guidedPrev() {
  if (!state.guided?.active) return
  if (state.guided.pos > 0) openGuided(state.guided.pos - 1)
}
function closeReviewer() {
  $('#pdfReviewer').setAttribute('aria-hidden', 'true')
  $('#pdfReviewer').classList.remove('guided-mode')
  $('#guidedBar').hidden = true
  state.guided.active = false
}

// Build and download the reviewer-feedback file. This is the artifact the
// reviewer sends back: for every AI finding it records whether the human
// confirmed it (AI was right) or rejected it (false positive), plus comments.
function exportFeedback() {
  const all = buildFindingsList()
  const findings = all.map(f => {
    const v = findingVerdict(f)   // 'good' | 'bad' | null
    const m = state.result.matches[f.matchIdx]
    const d = (m.diffs || []).find(x => (x.field || '') === f.fieldKey)
    const reviews = state.reviews?.[f.suiteKey] || {}
    const fr = (typeof reviews === 'object' && reviews[f.fieldKey]) || {}
    return {
      suite: m.suite || f.suiteKey || null,
      tenant: m.argus?.name || m.client?.name || '',
      field: f.fieldKey,
      label: f.label,
      severity: f.severity,
      argusValue: f.argusValue,
      clientValue: f.clientValue,
      rule: d?.rule || null,
      aiFlag: f.isMissing ? 'tenant_presence' : 'discrepancy',
      aiVerifier: d?.aiVerifier
        ? { verdict: d.aiVerifier.verdict, confidence: d.aiVerifier.confidence, reasoning: d.aiVerifier.reasoning }
        : null,
      reviewerVerdict: v === 'good' ? 'confirmed_real_discrepancy' : v === 'bad' ? 'false_positive' : 'undecided',
      aiWasCorrect: v === 'good' ? true : v === 'bad' ? false : null,
      reviewerComment: fr.note || '',
    }
  })
  const confirmed = findings.filter(f => f.reviewerVerdict === 'confirmed_real_discrepancy').length
  const rejected  = findings.filter(f => f.reviewerVerdict === 'false_positive').length
  const undecided = findings.filter(f => f.reviewerVerdict === 'undecided').length
  const out = {
    schema: 'a2a-review-feedback/v1',
    property: state.result?.property || 'Property',
    generatedAt: new Date().toISOString(),
    mode: state.mode,
    files: { argus: state.argusFile?.name || null, client: state.clientFile?.name || null },
    summary: {
      totalFindings: findings.length,
      confirmedRealDiscrepancies: confirmed,
      falsePositives: rejected,
      undecided,
      aiPrecision: (confirmed + rejected) ? +(confirmed / (confirmed + rejected)).toFixed(4) : null,
    },
    findings,
  }
  const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' })
  const safe = (out.property || 'property').replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'property'
  const name = `${safe}-review-feedback-${new Date().toISOString().slice(0, 10)}.json`
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a'); a.href = url; a.download = name
  document.body.appendChild(a); a.click(); a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
  log('exportFeedback', { findings: findings.length, confirmed, rejected, undecided })

  // Also offer the Excel (with reviews) so the handover bundle is complete.
  try { $('#downloadXlsx')?.click() } catch (e) { /* non-fatal */ }
}

$('#guidedPrev')?.addEventListener('click', guidedPrev)
$('#guidedNext')?.addEventListener('click', guidedNext)
$('#guidedExport')?.addEventListener('click', exportFeedback)

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

// ─── Drag-resizable divider between Apple and Pear sides ────
// User reported the all-or-nothing Expand button isn't enough; they want to
// see both at once and resize on the fly. Divider lets them grab the column
// boundary and drag left/right. Double-click resets to 50/50.
function wirePdfDivider() {
  const divider = document.getElementById('pdfReviewerDivider')
  const body = document.getElementById('pdfReviewerBody')
  if (!divider || !body || divider.dataset.wired) return
  divider.dataset.wired = '1'

  let dragging = false
  let startX = 0
  let startLeftPct = 50

  const applySplit = (leftPct) => {
    leftPct = Math.max(15, Math.min(85, leftPct))
    body.style.setProperty('--pdf-split', `${leftPct}fr`)
    body.style.setProperty('--pdf-split-r', `${100 - leftPct}fr`)
    state.splitPct = leftPct
  }

  divider.addEventListener('mousedown', (e) => {
    e.preventDefault()
    dragging = true
    startX = e.clientX
    const rect = body.getBoundingClientRect()
    startLeftPct = ((rect.width * (state.splitPct ?? 50) / 100) / rect.width) * 100
    divider.classList.add('dragging')
    body.classList.add('dragging')
  })
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return
    const rect = body.getBoundingClientRect()
    const dxPct = ((e.clientX - startX) / rect.width) * 100
    applySplit(startLeftPct + dxPct)
  })
  window.addEventListener('mouseup', () => {
    if (!dragging) return
    dragging = false
    divider.classList.remove('dragging')
    body.classList.remove('dragging')
    // Re-render both sides at their new widths
    if (state.activeIdx >= 0) {
      const m = state.result.matches[state.activeIdx]
      renderReviewerSide('argus',  $('#pdfRevArgus'),  m, state.result.argusTenants)
      renderReviewerSide('client', $('#pdfRevClient'), m, state.result.clientTenants)
    }
  })
  divider.addEventListener('dblclick', () => {
    applySplit(50)
    if (state.activeIdx >= 0) {
      const m = state.result.matches[state.activeIdx]
      renderReviewerSide('argus',  $('#pdfRevArgus'),  m, state.result.argusTenants)
      renderReviewerSide('client', $('#pdfRevClient'), m, state.result.clientTenants)
    }
  })
}

// The cross-reference selector and Prev/Next now walk the FLAT FINDINGS LIST.
// Each option in the dropdown is one finding (Suite + Tenant + Field) — picking
// it sets both state.activeIdx and state.activeFieldKey, which lets locateInPdf
// produce a TIGHT cell-level box (not just the tenant row). For unmatched
// tenants (argus-only / client-only) we still highlight the tenant row.
async function openPdfReviewer(idxOrFinding, fieldKey = null) {
  log('openPdfReviewer.start', { idxOrFinding, fieldKey })
  // Free (jump-anywhere) mode — make sure guided gating is off so its bar and
  // hooks don't fight the flat-finding selector.
  state.guided.active = false
  $('#pdfReviewer').classList.remove('guided-mode')
  $('#guidedBar').hidden = true
  const findings = buildFindingsList()
  if (!findings.length) { alert('Every tenant matched cleanly — nothing to review.'); return }

  // Resolve the active finding from args:
  //  - numeric idxOrFinding + fieldKey → locate that exact finding
  //  - numeric idxOrFinding alone → first finding for that match
  //  - default → first finding overall
  let activeFinding =
    findings.find(f => f.matchIdx === idxOrFinding && f.fieldKey === fieldKey) ||
    findings.find(f => f.matchIdx === idxOrFinding) ||
    findings[0]
  if (!activeFinding) return

  state.activeIdx = activeFinding.matchIdx
  state.activeFieldKey = activeFinding.fieldKey

  // Populate selector: one option per finding
  const sel = $('#pdfMatchSelector')
  sel.innerHTML = findings.map((f, i) => {
    const sevTag = f.severity === 'HIGH' ? '🔴' : f.severity === 'MEDIUM' ? '🟠' : '🟡'
    const label = `${sevTag} ${f.tenantLabel} · ${f.label}`
    const sel = (f.matchIdx === activeFinding.matchIdx && f.fieldKey === activeFinding.fieldKey) ? 'selected' : ''
    return `<option value="${i}" ${sel}>${escape(label)}</option>`
  }).join('')

  const pos = findings.findIndex(f => f.matchIdx === activeFinding.matchIdx && f.fieldKey === activeFinding.fieldKey) + 1
  $('#pdfPosition').textContent = `${pos} / ${findings.length}`

  const m = state.result.matches[activeFinding.matchIdx]
  $('#pdfReviewerFoot').innerHTML = renderReviewerFoot(m)

  $('#pdfReviewer').setAttribute('aria-hidden', 'false')
  wirePdfDivider()

  // Wait two animation frames so flex layout has settled
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))

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
  const suiteKey = m.suiteKey || m.suite || ''
  const reviews = state.reviews[suiteKey] || {}
  // Per-finding card with INLINE verdict buttons — confirm/deny right here,
  // no need to bounce back to the drawer. Clicking a card sets it as the
  // active finding (selector + highlight update).
  return `<ul class="diff-list">${(m.diffs || []).map((d, di) => {
    const fkey = d.field || ('idx' + di)
    const fr = (reviews && typeof reviews === 'object' && reviews[fkey]) || {}
    const v = fr.verdict || null
    const isActive = state.activeFieldKey === fkey
    return `
    <li class="sev-${d.severity} ${v ? 'verdict-' + v : ''} ${isActive ? 'active-finding' : ''} ${d.aiVerifier ? 'ai-' + d.aiVerifier.verdict : ''}"
        data-field="${escape(fkey)}">
      <div class="diff-row-head" data-select="1">
        <span class="diff-sev">${d.severity}</span>
        <div class="diff-label">${escape(d.label)}</div>
        ${d.aiVerifier ? renderAiBadge(d.aiVerifier) : ''}
        ${v === 'good' ? '<span class="diff-verdict-tag good">👍 Confirmed</span>' : ''}
        ${v === 'bad'  ? '<span class="diff-verdict-tag bad">👎 Rejected</span>' : ''}
      </div>
      <div class="diff-values" data-select="1"><b>🍎 Argus:</b> ${escape(d.argusValue)} · <b>🍐 Client:</b> ${escape(d.clientValue)}</div>
      ${d.rule ? `<div class="diff-rule">${escape(d.rule)}</div>` : ''}
      ${d.aiVerifier ? `<div class="diff-rule ai-verifier-note ${d.aiVerifier.verdict}">🤖 <b>AI verifier:</b> ${escape(d.aiVerifier.reasoning || '')}</div>` : ''}
      <div class="diff-actions">
        <button class="finding-btn good ${v === 'good' ? 'active' : ''}" data-verdict="good" title="Confirm real discrepancy">👍 Confirm</button>
        <button class="finding-btn bad  ${v === 'bad'  ? 'active' : ''}" data-verdict="bad"  title="Reject as false positive">👎 Reject</button>
        <button class="finding-btn clear" data-verdict="none">↺ Clear</button>
      </div>
      <textarea class="finding-note" data-field="${escape(fkey)}" placeholder="Add a comment for this finding (exported in the report)…">${escape(fr.note || '')}</textarea>
    </li>`}).join('')}</ul>`
}

async function renderReviewerSide(side, host, match, tenants) {
  const t0 = performance.now()
  log('renderReviewerSide.start', { side, suite: match?.suite, field: state.activeFieldKey })
  host.innerHTML = '<div style="padding:20px;color:#9ca3af">Loading…</div>'
  const tenant = side === 'argus' ? match.argus : match.client
  if (!tenant) {
    log('renderReviewerSide.noTenant', { side })
    host.innerHTML = `<div style="padding:20px;color:#9ca3af">Tenant not present on this side.</div>`
    return
  }

  // If a specific finding is active, target that finding's value for precise highlight.
  let targetValue = null
  if (state.activeFieldKey && state.activeFieldKey !== 'tenant_presence') {
    const diff = (match.diffs || []).find(d => d.field === state.activeFieldKey)
    if (diff) targetValue = side === 'argus' ? diff.argusValue : diff.clientValue
  }
  log('renderReviewerSide.targetValue', { side, field: state.activeFieldKey, targetValue })

  // Client "View as Apple" — render the client's normalized tenant in the
  // Argus 5-row template layout for direct visual comparison with the Apple side.
  if (side === 'client' && state.pearView === 'as-apple') {
    host.innerHTML = renderClientAsApple(tenant, match)
    log('renderReviewerSide.asAppleView', { side })
    return
  }

  let entry
  try { entry = await loadPdfDoc(side) }
  catch (e) { log('renderReviewerSide.loadPdfDoc.error', { side, msg: String(e) }); entry = null }

  if (entry?.type === 'pdf') {
    let loc
    try { loc = await locateInPdf(entry, tenant, { targetValue, fieldKey: state.activeFieldKey }) }
    catch (e) {
      log('renderReviewerSide.locateInPdf.error', { side, msg: String(e), stack: e?.stack?.slice(0, 300) })
      host.innerHTML = `<div style="padding:20px;color:#dc2626">Locator error: ${escape(String(e))}</div>`
      return
    }
    if (!loc) {
      log('renderReviewerSide.locate.miss', { side, name: tenant?.name, suite: match.suite })
      host.innerHTML = `<div style="padding:20px;color:#9ca3af">Couldn't locate "${escape(tenant?.name || match.suite || '')}" in this PDF.</div>`
      return
    }
    log('renderReviewerSide.locate.hit', { side, page: loc.page, precision: loc.precision, rect: loc.rect })
    const page = await entry.pdfDoc.getPage(loc.page)
    // Fit-to-container scale — always honor the actual host width so the PDF
    // fills (not overflows, not floats tiny). Multiply by user's zoom factor.
    // requestAnimationFrame above guaranteed layout is settled before this.
    const baseVp = page.getViewport({ scale: 1.0 })
    const containerW = host.clientWidth || 600
    const hostWidth = Math.max(200, containerW - 24)   // 24 = padding
    const fitScale = hostWidth / baseVp.width
    const sideZoom = side === 'argus' ? (state.zoomArgus || 1.0) : (state.zoomClient || 1.0)
    const scale = fitScale * sideZoom
    const vp = page.getViewport({ scale })
    const canvas = document.createElement('canvas')
    canvas.width = vp.width; canvas.height = vp.height
    await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise

    // Wrap the canvas in a positioned div and put the highlight rect inside
    // that wrap. This way the rect is positioned RELATIVE TO THE CANVAS, not
    // relative to the host (which can have padding / position:absolute / margin
    // that throws off canvas.offsetLeft|Top math). Bulletproof regardless of
    // whether the side is expanded, drag-resized, or in default split mode.
    host.innerHTML = ''
    const wrap = document.createElement('div')
    wrap.style.cssText = 'position:relative;display:inline-block'
    wrap.appendChild(canvas)
    const rect = document.createElement('div')
    rect.className = 'hl-rect ' + severityClass(match)
    rect.style.left   = (loc.rect.x * scale) + 'px'
    rect.style.top    = (loc.rect.y * scale) + 'px'
    rect.style.width  = (loc.rect.w * scale) + 'px'
    rect.style.height = (loc.rect.h * scale) + 'px'
    wrap.appendChild(rect)
    host.appendChild(wrap)
    host.scrollTop = Math.max(0, loc.rect.y * scale - 80)
    log('renderReviewerSide.done.pdf', { side, ms: Math.round(performance.now() - t0) })
  } else {
    // XLSX side → render the actual sheet as a styled table with tenant rows highlighted.
    // When a specific finding is active, also pinpoint the cell holding its value.
    const sheets = side === 'argus' ? state.result.argusSheets : state.result.clientSheets
    if (sheets?.length) {
      renderXlsxSheet(host, sheets[0], match, side, tenants || [], { targetValue, fieldKey: state.activeFieldKey })
      log('renderReviewerSide.done.xlsx', { side, ms: Math.round(performance.now() - t0) })
    } else {
      host.innerHTML = renderArgusCard(side, tenant, match)
      log('renderReviewerSide.done.argusCard', { side, ms: Math.round(performance.now() - t0) })
    }
  }
}

// ─── XLSX → styled HTML table renderer (faithful to original Excel) ─
// Uses cell-level styles extracted server-side (fills, fonts, alignment,
// borders, column widths, merged cells, number formats). Looks like
// opening the workbook in Excel.
// Argus Lease Summary 5-row tenant block: each field has a known (rowOffset, colIdx).
// When we know the active finding's field, we can highlight EXACTLY that cell —
// no text matching needed. Falls back to needle search if field isn't mapped.
const ARGUS_FIELD_CELL = {
  tenant_name:         { row: 0, col: 0 },
  suite:               { row: 1, col: 0 },
  lease_start:         { row: 2, col: 0 },
  lease_end:           { row: 2, col: 0 },
  sqft:                { row: 0, col: 1 },
  base_rent_psf:       { row: 0, col: 3 },
  base_rent_annual:    { row: 1, col: 3 },
  rent_steps_count:    { row: 0, col: 4 },
  rent_step_date:      { row: 0, col: 4 },
  rent_step_amount:    { row: 0, col: 5 },
  free_rent_count:     { row: 0, col: 8 },
  free_rent:           { row: 0, col: 8 },
  pct_rent_breakpoint: { row: 1, col: 10 },
  pct_rent_overage:    { row: 2, col: 10 },
}

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
  const fieldKey = opts.fieldKey || null
  const valueNeedles = targetValue ? buildValueNeedles(targetValue) : []
  // Deterministic Argus cell pinpoint: field key → known (rowOffset, colIdx)
  const argusCell = (side === 'argus' && fieldKey && ARGUS_FIELD_CELL[fieldKey]) || null

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
  // Per-side zoom: argus uses zoomArgus, client uses zoomClient
  const zoom = side === 'argus' ? (state.zoomArgus || 1.0) : (state.zoomClient || 1.0)
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
      // Pinpoint highlight: mark the EXACT cell tied to the active finding.
      // Priority 1 (Argus side): deterministic field→(row,col) map.
      // Priority 2 (fallback / Client side): match the value text in any block cell.
      let cellHit = ''
      if (isInBlock) {
        const offset = rIdx - blockStart
        if (argusCell && offset === argusCell.row && c === argusCell.col) {
          cellHit = ' xlsx-cell-hit'
        } else if (!argusCell && valueNeedles.length && raw != null && raw !== '') {
          // Check BOTH the raw value AND the formatted display text — Excel
          // stores 30.5 as a number, but the finding's needle is "30.50".
          const rawStr = String(raw)
          const dispStr = String(text)
          const rawStripped = rawStr.replace(/[$,\s]/g, '')
          const dispStripped = dispStr.replace(/[$,\s]/g, '')
          if (valueNeedles.some(n =>
            rawStr.includes(n) || dispStr.includes(n) ||
            rawStripped.includes(n) || dispStripped.includes(n)
          )) cellHit = ' xlsx-cell-hit'
        }
      }
      html += `<td${mergeAttr} class="${cellHit.trim()}"${css ? ` style="${css}"` : ''}>${escape(text)}</td>`
    }
    html += '</tr>'
  })
  html += '</tbody></table></div>'

  host.innerHTML = html
  host.style.position = 'relative'
  // Apply xlsx-host class so the scoped .xlsx-host .xlsx-table styles
  // apply equally in the cross-reference modal AND in the drawer source preview.
  host.classList.add('xlsx-host')

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
// For each finding field, a list of keyword regexes that identify the column
// header in the source PDF. When the literal target value can't be found in
// the tenant row (e.g. client value differs from what's printed), we fall
// back to (anchor.y, header.x) — a cell-aligned box on the right COLUMN.
const PDF_FIELD_HEADER_RE = {
  tenant_name:         [/^tenant$/i, /^name$/i],
  suite:               [/^suite/i, /^unit$/i, /^space/i],
  sqft:                [/sq\.?\s*ft/i, /square\s*feet/i, /^area$/i, /^sf$/i, /rentable/i],
  lease_start:         [/lease\s*start/i, /commence/i, /^start/i, /begin/i],
  lease_end:           [/exp\.?\s*date/i, /expir/i, /lease\s*end/i, /^end/i, /termination/i],
  base_rent_psf:       [/rent\s*per\s*sq/i, /\$\/sf/i, /per\s*sf/i, /^psf$/i, /^rate$/i, /per\s*square/i],
  base_rent_annual:    [/annual\s*rent/i, /^annual$/i, /\/yr/i, /yearly/i],
  rent_steps_count:    [/escalat/i, /step/i, /increase/i, /bump/i],
  rent_step_date:      [/escalat/i, /step.*date/i, /increase.*date/i],
  rent_step_amount:    [/escalat/i, /step.*amount/i, /increase.*amount/i, /new\s*rent/i],
  free_rent_count:     [/free\s*rent/i, /abate/i, /concession/i],
  free_rent:           [/free\s*rent/i, /abate/i, /concession/i],
  pct_rent_breakpoint: [/breakpoint/i, /sales\s*volume/i, /natural\s*bp/i],
  pct_rent_overage:    [/overage/i, /percent.*rent/i, /^%\s*rent/i],
}

// Scan the page text for column headers. Headers tend to live in the top 40%
// of the page (above the first data row) and are short. Returns a list of
// {x, y, w, h, str} for items that look like headers, plus the anchor Y so
// callers can filter "above the data" candidates.
function detectColumnHeaders(tc, viewport) {
  const items = []
  const yMax = viewport.height * 0.45   // headers in top ~45%
  for (const item of tc.items) {
    const tr = window.pdfjsLib.Util.transform(viewport.transform, item.transform)
    const top = tr[5] - item.height
    if (top > yMax) continue
    const s = String(item.str).trim()
    if (!s || s.length > 30) continue
    items.push({ x: tr[4], y: top, w: item.width, h: item.height, str: s })
  }
  return items
}

// Given a fieldKey and the list of header items detected on the page, find
// the X-center of the column for that field. Returns null if no header
// keyword matched. Picks the BOTTOM-MOST matching header (closest to data).
function findColumnX(fieldKey, headers) {
  const res = PDF_FIELD_HEADER_RE[fieldKey]
  if (!res || !res.length) return null
  let best = null
  for (const h of headers) {
    if (!res.some(re => re.test(h.str))) continue
    // Prefer the bottom-most matching header (closer to data, less likely
    // to be a section title higher up).
    if (!best || h.y > best.y) best = h
  }
  if (!best) return null
  return { x: best.x, w: best.w, xCenter: best.x + best.w / 2 }
}

async function locateInPdf(entry, tenant, opts = {}) {
  if (entry.type !== 'pdf' || !tenant) return null
  const targetValue = opts.targetValue || null
  const fieldKey = opts.fieldKey || null
  log('locateInPdf.start', { name: tenant.name, suite: tenant.suite, fieldKey, targetValue })

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

    // Phase 1: find the tenant's anchor.
    // Try search terms IN ORDER OF SPECIFICITY:
    //   1. Suite number (when present)
    //   2. Full 2-word name ("Academy Sports") — exact phrase
    //   3. Each single name token > 3 chars
    // For each term, scan all text items; if any hit, pick the TOPMOST hit
    // (smallest canvas Y) — for a rent roll, the tenant name appears at the
    // top of its block, and we want to anchor on the first occurrence.
    //
    // This fixes the bug where a generic token like "Sports" matched
    // "INSTANT REPLAY SPORTS C" (further down the page) before "ACADEMY
    // SPORTS + OUTDO" if pdf.js text-item order didn't match visual order.
    const searchTerms = []
    if (suiteRe) searchTerms.push(suiteRe)
    for (const cand of nameCandidates) {
      searchTerms.push(new RegExp(escapeRe(cand).replace(/\s+/g, '\\s*'), 'i'))
    }
    let anchor = null
    for (const re of searchTerms) {
      const hits = []
      for (const item of tc.items) {
        if (re.test(item.str)) {
          const tr = window.pdfjsLib.Util.transform(viewport.transform, item.transform)
          hits.push({ x: tr[4], y: tr[5] - item.height, w: item.width, h: item.height, len: item.str.length })
        }
      }
      if (!hits.length) continue
      // Pick the topmost hit; tiebreak by longest match (more specific text)
      hits.sort((a, b) => (a.y - b.y) || (b.len - a.len))
      anchor = hits[0]
      log('locateInPdf.anchor', { page: p, term: String(re), x: Math.round(anchor.x), y: Math.round(anchor.y), w: Math.round(anchor.w) })
      break
    }
    if (!anchor) continue

    // Phase 2: if we have a target value, find the SINGLE best hit in the
    // tenant's row. We deliberately do NOT union hits — when the needle is
    // generic ("0.00", "1,400"), multiple rows match and the union becomes
    // a page-wide stripe. Instead score every candidate by distance to the
    // anchor and pick the closest.
    if (targetValue) {
      const valueNeedles = buildValueNeedles(targetValue)
      // Tight band: only the tenant's own row. Most rent rolls put each
      // tenant on a single horizontal line; a 12pt vertical reach in each
      // direction comfortably covers wrapping but excludes neighbors.
      const yCenter = anchor.y + anchor.h / 2
      const band = { yMin: anchor.y - 12, yMax: anchor.y + anchor.h + 12 }
      const valueHits = []
      for (const item of tc.items) {
        const tr = window.pdfjsLib.Util.transform(viewport.transform, item.transform)
        const top = tr[5] - item.height
        if (top < band.yMin || top > band.yMax) continue
        const s = item.str
        if (!valueNeedles.some(n => s.includes(n))) continue
        // Prefer hits whose text is MOSTLY the needle (less noise = more specific)
        const center = { x: tr[4] + item.width / 2, y: top + item.height / 2 }
        const dy = Math.abs(center.y - yCenter)
        const dx = Math.abs(center.x - (anchor.x + anchor.w / 2))
        // Distance prioritises Y (same row) over X (anywhere in that row).
        const score = dy * 5 + dx
        valueHits.push({ x: tr[4], y: top, w: item.width, h: item.height, score, len: s.length })
      }
      log('locateInPdf.phase2.candidates', { count: valueHits.length, needles: valueNeedles })
      if (valueHits.length) {
        // Sort by score ascending — closest hit wins. Tiebreak by shortest
        // text (most specific — "0.00" beats "0.00 364.00 LOREM").
        valueHits.sort((a, b) => (a.score - b.score) || (a.len - b.len))
        const hit = valueHits[0]
        const box = { x: hit.x - 3, y: hit.y - 2, w: hit.w + 6, h: hit.h + 4 }
        log('locateInPdf.phase2.hit', { x: Math.round(hit.x), y: Math.round(hit.y), score: Math.round(hit.score) })
        return { page: p, rect: box, precision: 'value' }
      }
    }

    // Phase 2.5: column-header-aware fallback.
    // The value text wasn't found in this tenant's row — common when the
    // normalized value differs from what's printed ("19,000 SF" vs raw
    // "9,000", or "$30.00/SF/yr" vs PDF "30.00"). Scan the page for the
    // expected column header (Area, Annual, Exp. Date, etc.) and draw a
    // box at (anchor.y, header.x) — same row, right column.
    if (fieldKey) {
      const headers = detectColumnHeaders(tc, viewport)
      const col = findColumnX(fieldKey, headers)
      log('locateInPdf.phase25', { fieldKey, headerCount: headers.length, col: col ? { x: Math.round(col.x), w: Math.round(col.w) } : null })
      if (col) {
        // Cell box sits at the column's X, the anchor's Y, sized to roughly
        // a single cell width (header.w + a little padding for value overflow).
        const cellW = Math.max(col.w + 30, 60)
        const box = {
          x: Math.max(0, col.x - 6),
          y: anchor.y - 3,
          w: Math.min(viewport.width - Math.max(0, col.x - 6), cellW),
          h: anchor.h + 6,
        }
        return { page: p, rect: box, precision: 'column' }
      }
    }

    // Fall back: highlight ONLY the tenant-name text (anchor) plus a small pad.
    // Earlier this expanded the box to viewport.width × 0.7 which turned it
    // into a page-wide stripe — useful in theory, ugly in practice and often
    // mis-positioned because the union of multiple text hits would span the
    // whole table. Tight box around the anchor text is unambiguous and never
    // covers unrelated rows.
    const box = {
      x: Math.max(0, anchor.x - 4),
      y: anchor.y - 3,
      w: Math.min(viewport.width - Math.max(0, anchor.x - 4), anchor.w + 220),
      h: anchor.h + 6,
    }
    log('locateInPdf.fallback.row', { page: p })
    return { page: p, rect: box, precision: 'row' }
  }
  log('locateInPdf.miss', { name: tenant.name, suite: tenant.suite })
  return null
}

// Build a list of substrings to search for given a finding's value string.
// Handles currency ("$503,274" → ["503,274", "503274", "503274.00"]),
// dates ("12/31/2025" → ["12/31/25", "12-31-2025", "Dec 31, 2025", ...]),
// and PSF/unit suffixes.
function buildValueNeedles(v) {
  if (v == null || v === '' || v === '—') return []
  const s = String(v).trim()
  const out = new Set([s])

  // ---------- Date variants ----------
  // Try to detect a date in common formats and emit alternates.
  const dateVariants = buildDateVariants(s)
  for (const d of dateVariants) out.add(d)

  // ---------- Currency / number variants ----------
  const stripped = s.replace(/[$,]/g, '').replace(/\s+/g, '')
  if (stripped) out.add(stripped)
  const noUnit = stripped.replace(/\/?(SF\/yr|SF\/mo|yr|mo|sf|psf|annual|monthly)$/i, '')
  if (noUnit && noUnit !== stripped) out.add(noUnit)
  const num = parseFloat(noUnit || stripped)
  if (isFinite(num) && !dateVariants.length) {
    out.add(String(Math.round(num)))
    out.add(num.toFixed(2))
    out.add(num.toLocaleString('en-US'))
    out.add(num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }))
  }

  // Drop very short needles to avoid false positives ("00", "20" etc).
  return Array.from(out).filter(x => x && x.length >= 3)
}

// Parse a date-like string and return alternate textual representations
// covering the formats commonly found in rent rolls.
function buildDateVariants(s) {
  const variants = []
  // Match MM/DD/YYYY, M/D/YY, MM-DD-YYYY, YYYY-MM-DD, "Jan 5, 2025", "5-Jan-25"
  const monthsLong = ['January','February','March','April','May','June','July','August','September','October','November','December']
  const monthsShort = monthsLong.map(m => m.slice(0, 3))
  let y, m, d
  let mt
  if ((mt = s.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2,4})$/))) {
    m = +mt[1]; d = +mt[2]; y = +mt[3]
    if (y < 100) y += y < 50 ? 2000 : 1900
  } else if ((mt = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/))) {
    y = +mt[1]; m = +mt[2]; d = +mt[3]
  } else if ((mt = s.match(/^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\s+(\d{1,2}),?\s+(\d{2,4})$/i))) {
    m = monthsShort.findIndex(x => x.toLowerCase() === mt[1].slice(0, 3).toLowerCase()) + 1
    d = +mt[2]; y = +mt[3]
    if (y < 100) y += y < 50 ? 2000 : 1900
  } else {
    return variants
  }
  if (!m || !d || !y || m < 1 || m > 12 || d < 1 || d > 31) return variants
  const mm = String(m).padStart(2, '0'), dd = String(d).padStart(2, '0')
  const yy = String(y).slice(-2), yyyy = String(y)
  const mLong = monthsLong[m - 1], mShort = monthsShort[m - 1]
  variants.push(`${m}/${d}/${yyyy}`, `${mm}/${dd}/${yyyy}`)
  variants.push(`${m}/${d}/${yy}`, `${mm}/${dd}/${yy}`)
  variants.push(`${m}-${d}-${yyyy}`, `${mm}-${dd}-${yyyy}`)
  variants.push(`${m}-${d}-${yy}`, `${mm}-${dd}-${yy}`)
  variants.push(`${yyyy}-${mm}-${dd}`)
  variants.push(`${mShort} ${d}, ${yyyy}`, `${mLong} ${d}, ${yyyy}`)
  variants.push(`${d}-${mShort}-${yy}`, `${d}-${mShort}-${yyyy}`)
  return variants
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
  log('drawer.renderSide.start', { side, suite: match?.suite, field: state.activeFieldKey })
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
  try { entry = await loadPdfDoc(side) }
  catch (e) { log('drawer.renderSide.loadPdfDoc.error', { side, msg: String(e) }); entry = null }
  if (!entry) { host.innerHTML = '<div class="preview-placeholder">Source not loaded — re-upload to see preview.</div>'; return }
  // XLSX side → render the FULL styled sheet just like the cross-reference does,
  // so the user sees the actual Argus spreadsheet with the active cell pinpointed.
  if (entry.type === 'xlsx') {
    const sheets = side === 'argus' ? state.result.argusSheets : state.result.clientSheets
    if (sheets?.length) {
      renderXlsxSheet(host, sheets[0], match, side, side === 'argus' ? state.result.argusTenants : state.result.clientTenants, {
        targetValue, fieldKey: state.activeFieldKey,
      })
      log('drawer.renderSide.done.xlsx', { side })
      return
    }
    // Fallback to the simple key-value table if the styled sheet didn't come back
    return renderXlsxRow(host, tenant, match)
  }

  let loc
  try { loc = await locateInPdf(entry, tenant, { targetValue, fieldKey: state.activeFieldKey }) }
  catch (e) {
    log('drawer.renderSide.locateInPdf.error', { side, msg: String(e), stack: e?.stack?.slice(0, 300) })
    host.innerHTML = `<div class="preview-placeholder" style="color:#dc2626">Locator error: ${escape(String(e))}</div>`
    return
  }
  if (!loc) {
    log('drawer.renderSide.locate.miss', { side, name: tenant?.name })
    host.innerHTML = `<div class="preview-placeholder">Couldn't locate "${escape(tenant?.name || match.suite || '')}" in this PDF.</div>`
    return
  }
  log('drawer.renderSide.locate.hit', { side, page: loc.page, precision: loc.precision, rect: loc.rect })

  const page = await entry.pdfDoc.getPage(loc.page)
  const scale = 1.3
  const vp = page.getViewport({ scale })
  const canvas = document.createElement('canvas')
  canvas.width = vp.width; canvas.height = vp.height
  await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise
  host.innerHTML = ''
  const wrap = document.createElement('div')
  wrap.style.cssText = 'position:relative;display:inline-block'
  wrap.appendChild(canvas)

  const rect = document.createElement('div')
  rect.className = 'hl-rect ' + severityClass(match)
  rect.style.left   = (loc.rect.x * scale) + 'px'
  rect.style.top    = (loc.rect.y * scale) + 'px'
  rect.style.width  = (loc.rect.w * scale) + 'px'
  rect.style.height = (loc.rect.h * scale) + 'px'
  wrap.appendChild(rect)
  host.appendChild(wrap)
  // Scroll the highlight into vertical center of the preview pane so the
  // user sees BOTH the box AND surrounding context (tenant name, nearby
  // rows). Defer to next animation frame so the layout has settled —
  // setting scrollTop before the canvas is sized doesn't stick.
  requestAnimationFrame(() => {
    const hostH = host.clientHeight || 300
    const target = Math.max(0, loc.rect.y * scale - hostH / 3)
    host.scrollTop = target
    log('drawer.renderSide.scroll', { side, target, actual: host.scrollTop, hostH, scrollH: host.scrollHeight })
  })
  log('drawer.renderSide.done', { side, canvasH: canvas.height, rectY: Math.round(loc.rect.y * scale) })
}

// Pick a severity-color class for the highlighter based on the worst diff in the match.
function severityClass(match) {
  const diffs = match?.diffs || []
  if (diffs.some(d => d.severity === 'HIGH') || match?.flags?.argusOnly || match?.flags?.clientOnly) return 'urgent'
  if (diffs.some(d => d.severity === 'MEDIUM')) return 'warn'
  return ''  // default yellow highlighter
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
