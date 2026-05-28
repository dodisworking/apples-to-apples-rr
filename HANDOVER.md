# Apples to Apples — Handover

A web app that reconciles two rent rolls (Argus XLSX vs Client PDF/XLSX) and surfaces every discrepancy with source-document highlights and AI-verified false-positive removal.

**Live**: https://apples-to-apples-rr-production.up.railway.app

---

## The mission, in one sentence

Match every Argus tenant to its counterpart in the client rent roll. For each match: tell the user **what doesn't reconcile, what's missing, and where to look in the source documents.**

The whole "apples to apples" idea is that rent rolls are NOT standardized across formats. The program's job is to **translate values into a common axis** before declaring a discrepancy. A finding that the deterministic rules flag often turns out to be the same lease shown in a different representation ($/SF/yr vs annual total, DBA vs legal name). The AI verifier exists to catch and remove those false positives so only real discrepancies remain.

The validation spec the program follows is in `/Users/jarvis/Downloads/Rent Roll Validation 051126.docx` (extracted into the verifier prompt — see `lib/verifier.js`).

---

## The pipeline (top to bottom)

```
1. Upload    →  Argus XLSX + Client PDF/XLSX (drag-and-drop UI)
2. Detect    →  pick which slot is which (Argus is always the apple)
3. Process   →  SSE stream of progress events:
                 (a) Parse Argus deterministically       lib/argus.js
                 (b) Read raw Client text                lib/parsers.js
                 (c) 🤖 Normalize Client → Argus shape   lib/client.js   ← Claude (Sonnet/Haiku/Opus)
                 (d) Spec-check stages (UI flavor only)
                 (e) Deterministic matcher + comparator  lib/reconcile.js
                 (f) 🤖 Orphan reunifier                 lib/verifier.js ← Claude Haiku
                 (g) 🤖 Verifier removes false positives lib/verifier.js ← Claude Haiku
                 (h) Build Excel report                  lib/excel.js
4. Review    →  Side-by-side per-tenant drawer + full-screen cross-reference modal
                 - Per-finding 👍 Confirm / 👎 Reject / ↺ Clear
                 - Notes persist as learnings (lib/learnings.js)
                 - Excel re-exported with reviews baked in
```

---

## File layout

```
.
├── server.js              Express + SSE orchestration
├── lib/
│   ├── parsers.js         PDF / XLSX file-type detection + text extraction
│   ├── detect.js          Decide which uploaded file goes in which slot
│   ├── argus.js           Deterministic parser for Argus Lease Summary XLSX
│   ├── client.js          🤖 Claude-driven normalizer (client RR → Argus shape)
│   ├── reconcile.js       Tenant matcher + rule-based per-pair comparator
│   ├── verifier.js        🤖 AI second-pass: orphan reunify + false-positive removal
│   ├── learnings.js       Per-property review persistence
│   └── excel.js           Build the 4-sheet output report
├── public/
│   ├── index.html         Stages, drawer, cross-reference modal
│   ├── app.js             Frontend driver (≈2000 LOC, all stages + interactions)
│   └── style.css          All visual styles
└── railway.toml           Deployment config
```

---

## Key concepts

### Argus parser

The Argus Lease Summary Report has a fixed 5-row block per tenant starting at row 13. Each tenant block has:

| Col | Row 0 | Row 1 | Row 2 | Row 3 | Row 4 |
|-----|---|---|---|---|---|
| 0 | name | suite | dates | term | tenure |
| 1 | SF | building share % | — | — | — |
| 2 | status | — | lease type | category | — |
| 3 | $/SF/yr | $/yr | $/SF/mo | $/mo | (Rental Value — ignore) |
| 4-7 | rent steps (date, $/SF-Annual, $/SF-Monthly) — variable rows |
| 8-9 | free rent (date, months OR decimal abatement) |
| 10 | sales vol (row 0), breakpoint (row 1), overage % (row 2) |
| 11 | misc rent — **IGNORE** |
| 17 | renewal assumption — used to detect Reabsorbed |

Excluded from totals: reabsorbed suites, `(Option N)` / `(Contract Renewal N)` rows in the name column.

### Tenant matcher

The deterministic matcher in `reconcile.js#matchTenants` scores every (Argus, Client) pair across three signals:

```
score = nameSim × 0.55  +  suiteExact × 0.30  +  sfWithin0.5% × 0.15
```

where `nameSim` = `max(levenshtein, substringContainment)` over normalized strings (strips LLC/Inc/Corp/store-numbers, removes non-alphanum, lowercase). Threshold 0.45.

Test:
```
Barberito's <-> BARBERITOS              = 1.00 ✓
Academy Sports <-> ACADEMY SPORTS + OUTDO = 0.72
Dollar General <-> DOLLAR GENERAL #9621 = 0.76
Black Tie Formal Wear <-> BLACK TIE FORMALWEAR = 1.00
Barberito's <-> BLACK TIE FORMALWEAR    = 0.22 ✗
```

### AI second pass (lib/verifier.js)

Two functions, both using **claude-haiku-4-5** (cheap, fast, always on):

1. **`reunifyOrphans(argusOnly, clientOnly)`** — sends both unmatched lists to Claude in ONE call asking "are any of these the same business?" Catches DBA-vs-legal pairings the deterministic matcher missed. Pairs at ≥0.60 confidence get full `compareTenants` treatment.

2. **`verifyFindings(matches, onProgress)`** — for each matched tenant with findings, sends Argus tenant + Client tenant + findings list to Claude with the full Rent Roll Validation spec embedded in the system prompt. Claude returns a verdict per finding (`confirmed` or `false_positive`) with reasoning. False positives are **spliced out** of `m.diffs` entirely and archived on `m.aiRemoved` for transparency + override.

The system prompts know the user's rules from the spec: $0.02/SF rounding tolerance, 4 base-rent representations are equivalent, rent steps in different reps can be translated, etc. See `SYSTEM_PROMPT` in `lib/verifier.js`.

### Location metadata on every finding

Every diff in `lib/reconcile.js` is stamped with `_loc`:

```js
d._loc = {
  argus: { col: 1, rowOffset: 0, label: 'Initial Area (Col 1 row 0)' },
  clientHeader: 'Area / Sq Ft',
  argusAbsoluteRow: 14
}
```

The frontend `renderXlsxSheet` uses `argusAbsoluteRow + rowOffset` for deterministic cell highlighting on the Argus side. For the Pear (PDF) side, `clientHeader` drives a column-header-aware fallback when literal value search misses (`locateInPdf` Phase 2.5 in `public/app.js`).

---

## Frontend: drawer vs cross-reference

Two review surfaces, both backed by the same `state.reviews` store:

**Per-tenant drawer (`#drawer` in `index.html`)** — slides up from bottom. Shows:
- Title + match-by badge (`🔑 by suite 95%` / `🅰 by name 87%` / `🤖 AI-reunified`)
- Three open-original buttons (📊 Argus Excel · 📄 Client RR · 🔍 Cross-reference)
- Findings list (sticky-pinned active card with Confirm/Reject)
- AI-removed disclosure block (false positives the verifier filtered, restorable)
- Side-by-side source documents (Argus full Excel + Client PDF/Excel with red cell on active finding)

**Cross-reference modal (`#pdfReviewer`)** — full screen split-pane. Shows:
- Drag-resizable divider, per-side ⛶ fullscreen, per-side zoom
- Top selector walks findings (not tenants) so prev/next steps through every finding sequentially
- Click any finding in the foot list → both canvases re-render with the new pinpoint
- Inline Confirm/Reject on each foot card

The drawer's source previews are visible **by default** — that was a fix from a recent iteration. The active finding card is `position: sticky; top: 0` so Confirm/Reject is always reachable while the user scrolls sources.

### Highlighter precision

The Pear/Client PDF highlighter (`locateInPdf` in `public/app.js`) has three phases:

1. **Anchor**: find the tenant's row by suite # then 2-word name then single tokens. Pick the topmost (smallest Y) hit.
2. **Value search**: build needles for the target value (currency variants, date variants — `12/31/2025` → `Dec 31, 2025` etc.). Search within ±12pt of the anchor. Pick the **single closest hit** scored by `Δy × 5 + Δx` (don't union, that produces giant page-wide stripes when the needle is generic like `"0.00"`).
3. **Column-header fallback**: if value-needle search missed, scan the top 45% of the page for header text matching `PDF_FIELD_HEADER_RE[fieldKey]` regexes (`/sq ?ft/`, `/exp\.?\s*date/`, etc.). Pick the bottom-most matching header. Draw a cell-sized box at `(anchor.y, header.x)`.

The Argus/XLSX side uses the deterministic `ARGUS_FIELD_CELL` map — no text matching, just `(rowOffset, col)` from the field key.

---

## SSE flow

Server emits `event: progress` / `event: complete` / `event: error` over a chunked HTTP response. The frontend `consumeSSE()` (in `public/app.js`) reads and dispatches.

Long Claude calls are wrapped in `withHeartbeat()` (in `server.js`) — every 3 seconds, the same progress event re-fires with elapsed seconds appended to the message. Without this, the user sees a frozen "Pear → Apple, 7s" for 30 seconds and thinks the app hung.

Stall watchdog client-side: 240s of no progress event → abort + alert.

Diagnostic logging: every meaningful client-side event emits `[A2A] tag {json}` into a 400-line ring buffer at `state.debugLog`. Press **📋 Copy logs** in the cross-reference header to copy them to clipboard. Or `__a2aCopyLogs()` in DevTools.

---

## Models / modes

Three modes selected via radio buttons in the top bar, mapped in `server.js`:

```
dumb    → claude-haiku-4-5    (fastest, cheapest)
regular → claude-sonnet-4-6   (default)
deluxe  → claude-opus-4-7     (slowest, best)
```

The mode applies ONLY to the client normalizer. The verifier + reunifier always use **claude-haiku-4-5** (they're constrained tasks with structured output — Haiku is plenty).

Environment: `ANTHROPIC_API_KEY` (loaded via `dotenv`). On Railway it's set in the project's variables.

---

## Setup / running locally

```bash
npm install
ANTHROPIC_API_KEY=sk-ant-... npm start
# → http://localhost:3790
```

The project root expects an Argus `.xlsx` and a client `.pdf` or `.xlsx`. There's a folder of test samples on the user's machine at `/Users/jarvis/Downloads/Rent Roll Tests/` (Isaac shared 3 properties: Stanford Station, Mayfair Center, and a third).

---

## Deployment

Auto-deploys on `git push` to `main` via Railway's GitHub integration. Service name: `confident-youth`. Watch for `[compare]` / `[verify]` / `[reunify]` log lines in the Railway dashboard for backend signals.

Most common deploy failure mode: Railway sometimes silently doesn't pick up a commit. The fix is an empty commit to nudge it:

```bash
git commit --allow-empty -m "kick Railway"
git push
```

---

## Where to look in the code

| You want to change… | Look at… |
|---|---|
| The matcher's signals or threshold | `lib/reconcile.js#matchTenants` |
| A new comparison rule | `lib/reconcile.js#compareTenants` + add an entry to `ARGUS_LOC` / `CLIENT_HEADER` |
| The verifier's understanding of the spec | `lib/verifier.js#SYSTEM_PROMPT` |
| How orphans get re-paired | `lib/verifier.js#reunifyOrphans` + `REUNIFY_SYSTEM` |
| Client normalizer prompt | `lib/client.js#SYSTEM` |
| The drawer layout | `renderDrawerBody` + `openDrawer` in `public/app.js` |
| Highlight precision | `locateInPdf` in `public/app.js` and `ARGUS_FIELD_CELL` map |
| Excel report sheets | `lib/excel.js` |
| Progress stage labels | `STAGE_TO_HEADLINE` in `public/app.js` |

---

## Open todos / known limits

- **OCR for scanned PDFs**: `lib/parsers.js` returns `[SCANNED_PDF…]` placeholder when no text layer is detected. Normalizer short-circuits to empty tenants. Need to wire in tesseract or a hosted OCR.
- **LLM location hints in verifier output**: the verifier prompt asks for `argusLocation` + `clientLocation` strings but the frontend doesn't yet consume them to refine the highlight. Easy follow-up.
- **Multi-page client PDFs**: `locateInPdf` returns the first page where the anchor matches. If a tenant spans pages we only show one. Rarely an issue in practice.
- **Cross-tenant validation**: e.g. total SF reconciliation across the whole property. Spec mentions this; currently we only check at the tenant level.
- **Learnings reuse**: `lib/learnings.js` persists per-property feedback but the matcher / verifier don't yet read prior learnings to bias decisions. The reconciler does apply suppressed/confirmed learnings to individual findings.

---

## The Word doc spec

`/Users/jarvis/Downloads/Rent Roll Validation 051126.docx` is the ground truth. Skim every six months and re-check whether the verifier prompt is still aligned. The key invariants:

- $0.02/SF rounding tolerance on base rent comparisons
- The 4 base-rent reps ($/SF/yr, $/yr, $/SF/mo, $/mo) are equivalent — translate before comparing
- Rent steps in any rep should be translated to the same axis
- Free rent codes vary: base rent typically starts R/B/M; CAM/TAX/INS/SEC/REC are excluded
- % rent: ONLY Breakpoint and Overage %. Sales Volume is rarely on source — don't flag.
- Misc Rent column (Col 11): **ignore entirely**
- Renewal options (rows with dates beyond lease expiration): **defer**

---

## Quick mental model of "what the AI calls do"

1. **Client normalizer** (Sonnet/Haiku/Opus depending on mode): "Read this messy client rent roll. Output it as JSON in the Argus 5-row schema."
2. **Orphan reunifier** (Haiku): "Here are Argus tenants we couldn't pair and Client tenants we couldn't pair. Are any of these the same business?"
3. **Verifier** (Haiku, one call per tenant with findings): "Here's an Argus tenant + its Client pair + the discrepancies our deterministic rules flagged. Apply the spec. For each finding: confirmed real, or false positive — show your math."

Everything else is deterministic JS.

---

*Last updated alongside the matcher rewrite + AI second-pass + spec-aware verifier. Commit `e0ae225` (or later).*
