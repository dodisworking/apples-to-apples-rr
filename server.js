import 'dotenv/config'
import express from 'express'
import path from 'path'
import { fileURLToPath } from 'url'
import { parseFile } from './lib/parsers.js'
import { detect, decideRoles } from './lib/detect.js'
import { parseArgusFromSheets } from './lib/argus.js'
import { normalizeClient } from './lib/client.js'
import { reconcile } from './lib/reconcile.js'
import { buildExcel } from './lib/excel.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname  = path.dirname(__filename)

const app  = express()
const PORT = process.env.PORT || 3790
const HOST = process.env.HOST?.trim() || '0.0.0.0'

app.use(express.json({ limit: '200mb' }))
app.use(express.static(path.join(__dirname, 'public')))

app.get('/api/health', (_req, res) => res.json({ ok: true, name: 'apples-to-apples-rr' }))

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

  try {
    const { argus, client, mode } = req.body || {}
    if (!argus?.base64 || !client?.base64) throw new Error('argus and client files required')
    const m = mode === 'dumb' ? 'claude-haiku-4-5' :
              mode === 'deluxe' ? 'claude-opus-4-7' :
              'claude-sonnet-4-6'
    console.log(`[compare] mode=${mode || 'regular'} model=${m} argus=${argus.name} client=${client.name}`)

    emit('progress', { stage: 'parsing-argus', pct: 10, msg: 'Parsing Argus rent roll…' })
    const argusBuf = Buffer.from(argus.base64, 'base64')
    const parsedArgus = await parseFile(argusBuf, argus.name)
    const argusParsed = parseArgusFromSheets(parsedArgus.sheets)
    console.log(`[compare] argus: ${argusParsed.tenants.length} tenants, ${argusParsed.totalSF.toLocaleString()} SF`)

    emit('progress', { stage: 'parsing-client', pct: 25, msg: 'Reading client rent roll…' })
    const clientBuf = Buffer.from(client.base64, 'base64')
    const parsedClient = await parseFile(clientBuf, client.name)

    emit('progress', { stage: 'normalizing', pct: 45, msg: 'Turning pear into apple — normalizing client to Argus format…' })
    const clientNormalized = await normalizeClient({ parsed: parsedClient, filename: client.name, model: m })
    console.log(`[compare] client: ${clientNormalized.tenants.length} tenants, reported ${clientNormalized.topLevelTotalSF || '?'} SF`)

    emit('progress', { stage: 'reconciling', pct: 80, msg: 'Matching and diffing apple to apple…' })
    const result = reconcile({ argus: argusParsed, client: clientNormalized })

    emit('progress', { stage: 'rendering', pct: 95, msg: 'Plating up Excel report…' })
    const payload = {
      property: result.property,
      totals: result.totals,
      notes: result.notes,
      summary: result.summary,
      matches: result.matches,
      argusTenants: argusParsed.tenants,
      clientTenants: clientNormalized.tenants,
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

function slug(s) {
  return String(s).replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'property'
}

app.listen(PORT, HOST, () => {
  console.log(`🍏  Apples to Apples listening on http://${HOST}:${PORT}`)
})
