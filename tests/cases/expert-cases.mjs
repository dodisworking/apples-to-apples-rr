// ─────────────────────────────────────────────────────────────────────────
// SECRET ANSWER KEY — "EXPERT" pressure-test set (10 properties).
//
// A second, independent fixture set authored as a real-estate rent-roll expert
// to stress the WHOLE pipeline (Argus xlsx + Client PDF). Same schema and rules
// as reconcile-cases.mjs, but fresh properties/tenants the engine has never
// "seen". The point: prove the program reconciles correctly WITHOUT being told
// the answers — every economically-identical pair must come back clean, and
// every planted real error must be flagged.
//
// Each tenant is deliberately authored so the Argus side and the Client side
// LOOK different (psf vs annual vs monthly rent, steps in different units, date
// formats, DBA/store-number names, leading-zero suites, sub-0.5% SF drift) while
// being the SAME lease — so any finding on a "clean" pair is a FALSE POSITIVE.
// Planted real errors MUST be flagged (missing one = FALSE NEGATIVE).
//
// expect = {
//   findings:   [{ suite, field }]   // MUST be flagged (a real discrepancy)
//   allowSoft:  [{ suite, field }]   // OK to flag or not (DBA name, current-vs-stepped)
//   argusOnly:  [suite, ...]         // tenant present only in Argus
//   clientOnly: [suite, ...]         // tenant present only in Client
// }
// ─────────────────────────────────────────────────────────────────────────

import { normalizeSuite } from '../../lib/argus.js'

let _row = 13
function T(o, isArgus = false) {
  const suite = o.suite != null ? String(o.suite) : null
  return {
    name: o.name ?? null,
    suite,
    suiteKey: normalizeSuite(suite),
    leaseStart: o.ls ?? null,
    leaseEnd: o.le ?? null,
    sqft: o.sqft ?? null,
    baseRent: {
      psfAnnual: o.psf ?? null,
      annualTotal: o.ann ?? null,
      psfMonthly: o.psfMo ?? null,
      monthlyTotal: o.mo ?? null,
    },
    rentSteps: (o.steps || []).map(s => ({
      effectiveDate: s.d ?? null,
      psfAnnual: s.psf ?? null,
      psfMonthly: s.psfMo ?? null,
      monthlyTotal: s.mo ?? null,
      annualTotal: s.ann ?? null,
    })),
    freeRent: (o.free || []).map(f => ({
      startDate: f.d ?? null,
      months: f.months ?? null,
      abatementPct: f.pct ?? null,
    })),
    percentRent: o.pr ? { breakpoint: o.pr.bp ?? null, overagePct: o.pr.ov ?? null, salesVolume: null } : null,
    isOption: !!o.isOption,
    isVacant: !!o.isVacant,
    isReabsorbed: !!o.isReabsorbed,
    ...(isArgus ? { _argusBlockRow: o._row ?? (_row += 6) } : {}),
  }
}
const argus = list => list.map(o => T(o, true))
const client = list => ({ tenants: list.map(o => T(o, false)), topLevelTotalSF: null })
function prop(name, aList) {
  const tenants = argus(aList)
  const totalSF = tenants
    .filter(t => !t.isOption && !t.isReabsorbed && t.sqft)
    .reduce((s, t) => s + t.sqft, 0)
  return { property: name, tenants, totalSF }
}

export const CASES = [
  // ═══════════════════════════════════════════════════════════════════════
  // CASE 1 — "Magnolia Crossing": pure representation noise. MUST be clean.
  //   psf↔monthly, psf↔annual, step in $/mo vs $/SF, store-number names,
  //   sub-0.5% SF drift, date-format differences. ZERO real discrepancies.
  // ═══════════════════════════════════════════════════════════════════════
  {
    name: 'Magnolia Crossing — representation noise (must be clean)',
    argus: prop('Magnolia Crossing', [
      { suite: '110', name: 'Ulta Beauty, LLC', ls: '3/1/2021', le: '2/28/2031', sqft: 12000, psf: 28 },     // ann 336000, mo 28000
      { suite: '120', name: 'Five Below #1234', ls: '6/1/2020', le: '5/31/2030', sqft: 9000, psf: 22 },        // ann 198000
      { suite: '130', name: 'Chipotle Mexican Grill', ls: '8/1/2022', le: '7/31/2032', sqft: 2400, psf: 45,    // ann 108000
        steps: [{ d: 'Jul-2027', psf: 48 }] },                                                                  // 48*2400/12 = 9600/mo
      { suite: '140', name: 'GameStop', ls: '2/1/2019', le: '1/31/2034', sqft: 4000, psf: 30 },
    ]),
    client: client([
      { suite: '110', name: 'ULTA BEAUTY', ls: '3/1/2021', le: '2/28/2031', sqft: 12000, mo: 28000 },          // 28000*12/12000 = 28
      { suite: '120', name: 'Five Below', ls: '6/1/2020', le: '5/31/2030', sqft: 9000, ann: 198000 },           // 198000/9000 = 22
      { suite: '130', name: 'Chipotle', ls: '08/01/2022', le: '07/31/2032', sqft: 2400, ann: 108000,
        steps: [{ d: '7/1/2027', mo: 9600 }] },                                                                 // 9600*12/2400 = 48
      { suite: '140', name: 'GameStop', ls: '2/1/2019', le: '1/31/2034', sqft: 4015, psf: 30 },                 // +0.375% SF (under tol)
    ]),
    expect: { findings: [], allowSoft: [], argusOnly: [], clientOnly: [] },
  },

  // ═══════════════════════════════════════════════════════════════════════
  // CASE 2 — "Juniper Pointe": planted real errors across the spectrum.
  // ═══════════════════════════════════════════════════════════════════════
  {
    name: 'Juniper Pointe — real discrepancies (must flag)',
    argus: prop('Juniper Pointe', [
      { suite: '200', name: 'Old Navy', ls: '1/1/2021', le: '12/31/2031', sqft: 20000, psf: 18 },
      { suite: '210', name: 'Sephora', ls: '5/1/2020', le: '4/30/2030', sqft: 4000, psf: 38,
        steps: [{ d: 'Aug-2026', psf: 40 }] },
      { suite: '220', name: 'Bath & Body Works', ls: '6/1/2021', le: '5/31/2031', sqft: 3000, psf: 32 },        // ann 96000
      { suite: '230', name: 'Panera Bread', ls: '6/1/2021', le: '12/31/2030', sqft: 4500, psf: 35 },
      { suite: '240', name: 'Verizon Wireless', ls: '9/1/2021', le: '8/31/2031', sqft: 2200, psf: 42 },         // argus only
    ]),
    client: client([
      { suite: '200', name: 'Old Navy', ls: '1/1/2021', le: '12/31/2031', sqft: 21500, psf: 18 },              // +7.5% SF → sqft
      { suite: '210', name: 'Sephora', ls: '5/1/2020', le: '4/30/2030', sqft: 4000, psf: 38,
        steps: [{ d: '8/1/2026', psf: 43 }] },                                                                  // step 40→43 → rent_step_amount
      { suite: '220', name: 'Bath & Body Works', ls: '6/1/2021', le: '5/31/2031', sqft: 3000, ann: 108000 },   // 96000→108000 → base rent
      { suite: '230', name: 'Panera Bread', ls: '6/1/2021', le: '6/30/2031', sqft: 4500, psf: 35 },            // lease end +181d → lease_end
      { suite: '250', name: 'Crumbl Cookies', ls: '4/1/2022', le: '3/31/2032', sqft: 1800, psf: 48 },           // client only
    ]),
    expect: {
      findings: [
        { suite: '200', field: 'sqft' },
        { suite: '210', field: 'rent_step_amount' },
        { suite: '220', field: 'base_rent_psf' },
        { suite: '220', field: 'base_rent_annual' },   // same rate diff shows on both axes
        { suite: '230', field: 'lease_end' },
      ],
      allowSoft: [], argusOnly: ['240'], clientOnly: ['250'],
    },
  },

  // ═══════════════════════════════════════════════════════════════════════
  // CASE 3 — "Sycamore Station": % rent + free rent. Two real % findings,
  //   one asymmetric free-rent omission; the matching ones must stay clean.
  // ═══════════════════════════════════════════════════════════════════════
  {
    name: 'Sycamore Station — percent rent & free rent (mixed)',
    argus: prop('Sycamore Station', [
      { suite: '300', name: 'AMC Theatres', ls: '1/1/2020', le: '12/31/2035', sqft: 40000, psf: 15,
        pr: { bp: 1000000, ov: 0.08 } },
      { suite: '310', name: 'Cinemark', ls: '1/1/2021', le: '12/31/2036', sqft: 30000, psf: 16,
        pr: { bp: 800000, ov: 0.07 } },
      { suite: '320', name: "Dave & Buster's", ls: '6/1/2019', le: '5/31/2034', sqft: 25000, psf: 20,
        pr: { bp: 1200000, ov: 0.06 } },
      { suite: '330', name: 'Lululemon', ls: '3/1/2022', le: '2/28/2032', sqft: 4000, psf: 50,
        free: [{ d: 'May-2026', months: 3 }] },
      { suite: '340', name: 'Athleta', ls: '4/1/2022', le: '3/31/2032', sqft: 3500, psf: 48,
        free: [{ d: 'Jan-2026', months: 2 }] },
      { suite: '350', name: 'Warby Parker', ls: '7/1/2021', le: '6/30/2031', sqft: 2000, psf: 55,
        free: [{ d: 'Mar-2026', pct: 0.5 }] },
    ]),
    client: client([
      { suite: '300', name: 'AMC Theatres', ls: '1/1/2020', le: '12/31/2035', sqft: 40000, psf: 15,
        pr: { bp: 1000000, ov: 0.08 } },                                                                        // identical → clean
      { suite: '310', name: 'Cinemark', ls: '1/1/2021', le: '12/31/2036', sqft: 30000, psf: 16,
        pr: { bp: 900000, ov: 0.07 } },                                                                         // breakpoint 800k→900k
      { suite: '320', name: "Dave & Buster's", ls: '6/1/2019', le: '5/31/2034', sqft: 25000, psf: 20,
        pr: { bp: 1200000, ov: 0.08 } },                                                                        // overage 6%→8%
      { suite: '330', name: 'Lululemon', ls: '3/1/2022', le: '2/28/2032', sqft: 4000, psf: 50,
        free: [{ d: '5/1/2026', months: 3 }] },                                                                 // same concession, date format
      { suite: '340', name: 'Athleta', ls: '4/1/2022', le: '3/31/2032', sqft: 3500, psf: 48 },                  // free rent DROPPED → free_rent_count
      { suite: '350', name: 'Warby Parker', ls: '7/1/2021', le: '6/30/2031', sqft: 2000, psf: 55,
        free: [{ d: '3/1/2026', pct: 0.5 }] },                                                                  // same 50% abatement
    ]),
    expect: {
      findings: [
        { suite: '310', field: 'pct_rent_breakpoint' },
        { suite: '320', field: 'pct_rent_overage' },
        { suite: '340', field: 'free_rent_count' },
      ],
      allowSoft: [], argusOnly: [], clientOnly: [],
    },
  },

  // ═══════════════════════════════════════════════════════════════════════
  // CASE 4 — "Hawthorne Yards": rent-step subtleties. One step in different
  //   units (clean), one real date drift (40d), one real base-rent gap, and
  //   one current-vs-stepped representation (must be recognized as NOT real).
  // ═══════════════════════════════════════════════════════════════════════
  {
    name: 'Hawthorne Yards — rent step subtleties',
    argus: prop('Hawthorne Yards', [
      { suite: '400', name: 'Nordstrom Rack', ls: '1/1/2022', le: '12/31/2032', sqft: 30000, psf: 24,
        steps: [{ d: 'Jan-2027', psf: 26 }] },
      { suite: '410', name: 'DSW', ls: '8/1/2021', le: '7/31/2031', sqft: 6000, psf: 30,
        steps: [{ d: 'Aug-2026', psf: 33 }] },
      { suite: '420', name: 'Shoe Carnival', ls: '3/1/2020', le: '2/28/2030', sqft: 8000, psf: 20 },
      { suite: '430', name: 'Famous Footwear', ls: '1/1/2021', le: '12/31/2031', sqft: 5000, psf: 28,
        steps: [{ d: 'Jan-2027', psf: 30 }] },
    ]),
    client: client([
      { suite: '400', name: 'Nordstrom Rack', ls: '1/1/2022', le: '12/31/2032', sqft: 30000, psf: 24,
        steps: [{ d: '1/1/2027', mo: 65000 }] },                                                                // 65000*12/30000 = 26 → clean
      { suite: '410', name: 'DSW', ls: '8/1/2021', le: '7/31/2031', sqft: 6000, psf: 30,
        steps: [{ d: '9/10/2026', psf: 33 }] },                                                                 // 40d drift, same amt → rent_step_date
      { suite: '420', name: 'Shoe Carnival', ls: '3/1/2020', le: '2/28/2030', sqft: 8000, psf: 22 },           // 20→22 → base rent
      { suite: '430', name: 'Famous Footwear', ls: '1/1/2021', le: '12/31/2031', sqft: 5000, psf: 30 },         // prints post-step rate (=argus step) → soft
    ]),
    expect: {
      findings: [
        { suite: '410', field: 'rent_step_date' },
        { suite: '420', field: 'base_rent_psf' },
        { suite: '420', field: 'base_rent_annual' },
      ],
      allowSoft: [
        { suite: '430', field: 'base_rent_psf' },        // current-vs-stepped (client = argus's step rate)
        { suite: '430', field: 'rent_step_unmatched' },  // client folded the step into current rent
      ],
      argusOnly: [], clientOnly: [],
    },
  },

  // ═══════════════════════════════════════════════════════════════════════
  // CASE 5 — "Linden Square": suite & name normalization. Leading-zero suite
  //   and DBA names must stay clean; one genuine unit-number mismatch flags.
  // ═══════════════════════════════════════════════════════════════════════
  {
    name: 'Linden Square — suite & name normalization',
    argus: prop('Linden Square', [
      { suite: '0500', name: "Trader Joe's", ls: '1/1/2020', le: '12/31/2030', sqft: 12000, psf: 35 },
      { suite: '510', name: 'Whole Foods Market', ls: '6/1/2019', le: '5/31/2034', sqft: 25000, psf: 30 },
      { suite: '520', name: 'Sprouts Farmers Market', ls: '3/1/2021', le: '2/28/2031', sqft: 18000, psf: 28 },
      { suite: '530', name: 'ALDI', ls: '8/1/2022', le: '7/31/2032', sqft: 15000, psf: 26 },
    ]),
    client: client([
      { suite: '500', name: 'TRADER JOES', ls: '1/1/2020', le: '12/31/2030', sqft: 12000, psf: 35 },           // 0500↔500, apostrophe/case → clean
      { suite: '512', name: 'Whole Foods Market', ls: '6/1/2019', le: '5/31/2034', sqft: 25000, psf: 30 },     // 510 vs 512 → suite
      { suite: '520', name: 'Sprouts', ls: '3/1/2021', le: '2/28/2031', sqft: 18000, psf: 28 },                // DBA subset → soft
      { suite: '530', name: 'Aldi', ls: '08/01/2022', le: '07/31/2032', sqft: 15000, psf: 26 },                // case only → clean
    ]),
    expect: {
      findings: [{ suite: '510', field: 'suite' }],
      allowSoft: [{ suite: '520', field: 'tenant_name' }],
      argusOnly: [], clientOnly: [],
    },
  },

  // ═══════════════════════════════════════════════════════════════════════
  // CASE 6 — "Chestnut Walk": heavy representation noise. MUST be clean.
  // ═══════════════════════════════════════════════════════════════════════
  {
    name: 'Chestnut Walk — representation noise (must be clean)',
    argus: prop('Chestnut Walk', [
      { suite: '600', name: 'REI Co-op', ls: '1/1/2021', le: '12/31/2031', sqft: 15000, psf: 24 },
      { suite: '610', name: "Dick's Sporting Goods #45", ls: '6/1/2020', le: '5/31/2030', sqft: 30000, psf: 20 }, // ann 600000, mo 50000
      { suite: '620', name: 'Bass Pro Shops', ls: '3/1/2019', le: '2/28/2034', sqft: 50000, psf: 12,             // ann 600000
        steps: [{ d: 'Jan-2028', psf: 13 }] },                                                                    // 13*50000 = 650000/yr
      { suite: '630', name: 'Academy Sports', ls: '8/1/2022', le: '7/31/2032', sqft: 20000, psf: 9.25 },
    ]),
    client: client([
      { suite: '600', name: 'REI Co-op', ls: '1/1/2021', le: '12/31/2031', sqft: 15060, psf: 24 },              // +0.4% SF (under tol)
      { suite: '610', name: "Dick's Sporting Goods", ls: '6/1/2020', le: '5/31/2030', sqft: 30000, mo: 50000 },  // 50000*12/30000 = 20
      { suite: '620', name: 'Bass Pro Shops', ls: '3/1/2019', le: '2/28/2034', sqft: 50000, ann: 600000,         // 600000/50000 = 12
        steps: [{ d: '1/1/2028', ann: 650000 }] },                                                               // 650000/50000 = 13
      { suite: '630', name: 'Academy Sports', ls: '08/01/2022', le: '07/31/2032', sqft: 20000, psf: 9.25 },
    ]),
    expect: { findings: [], allowSoft: [], argusOnly: [], clientOnly: [] },
  },

  // ═══════════════════════════════════════════════════════════════════════
  // CASE 7 — "Redwood Galleria": dense real-error property (anchor box mall).
  // ═══════════════════════════════════════════════════════════════════════
  {
    name: 'Redwood Galleria — dense real discrepancies (must flag)',
    argus: prop('Redwood Galleria', [
      { suite: '700', name: "Macy's", ls: '1/1/2018', le: '12/31/2037', sqft: 80000, psf: 10 },
      { suite: '710', name: 'JCPenney', ls: '1/1/2020', le: '12/31/2034', sqft: 60000, psf: 9 },
      { suite: '720', name: 'Forever 21', ls: '6/1/2021', le: '5/31/2031', sqft: 12000, psf: 22 },             // ann 264000
      { suite: '730', name: 'H&M', ls: '3/1/2020', le: '2/28/2030', sqft: 15000, psf: 28,
        steps: [{ d: 'Jan-2027', psf: 30 }] },
      { suite: '740', name: 'Zara', ls: '9/1/2021', le: '8/31/2031', sqft: 18000, psf: 26 },                   // argus only
    ]),
    client: client([
      { suite: '700', name: "Macy's", ls: '1/1/2018', le: '12/31/2037', sqft: 88000, psf: 10 },               // +10% SF → sqft
      { suite: '710', name: 'JCPenney', ls: '7/1/2020', le: '12/31/2034', sqft: 60000, psf: 9 },              // start +182d → lease_start
      { suite: '720', name: 'Forever 21', ls: '6/1/2021', le: '5/31/2031', sqft: 12000, ann: 300000 },        // 264000→300000 (psf 25) → base rent
      { suite: '730', name: 'H&M', ls: '3/1/2020', le: '2/28/2030', sqft: 15000, psf: 28,
        steps: [{ d: '1/1/2027', psf: 32 }] },                                                                 // step 30→32 → rent_step_amount
    ]),
    expect: {
      findings: [
        { suite: '700', field: 'sqft' },
        { suite: '710', field: 'lease_start' },
        { suite: '720', field: 'base_rent_psf' },
        { suite: '720', field: 'base_rent_annual' },
        { suite: '730', field: 'rent_step_amount' },
      ],
      allowSoft: [], argusOnly: ['740'], clientOnly: [],
    },
  },

  // ═══════════════════════════════════════════════════════════════════════
  // CASE 8 — "Cypress Corners": free-rent forms. Months vs date-range, decimal
  //   abatement, two periods — all clean; one real month-count difference.
  // ═══════════════════════════════════════════════════════════════════════
  {
    name: 'Cypress Corners — free rent forms',
    argus: prop('Cypress Corners', [
      { suite: '800', name: 'Starbucks', ls: '1/1/2022', le: '12/31/2031', sqft: 1800, psf: 60,
        free: [{ d: 'May-2026', months: 3 }] },
      { suite: '810', name: "Dunkin'", ls: '6/1/2021', le: '5/31/2031', sqft: 1500, psf: 55,
        free: [{ d: 'Jan-2026', pct: 0.5 }] },
      { suite: '820', name: "Peet's Coffee", ls: '3/1/2020', le: '2/28/2030', sqft: 1600, psf: 58,
        free: [{ d: 'Jan-2026', months: 2 }, { d: 'Jan-2027', months: 1 }] },
      { suite: '830', name: 'Tim Hortons', ls: '8/1/2021', le: '7/31/2031', sqft: 2000, psf: 52,
        free: [{ d: 'Jun-2026', months: 4 }] },
    ]),
    client: client([
      { suite: '800', name: 'Starbucks', ls: '1/1/2022', le: '12/31/2031', sqft: 1800, psf: 60,
        free: [{ d: '5/1/2026', months: 3 }] },                                                                // same → clean
      { suite: '810', name: "Dunkin'", ls: '6/1/2021', le: '5/31/2031', sqft: 1500, psf: 55,
        free: [{ d: '1/1/2026', pct: 0.5 }] },                                                                 // same 50% → clean
      { suite: '820', name: "Peet's Coffee", ls: '3/1/2020', le: '2/28/2030', sqft: 1600, psf: 58,
        free: [{ d: '1/1/2026', months: 2 }, { d: '1/1/2027', months: 1 }] },                                 // same two periods → clean
      { suite: '830', name: 'Tim Hortons', ls: '8/1/2021', le: '7/31/2031', sqft: 2000, psf: 52,
        free: [{ d: '6/1/2026', months: 2 }] },                                                                // 4 mo → 2 mo → free_rent
    ]),
    expect: {
      findings: [{ suite: '830', field: 'free_rent' }],
      allowSoft: [], argusOnly: [], clientOnly: [],
    },
  },

  // ═══════════════════════════════════════════════════════════════════════
  // CASE 9 — "Dogwood Plaza": one-sided % rent (must stay clean — % rent is
  //   only validated when BOTH rolls carry it) + a real step-date drift.
  // ═══════════════════════════════════════════════════════════════════════
  {
    name: 'Dogwood Plaza — one-sided percent rent & step date',
    argus: prop('Dogwood Plaza', [
      { suite: '900', name: 'Cheesecake Factory', ls: '1/1/2020', le: '12/31/2034', sqft: 10000, psf: 30,
        pr: { bp: 2000000, ov: 0.06 } },
      { suite: '910', name: "P.F. Chang's", ls: '6/1/2021', le: '5/31/2031', sqft: 8000, psf: 32,
        pr: { bp: 1500000, ov: 0.05 } },
      { suite: '920', name: 'Olive Garden', ls: '8/1/2021', le: '7/31/2031', sqft: 9000, psf: 28,
        steps: [{ d: 'Aug-2027', psf: 30 }] },
      { suite: '930', name: 'Red Lobster', ls: '3/1/2020', le: '2/28/2030', sqft: 8500, psf: 26 },
    ]),
    client: client([
      { suite: '900', name: 'Cheesecake Factory', ls: '1/1/2020', le: '12/31/2034', sqft: 10000, psf: 30 },    // NO % rent on client → clean
      { suite: '910', name: "P.F. Chang's", ls: '6/1/2021', le: '5/31/2031', sqft: 8000, psf: 32,
        pr: { bp: 1500000, ov: 0.05 } },                                                                        // identical → clean
      { suite: '920', name: 'Olive Garden', ls: '8/1/2021', le: '7/31/2031', sqft: 9000, psf: 28,
        steps: [{ d: '9/10/2027', psf: 30 }] },                                                                 // 40d drift → rent_step_date
      { suite: '930', name: 'Red Lobster', ls: '03/01/2020', le: '02/28/2030', sqft: 8500, psf: 26 },
    ]),
    expect: {
      findings: [{ suite: '920', field: 'rent_step_date' }],
      allowSoft: [], argusOnly: [], clientOnly: [],
    },
  },

  // ═══════════════════════════════════════════════════════════════════════
  // CASE 10 — "Sequoia Marketplace": comprehensive mix (big-box power center).
  // ═══════════════════════════════════════════════════════════════════════
  {
    name: 'Sequoia Marketplace — comprehensive mix',
    argus: prop('Sequoia Marketplace', [
      { suite: '1000', name: 'Best Buy', ls: '1/1/2021', le: '12/31/2031', sqft: 45000, psf: 14 },            // ann 630000
      { suite: '1010', name: 'Target', ls: '1/1/2018', le: '12/31/2037', sqft: 120000, psf: 9 },
      { suite: '1020', name: 'Walmart Neighborhood Market', ls: '6/1/2019', le: '5/31/2034', sqft: 100000, psf: 8 },
      { suite: '1030', name: "Kohl's", ls: '3/1/2020', le: '2/28/2035', sqft: 60000, psf: 11,
        steps: [{ d: 'Jan-2028', psf: 12 }] },
      { suite: '1040', name: 'Costco', ls: '1/1/2019', le: '12/31/2038', sqft: 150000, psf: 12 },             // ann 1800000
    ]),
    client: client([
      { suite: '1000', name: 'Best Buy', ls: '1/1/2021', le: '12/31/2031', sqft: 45000, ann: 630000 },        // 630000/45000 = 14 → clean
      { suite: '1010', name: 'Target', ls: '1/1/2018', le: '12/31/2037', sqft: 132000, psf: 9 },             // +10% SF → sqft
      { suite: '1020', name: 'Walmart', ls: '6/1/2019', le: '5/31/2034', sqft: 100000, psf: 8 },             // DBA subset → soft
      { suite: '1030', name: "Kohl's", ls: '3/1/2020', le: '2/28/2035', sqft: 60000, psf: 11,
        steps: [{ d: '1/1/2028', psf: 13 }] },                                                                // step 12→13 → rent_step_amount
      { suite: '1040', name: 'Costco', ls: '1/1/2019', le: '12/31/2038', sqft: 150000, ann: 1980000 },       // 1800000→1980000 (psf 13.2) → base rent
      { suite: '1050', name: "Sam's Club", ls: '4/1/2022', le: '3/31/2042', sqft: 140000, psf: 10 },         // client only
    ]),
    expect: {
      findings: [
        { suite: '1010', field: 'sqft' },
        { suite: '1030', field: 'rent_step_amount' },
        { suite: '1040', field: 'base_rent_psf' },
        { suite: '1040', field: 'base_rent_annual' },
      ],
      allowSoft: [{ suite: '1020', field: 'tenant_name' }],
      argusOnly: [], clientOnly: ['1050'],
    },
  },
]
