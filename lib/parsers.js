// Shared file-parsing helpers (xlsx + pdf).
//
// Goal: produce a uniform `{ type, sheets?, pages? }` representation
// that downstream code can iterate without caring about source format.

import ExcelJS from 'exceljs'
import pdfParse from 'pdf-parse/lib/pdf-parse.js'

/** Parse XLSX → { type:'xlsx', sheets: [{ name, rows: cell[][], styled }], text }
 *
 * `styled` is a richer representation used by the client-side high-fidelity renderer:
 *   {
 *     colWidths: [number|null, ...],        // Excel column widths (chars)
 *     rowHeights: [number|null, ...],       // Excel row heights (pts)
 *     merges: [{ top, left, bottom, right }, ...],   // 0-based merged cell ranges
 *     cells: [[ { v, f?, b?, c?, a?, bg?, brd? }, ... ], ...]
 *                  // v=value (number|string|null)
 *                  // f=font {n,s,b,i,c}  (name, size, bold, italic, colorHex)
 *                  // bg=fill background colorHex
 *                  // a=alignment {h,v}  horizontal, vertical
 *                  // brd=border {t,b,l,r}  thin/medium/thick or 0
 *   }
 */
export async function parseXlsx(buffer) {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer))
  const sheets = []
  wb.eachSheet((ws) => {
    const rows = []
    const styledCells = []
    let maxCols = 0
    ws.eachRow({ includeEmpty: true }, (row) => {
      const cells = []
      const styled = []
      row.eachCell({ includeEmpty: true }, (c) => {
        cells.push(normalizeCell(c.value))
        styled.push(extractCellStyle(c))
      })
      if (cells.length > maxCols) maxCols = cells.length
      rows.push(cells)
      styledCells.push(styled)
    })

    // Column widths (chars, Excel-native units) — pad to maxCols
    const colWidths = []
    for (let i = 1; i <= maxCols; i++) {
      const col = ws.getColumn(i)
      colWidths.push(col?.width || null)
    }
    // Row heights (points)
    const rowHeights = rows.map((_, i) => ws.getRow(i + 1)?.height || null)

    // Merged cell ranges (0-based for the client)
    const merges = []
    if (ws.model?.merges) {
      for (const mref of ws.model.merges) {
        // mref like "A1:C2" — decode
        const m = mref.match(/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/)
        if (m) {
          merges.push({
            top:    parseInt(m[2], 10) - 1,
            left:   colLetterToIdx(m[1]),
            bottom: parseInt(m[4], 10) - 1,
            right:  colLetterToIdx(m[3]),
          })
        }
      }
    }

    sheets.push({
      name: ws.name,
      rows,
      styled: { colWidths, rowHeights, merges, cells: styledCells },
    })
  })
  const text = sheets.map(s =>
    `=== SHEET: ${s.name} ===\n` + s.rows.map(r => r.map(c => c ?? '').join('\t')).join('\n')
  ).join('\n\n')
  return { type: 'xlsx', sheets, text }
}

function extractCellStyle(c) {
  const out = {}
  // value
  out.v = normalizeCell(c.value)
  // font
  if (c.font) {
    const f = {}
    if (c.font.name)  f.n = c.font.name
    if (c.font.size)  f.s = c.font.size
    if (c.font.bold)  f.b = 1
    if (c.font.italic) f.i = 1
    if (c.font.color?.argb) f.c = argbToHex(c.font.color.argb)
    if (Object.keys(f).length) out.f = f
  }
  // fill
  if (c.fill?.fgColor?.argb) {
    out.bg = argbToHex(c.fill.fgColor.argb)
  }
  // alignment
  if (c.alignment) {
    const a = {}
    if (c.alignment.horizontal) a.h = c.alignment.horizontal
    if (c.alignment.vertical)   a.v = c.alignment.vertical
    if (Object.keys(a).length) out.a = a
  }
  // borders (collapsed to t/b/l/r presence — keeps payload small)
  if (c.border) {
    const b = {}
    if (c.border.top?.style)    b.t = 1
    if (c.border.bottom?.style) b.b = 1
    if (c.border.left?.style)   b.l = 1
    if (c.border.right?.style)  b.r = 1
    if (Object.keys(b).length) out.brd = b
  }
  // number format hint (just for currency / accounting detection)
  if (c.numFmt && /[$£€¥]/.test(c.numFmt)) out.fmt = 'money'
  else if (c.numFmt && /%/.test(c.numFmt))  out.fmt = 'pct'
  else if (typeof c.value === 'number' && !Number.isInteger(c.value)) out.fmt = 'num'

  return out
}

function colLetterToIdx(letters) {
  let n = 0
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n - 1
}

function argbToHex(argb) {
  // ARGB hex (e.g. "FF1E3A5F") → "#1E3A5F"
  if (!argb || argb.length < 6) return null
  return '#' + argb.slice(-6)
}

/** Parse PDF → { type:'pdf', text, pages } */
export async function parsePdf(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer)
  try {
    const data = await pdfParse(buf)
    const text = data.text?.trim() || ''
    return { type: 'pdf', text, pages: data.numpages || 0, scanned: text.length < 80 }
  } catch (e) {
    return { type: 'pdf', text: '', pages: 0, scanned: true, error: e.message }
  }
}

/** Dispatcher by filename. */
export async function parseFile(buffer, filename) {
  const lower = (filename || '').toLowerCase()
  if (lower.endsWith('.xlsx') || lower.endsWith('.xls')) return parseXlsx(buffer)
  if (lower.endsWith('.pdf'))                              return parsePdf(buffer)
  if (lower.endsWith('.csv')) {
    return { type: 'csv', text: Buffer.from(buffer).toString('utf-8') }
  }
  return { type: 'text', text: Buffer.from(buffer).toString('utf-8') }
}

function normalizeCell(val) {
  if (val == null) return ''
  if (val instanceof Date) return formatDate(val)
  if (typeof val === 'object') {
    if (val.result !== undefined) {
      const r = val.result
      if (r instanceof Date) return formatDate(r)
      return r == null ? '' : (typeof r === 'number' ? r : String(r))
    }
    if (val.richText) return val.richText.map(rt => rt.text || '').join('')
    if (val.text)     return String(val.text)
    if (val.hyperlink) return String(val.text || val.hyperlink || '')
    return ''
  }
  return val
}

function formatDate(d) {
  return d.toLocaleDateString('en-US', { month: 'numeric', day: 'numeric', year: 'numeric' })
}
