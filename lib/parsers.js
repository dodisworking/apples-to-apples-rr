// Shared file-parsing helpers (xlsx + pdf).
//
// Goal: produce a uniform `{ type, sheets?, pages? }` representation
// that downstream code can iterate without caring about source format.

import ExcelJS from 'exceljs'
import pdfParse from 'pdf-parse/lib/pdf-parse.js'

/** Parse XLSX → { type:'xlsx', sheets: [{ name, rows: cell[][] }], text } */
export async function parseXlsx(buffer) {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer))
  const sheets = []
  wb.eachSheet((ws) => {
    const rows = []
    ws.eachRow({ includeEmpty: true }, (row) => {
      const cells = []
      row.eachCell({ includeEmpty: true }, (c) => cells.push(normalizeCell(c.value)))
      rows.push(cells)
    })
    sheets.push({ name: ws.name, rows })
  })
  const text = sheets.map(s =>
    `=== SHEET: ${s.name} ===\n` + s.rows.map(r => r.map(c => c ?? '').join('\t')).join('\n')
  ).join('\n\n')
  return { type: 'xlsx', sheets, text }
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
