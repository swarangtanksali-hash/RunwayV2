/* Path to $1M ARR — calculation engine.
 * Pure functions only: no DOM, no network, no storage. The same file is unit-tested
 * under Node (tests/engine.test.js) and inlined verbatim into path-to-1m.html by build.js.
 *
 * TIMING CONVENTIONS (month m = 1 is the first modelled month):
 *  - Cash: closing(m) = opening(m) + inflows(m) - outflows(m).
 *  - Monthly-billed streams (PLG subscriptions, marketing-acquired PLG, AI credits, SLG opening
 *    base) collect ARR_open(m) / 12 in month m, where ARR_open(m) = ARR at the end of m-1.
 *  - PLG subscriptions: ARR_close(m) = ARR_open(m) * (1 + new%(m) - churn%), both on the opening base.
 *    new%(m) = newPct for months 1..newHoldMonths, then falls newStepPts per month to newFloorPct.
 *    Exception: for months 1..newFixedMonths, new ARR is a fixed dollar amount (newFixedArr) instead
 *    of new% x base, i.e. ARR_close(m) = ARR_open(m) * (1 - churn%) + newFixedArr.
 *  - Marketing: on top of PLG new ARR (fixed-$ or %). Spend leaves cash in month m; the acquired ARR (spend x ROI) is counted in
 *    ARR_close(m) and collects monthly from m+1. That cohort only churns (no new% on it).
 *  - AI credits: ARR_close(m) = ARR_open(m) * (1 + growth%).
 *  - SLG opening base: steps by NDR = 1 - churn% + expansion% at the start of months 13, 25, ...
 *    Monthly cash = (ARR - Jacobs ARR) / 12; Jacobs is collected only via its scheduled payments.
 *  - Organic SLG growth: from startMonth, each month adds pct% of the original SLG base as new ARR
 *    (flat, excludes named deals), collected in full collectLag months later, renewing x NDR.
 *  - Collections (Opening AR, Jacobs): fixed payments in fixed months, each group switchable.
 *  - OpenAI credits: reduce the inference cost evenly over their window, capped at that month's
 *    inference cost (credits can't turn a cost into income).
 *  - SLG deals: ARR counted from the end of the close month. Cash follows the schedule
 *    (offsets in months from close, % of contract value). Each deal renews every 12 months
 *    at value x NDR, re-collected on the same relative schedule.
 *  - Runway: fractional month where cash first reaches <= 0, interpolated inside that month.
 *  - $1M reached: first month whose closing total ARR, rounded to the nearest arrRounding ($10K),
 *    is >= target, i.e. ARR >= target - arrRounding / 2 ($995,000 counts as $1M).
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RunwayEngine = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DAYS_PER_MONTH = 30.4375;
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var EXT_HORIZON = 120; // months simulated for analysis (runway / $1M beyond the display horizon)
  var ALERT_MONTHS = 4;  // amber warning when less than this much runway is left at $1M (~122 days)

  // ── Dates ────────────────────────────────────────────────────────────────
  // start = { year: 2026, month0: 10 } means month 1 = Nov '26.
  function monthIndex(start, year, month0) {
    return (year - start.year) * 12 + (month0 - start.month0) + 1;
  }
  function monthLabel(start, m) {
    var total = start.year * 12 + start.month0 + (m - 1);
    var y = Math.floor(total / 12), mo = total - y * 12;
    return MONTHS[mo] + " '" + String(y % 100).padStart(2, '0');
  }

  // ── Validation (fail closed: invalid params throw, nothing is guessed) ──
  function fin(x, name) {
    if (typeof x !== 'number' || !Number.isFinite(x)) throw new TypeError(name + ' must be a finite number');
    return x;
  }
  function nonNeg(x, name) {
    fin(x, name);
    if (x < 0) throw new RangeError(name + ' must be >= 0');
    return x;
  }
  function intIn(x, lo, hi, name) {
    if (!Number.isInteger(x) || x < lo || x > hi) throw new RangeError(name + ' must be an integer in [' + lo + ',' + hi + ']');
    return x;
  }
  function validate(p) {
    if (!p || typeof p !== 'object') throw new TypeError('params required');
    fin(p.openingCash, 'openingCash');
    intIn(p.horizon, 1, EXT_HORIZON, 'horizon');
    nonNeg(p.targetArr, 'targetArr');
    nonNeg(p.arrRounding, 'arrRounding');
    nonNeg(p.costs.base, 'costs.base');
    nonNeg(p.costs.anthropic, 'costs.anthropic');
    var oc = p.openAiCredit;
    nonNeg(oc.total, 'openAiCredit.total');
    intIn(oc.startMonth, 1, EXT_HORIZON, 'openAiCredit.startMonth');
    intIn(oc.months, 1, EXT_HORIZON, 'openAiCredit.months');
    nonNeg(p.plg.subArr, 'plg.subArr');
    nonNeg(p.plg.newPct, 'plg.newPct');
    intIn(p.plg.newHoldMonths, 0, EXT_HORIZON, 'plg.newHoldMonths');
    nonNeg(p.plg.newFixedArr, 'plg.newFixedArr');
    intIn(p.plg.newFixedMonths, 0, EXT_HORIZON, 'plg.newFixedMonths');
    nonNeg(p.plg.newStepPts, 'plg.newStepPts');
    nonNeg(p.plg.newFloorPct, 'plg.newFloorPct');
    if (p.plg.newFloorPct > p.plg.newPct) throw new RangeError('plg.newFloorPct cannot exceed plg.newPct');
    nonNeg(p.plg.churnPct, 'plg.churnPct');
    nonNeg(p.plg.lowChurnPct, 'plg.lowChurnPct');
    nonNeg(p.ai.arr, 'ai.arr');
    fin(p.ai.growthPct, 'ai.growthPct');
    if (p.ai.growthPct <= -100) throw new RangeError('ai.growthPct must be > -100');
    nonNeg(p.slg.arr, 'slg.arr');
    nonNeg(p.slg.churnPct, 'slg.churnPct');
    nonNeg(p.slg.expPct, 'slg.expPct');
    nonNeg(p.slg.jacobsArr, 'slg.jacobsArr');
    if (p.slg.jacobsArr > p.slg.arr) throw new RangeError('slg.jacobsArr cannot exceed slg.arr');
    (p.collections || []).forEach(function (c, i) {
      c.payments.forEach(function (o, j) {
        fin(o.amount, 'collections[' + i + '].payments[' + j + '].amount');
        intIn(o.month, 1, EXT_HORIZON, 'collections[' + i + '].payments[' + j + '].month');
      });
    });
    (p.deals || []).forEach(function (d, i) {
      nonNeg(d.arr, 'deals[' + i + '].arr');
      intIn(d.closeMonth, 1, EXT_HORIZON, 'deals[' + i + '].closeMonth');
      var pctSum = 0;
      d.schedule.forEach(function (s, j) {
        intIn(s.offset, 0, 11, 'deals[' + i + '].schedule[' + j + '].offset');
        nonNeg(s.pct, 'deals[' + i + '].schedule[' + j + '].pct');
        pctSum += s.pct;
      });
      if (Math.abs(pctSum - 100) > 1e-9) throw new RangeError('deals[' + i + '] schedule must total 100%');
    });
    if (p.slgGrowth) {
      nonNeg(p.slgGrowth.pct, 'slgGrowth.pct');
      intIn(p.slgGrowth.startMonth, 1, EXT_HORIZON, 'slgGrowth.startMonth');
      intIn(p.slgGrowth.collectLag, 0, 11, 'slgGrowth.collectLag');
    }
    var mk = p.marketing;
    nonNeg(mk.monthlySpend, 'marketing.monthlySpend');
    nonNeg(mk.roi, 'marketing.roi');
    intIn(mk.startMonth, 1, EXT_HORIZON, 'marketing.startMonth');
    intIn(mk.months, 0, EXT_HORIZON, 'marketing.months');
    return p;
  }

  function plgChurnRate(p) {
    // "Lower PLG churn" switch: the whole PLG base (and marketing ARR) churns at lowChurnPct instead.
    return (p.plg.churnReductionOn ? p.plg.lowChurnPct : p.plg.churnPct) / 100;
  }
  // PLG new ARR % of the opening base in month m (held, then stepped down to a floor).
  // Fixed-dollar PLG new ARR applies in months 1..newFixedMonths.
  function plgFixedMonth(p, m) { return m <= p.plg.newFixedMonths; }
  // New PLG ARR added at the end of month m on an opening base of arr.
  function plgNewArr(p, m, arr) { return plgFixedMonth(p, m) ? p.plg.newFixedArr : arr * plgNewRate(p, m); }
  function plgNewRate(p, m) {
    var g = p.plg, steps = Math.max(m - g.newHoldMonths, 0);
    return Math.max(g.newPct - g.newStepPts * steps, g.newFloorPct) / 100;
  }

  function slgNdr(p) {
    return Math.max(1 - p.slg.churnPct / 100 + p.slg.expPct / 100, 0);
  }

  // ── Core monthly simulation ───────────────────────────────────────────────
  function simulate(p, horizon) {
    validate(p);
    var H = horizon || p.horizon;
    var plgChurn = plgChurnRate(p);
    var aiG = p.ai.growthPct / 100, ndr = slgNdr(p);
    var mk = p.marketing;

    var plgArr = p.plg.subArr, mktArr = 0, aiArr = p.ai.arr, slgArr = p.slg.arr;
    // Jacobs is collected as scheduled one-off payments (collections), so it is excluded here.
    var slgCashBase = slgArr - p.slg.jacobsArr;
    var oc = p.openAiCredit;
    var deals = (p.deals || []).filter(function (d) { return d.on; });
    var cash = p.openingCash;
    var rows = [];

    for (var m = 1; m <= H; m++) {
      // Annual NDR step on the SLG opening base (start of months 13, 25, ...)
      if (m > 1 && (m - 1) % 12 === 0) { slgArr *= ndr; slgCashBase *= ndr; }

      var cashOpen = cash;
      var inPlg = plgArr / 12, inMkt = mktArr / 12, inAi = aiArr / 12, inSlgBase = slgCashBase / 12;

      var inDeals = 0, dealArr = 0;
      for (var i = 0; i < deals.length; i++) {
        var d = deals[i], age = m - d.closeMonth;
        if (age >= 0) {
          var cycle = Math.floor(age / 12), inCycle = age - cycle * 12;
          var value = d.arr * Math.pow(ndr, cycle);
          dealArr += value;
          for (var j = 0; j < d.schedule.length; j++) {
            if (d.schedule[j].offset === inCycle) inDeals += value * d.schedule[j].pct / 100;
          }
        }
      }

      // Organic SLG growth: from startMonth, each month books pct% of the ORIGINAL SLG base
      // (flat, no compounding, excludes named deals). Same renewal and lag rules as a deal.
      var inSlgOrg = 0, slgOrgArr = 0, sg = p.slgGrowth;
      if (sg && sg.on) {
        var orgAmt = p.slg.arr * sg.pct / 100;
        for (var c = sg.startMonth; c <= m; c++) {
          var oAge = m - c, oCycle = Math.floor(oAge / 12), oIn = oAge - oCycle * 12;
          var oVal = orgAmt * Math.pow(ndr, oCycle);
          slgOrgArr += oVal;
          if (oIn === sg.collectLag) inSlgOrg += oVal;
        }
      }

      var inOneOff = 0;
      (p.collections || []).forEach(function (c) {
        if (!c.on) return;
        c.payments.forEach(function (o) { if (o.month === m) inOneOff += o.amount; });
      });

      var mktActive = !!mk.on && m >= mk.startMonth && m < mk.startMonth + mk.months;
      var outBase = p.costs.base, outAnthropic = p.costs.anthropic, outMkt = mktActive ? mk.monthlySpend : 0;
      // OpenAI credits offset inference cost, spread evenly; never more than that month's inference cost.
      var creditActive = !!oc.on && m >= oc.startMonth && m < oc.startMonth + oc.months;
      var creditOffset = creditActive ? Math.min(oc.total / oc.months, outAnthropic) : 0;

      var inflow = inPlg + inMkt + inAi + inSlgBase + inDeals + inSlgOrg + inOneOff;
      var outflow = outBase + outAnthropic - creditOffset + outMkt;
      cash = cashOpen + inflow - outflow;

      // End-of-month ARR movements
      var plgNew = plgNewArr(p, m, plgArr);
      plgArr = Math.max(plgArr * (1 - plgChurn) + plgNew, 0);
      mktArr = mktArr * (1 - plgChurn) + (mktActive ? mk.monthlySpend * mk.roi : 0);
      aiArr = aiArr * (1 + aiG);

      rows.push({
        m: m,
        cashOpen: cashOpen,
        inPlg: inPlg, inMkt: inMkt, inAi: inAi, inSlgBase: inSlgBase, inDeals: inDeals, inSlgOrg: inSlgOrg, inOneOff: inOneOff,
        inflow: inflow,
        outBase: outBase, outAnthropic: outAnthropic, creditOffset: creditOffset, outMkt: outMkt,
        outflow: outflow,
        net: inflow - outflow,
        cashClose: cash,
        arrPlg: plgArr, arrMkt: mktArr, arrAi: aiArr, arrSlgBase: slgArr, arrDeals: dealArr, arrSlgOrg: slgOrgArr,
        arrTotal: plgArr + mktArr + aiArr + slgArr + dealArr + slgOrgArr
      });
    }
    return rows;
  }

  function openingArr(p) {
    return p.plg.subArr + p.ai.arr + p.slg.arr;
  }

  // Fractional month at which cash first reaches zero (null if it never does in rows).
  function runoutMonth(p, rows) {
    if (p.openingCash <= 0) return 0;
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (r.cashClose <= 0) return (r.m - 1) + r.cashOpen / (r.cashOpen - r.cashClose);
    }
    return null;
  }
  // ARR counts as on target when, rounded to the nearest arrRounding, it reaches the target.
  function meetsTarget(p, arr) { return arr >= p.targetArr - p.arrRounding / 2; }
  function hitMonth(p, rows) {
    if (meetsTarget(p, openingArr(p))) return 0;
    for (var i = 0; i < rows.length; i++) if (meetsTarget(p, rows[i].arrTotal)) return rows[i].m;
    return null;
  }

  // ── Analysis: the numbers the dashboard reads ─────────────────────────────
  // status: 'ok' | 'low-runway' (reached, < ALERT_MONTHS of cash left)
  //         | 'cash-out-first' (cash hits zero at or before the $1M month) | 'not-reached'
  function analyse(p) {
    var rows = simulate(p, EXT_HORIZON);
    var runout = runoutMonth(p, rows);
    var hit = hitMonth(p, rows);
    var res = {
      rows: rows.slice(0, p.horizon),
      runout: runout,
      hit: hit,
      cashAtHit: null,
      runwayAtHit: null,
      status: null,
      lowestCash: Math.min.apply(null, rows.slice(0, p.horizon).map(function (r) { return r.cashClose; }))
    };
    if (hit === null) {
      res.status = runout === null ? 'not-reached' : 'cash-out-first';
      return res;
    }
    if (runout !== null && runout <= hit) {
      res.status = 'cash-out-first';
      return res;
    }
    res.cashAtHit = hit === 0 ? p.openingCash : rows[hit - 1].cashClose;
    res.runwayAtHit = runout === null ? Infinity : runout - hit;
    res.status = res.runwayAtHit < ALERT_MONTHS ? 'low-runway' : 'ok';
    return res;
  }

  function clone(p) { return JSON.parse(JSON.stringify(p)); }

  // $1M counts as reached only when it happens before cash runs out.
  function reached(a) { return a.status === 'ok' || a.status === 'low-runway'; }

  // Impact of one lever: result with the lever applied minus result without it,
  // all other selections unchanged. apply(q) / remove(q) mutate a copy.
  function leverImpact(p, apply, remove) {
    var on = clone(p), off = clone(p);
    apply(on); remove(off);
    var a = analyse(on), b = analyse(off);
    function d(x, y) { return (x === null || y === null || !isFinite(x) || !isFinite(y)) ? null : x - y; }
    // A $1M date only counts if cash is still positive at that point.
    var rw = reached(a), rwo = reached(b);
    return {
      with: a, without: b,
      reachedWith: rw, reachedWithout: rwo,
      hitDelta: rw && rwo ? d(a.hit, b.hit) : null,
      cashAtHitDelta: rw && rwo ? d(a.cashAtHit, b.cashAtHit) : null,
      runoutDelta: d(a.runout, b.runout)
    };
  }

  function monthsToDays(mo) { return Math.round(mo * DAYS_PER_MONTH); }

  // Hand-calc sense check for a monthly cost change (Anthropic selector), shown on the page and
  // pinned by tests: extra cost x months until the earlier cash-out / net burn of the cheaper path
  // in that cash-out month. Independent of the runout interpolation; null if neither path runs out.
  function costCheck(p, costA, costB) {
    var hi = clone(p), lo = clone(p);
    hi.costs.anthropic = Math.max(costA, costB); lo.costs.anthropic = Math.min(costA, costB);
    var extra = hi.costs.anthropic - lo.costs.anthropic;
    var T = analyse(hi).runout;
    if (extra === 0 || T === null) return null;
    var m = Math.max(Math.ceil(T), 1), row = simulate(lo, EXT_HORIZON)[m - 1];
    var burn = -row.net;
    if (!(burn > 0)) return null;
    return { extra: extra, months: T, burnMonth: m, burn: burn, days: monthsToDays(extra * T / burn) };
  }

  // ── Default inputs: Oct '26 month-end actuals + agreed assumptions ────────
  // All month positions derive from START, so a roll-forward edits START and the dates below.
  var START = { year: 2026, month0: 10 }; // month 1 = Nov '26 (opening balances = Oct '26 ME)
  function at(year, month0) { return monthIndex(START, year, month0); }
  // Deal cash, relative to the close month: 50% at +2 mo, 25% at +4, 25% at +7
  // (a Dec '26 close collects Feb / Apr / Jul '27).
  var DEAL_SCHEDULE = [{ offset: 2, pct: 50 }, { offset: 4, pct: 25 }, { offset: 7, pct: 25 }];
  function defaults() {
    // group: deals sharing a group are switched on/off together (e.g. "Others" in two tranches)
    function deal(id, group, label, arr, closeMonth) {
      return { id: id, group: group, label: label, arr: arr, on: false, closeMonth: closeMonth, schedule: clone(DEAL_SCHEDULE) };
    }
    return {
      start: clone(START),
      horizon: 36,
      targetArr: 1000000,
      arrRounding: 10000,                         // $1M test uses ARR rounded to the nearest $10K (user, Nov 11)
      openingCash: 2316098,                       // FS Cash Burn MvM, Oct '26
      costs: { base: 250000, anthropic: 50000 },  // anthropic: 50K base; selector 80K / 25K
      anthropicBase: 50000,
      // OpenAI credits: $50K off inference cost, 50% Nov / 50% Dec
      openAiCredit: { on: true, total: 50000, startMonth: at(2026, 10), months: 2 },
      // PLG new ARR: 30% of base for 6 months (Nov-Apr), then -2.5 pts/mo to a 25% floor (from Jun '27)
      // Nov-Jan: fixed $70K/mo new PLG ARR before churn (~125 users x $45 x 12); marketing ARR comes on top.
      plg: { subArr: 142557, newFixedArr: 70000, newFixedMonths: 3, newPct: 30, newHoldMonths: 6, newStepPts: 2.5, newFloorPct: 25,
             churnPct: 20, lowChurnPct: 15, churnReductionOn: false }, // lower-churn switch off by default
      ai: { arr: 78300, growthPct: 5 },           // SAAS KPIs row 12, Oct '26
      // Existing SLG cash = (ARR - Jacobs) / 12 monthly; Jacobs is collected via the schedule below
      slg: { arr: 275403, churnPct: 5, expPct: 10, jacobsArr: 105000 },
      // Organic SLG: from Mar '27, +10% of the Oct '26 SLG base each month ($27.5K), collected in 60 days
      slgGrowth: { on: true, pct: 10, startMonth: at(2027, 2), collectLag: 2 },
      collections: [
        { id: 'openingAr', label: 'Opening AR', on: true, payments: [
          { month: at(2026, 10), amount: 40000 },
          { month: at(2026, 11), amount: 40000 },
          { month: at(2027, 0), amount: 20000 }
        ] },
        { id: 'jacobs', label: 'Jacobs', on: true, payments: [
          { month: at(2027, 0), amount: 42000 },
          { month: at(2027, 3), amount: 56000 }
        ] }
      ],
      deals: [
        deal('itc', 'itc', 'ITC', 75000, at(2027, 0)),               // Jan '27
        deal('lt', 'lt', 'L&T', 150000, at(2026, 10)),               // Nov '26
        deal('carwash', 'carwash', 'Car Wash', 100000, at(2026, 11)), // Dec '26
        deal('others-1', 'others', 'Others', 50000, at(2026, 11)),    // Dec '26
        deal('others-2', 'others', 'Others', 25000, at(2027, 0))      // Jan '27
      ],
      marketing: { on: false, monthlySpend: 35000, startMonth: at(2026, 10), months: 3, roi: 1 }
    };
  }

  // ── Preset scenarios: each sets every switch; assumptions are left alone ──
  // OpenAI credits are always on (not a scenario switch); lower PLG churn is off in every case.
  var SCENARIOS = [
    { id: 'bear', label: 'Bear', deals: ['lt', 'others'], openingAr: true, churnReduction: false, anthropic: 80000, openAi: true, marketing: false },
    { id: 'base', label: 'Base', deals: ['lt', 'others', 'carwash'], openingAr: true, churnReduction: false, anthropic: 50000, openAi: true, marketing: false },
    { id: 'bull', label: 'Bull', deals: ['lt', 'others', 'carwash', 'itc'], openingAr: true, churnReduction: false, anthropic: 25000, openAi: true, marketing: true }
  ];
  function scenarioById(id) {
    for (var i = 0; i < SCENARIOS.length; i++) if (SCENARIOS[i].id === id) return SCENARIOS[i];
    throw new RangeError('unknown scenario ' + id);
  }
  function setSwitches(q, s) {
    q.deals.forEach(function (d) { d.on = s.deals.indexOf(d.group) !== -1; });
    q.collections.forEach(function (c) { if (c.id === 'openingAr') c.on = s.openingAr; });
    q.plg.churnReductionOn = s.churnReduction;
    q.costs.anthropic = s.anthropic;
    q.openAiCredit.on = s.openAi;
    q.marketing.on = s.marketing;
  }
  function applyScenario(p, id) { var q = clone(p); setSwitches(q, scenarioById(id)); return q; }
  // id of the preset whose switches exactly match p, else null ("Custom").
  function matchScenario(p) {
    for (var i = 0; i < SCENARIOS.length; i++) {
      var q = clone(p); setSwitches(q, SCENARIOS[i]);
      if (JSON.stringify(q) === JSON.stringify(p)) return SCENARIOS[i].id;
    }
    return null;
  }

  return {
    SCENARIOS: SCENARIOS,
    applyScenario: applyScenario,
    matchScenario: matchScenario,
    plgNewRate: plgNewRate,
    plgNewArr: plgNewArr,
    DAYS_PER_MONTH: DAYS_PER_MONTH,
    EXT_HORIZON: EXT_HORIZON,
    ALERT_MONTHS: ALERT_MONTHS,
    monthIndex: monthIndex,
    monthLabel: monthLabel,
    validate: validate,
    plgChurnRate: plgChurnRate,
    slgNdr: slgNdr,
    simulate: simulate,
    openingArr: openingArr,
    runoutMonth: runoutMonth,
    hitMonth: hitMonth,
    meetsTarget: meetsTarget,
    costCheck: costCheck,
    analyse: analyse,
    leverImpact: leverImpact,
    reached: reached,
    monthsToDays: monthsToDays,
    clone: clone,
    START: START,
    defaults: defaults
  };
});
