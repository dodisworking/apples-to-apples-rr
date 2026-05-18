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
  wireToolbar()
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
  const r = state.reviews[key] || { verdict: null, note: '' }
  r.note = e.target.value
  state.reviews[key] = r
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
  const review = state.reviews[key] || { verdict: null, note: '' }

  $('#drawerTitle').innerHTML = `Suite <b>${escape(m.suite || '—')}</b> · ${escape(m.argus?.name || m.client?.name || '—')}`
  $('#drawerBody').innerHTML = renderDrawerBody(m)

  document.querySelectorAll('.btn-review').forEach(b => {
    b.classList.toggle('active', b.dataset.verdict === review.verdict)
  })
  $('#reviewNote').value = review.note || ''

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
  const list = state.result.matches
  let idx = state.activeIdx
  for (let k = 0; k < list.length; k++) {
    idx = (idx + d + list.length) % list.length
    if (!list[idx].flags?.clean) break
  }
  openDrawer(idx)
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
        // Flash a tiny indicator in the footer
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

  const status =
    m.flags?.argusOnly  ? '<div class="note-item">This tenant is in Argus but <b>not found</b> in the client RR.</div>' :
    m.flags?.clientOnly ? '<div class="note-item">This tenant is in the client RR but <b>not found</b> in Argus.</div>' : ''

  const diffList = diffs.length ? `
    <ul class="diff-list">
      ${diffs.map(d => `
        <li class="sev-${d.severity || 'LOW'} ${d.suppressed ? 'suppressed' : ''} ${d.confirmed ? 'confirmed' : ''}">
          <span class="diff-sev">${d.severity || 'LOW'}</span>
          <div class="diff-label">${escape(d.label || d.field)} ${d.suppressed ? '<span class="badge muted">muted by learning</span>' : ''} ${d.confirmed ? '<span class="badge good">confirmed by learning</span>' : ''}</div>
          <div class="diff-values">Argus: <b>${escape(d.argusValue)}</b> · Client: <b>${escape(d.clientValue)}</b></div>
          ${d.rule ? `<div class="diff-rule">${escape(d.rule)}</div>` : ''}
          ${d.suppressedReason ? `<div class="diff-rule" style="color:#16a34a">🧠 ${escape(d.suppressedReason)}</div>` : ''}
          ${d.confirmedNote    ? `<div class="diff-rule" style="color:#16a34a">🧠 ${escape(d.confirmedNote)}</div>`    : ''}
        </li>`).join('')}
    </ul>` : '<div style="color:#6b7280;font-size:13px;margin-bottom:14px">No field-level diffs — clean match.</div>'

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
  let entry
  try { entry = await loadPdfDoc(side) } catch (e) { entry = null }

  if (entry?.type === 'pdf') {
    await buildIndex(entry, tenants || [])
    const loc = entry.index.get(match.suiteKey || match.suite)
    if (!loc) {
      host.innerHTML = `<div style="padding:20px;color:#9ca3af">Couldn't locate Suite ${escape(match.suite || '')} in this PDF.</div>`
      return
    }
    const page = await entry.pdfDoc.getPage(loc.page)
    const scale = 1.7
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
    // XLSX side → render an Argus-style card with the flagged fields outlined
    host.innerHTML = renderArgusCard(side, tenant, match)
  }
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
  const file = side === 'argus' ? state.argusFile : state.clientFile
  if (!file) return null
  const isPdf = /\.pdf$/i.test(file.name)
  if (!isPdf) { pdfCache.set(side, { type: 'xlsx', file }); return pdfCache.get(side) }
  if (typeof window.pdfjsLib === 'undefined') return null
  const buf = await file.arrayBuffer()
  const pdfDoc = await window.pdfjsLib.getDocument({ data: buf }).promise
  const entry = { type: 'pdf', pdfDoc, index: new Map() }
  pdfCache.set(side, entry)
  return entry
}

async function buildIndex(entry, tenants) {
  if (entry.type !== 'pdf' || entry.index.size) return
  const pdfDoc = entry.pdfDoc
  for (let p = 1; p <= pdfDoc.numPages; p++) {
    const page = await pdfDoc.getPage(p)
    const viewport = page.getViewport({ scale: 1.0 })
    const tc = await page.getTextContent()
    for (const t of tenants) {
      const key = t.suiteKey || t.suite
      if (!key || entry.index.has(key)) continue
      const suiteStr = String(t.suite || '').replace(/[^a-z0-9]/gi, '')
      if (!suiteStr) continue
      const suiteRe = new RegExp(`(^|\\s|#)0*${escapeRe(suiteStr)}\\b`, 'i')
      const nameTok = t.name ? t.name.split(/[\s,&]/).find(w => w.length > 3) : null
      const nameRe = nameTok ? new RegExp(escapeRe(nameTok), 'i') : null
      const hits = []
      for (const item of tc.items) {
        const s = item.str
        if (!(suiteRe.test(s) || (nameRe && nameRe.test(s)))) continue
        const tr = window.pdfjsLib.Util.transform(viewport.transform, item.transform)
        hits.push({ x: tr[4], y: tr[5] - item.height, w: item.width, h: item.height })
      }
      if (hits.length) {
        const box = union(hits)
        box.x -= 6; box.y -= 4; box.w += 12; box.h += 8
        entry.index.set(key, { page: p, rect: box })
      }
    }
  }
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
  let entry
  try { entry = await loadPdfDoc(side) } catch (e) { entry = null }
  if (!entry) { host.innerHTML = '<div class="preview-placeholder">Source not loaded — re-upload to see preview.</div>'; return }
  if (entry.type === 'xlsx') return renderXlsxRow(host, tenant, match)

  try { await buildIndex(entry, tenants || []) } catch (e) { console.warn('index', e) }
  const key = match.suiteKey || match.suite
  const loc = entry.index.get(key)
  if (!loc) { host.innerHTML = `<div class="preview-placeholder">Couldn't locate Suite ${escape(match.suite || '')} in this PDF.</div>`; return }

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
