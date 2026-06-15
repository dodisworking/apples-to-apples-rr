// ─────────────────────────────────────────────────────────────────────────
// SECRET ANSWER KEY — canonical-schema reconciliation fixtures.
//
// Each case is ONE property: an Argus canonical schema + a Client canonical
// schema (the shape lib/argus.js and lib/client.js both emit), plus `expect`
// — what reconcile() SHOULD conclude.
//
// The whole point: the two sides are deliberately authored to *look different*
// (monthly vs annual rent, $/SF vs totals, rent steps in different units/order,
// date formats, DBA vs legal names, leading-zero suites, BOMA SF drift) while
// being economically IDENTICAL — so any finding the engine emits on a "clean"
// pair is a FALSE POSITIVE. Separately, planted real errors MUST be flagged
// (missing them = FALSE NEGATIVE).
//
// expect = {
//   findings:   [{ suite, field }]   // MUST be flagged (a real discrepancy)
//   allowSoft:  [{ suite, field }]   // OK to flag or not (e.g. stepReconciled, DBA name)
//   argusOnly:  [suite, ...]         // tenant present only in Argus
//   clientOnly: [suite, ...]         // tenant present only in Client
//   // every other emitted finding on a matched suite is a FALSE POSITIVE
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
// reconcile() reads client.tenants — return the canonical { tenants } shape.
const client = list => ({ tenants: list.map(o => T(o, false)), topLevelTotalSF: null })
function prop(name, aList) {
  const tenants = argus(aList)
  const totalSF = tenants
    .filter(t => !t.isOption && !t.isContractRenewal && !t.isReabsorbed && t.sqft)
    .reduce((s, t) => s + t.sqft, 0)
  return { property: name, tenants, totalSF }
}

export const CASES = [
  // ═══════════════════════════════════════════════════════════════════════
  // CASE 1 — "Maple Plaza": pure representation noise. Everything is the SAME
  // lease shown differently. Expected: ZERO findings, all suites clean.
  // ═══════════════════════════════════════════════════════════════════════
  {
    name: 'Maple Plaza — representation noise (must be clean)',
    argus: prop('Maple Plaza', [
      // psfAnnual on Argus; client will give monthlyTotal of the SAME rent
      { suite: '100', name: 'Academy Sports LLC', ls: '8/1/2022', le: '7/31/2037', sqft: 54408, psf: 9.25 },
      // step in $/SF/yr + "Aug-2027"; client gives the step as monthlyTotal + "8/1/2027"
      { suite: '200', name: "Barberito's", ls: '1/1/2020', le: '12/31/2030', sqft: 3000, psf: 30,
        steps: [{ d: 'Aug-2027', psf: 33 }] },
      // #store suffix vs none; SF drifts 0.4% (under 0.5% tol)
      { suite: '305', name: 'Dollar General #9621', ls: '3/1/2019', le: '2/28/2034', sqft: 10000, psf: 12 },
      // date format differences only
      { suite: '410', name: 'Cafe Rio', ls: '8/1/2022', le: '7/31/2032', sqft: 2500, psf: 40 },
    ]),
    client: client([
      { suite: '100', name: 'Academy Sports, Inc.', ls: '8/1/2022', le: '7/31/2037', sqft: 54408, mo: 41940 }, // 41940*12/54408 = 9.2501
      { suite: '200', name: 'BARBERITOS', ls: '1/1/2020', le: '12/31/2030', sqft: 3000, ann: 90000,            // 90000/3000 = 30
        steps: [{ d: '8/1/2027', mo: 8250 }] },                                                                  // 8250*12/3000 = 33
      { suite: '305', name: 'Dollar General', ls: '3/1/2019', le: '2/28/2034', sqft: 10040, psf: 12 },          // 0.4% SF drift
      { suite: '410', name: 'Cafe Rio', ls: '08/01/2022', le: '07/31/2032', sqft: 2500, ann: 100000 },          // 100000/2500 = 40
    ]),
    expect: { findings: [], allowSoft: [], argusOnly: [], clientOnly: [] },
  },

  // ═══════════════════════════════════════════════════════════════════════
  // CASE 2 — "Oak Center": planted REAL errors. Each MUST be flagged.
  // ═══════════════════════════════════════════════════════════════════════
  {
    name: 'Oak Center — real discrepancies (must flag)',
    argus: prop('Oak Center', [
      { suite: '100', name: 'Big Lots', ls: '1/1/2021', le: '12/31/2031', sqft: 30000, psf: 8 },
      { suite: '200', name: 'Petco', ls: '6/1/2020', le: '5/31/2030', sqft: 12000, psf: 22,
        steps: [{ d: 'Aug-2027', psf: 24 }] },
      { suite: '300', name: 'GNC', ls: '7/1/2019', le: '7/31/2030', sqft: 1800, psf: 35 },
      { suite: '400', name: 'Subway', ls: '2/1/2018', le: '1/31/2033', sqft: 1500, psf: 25 },
      { suite: '500', name: 'Verizon Wireless', ls: '9/1/2021', le: '8/31/2031', sqft: 2200, psf: 40 },
    ]),
    client: client([
      { suite: '100', name: 'Big Lots', ls: '1/1/2021', le: '12/31/2031', sqft: 31800, psf: 8 },   // +6% SF → flag
      { suite: '200', name: 'Petco', ls: '6/1/2020', le: '5/31/2030', sqft: 12000, psf: 22,
        steps: [{ d: '8/1/2027', psf: 26 }] },                                                       // step amount 24→26 → flag
      { suite: '300', name: 'GNC', ls: '7/1/2019', le: '7/31/2032', sqft: 1800, psf: 35 },           // lease end +2yr → flag
      { suite: '400', name: 'Subway', ls: '2/1/2018', le: '1/31/2033', sqft: 1500, psf: 28 },        // base rent 25→28 → flag
      // Verizon (500) missing → argusOnly
      { suite: '600', name: 'T-Mobile', ls: '4/1/2022', le: '3/31/2032', sqft: 2000, psf: 38 },      // extra → clientOnly
    ]),
    expect: {
      findings: [
        { suite: '100', field: 'sqft' },
        { suite: '200', field: 'rent_step_amount' },
        { suite: '300', field: 'lease_end' },
        { suite: '400', field: 'base_rent_psf' },
        { suite: '400', field: 'base_rent_annual' }, // genuine rate diff shows on both axes
      ],
      allowSoft: [],
      argusOnly: ['500'],
      clientOnly: ['600'],
    },
  },

  // ═══════════════════════════════════════════════════════════════════════
  // CASE 3 — "Pine Square": tricky-but-clean. Current-vs-stepped base rent,
  // free rent with different date formats, % rent that agrees.
  // ═══════════════════════════════════════════════════════════════════════
  {
    name: 'Pine Square — tricky but clean',
    argus: prop('Pine Square', [
      // current-vs-stepped: Argus prints current 25 (with a future step to 27);
      // client prints 27 as "current" (already stepped) + same step.
      { suite: '100', name: 'Old Navy', ls: '1/1/2022', le: '12/31/2032', sqft: 15000, psf: 25,
        steps: [{ d: 'Jan-2027', psf: 27 }] },
      // free rent: same 3 months May 2026, different date FORMAT only
      { suite: '200', name: 'Chipotle', ls: '5/1/2023', le: '4/30/2033', sqft: 2400, psf: 45,
        free: [{ d: 'May-2026', months: 3 }] },
      // % rent that agrees on both sides
      { suite: '300', name: 'Macys', ls: '1/1/2015', le: '12/31/2035', sqft: 80000, psf: 6,
        pr: { bp: 500000, ov: 0.06 } },
    ]),
    client: client([
      { suite: '100', name: 'Old Navy', ls: '1/1/2022', le: '12/31/2032', sqft: 15000, psf: 27,
        steps: [{ d: '1/1/2027', psf: 27 }] },
      { suite: '200', name: 'Chipotle', ls: '5/1/2023', le: '4/30/2033', sqft: 2400, psf: 45,
        free: [{ d: '5/1/2026', months: 3 }] },
      { suite: '300', name: 'Macys', ls: '1/1/2015', le: '12/31/2035', sqft: 80000, psf: 6,
        pr: { bp: 500000, ov: 0.06 } },
    ]),
    expect: {
      // current-vs-stepped base rent is allowed to surface as a LOW/stepReconciled
      // note, but must NOT be a hard finding. Free rent + % rent must be clean.
      findings: [],
      allowSoft: [{ suite: '100', field: 'base_rent_psf' }],
      argusOnly: [],
      clientOnly: [],
    },
  },

  // ═══════════════════════════════════════════════════════════════════════
  // CASE 4 — "Cedar Commons": MORE representation noise. Must be clean.
  //   - $/SF/mo vs $/SF/yr base rent
  //   - rent steps listed in REVERSE order (engine pairs by date, not index)
  //   - rent step amount given as annualTotal vs $/SF/yr
  //   - step date anniversary-vs-calendar drift inside the 45-day window
  //   - leading-zero suite ("0820" vs "820")
  //   - 1-day lease-start drift (inside tolerance)
  // ═══════════════════════════════════════════════════════════════════════
  {
    name: 'Cedar Commons — more representation noise (must be clean)',
    argus: prop('Cedar Commons', [
      { suite: '100', name: 'Panera Bread', ls: '1/1/2021', le: '12/31/2031', sqft: 5000, psfMo: 2.50 }, // 2.50*12 = 30
      { suite: '200', name: 'Sprint', ls: '1/1/2020', le: '12/31/2030', sqft: 4000, psf: 30,
        steps: [{ d: '8/1/2026', psf: 31 }, { d: '8/1/2027', psf: 32 }] },
      { suite: '300', name: 'Visionworks', ls: '1/1/2022', le: '12/31/2032', sqft: 10000, psf: 25,
        steps: [{ d: '1/1/2028', psf: 26 }] },
      { suite: '400', name: 'Jersey Mikes', ls: '2/1/2020', le: '1/31/2030', sqft: 6000, psf: 30,
        steps: [{ d: '8/1/2027', psf: 33 }] },
      { suite: '0820', name: 'Foot Locker', ls: '3/1/2019', le: '2/28/2034', sqft: 8000, psf: 28 },
      { suite: '900', name: 'GameStop', ls: '8/1/2022', le: '7/31/2032', sqft: 1500, psf: 35 },
    ]),
    client: client([
      { suite: '100', name: 'Panera Bread', ls: '1/1/2021', le: '12/31/2031', sqft: 5000, psf: 30 },
      { suite: '200', name: 'Sprint', ls: '1/1/2020', le: '12/31/2030', sqft: 4000, psf: 30,
        steps: [{ d: '8/1/2027', psf: 32 }, { d: '8/1/2026', psf: 31 }] },                       // reversed
      { suite: '300', name: 'Visionworks', ls: '1/1/2022', le: '12/31/2032', sqft: 10000, psf: 25,
        steps: [{ d: '1/1/2028', ann: 260000 }] },                                                // 260000/10000 = 26
      { suite: '400', name: 'Jersey Mikes', ls: '2/1/2020', le: '1/31/2030', sqft: 6000, psf: 30,
        steps: [{ d: '8/15/2027', psf: 33 }] },                                                   // 14-day drift
      { suite: '820', name: 'Foot Locker', ls: '3/1/2019', le: '2/28/2034', sqft: 8000, psf: 28 }, // leading zero
      { suite: '900', name: 'GameStop', ls: '8/2/2022', le: '7/31/2032', sqft: 1500, psf: 35 },   // 1-day start drift
    ]),
    expect: { findings: [], allowSoft: [], argusOnly: [], clientOnly: [] },
  },

  // ═══════════════════════════════════════════════════════════════════════
  // CASE 5 — "Birch Plaza": MORE real errors. Each MUST be flagged.
  // ═══════════════════════════════════════════════════════════════════════
  {
    name: 'Birch Plaza — more real discrepancies (must flag)',
    argus: prop('Birch Plaza', [
      { suite: '100', name: 'Ross Dress for Less', ls: '1/1/2020', le: '12/31/2030', sqft: 20000, psf: 18,
        steps: [{ d: '8/1/2027', psf: 19 }] },
      { suite: '200', name: 'Five Guys', ls: '5/1/2023', le: '4/30/2033', sqft: 2500, psf: 40,
        free: [{ d: '5/1/2026', months: 3 }] },
      { suite: '300', name: 'Sephora', ls: '6/1/2022', le: '5/31/2032', sqft: 3000, psf: 50,
        free: [{ d: '6/1/2026', months: 2 }] },
      { suite: '400', name: 'Bath & Body Works', ls: '1/1/2021', le: '12/31/2031', sqft: 3500, psf: 45,
        pr: { bp: 500000, ov: 0.06 } },
      { suite: '500', name: 'Lush', ls: '1/1/2022', le: '12/31/2032', sqft: 1200, psf: 60,
        pr: { bp: 500000, ov: 0.05 } },
      { suite: '600', name: 'AT&T', ls: '1/1/2020', le: '12/31/2030', sqft: 10000, psf: 10 },
    ]),
    client: client([
      { suite: '100', name: 'Ross Dress for Less', ls: '1/1/2020', le: '12/31/2030', sqft: 20000, psf: 18,
        steps: [{ d: '9/10/2027', psf: 19 }] },                                          // step date +40d → flag
      { suite: '200', name: 'Five Guys', ls: '5/1/2023', le: '4/30/2033', sqft: 2500, psf: 40,
        free: [{ d: '5/1/2026', months: 2 }] },                                          // 3mo → 2mo → flag
      { suite: '300', name: 'Sephora', ls: '6/1/2022', le: '5/31/2032', sqft: 3000, psf: 50,
        free: [] },                                                                      // free rent dropped → flag count
      { suite: '400', name: 'Bath & Body Works', ls: '1/1/2021', le: '12/31/2031', sqft: 3500, psf: 45,
        pr: { bp: 600000, ov: 0.06 } },                                                  // breakpoint → flag
      { suite: '500', name: 'Lush', ls: '1/1/2022', le: '12/31/2032', sqft: 1200, psf: 60,
        pr: { bp: 500000, ov: 0.07 } },                                                  // overage → flag
      { suite: '600', name: 'AT&T', ls: '1/1/2020', le: '12/31/2030', sqft: 10000, psf: 10, ann: 105000 }, // annual total drift → flag
    ]),
    expect: {
      findings: [
        { suite: '100', field: 'rent_step_date' },
        { suite: '200', field: 'free_rent' },
        { suite: '300', field: 'free_rent_count' },
        { suite: '400', field: 'pct_rent_breakpoint' },
        { suite: '500', field: 'pct_rent_overage' },
        { suite: '600', field: 'base_rent_annual' },
      ],
      allowSoft: [],
      argusOnly: [],
      clientOnly: [],
    },
  },

  // ═══════════════════════════════════════════════════════════════════════
  // CASE 6 — "Elm Court": exclusions & one-sided % rent. Must be clean at the
  // suite level (options/reabsorbed excluded; one-sided % rent → top note only).
  // ═══════════════════════════════════════════════════════════════════════
  {
    name: 'Elm Court — exclusions & one-sided % rent (clean + note)',
    argus: prop('Elm Court', [
      { suite: '110', name: 'Party City', ls: '8/1/2022', le: '7/31/2032', sqft: 8000, psf: 12 },
      // renewal OPTION block — must be excluded from matching, NOT flagged argus-only
      { suite: '110', name: 'Party City (Option 1)', isOption: true, ls: '8/1/2032', le: '7/31/2037', sqft: 8000, psf: 14 },
      // % rent present on Argus only → reconciler emits ONE top-level note, no per-suite finding
      { suite: '200', name: "Claire's", ls: '1/1/2021', le: '12/31/2031', sqft: 1000, psf: 55,
        pr: { bp: 300000, ov: 0.05 } },
      // reabsorbed suite — excluded, not flagged
      { suite: '300', name: 'Former Tenant', isReabsorbed: true, ls: '1/1/2015', le: '12/31/2025', sqft: 5000, psf: 10 },
    ]),
    client: client([
      { suite: '110', name: 'Party City', ls: '8/1/2022', le: '7/31/2032', sqft: 8000, psf: 12 },
      { suite: '200', name: "Claire's", ls: '1/1/2021', le: '12/31/2031', sqft: 1000, psf: 55 }, // no % rent
    ]),
    expect: {
      findings: [],
      allowSoft: [],
      argusOnly: [],
      clientOnly: [],
      notesInclude: ['Percentage Rent'],
    },
  },

  // ═══════════════════════════════════════════════════════════════════════
  // CASE 7 — "Willow Walk": DATE-FORMAT & name/suite formatting noise.
  // Must be clean. (ISO dates, month-name dates, $/SF/mo step, "The" prefix,
  // suite letter formatting.)
  // ═══════════════════════════════════════════════════════════════════════
  {
    name: 'Willow Walk — date/name/suite formatting (must be clean)',
    argus: prop('Willow Walk', [
      { suite: '100', name: 'Target', ls: '8/1/2022', le: '7/31/2032', sqft: 120000, psf: 7 },
      { suite: '200', name: 'CVS', ls: '1/1/2021', le: '12/31/2031', sqft: 12000, psf: 20 },
      { suite: '300', name: 'Ulta Beauty', ls: '6/1/2020', le: '5/31/2030', sqft: 10000, psf: 28,
        steps: [{ d: '8/1/2027', psf: 36 }] },
      { suite: '400', name: 'The Vitamin Shoppe', ls: '2/1/2019', le: '1/31/2034', sqft: 3000, psf: 33 },
      { suite: '1A', name: 'Auntie Annes', ls: '3/1/2021', le: '2/28/2031', sqft: 800, psf: 60 },
    ]),
    client: client([
      { suite: '100', name: 'Target', ls: '2022-08-01', le: '2032-07-31', sqft: 120000, psf: 7 },       // ISO dates
      { suite: '200', name: 'CVS', ls: 'January 1, 2021', le: 'December 31, 2031', sqft: 12000, psf: 20 }, // month-name
      { suite: '300', name: 'Ulta Beauty', ls: '6/1/2020', le: '5/31/2030', sqft: 10000, psf: 28,
        steps: [{ d: '8/1/2027', psfMo: 3.0 }] },                                                         // 3.0*12 = 36
      { suite: '400', name: 'Vitamin Shoppe', ls: '2/1/2019', le: '1/31/2034', sqft: 3000, psf: 33 },     // "The" dropped
      { suite: 'Suite 1-A', name: "Auntie Anne's", ls: '3/1/2021', le: '2/28/2031', sqft: 800, psf: 60 }, // suite formatting
    ]),
    expect: { findings: [], allowSoft: [], argusOnly: [], clientOnly: [] },
  },

  // ═══════════════════════════════════════════════════════════════════════
  // CASE 8 — "Aspen Row": name/suite/SF real errors. Each MUST be flagged.
  // ═══════════════════════════════════════════════════════════════════════
  {
    name: 'Aspen Row — name/suite/SF discrepancies (must flag)',
    argus: prop('Aspen Row', [
      { suite: '100', name: 'Starbucks', ls: '1/1/2021', le: '12/31/2031', sqft: 1800, psf: 50 },
      { suite: '1', name: 'Walmart', ls: '1/1/2015', le: '12/31/2035', sqft: 100000, psf: 5 },
      { suite: '300', name: 'Marshalls', ls: '6/1/2020', le: '5/31/2030', sqft: 25000, psf: 12 },
    ]),
    client: client([
      { suite: '100', name: 'Dunkin', ls: '1/1/2021', le: '12/31/2031', sqft: 1800, psf: 50 },     // different operator → tenant_name
      { suite: '2', name: 'Walmart', ls: '1/1/2015', le: '12/31/2035', sqft: 100000, psf: 5 },      // suite 1 vs 2 → suite
      { suite: '300', name: 'Marshalls', ls: '6/1/2020', le: '5/31/2030', sqft: 25750, psf: 12 },   // +3% SF → sqft
    ]),
    expect: {
      findings: [
        { suite: '100', field: 'tenant_name' },
        { suite: '1', field: 'suite' },
        { suite: '300', field: 'sqft' },
      ],
      allowSoft: [],
      argusOnly: [],
      clientOnly: [],
    },
  },
]
