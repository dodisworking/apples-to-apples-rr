// Auto-detect Argus vs Client based on file content.
// Argus exports have a very specific signature in the first ~25 rows / 2k chars.

const ARGUS_MARKERS = [
  /Rental Value Per Year/i,
  /Building Share/i,
  /Initial Area/i,
  /Recovery Structure/i,
  /Market Leasing/i,
  /Lease Summary Report/i,
  /Rate Per Year/i,
  /Amount Per Month/i,
  /Renewal Assumption/i,
  /Rent Changes On/i,
]

const CLIENT_HINTS = [
  /Period Ending/i,
  /Operating Expense/i,
  /Est\.\s*(CAM|Tax|Ins)/i,
  /Real Estate Tax/i,
  /Total Rent PSF/i,
  /CONTAINER CHARGE/i,
  /MONTHLY CAM/i,
  /Renewal Options/i,
  /Tax Stop/i,
  /Rent Increases/i,
]

export function detect(text, filename = '') {
  const haystack = (text || '').slice(0, 4000)
  const argusHits = ARGUS_MARKERS.map(m => m.source).filter(m => new RegExp(m, 'i').test(haystack))
  const clientHits = CLIENT_HINTS.map(m => m.source).filter(m => new RegExp(m, 'i').test(haystack))

  let score = argusHits.length * 2 - clientHits.length
  if (/argus/i.test(filename)) score += 3
  if (/client/i.test(filename)) score -= 3

  return { score, argusHits, clientHits, isArgus: score >= 3 }
}

export function decideRoles(detA, detB) {
  let argus, client
  if (detA.score > detB.score) { argus = 'A'; client = 'B' }
  else if (detB.score > detA.score) { argus = 'B'; client = 'A' }
  else { argus = 'A'; client = 'B' }   // arbitrary tie-break; user can swap
  return { argus, client }
}
