// ─────────────────────────────────────────────────────────────────────────
// Tiny dependency-free PDF text writer (just enough to emit realistic,
// text-extractable rent-roll PDFs that pdf-parse / pdf.js can read back).
//
// Standard Type1 Helvetica fonts (no embedding). Letter pages (612×792 pt).
// You give it lines: { x, y, text, size?, font? }, grouped per page.
//
//   const pdf = buildPdf(pages)   // pages: [ [ {x,y,text}, ... ], ... ]
//   await fs.writeFile('out.pdf', pdf)   // pdf is a Buffer
// ─────────────────────────────────────────────────────────────────────────

const esc = s => String(s).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)').replace(/\r/g, ' ').replace(/\n/g, ' ')

// Build one page content stream from an array of text items.
function contentStream(items) {
  let s = ''
  for (const it of items) {
    const size = it.size || 10
    const font = it.font === 'bold' ? '/F2' : '/F1'
    s += `BT ${font} ${size} Tf 1 0 0 1 ${it.x.toFixed(2)} ${it.y.toFixed(2)} Tm (${esc(it.text)}) Tj ET\n`
  }
  return s
}

export function buildPdf(pages) {
  // Object layout:
  //  1 Catalog, 2 Pages, 3 Helvetica, 4 Helvetica-Bold,
  //  then per page: Page obj + Content obj (2 objects each).
  const objects = []
  const pageObjNums = []
  let nextNum = 5
  const contentChunks = []
  for (const items of pages) {
    const pageNum = nextNum++
    const contentNum = nextNum++
    pageObjNums.push(pageNum)
    contentChunks.push({ pageNum, contentNum, items })
  }

  objects[1] = `1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`
  objects[2] = `2 0 obj\n<< /Type /Pages /Kids [${pageObjNums.map(n => `${n} 0 R`).join(' ')}] /Count ${pageObjNums.length} >>\nendobj\n`
  // /Encoding /WinAnsiEncoding makes char code 0x27 map to a straight apostrophe
  // (U+0027). Without it, base14 fonts default to StandardEncoding where 0x27 is
  // "quoteright" → U+2019, which silently mangles names like "Claire's" on
  // extraction. Real-world PDFs use WinAnsiEncoding, so this is the faithful choice.
  objects[3] = `3 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>\nendobj\n`
  objects[4] = `4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>\nendobj\n`

  for (const { pageNum, contentNum, items } of contentChunks) {
    objects[pageNum] = `${pageNum} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
      `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentNum} 0 R >>\nendobj\n`
    const stream = contentStream(items)
    objects[contentNum] = `${contentNum} 0 obj\n<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream\nendobj\n`
  }

  // Assemble with a correct xref table.
  let pdf = '%PDF-1.4\n'
  const offsets = []
  for (let i = 1; i < objects.length; i++) {
    if (!objects[i]) continue
    offsets[i] = Buffer.byteLength(pdf)
    pdf += objects[i]
  }
  const xrefStart = Buffer.byteLength(pdf)
  const count = objects.length // includes index 0 placeholder
  pdf += `xref\n0 ${count}\n`
  pdf += `0000000000 65535 f \n`
  for (let i = 1; i < count; i++) {
    if (offsets[i] == null) { pdf += `0000000000 65535 f \n`; continue }
    pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`
  }
  pdf += `trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`
  return Buffer.from(pdf, 'latin1')
}

// ── Simple table layout helper ──────────────────────────────────────────────
// Lay out a header + rows as a grid across pages. Returns pages[] for buildPdf.
//   cols: [{ x, w?, align? }]  (x = left edge in pt)
//   title lines, header cells, body rows
export function layoutTable({ titleLines = [], header = [], rows = [], cols, rowHeight = 16, top = 740, bottom = 60, fontSize = 9 }) {
  const pages = []
  let items = []
  let y = top

  const place = (cells, opts = {}) => {
    cells.forEach((c, i) => {
      if (c == null || c === '') return
      const col = cols[i] || cols[cols.length - 1]
      items.push({ x: col.x, y, text: String(c), size: opts.size || fontSize, font: opts.font })
    })
  }

  for (const t of titleLines) { items.push({ x: 40, y, text: t.text, size: t.size || 13, font: t.font || 'bold' }); y -= (t.gap || 20) }
  if (header.length) { place(header, { font: 'bold' }); y -= rowHeight + 2 }

  for (const row of rows) {
    if (y < bottom) { pages.push(items); items = []; y = top }
    // a row can be an array (single line) OR { cells, sub:[strings] } for wrapped detail
    if (Array.isArray(row)) { place(row); y -= rowHeight }
    else {
      place(row.cells); y -= rowHeight
      for (const line of (row.sub || [])) {
        if (y < bottom) { pages.push(items); items = []; y = top }
        items.push({ x: (row.subX ?? 60), y, text: line, size: fontSize - 1 }); y -= rowHeight - 2
      }
    }
  }
  pages.push(items)
  return pages
}
