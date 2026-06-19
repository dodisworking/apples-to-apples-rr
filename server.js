import 'dotenv/config'
import express from 'express'
import path from 'path'
import { fileURLToPath } from 'url'
import { parseFile } from './lib/parsers.js'
import { detect, decideRoles } from './lib/detect.js'
import { parseArgusFromSheets } from './lib/argus.js'
import { normalizeClient, normalizeClientEnsemble } from './lib/client.js'
import { reconcile, compareTenantsExternal } from './lib/reconcile.js'
import { verifyFindings, reunifyOrphans } from './lib/verifier.js'
import { buildExcel } from './lib/excel.js'
import { loadAll as loadLearnings, recordBulk, forProperty, stats as learningStats } from './lib/learnings.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname  = path.dirname(__filename)

const app  = express()
const PORT = process.env.PORT || 3790
const HOST = process.env.HOST?.trim() || '0.0.0.0'

app.use(express.json({ limit: '200mb' }))
app.use(express.static(path.join(__dirname, 'public')))

app.get('/api/health', (_req, res) => res.json({ ok: true, name: 'apples-to-apples-rr', learnings: learningStats() }))

/** GET /api/learnings?property=... → all learnings for a property */
app.get('/api/learnings', (req, res) => {
  const property = req.query.property
  if (property) return res.json({ learnings: forProperty(property) })
  res.json({ stats: learningStats(), learnings: loadLearnings() })
})

/**
 * POST /api/learn
 * Body: { property, matches: [...], reviews: { [suiteKey]: { verdict, note } } }
 * Persists the paralegal's 👍/👎/notes so future runs for the same property
 * suppress repeated false-positives and confirm repeated real findings.
 */
app.post('/api/learn', (req, res) => {
  try {
    const { property, matches, reviews } = req.body || {}
    const n = recordBulk({ property, matches, reviews })
    res.json({ ok: true, recorded: n, stats: learningStats() })
  } catch (e) {
    console.error('[learn]', e)
    res.status(500).json({ error: e.message })
  }
})

/**
 * POST /api/detect
 * Body: { fileA: { name, base64 }, fileB: { name, base64 } }
 * Returns which file looks Argus vs Client + the signature hits.
 */
app.post('/api/detect', async (req, res) => {
  try {
    const { fileA, fileB } = req.body || {}
    if (!fileA?.base64 || !fileB?.base64) return res.status(400).json({ error: 'fileA and fileB required' })
    const bufA = Buffer.from(fileA.base64, 'base64')
    const bufB = Buffer.from(fileB.base64, 'base64')
    const [parsedA, parsedB] = await Promise.all([parseFile(bufA, fileA.name), parseFile(bufB, fileB.name)])
    const detA = detect(parsedA.text, fileA.name)
    const detB = detect(parsedB.text, fileB.name)
    const roles = decideRoles(detA, detB)
    res.json({
      argus: roles.argus, client: roles.client,
      detection: {
        A: { ...detA, filename: fileA.name },
        B: { ...detB, filename: fileB.name },
      },
    })
  } catch (e) {
    console.error('[detect]', e)
    res.status(500).json({ error: e.message })
  }
})

/**
 * POST /api/compare
 * Body: { argus: { name, base64 }, client: { name, base64 }, mode?: 'dumb'|'regular'|'deluxe' }
 * Streams Server-Sent Events with progress + final result.
 */
app.post('/api/compare', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders?.()
  const emit = (event, data) => {
    res.write(`event: ${event}\n`)
    res.write(`data: ${JSON.stringify(data)}\n\n`)
  }
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 15000)

  // Wrap a long-running await with a periodic "still working" progress emit
  // so the UI elapsed counter visibly moves and the user doesn't think the
  // pipeline hung mid-LLM-call. emit() runs every `intervalMs`; stage/pct
  // stay fixed but msg gets a (XXs) elapsed suffix.
  async function withHeartbeat(stage, pct, baseMsg, work, intervalMs = 3000) {
    const t0 = Date.now()
    emit('progress', { stage, pct, msg: baseMsg })
    const ticker = setInterval(() => {
      const s = Math.round((Date.now() - t0) / 1000)
      emit('progress', { stage, pct, msg: `${baseMsg} (${s}s)` })
    }, intervalMs)
    try { return await work() }
    finally { clearInterval(ticker) }
  }

  try {
    const { argus, client, mode, strategy } = req.body || {}
    if (!argus?.base64 || !client?.base64) throw new Error('argus and client files required')
    const m = mode === 'dumb' ? 'claude-haiku-4-5' :
              mode === 'deluxe' ? 'claude-opus-4-7' :
              'claude-sonnet-4-6'
    // "Special" = ensemble standardization (two independent passes + tie-breaker).
    // Offered on Regular (Sonnet) and Dumb (Haiku — for cheap UX testing); not
    // on Deluxe, where a 2-3x Opus ensemble would be needlessly expensive.
    const special = strategy === 'special' && (mode === 'regular' || mode === 'dumb')
    console.log(`[compare] mode=${mode || 'regular'} strategy=${special ? 'special' : 'standard'} model=${m} argus=${argus.name} client=${client.name}`)

    // ── Step 1: parse Argus ──────────────────────────────
    emit('progress', { stage: 'parsing-argus', pct: 8, msg: 'Parsing Argus rent roll…' })
    const argusBuf = Buffer.from(argus.base64, 'base64')
    const parsedArgus = await parseFile(argusBuf, argus.name)
    let argusParsed
    if (parsedArgus.type === 'xlsx') {
      // Canonical path: a real Argus "Lease Summary Report" workbook parses
      // deterministically (5-row blocks) — no LLM needed.
      argusParsed = parseArgusFromSheets(parsedArgus.sheets)
    } else {
      // Argus exported as PDF/CSV/text (no spreadsheet grid). Standardize it with
      // the SAME LLM normalizer the client side uses — it emits the identical
      // canonical schema — then derive total SF the way the xlsx parser does.
      const norm = await withHeartbeat(
        'parsing-argus', 14,
        '🤖 Argus is a PDF — Claude is reading the Argus Lease Summary Report (20-60s)…',
        () => normalizeClient({ parsed: parsedArgus, filename: argus.name, model: m })
      )
      const tenants = norm.tenants || []
      const totalSF = tenants
        .filter(t => !t.isOption && !t.isReabsorbed && t.sqft)
        .reduce((s, t) => s + t.sqft, 0)
      argusParsed = { property: norm.property || null, tenants, totalSF }
    }
    console.log(`[compare] argus: ${argusParsed.tenants.length} tenants, ${(argusParsed.totalSF || 0).toLocaleString()} SF`)

    if (!argusParsed.tenants?.length) {
      throw new Error('Argus rent roll parsed empty — make sure the 🍎 Apples slot contains an Argus Lease Summary Report. If you uploaded the files in the wrong slots, click ✕ and swap.')
    }

    // ── Step 2: parse client (Pear) ──────────────────────
    emit('progress', { stage: 'parsing-client', pct: 18, msg: 'Reading client rent roll…' })
    const clientBuf = Buffer.from(client.base64, 'base64')
    const parsedClient = await parseFile(clientBuf, client.name)

    // ── Step 3: normalize Pear → Apple ───────────────────
    // This is a 20-60s Claude call. withHeartbeat keeps the UI alive so
    // the user sees the elapsed counter tick and doesn't think it hung.
    const clientNormalized = await withHeartbeat(
      'normalizing', 38,
      special
        ? '🔬 Special mode — running two independent extractions to cross-check the client rent roll…'
        : '🤖 Claude is reading the client rent roll — dense PDFs take 20-60s…',
      () => special
        ? normalizeClientEnsemble({
            parsed: parsedClient, filename: client.name, model: m,
            onStage: (s, info) => {
              if (s === 'tiebreak') {
                emit('progress', { stage: 'normalizing', pct: 46, msg: `🔬 Two passes disagreed on ${info?.count || 'some'} tenant(s) — running a tie-breaker pass…` })
              }
            },
          })
        : normalizeClient({ parsed: parsedClient, filename: client.name, model: m })
    )
    if (special && clientNormalized._ensemble) {
      const e = clientNormalized._ensemble
      emit('progress', { stage: 'normalizing-done', pct: 50, msg: `✓ Cross-check: ${e.agreed} tenant(s) matched on both passes · ${e.disputed} reconciled by tie-breaker` })
    }
    console.log(`[compare] client: ${clientNormalized.tenants.length} tenants, reported ${clientNormalized.topLevelTotalSF || '?'} SF`)

    // ── Steps 4-8: walk the spec checks in order ─────────
    // The actual reconcile() runs in one shot (pure JS, fast), but we emit
    // granular events so the user sees each check from the Word doc tick off.
    emit('progress', { stage: 'check-totals',   pct: 55, msg: 'Confirming property total SF (Argus col 2) — excluding options & reabsorbed suites…' })
    await tick()
    emit('progress', { stage: 'check-suite',    pct: 65, msg: 'Suite-by-suite (Argus col 1) — tenant name, suite, lease begin/end…' })
    await tick()
    emit('progress', { stage: 'check-baserent', pct: 73, msg: 'Base rent (Argus col 4) — comparing $/SF/yr with $0.02 rounding tolerance…' })
    await tick()
    emit('progress', { stage: 'check-steps',    pct: 81, msg: 'Rent steps (Argus cols 5–7) — date + amount per step…' })
    await tick()
    emit('progress', { stage: 'check-freerent', pct: 86, msg: 'Free rent (Argus col 9) — months or % abatement…' })
    await tick()
    emit('progress', { stage: 'check-pctrent',  pct: 90, msg: '% rent (Argus col 10) — breakpoint + overage %…' })
    await tick()

    // ── Run reconciliation (one shot, fast) — with learnings ──
    const propertyName = argusParsed.property || clientNormalized.property
    const learnings = propertyName ? forProperty(propertyName) : []
    if (learnings.length) console.log(`[compare] applying ${learnings.length} prior learning(s) for ${propertyName}`)
    const result = reconcile({ argus: argusParsed, client: clientNormalized, learnings })

    // ── Step 8.5: Orphan reunification ───────────────────
    // The deterministic matcher leaves leftovers (argusOnly + clientOnly).
    // Send BOTH lists to Claude in one call — the LLM is uniquely good at
    // catching DBA-vs-legal-name pairings the Levenshtein scoring missed.
    // Any new pairs get full compareTenants treatment so they show up in
    // the findings list like any other match.
    const orphanA = result.matches.filter(x => x.flags?.argusOnly).map(x => x.argus).filter(Boolean)
    const orphanC = result.matches.filter(x => x.flags?.clientOnly).map(x => x.client).filter(Boolean)
    if (orphanA.length && orphanC.length) {
      try {
        const { pairs } = await withHeartbeat(
          'reunify', 91,
          `🤖 Reunifying ${orphanA.length} Argus + ${orphanC.length} client unmatched tenants…`,
          () => reunifyOrphans(orphanA, orphanC)
        )
        if (pairs.length) {
          // For each AI-suggested pair: build a new match record using the
          // same compareTenants logic, then remove the old solo entries.
          for (const p of pairs) {
            const newMatch = compareTenantsExternal(p.argus, p.client)
            newMatch.matchedBy = 'ai-reunified'
            newMatch.matchScore = p.confidence
            newMatch.aiReunified = { reasoning: p.reasoning, confidence: p.confidence }
            // Drop the two orphan match entries
            result.matches = result.matches.filter(x =>
              !(x.flags?.argusOnly && x.argus === p.argus) &&
              !(x.flags?.clientOnly && x.client === p.client))
            result.matches.push(newMatch)
          }
          console.log(`[reunify] AI rescued ${pairs.length} orphan pair(s)`)
          emit('progress', { stage: 'reunify-done', pct: 91.5, msg: `✓ AI rescued ${pairs.length} additional tenant pair${pairs.length === 1 ? '' : 's'}` })
        }
      } catch (e) {
        console.warn('[reunify] failed (continuing):', e.message)
      }
    }

    // ── Step 9: AI second-pass verifier (always runs, even in dumb mode) ──
    // Sends each tenant's full Apple+Pear context plus its findings to Claude
    // Haiku for a sanity check. False positives get suppressed with reasoning.
    emit('progress', { stage: 'verifying', pct: 92, msg: '🤖 Second-pass cross-check — verifying findings against source data…' })
    try {
      const totalToVerify = result.matches.filter(m => (m.diffs || []).some(d => !d.suppressed)).length
      const verifyStart = Date.now()
      const { stats } = await verifyFindings(result.matches, (done, total) => {
        // Update the live progress message so user sees the second pass running
        const pct = 92 + Math.min(2, (done / Math.max(1, total)) * 2)
        emit('progress', { stage: 'verifying', pct, msg: `🤖 Verifying findings — ${done}/${total} tenants cross-checked…` })
      })
      const verifyMs = Date.now() - verifyStart
      console.log(`[verify] ${stats.reviewed} tenants reviewed in ${verifyMs}ms — ${stats.falsePositives} false positives suppressed, ${stats.confirmed} confirmed`)
      emit('progress', { stage: 'verifying-done', pct: 94, msg: `✓ Verifier: ${stats.falsePositives} false positives suppressed · ${stats.confirmed} confirmed · ${totalToVerify} tenants reviewed` })
    } catch (e) {
      console.warn('[verify] second-pass verifier failed (continuing without):', e.message)
      emit('progress', { stage: 'verifying-skip', pct: 94, msg: '⚠ Verifier skipped (continuing without)' })
    }

    emit('progress', { stage: 'rendering', pct: 95, msg: 'Plating up Excel report…' })

    const payload = {
      property: result.property,
      totals: result.totals,
      notes: result.notes,
      summary: result.summary,
      matches: result.matches,
      argusTenants: argusParsed.tenants,
      clientTenants: clientNormalized.tenants,
      argusFileType:  parsedArgus.type,
      clientFileType: parsedClient.type,
      // Rich styled sheet data for the client-side XLSX renderer (looks like
      // opening the workbook in Excel — col widths, merges, fills, fonts, borders).
      argusSheets:  parsedArgus.type  === 'xlsx' ? parsedArgus.sheets.slice(0, 1)  : null,
      clientSheets: parsedClient.type === 'xlsx' ? parsedClient.sheets.slice(0, 1) : null,
    }
    const excelBuf = await buildExcel(payload)

    emit('complete', {
      result: payload,
      excelBase64: excelBuf.toString('base64'),
      excelFilename: `RentRoll-${slug(result.property || 'property')}-${Date.now()}.xlsx`,
    })
  } catch (e) {
    console.error('[compare]', e)
    emit('error', { error: e.message || String(e) })
  } finally {
    clearInterval(heartbeat)
    res.end()
  }
})

/**
 * POST /api/export
 * Body: { payload: <complete payload from compare>, reviews: { [suiteKey]: { verdict, note } } }
 * Regenerates Excel embedding the reviews per matched tenant.
 */
app.post('/api/export', async (req, res) => {
  try {
    const { payload, reviews } = req.body || {}
    if (!payload) return res.status(400).json({ error: 'payload required' })
    for (const m of payload.matches || []) {
      const key = m.suiteKey || m.suite
      const r = reviews?.[key]
      if (r) m.review = r
    }
    const buf = await buildExcel(payload)
    res.json({
      excelBase64: buf.toString('base64'),
      excelFilename: `RentRoll-${slug(payload.property || 'property')}-reviewed-${Date.now()}.xlsx`,
    })
  } catch (e) {
    console.error('[export]', e)
    res.status(500).json({ error: e.message })
  }
})

// Tiny delay so each granular check stage gets its own paint frame on the client.
const tick = () => new Promise(r => setTimeout(r, 180))

function slug(s) {
  return String(s).replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'property'
}

app.listen(PORT, HOST, () => {
  console.log(`🍏  Apples to Apples listening on http://${HOST}:${PORT}`)
})
