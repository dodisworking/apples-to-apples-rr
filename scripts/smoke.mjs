// End-to-end smoke test against all 4 sample properties.
// Calls /api/compare on a locally-running server.

import fs from 'node:fs/promises'
import path from 'node:path'

const BASE = process.env.BASE || 'http://localhost:3790'
const PAIRS = [
  {
    name: 'Stanford Station',
    argus:  '/Users/jarvis/Downloads/Brixmor- Stanford Station- AI Rent Roll Comp 3/Argus RR/BRX- Stanford Station- Argus RR (Before).xlsx',
    client: '/Users/jarvis/Downloads/Brixmor- Stanford Station- AI Rent Roll Comp 3/Client RR/Stanford Station RR.pdf',
  },
  {
    name: 'Mayfair',
    argus:  '/Users/jarvis/Downloads/Rent Roll Tests for Isaac for 3 Sample Properties/Mayfair Shopping Center/Argus RR/Mayfair Shopping Center - Argus RR- BEFORE.xlsx',
    client: '/Users/jarvis/Downloads/Rent Roll Tests for Isaac for 3 Sample Properties/Mayfair Shopping Center/Client RR/Mayfair Shopping Center - Rent Roll- Client RR.pdf',
  },
  {
    name: 'Northwood',
    argus:  '/Users/jarvis/Downloads/Rent Roll Tests for Isaac for 3 Sample Properties/Northwood Plaza/Argus RR /BRX UW - Northwood Plaza- Argus RR- BEFORE.xlsx',
    client: '/Users/jarvis/Downloads/Rent Roll Tests for Isaac for 3 Sample Properties/Northwood Plaza/Client RR/2026-02 12 Rent Roll 179- Client RR.pdf',
  },
  {
    name: 'Vintage',
    argus:  '/Users/jarvis/Downloads/Rent Roll Tests for Isaac for 3 Sample Properties/Vintage Marketplace/Argus RR 9/Vintage Marketplace (Jan-25) - Argus RR- BEFORE.xlsx',
    client: '/Users/jarvis/Downloads/Rent Roll Tests for Isaac for 3 Sample Properties/Vintage Marketplace/Client RR/Vintage Marketplace Rent Roll - 1.26.26- Client RR.xlsx',
  },
]

async function toB64(p) { return (await fs.readFile(p)).toString('base64') }

async function run(pair) {
  console.log(`\n══════════ ${pair.name} ══════════`)
  const argus  = { name: path.basename(pair.argus),  base64: await toB64(pair.argus)  }
  const client = { name: path.basename(pair.client), base64: await toB64(pair.client) }

  const resp = await fetch(`${BASE}/api/compare`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ argus, client, mode: 'regular' }),
  })
  if (!resp.ok || !resp.body) { console.error('HTTP', resp.status, await resp.text()); return null }

  const reader = resp.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  let result = null
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
      const p = JSON.parse(data)
      if (ev === 'progress') process.stdout.write(`  [${p.pct}%] ${p.stage}: ${p.msg}\n`)
      else if (ev === 'complete') { result = p; console.log('  ✓ complete') }
      else if (ev === 'error') { console.error('  ✗ error:', p.error); return null }
    }
  }

  const r = result?.result
  if (!r) return null
  console.log(`\n  property:         ${r.property}`)
  console.log(`  argus total SF:   ${r.totals.argus?.toLocaleString()} (${r.argusTenants.length} tenants — ${r.argusTenants.filter(t=>!t.isOption&&!t.isContractRenewal).length} active)`)
  console.log(`  client total SF:  ${r.totals.client?.toLocaleString()} (${r.clientTenants.length} tenants — ${r.clientTenants.filter(t=>!t.isOption).length} active)`)
  if (r.totals.clientReported) console.log(`  client reported:  ${r.totals.clientReported.toLocaleString()} SF`)
  if (r.totals.diff != null) console.log(`  diff:             ${r.totals.diff > 0 ? '+' : ''}${r.totals.diff.toLocaleString()} SF`)
  console.log(`\n  reconciliation:`)
  console.log(`    matched:        ${r.summary.matched}`)
  console.log(`    clean:          ${r.summary.clean}`)
  console.log(`    with diffs:     ${r.summary.withDiffs}`)
  console.log(`    argus only:     ${r.summary.argusOnly}`)
  console.log(`    client only:    ${r.summary.clientOnly}`)
  console.log(`    HIGH findings:  ${r.summary.highSeverityCount}`)

  if (r.notes?.length) {
    console.log(`\n  notes:`)
    for (const n of r.notes) console.log(`    • ${n}`)
  }

  const diffMatches = r.matches.filter(m => !m.flags.clean && !m.flags.argusOnly && !m.flags.clientOnly).slice(0, 8)
  if (diffMatches.length) {
    console.log(`\n  sample discrepancies (first ${diffMatches.length}):`)
    for (const m of diffMatches) {
      console.log(`    Suite ${m.suite} — ${m.argus?.name || ''} ↔ ${m.client?.name || ''}`)
      for (const d of m.diffs.slice(0, 4)) {
        console.log(`      · [${d.severity}] ${d.label}: "${d.argusValue}" vs "${d.clientValue}"`)
      }
    }
  }

  const argusOnly = r.matches.filter(m => m.flags.argusOnly).slice(0, 3)
  const clientOnly = r.matches.filter(m => m.flags.clientOnly).slice(0, 3)
  if (argusOnly.length) {
    console.log(`\n  argus-only sample:`)
    for (const m of argusOnly) console.log(`    Suite ${m.suite} — ${m.argus?.name}`)
  }
  if (clientOnly.length) {
    console.log(`\n  client-only sample:`)
    for (const m of clientOnly) console.log(`    Suite ${m.suite} — ${m.client?.name}`)
  }

  const out = path.join('/tmp/a2a', `${pair.name.replace(/\s+/g, '-')}.xlsx`)
  await fs.mkdir(path.dirname(out), { recursive: true })
  await fs.writeFile(out, Buffer.from(result.excelBase64, 'base64'))
  console.log(`\n  → wrote ${out}`)
  return r
}

for (const pair of PAIRS) {
  try { await run(pair) }
  catch (e) { console.error('FAILED:', e.message) }
}
