// Unit tests for src/engine.js. Run: node --test tests/
// Expected values are computed independently (hand arithmetic or closed-form formulas),
// never by calling the engine's own helpers, so a bug in the engine cannot hide itself.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../src/engine.js');

const TOL = 1e-6;
const close = (actual, expected, msg) =>
  assert.ok(Math.abs(actual - expected) <= TOL * Math.max(1, Math.abs(expected)),
    `${msg || ''} expected ${expected}, got ${actual}`);

const D = () => E.defaults();
const H = 36;

// Independent closed forms for the default baseline (no levers)
const PLG0 = 142557, AI0 = 78300, SLG0 = 275403, SLG_CASH0 = 275403 - 105000; // Jacobs paid separately
const NDR = 1 - 0.05 + 0.10;
// PLG new % by month, written out by hand: 30% Nov-Apr, 27.5% May, 25% floor from Jun '27
const NEW_RATES = [0.30, 0.30, 0.30, 0.30, 0.30, 0.30, 0.275];
const newRate = (m) => (m <= NEW_RATES.length ? NEW_RATES[m - 1] : 0.25);
const plgArrClose = (m, churn) => {                                   // ARR at end of month m
  let a = PLG0;
  // Nov-Jan: fixed $70K new ARR (~125 users x $45 x 12); then new% of base
  for (let k = 1; k <= m; k++) a = k <= 3 ? a * (1 - churn) + 70000 : a * (1 + newRate(k) - churn);
  return a;
};
const aiArrClose = (m) => AI0 * Math.pow(1.05, m);
const slgArrAt = (m) => SLG0 * Math.pow(NDR, Math.floor((m - 1) / 12)); // during / end of month m
// Opening AR 40/40/20 (Nov-Jan) + Jacobs 42K Jan '27, 56K Apr '27
const COLLECT = { 1: 40000, 2: 40000, 3: 20000 + 42000, 6: 56000 };
const CREDIT = (m) => (m <= 2 ? 25000 : 0); // OpenAI credits off inference, 50% Nov / 50% Dec

// Organic SLG: $27,540.30/mo of new ARR booked from Mar '27 (month 5); each cohort collected
// in full 2 months later, renewing x NDR every 12 months.
const ORG = 275403 * 0.10, ORG_START = 5;
const orgArr = (m) => {
  let a = 0;
  for (let c = ORG_START; c <= m; c++) a += ORG * Math.pow(NDR, Math.floor((m - c) / 12));
  return a;
};
const orgCash = (m) => {
  let a = 0;
  for (let c = ORG_START; c <= m; c++) if ((m - c) % 12 === 2) a += ORG * Math.pow(NDR, Math.floor((m - c) / 12));
  return a;
};

function baselineInflow(m, churn) {
  return plgArrClose(m - 1, churn) / 12
    + AI0 * Math.pow(1.05, m - 1) / 12
    + SLG_CASH0 * Math.pow(NDR, Math.floor((m - 1) / 12)) / 12
    + orgCash(m)
    + (COLLECT[m] || 0);
}
const baselineOutflow = (m) => 300000 - CREDIT(m);

// ── Dates ───────────────────────────────────────────────────────────────────
test('month labels and default dates map to the agreed calendar months', () => {
  const p = D();
  assert.equal(E.monthLabel(p.start, 1), "Nov '26");
  assert.equal(E.monthLabel(p.start, 2), "Dec '26");
  assert.equal(E.monthLabel(p.start, 3), "Jan '27");
  assert.equal(E.monthLabel(p.start, 36), "Oct '29");
  assert.deepEqual(p.deals.map(d => [d.id, d.group, d.arr, E.monthLabel(p.start, d.closeMonth)]), [
    ['itc', 'itc', 75000, "Jan '27"],
    ['lt', 'lt', 150000, "Nov '26"],
    ['carwash', 'carwash', 100000, "Dec '26"],
    ['others-1', 'others', 50000, "Dec '26"],
    ['others-2', 'others', 25000, "Jan '27"]
  ]);
  for (const d of p.deals) {
    assert.deepEqual(d.schedule.map(s => [s.offset, s.pct]), [[2, 50], [4, 25], [7, 25]], d.id);
  }
  const cw = p.deals.find(d => d.id === 'carwash'); // Dec close -> Feb / Apr / Jul '27
  assert.deepEqual(cw.schedule.map(s => E.monthLabel(p.start, cw.closeMonth + s.offset)), ["Feb '27", "Apr '27", "Jul '27"]);
  const pay = id => p.collections.find(c => c.id === id).payments.map(o => [o.amount, E.monthLabel(p.start, o.month)]);
  assert.deepEqual(pay('openingAr'), [[40000, "Nov '26"], [40000, "Dec '26"], [20000, "Jan '27"]]);
  assert.deepEqual(pay('jacobs'), [[42000, "Jan '27"], [56000, "Apr '27"]]);
  assert.ok(p.collections.every(c => c.on));
  assert.equal(E.monthLabel(p.start, p.openAiCredit.startMonth), "Nov '26");
  assert.equal(p.openAiCredit.months, 2);
  assert.equal(p.openAiCredit.total, 50000);
  assert.equal(p.openAiCredit.on, true);
  assert.equal(E.monthLabel(p.start, p.marketing.startMonth), "Nov '26");
  assert.equal(p.marketing.months, 3);
  assert.equal(E.monthIndex(p.start, 2027, 6), 9); // Jul '27 = month 9
});

test('default inputs match Oct-26 month-end actuals and agreed assumptions', () => {
  const p = D();
  assert.equal(p.openingCash, 2316098);
  assert.equal(p.costs.base + p.costs.anthropic, 300000);
  assert.equal(E.openingArr(p), 142557 + 78300 + 275403);
  assert.equal(E.openingArr(p), 496260);
  assert.ok(p.deals.every(d => d.on === false));
  assert.equal(p.deals.filter(d => d.group === 'others').reduce((a, d) => a + d.arr, 0), 75000);
  assert.equal(p.deals.reduce((a, d) => a + d.arr, 0), 400000);
  assert.equal(p.marketing.on, false);
  assert.equal(p.plg.churnReductionOn, false);
});

// ── Baseline, month 1 by hand ───────────────────────────────────────────────
test('month 1 cash, by hand', () => {
  const r = E.simulate(D(), H)[0];
  close(r.inPlg, 142557 / 12);
  close(r.inAi, 78300 / 12);
  close(r.inSlgBase, 170403 / 12);
  close(r.inOneOff, 40000);
  close(r.inDeals, 0);
  close(r.creditOffset, 25000);
  close(r.outflow, 300000 - 25000);
  // 11879.75 + 6525 + 14200.25 + 40000 - (300000 - 25000)
  close(r.cashClose, 2316098 + 11879.75 + 6525 + 14200.25 + 40000 - 300000 + 25000);
});

test('Jacobs: $42K in Jan-27 and $56K in Apr-27 only; excluded from monthly SLG cash', () => {
  const p = D();
  const rows = E.simulate(p, H);
  const noJ = D(); noJ.collections.find(c => c.id === 'jacobs').on = false;
  const rowsNoJ = E.simulate(noJ, H);
  const jac = rows.map((r, i) => r.inOneOff - rowsNoJ[i].inOneOff);
  jac.forEach((v, i) => close(v, i === 2 ? 42000 : i === 5 ? 56000 : 0, `Jacobs m${i + 1}`));
  close(jac.reduce((a, b) => a + b, 0), 98000);
  rows.forEach(r => close(r.inSlgBase, 170403 * Math.pow(NDR, Math.floor((r.m - 1) / 12)) / 12, `SLG cash m${r.m}`));
  rows.forEach((r, i) => close(r.arrTotal, rowsNoJ[i].arrTotal)); // cash-only assumption
});

test('Opening AR switch removes exactly $40K / $40K / $20K', () => {
  const base = E.simulate(D(), H);
  const p = D(); p.collections.find(c => c.id === 'openingAr').on = false;
  const rows = E.simulate(p, H);
  const cum = [40000, 80000, 100000];
  rows.forEach((r, i) => close(base[i].cashClose - r.cashClose, cum[Math.min(i, 2)], `AR m${r.m}`));
});

test('OpenAI credits: $50K off inference, $25K Nov + $25K Dec, capped at that month\'s inference cost', () => {
  const base = E.simulate(D(), H);
  base.forEach(r => close(r.creditOffset, CREDIT(r.m), `credit m${r.m}`));
  close(base.reduce((a, r) => a + r.creditOffset, 0), 50000);
  const off = D(); off.openAiCredit.on = false;
  E.simulate(off, H).forEach((r, i) => {
    close(r.creditOffset, 0);
    close(base[i].cashClose - r.cashClose, 25000 * Math.min(r.m, 2), `credit cum m${r.m}`);
  });
  const small = D(); small.costs.anthropic = 10000;
  E.simulate(small, H).forEach(r => close(r.creditOffset, r.m <= 2 ? 10000 : 0, `cap m${r.m}`));
  const zero = D(); zero.costs.anthropic = 0;
  E.simulate(zero, H).forEach(r => { close(r.creditOffset, 0); close(r.outflow, 250000); });
});

// ── Baseline, every month vs closed form ────────────────────────────────────
test('baseline ARR streams follow closed forms for 36 months', () => {
  const rows = E.simulate(D(), H);
  rows.forEach(r => {
    close(r.arrPlg, plgArrClose(r.m, 0.20), `PLG m${r.m}`);
    close(r.arrAi, aiArrClose(r.m), `AI m${r.m}`);
    close(r.arrSlgBase, slgArrAt(r.m), `SLG m${r.m}`);
    close(r.arrMkt, 0);
    close(r.arrDeals, 0);
  });
  close(rows[11].arrSlgBase, 275403);           // Oct '27: before first renewal step
  close(rows[12].arrSlgBase, 275403 * 1.05);    // Nov '27: first annual NDR step
  close(rows[24].arrSlgBase, 275403 * 1.05 * 1.05);
});

test('baseline closing cash matches cumulative closed form for 36 months', () => {
  const rows = E.simulate(D(), H);
  let cash = 2316098;
  for (let m = 1; m <= H; m++) {
    cash += baselineInflow(m, 0.20) - baselineOutflow(m);
    close(rows[m - 1].cashClose, cash, `cash m${m}`);
  }
});

// ── Identities that must hold in every row of every scenario ─────────────────
function assertIdentities(rows, p) {
  let prev = p.openingCash;
  for (const r of rows) {
    close(r.cashOpen, prev, `opening m${r.m}`);
    close(r.inflow, r.inPlg + r.inMkt + r.inAi + r.inSlgBase + r.inDeals + r.inSlgOrg + r.inOneOff, `inflow m${r.m}`);
    close(r.outflow, r.outBase + r.outAnthropic - r.creditOffset + r.outMkt, `outflow m${r.m}`);
    assert.ok(r.creditOffset >= 0 && r.creditOffset <= r.outAnthropic, `credit cap m${r.m}`);
    close(r.cashClose, r.cashOpen + r.inflow - r.outflow, `cash m${r.m}`);
    close(r.arrTotal, r.arrPlg + r.arrMkt + r.arrAi + r.arrSlgBase + r.arrDeals + r.arrSlgOrg, `ARR m${r.m}`);
    prev = r.cashClose;
  }
}

test('cash and ARR identities hold with every lever combination', () => {
  const ants = [0, 25000, 50000, 80000];
  for (let mask = 0; mask < 1024; mask++) {
    const p = D();
    p.deals.forEach((d, i) => { d.on = !!(mask & (1 << i)); });
    p.marketing.on = !!(mask & 32);
    p.plg.churnReductionOn = !!(mask & 64);
    p.openAiCredit.on = !!(mask & 128);
    p.collections[0].on = !!(mask & 256);
    p.collections[1].on = !!(mask & 512);
    p.costs.anthropic = ants[mask % 4];
    assertIdentities(E.simulate(p, H), p);
  }
});

// ── Levers ──────────────────────────────────────────────────────────────────
test('Anthropic selector shifts cash by exactly (cost - 50K) x months (credits off)', () => {
  const b = D(); b.openAiCredit.on = false;
  const base = E.simulate(b, H);
  for (const [cost, delta] of [[80000, -30000], [25000, 25000], [0, 50000]]) {
    const p = D(); p.openAiCredit.on = false; p.costs.anthropic = cost;
    const rows = E.simulate(p, H);
    rows.forEach((r, i) => {
      close(r.cashClose - base[i].cashClose, delta * r.m, `anthropic ${cost} m${r.m}`);
      close(r.arrTotal, base[i].arrTotal); // cost lever never touches ARR
    });
  }
});

test('L&T deal: ARR from Dec-26, cash 50/25/25 in Feb/Apr/Jul-27, renews x NDR', () => {
  const base = E.simulate(D(), H);
  const p = D(); const lt = p.deals.find(d => d.id === 'lt'); lt.on = true; lt.closeMonth = 2;
  const rows = E.simulate(p, H);
  const expCash = { 4: 75000, 6: 37500, 9: 37500, 16: 78750, 18: 39375, 21: 39375, 28: 82687.5, 30: 41343.75, 33: 41343.75 };
  let cum = 0;
  rows.forEach((r, i) => {
    const m = r.m;
    const expArr = m < 2 ? 0 : m < 14 ? 150000 : m < 26 ? 157500 : 165375;
    close(r.arrDeals, expArr, `deal ARR m${m}`);
    close(r.inDeals, expCash[m] || 0, `deal cash m${m}`);
    cum += expCash[m] || 0;
    close(r.cashClose - base[i].cashClose, cum, `deal cumulative m${m}`);
  });
});

test('default close months: L&T Nov, Car Wash + Others $50K Dec, ITC + Others $25K Jan', () => {
  const p = D(); p.deals.forEach(d => { d.on = true; });
  const rows = E.simulate(p, H);
  // ARR builds 150K (Nov) -> 300K (Dec) -> 400K (Jan)
  [150000, 300000, 400000, 400000].forEach((v, i) => close(rows[i].arrDeals, v, `deal ARR m${i + 1}`));
  // Cash by hand (50/25/25 at +2/+4/+7 from each close):
  // L&T Nov 150K: Jan 75K, Mar 37.5K, Jun 37.5K | Car Wash Dec: Feb 50K, Apr 25K, Jul 25K
  // Others-1 Dec 50K: Feb 25K, Apr 12.5K, Jul 12.5K | ITC Jan: Mar 37.5K, May 18.75K, Aug 18.75K
  // Others-2 Jan 25K: Mar 12.5K, May 6.25K, Aug 6.25K
  const exp = { 3: 75000, 4: 75000, 5: 87500, 6: 37500, 7: 25000, 8: 37500, 9: 37500, 10: 25000 };
  rows.slice(0, 12).forEach(r => close(r.inDeals, exp[r.m] || 0, `deal cash m${r.m}`));
  close(rows.slice(0, 12).reduce((a, r) => a + r.inDeals, 0), 400000);
});

test('all deals closing together = $400K ARR in Dec-26 and $200K cash in Feb-27', () => {
  const p = D(); p.deals.forEach(d => { d.on = true; d.closeMonth = 2; });
  const rows = E.simulate(p, H);
  close(rows[0].arrDeals, 0);
  close(rows[1].arrDeals, 400000);
  close(rows[3].inDeals, 200000);
  close(rows[5].inDeals, 100000);
  close(rows[8].inDeals, 100000);
  const total12 = rows.slice(0, 12).reduce((a, r) => a + r.inDeals, 0);
  close(total12, 400000); // first-year contract fully collected by Jul '27
});

test('each deal is independent and additive', () => {
  const base = E.simulate(D(), H);
  const all = D(); all.deals.forEach(d => { d.on = true; });
  const allRows = E.simulate(all, H);
  const sum = new Array(H).fill(0);
  for (const id of ['itc', 'lt', 'carwash', 'others-1', 'others-2']) {
    const p = D(); p.deals.find(d => d.id === id).on = true;
    E.simulate(p, H).forEach((r, i) => { sum[i] += r.cashClose - base[i].cashClose; });
  }
  allRows.forEach((r, i) => close(r.cashClose - base[i].cashClose, sum[i], `additive m${r.m}`));
});

test('PLG fixed $ new ARR: Nov-Jan +$70K/mo before 20% churn, then 30% of base (by hand)', () => {
  const rows = E.simulate(D(), 6);
  close(rows[0].arrPlg, 184045.6);                              // Nov '26: 142,557 x 0.8 + 70,000
  close(rows[1].arrPlg, 217236.48);                             // Dec '26: 184,045.6 x 0.8 + 70,000
  close(rows[2].arrPlg, 243789.184);                            // Jan '27: 217,236.48 x 0.8 + 70,000
  close(rows[3].arrPlg, rows[2].arrPlg * 1.10);                 // Feb '27: 30% new - 20% churn
  const p = D(); p.plg.newFixedMonths = 0;                      // switched off = pure % rule
  close(E.simulate(p, 1)[0].arrPlg, 142557 * 1.10);
});

test('marketing: 3 x $35K spend, ARR lands 1x ON TOP of PLG new ARR and churns at PLG rate only', () => {
  const base = E.simulate(D(), H);
  const p = D(); p.marketing.on = true;
  const rows = E.simulate(p, H);
  // ARR (closing): m1 35000; m2 35000*0.8+35000; m3 63000*0.8+35000; then decays 20%/mo
  const arr = [35000, 63000, 85400];
  for (let m = 4; m <= H; m++) arr.push(arr[m - 2] * 0.8);
  rows.forEach((r, i) => {
    close(r.outMkt, r.m <= 3 ? 35000 : 0, `spend m${r.m}`);
    close(r.arrMkt, arr[i], `mkt ARR m${r.m}`);
    close(r.inMkt, i === 0 ? 0 : arr[i - 1] / 12, `mkt cash m${r.m}`);
    close(r.arrPlg, base[i].arrPlg); // no compounding on the organic base
    close(r.arrTotal, base[i].arrTotal + arr[i], `on top m${r.m}`);
  });
});

test('PLG new % schedule: 30% for 6 months, -2.5 pts/mo, 25% floor', () => {
  const p = D();
  const got = [];
  for (let m = 1; m <= 14; m++) got.push(+(E.plgNewRate(p, m) * 100).toFixed(9));
  assert.deepEqual(got, [30, 30, 30, 30, 30, 30, 27.5, 25, 25, 25, 25, 25, 25, 25]);
  assert.equal(E.monthLabel(p.start, 8), "Jun '27"); // floor reached Jun '27
  p.plg.newStepPts = 0;                               // step 0 = flat 30%
  for (let m = 1; m <= 36; m++) close(E.plgNewRate(p, m), 0.30);
  const q = D(); q.plg.newFloorPct = 40;              // floor above start is rejected
  assert.throws(() => E.simulate(q, H));
});

test('Lower PLG churn switch: off by default; on = whole base at the editable rate (15%, try 10%)', () => {
  const p = D();
  assert.equal(p.plg.churnReductionOn, false);
  assert.equal(E.plgChurnRate(p), 0.20);
  p.plg.churnReductionOn = true;
  assert.equal(E.plgChurnRate(p), 0.15);
  E.simulate(p, H).forEach(r => close(r.arrPlg, plgArrClose(r.m, 0.15), `PLG m${r.m}`));
  close(E.simulate(p, 1)[0].arrPlg, 142557 * 0.85 + 70000);     // existing base churns at 15% too
  p.plg.lowChurnPct = 10;
  assert.equal(E.plgChurnRate(p), 0.10);
  E.simulate(p, H).forEach(r => close(r.arrPlg, plgArrClose(r.m, 0.10), `PLG 10% m${r.m}`));
  p.plg.lowChurnPct = -1;
  assert.throws(() => E.simulate(p, H));
});

test('everything on: cash equals baseline + each lever computed independently', () => {
  const p = D();
  p.deals.forEach(d => { d.on = true; d.closeMonth = 2; });
  p.marketing.on = true;
  p.plg.churnReductionOn = true;
  p.costs.anthropic = 80000;
  const rows = E.simulate(p, H);
  const dealCash = { 4: 200000, 6: 100000, 9: 100000, 16: 210000, 18: 105000, 21: 105000, 28: 220500, 30: 110250, 33: 110250 };
  const mkt = [35000, 35000 * 0.85 + 35000];                    // marketing ARR on top, churning at 15%
  mkt.push(mkt[1] * 0.85 + 35000);
  for (let m = 4; m <= H; m++) mkt.push(mkt[m - 2] * 0.85);
  let cash = 2316098;
  for (let m = 1; m <= H; m++) {
    const inflow = baselineInflow(m, 0.15) + (dealCash[m] || 0) + (m > 1 ? mkt[m - 2] / 12 : 0);
    const outflow = 250000 + 80000 - CREDIT(m) + (m <= 3 ? 35000 : 0);
    cash += inflow - outflow;
    const r = rows[m - 1];
    close(r.cashClose, cash, `cash m${m}`);
    const dealArr = m < 2 ? 0 : 400000 * Math.pow(NDR, Math.floor((m - 2) / 12));
    close(r.arrTotal, plgArrClose(m, 0.15) + aiArrClose(m) + slgArrAt(m) + mkt[m - 1] + dealArr + orgArr(m), `ARR m${m}`);
  }
});

test('turning levers on then off returns exactly the baseline', () => {
  const base = E.simulate(D(), H);
  const p = D();
  p.deals.forEach(d => { d.on = true; }); p.marketing.on = true; p.plg.churnReductionOn = true;
  E.simulate(p, H);
  p.deals.forEach(d => { d.on = false; }); p.marketing.on = false; p.plg.churnReductionOn = false;
  assert.deepEqual(E.simulate(p, H), base);
});

// ── Runway, $1M and alerts (synthetic cases, solved by hand) ─────────────────
// PLG only: ARR 1200 doubling each month, cost 1000/mo. Cash inflow m = 100 * 2^(m-1).
function synthetic(cash, target) {
  const p = D();
  p.openingCash = cash; p.targetArr = target; p.arrRounding = 0; // exact target in hand-solved cases
  p.costs = { base: 1000, anthropic: 0 };
  p.plg = { subArr: 1200, newFixedArr: 0, newFixedMonths: 0, newPct: 100, newHoldMonths: 0, newStepPts: 0, newFloorPct: 0, churnPct: 0, lowChurnPct: 0, churnReductionOn: false };
  p.ai = { arr: 0, growthPct: 0 };
  p.slg = { arr: 0, churnPct: 0, expPct: 0, jacobsArr: 0 };
  p.collections = [];
  return p;
}

test('runout interpolates inside the month', () => {
  // cash: 2000 -> 1100 -> 300 -> -300 (m3) => runout = 2 + 300/600 = 2.5
  const p = synthetic(2000, 1e12);
  assert.equal(E.analyse(p).runout, 2.5);
  const flat = D(); flat.openingCash = 100; flat.costs = { base: 40, anthropic: 0 };
  flat.plg.subArr = 0; flat.plg.newFixedMonths = 0; flat.ai.arr = 0; flat.slg.arr = 0; flat.slg.jacobsArr = 0; flat.collections = [];
  assert.equal(E.analyse(flat).runout, 2.5); // 100 -> 60 -> 20 -> -20
});

test('$1M month is the first month closing ARR >= target (equality counts)', () => {
  const p = synthetic(5000, 1200 * 16); // ARR close m4 = 19200 exactly
  const a = E.analyse(p);
  assert.equal(a.hit, 4);
  // cash: 5000 -> 4100 -> 3300 -> 2700 -> 2500, then grows: never runs out
  close(a.cashAtHit, 2500);
  assert.equal(a.runout, null);
  assert.equal(a.runwayAtHit, Infinity);
  assert.equal(a.status, 'ok');
});

test('status: cash-out-first when cash hits zero before $1M', () => {
  const a = E.analyse(synthetic(2000, 1200 * 16)); // runout 2.5 < hit 4
  assert.equal(a.status, 'cash-out-first');
  assert.equal(a.cashAtHit, null);
});

test('status: low-runway when < 4 months of cash remain at $1M', () => {
  const a = E.analyse(synthetic(2000, 2400)); // hit m1, runout 2.5 => 1.5 months left
  assert.equal(a.hit, 1);
  close(a.cashAtHit, 1100);
  close(a.runwayAtHit, 1.5);
  assert.equal(a.status, 'low-runway');
});

test('status boundary: exactly 4 months left is not an alert', () => {
  // flat burn 100/mo, no revenue, opening ARR already >= target => hit 0, runout exactly 4.0
  const p = D(); p.openingCash = 400; p.costs = { base: 100, anthropic: 0 };
  p.plg.subArr = 0; p.plg.newFixedMonths = 0; p.ai.arr = 0; p.slg.arr = 0; p.slg.jacobsArr = 0; p.collections = []; p.targetArr = 0;
  const a = E.analyse(p);
  assert.equal(a.hit, 0);
  assert.equal(a.runout, 4);
  assert.equal(a.runwayAtHit, 4);
  assert.equal(a.status, 'ok');
  p.openingCash = 399;
  assert.equal(E.analyse(p).status, 'low-runway');
});

test('status: not-reached when ARR never gets there and cash never runs out', () => {
  const p = synthetic(1e9, 1e15);
  p.plg.newPct = 0;
  const a = E.analyse(p);
  assert.equal(a.hit, null);
  assert.equal(a.runout, null);
  assert.equal(a.status, 'not-reached');
});

test('$1M is found beyond the 36-month display horizon', () => {
  const p = synthetic(1e9, 1200 * Math.pow(2, 40));
  const a = E.analyse(p);
  assert.equal(a.hit, 40);
  assert.equal(a.rows.length, 36);
});

test('organic SLG: +$27.5K ARR/mo from Mar-27, cash 60 days later, renews x 1.05 (by hand)', () => {
  const rows = E.simulate(D(), H);
  const at = (m) => rows[m - 1];
  close(at(4).arrSlgOrg, 0);                        // Feb '27: nothing yet
  close(at(5).arrSlgOrg, 27540.3);                  // Mar '27
  close(at(6).arrSlgOrg, 55080.6);                  // Apr '27
  [1, 2, 3, 4, 5, 6].forEach(m => close(at(m).inSlgOrg, 0, `no cash m${m}`));
  close(at(7).inSlgOrg, 27540.3);                   // May '27: Mar cohort collected
  close(at(8).inSlgOrg, 27540.3);
  close(at(17).arrSlgOrg, 13 * 27540.3 + 0.05 * 27540.3); // Mar '28: 13 cohorts, first renewed
  close(at(19).inSlgOrg, 27540.3 + 27540.3 * 1.05);       // May '28: new + renewal of Mar '27
  const off = D(); off.slgGrowth.on = false;
  E.simulate(off, H).forEach(r => { close(r.arrSlgOrg, 0); close(r.inSlgOrg, 0); });
});

test('leverImpact: no $1M date delta when cash runs out first on either side', () => {
  const p = D(); p.slgGrowth.on = false; // no deals, no organic SLG: cash runs out first with or without ITC
  const itc = E.leverImpact(p, q => { q.deals[0].on = true; }, q => { q.deals[0].on = false; });
  assert.equal(itc.reachedWith, false);
  assert.equal(itc.reachedWithout, false);
  assert.equal(itc.hitDelta, null);
  assert.equal(itc.cashAtHitDelta, null);
  assert.ok(itc.runoutDelta > 0); // runway still extends
});

test('leverImpact: real deltas when $1M is reached both ways; identical runs give zero', () => {
  const p = D(); p.deals.forEach(d => { d.on = true; }); p.plg.churnReductionOn = true;
  const lt = E.leverImpact(p, q => { q.deals[1].on = true; }, q => { q.deals[1].on = false; });
  assert.equal(lt.reachedWith, true);
  assert.equal(lt.reachedWithout, true);
  assert.equal(lt.hitDelta, lt.with.hit - lt.without.hit);
  assert.ok(lt.hitDelta < 0);
  close(lt.cashAtHitDelta, lt.with.cashAtHit - lt.without.cashAtHit);
  const zero = E.leverImpact(p, () => {}, () => {});
  assert.equal(zero.hitDelta, 0);
  assert.equal(zero.cashAtHitDelta, 0);
  assert.equal(zero.runoutDelta, 0);
});

// ── Safety ──────────────────────────────────────────────────────────────────
test('invalid inputs throw instead of producing numbers', () => {
  const bad = [
    p => { p.openingCash = NaN; },
    p => { p.openingCash = Infinity; },
    p => { p.costs.base = -1; },
    p => { p.horizon = 0; },
    p => { p.plg.churnPct = -5; },
    p => { p.deals[0].schedule[0].pct = 60; },          // schedule totals 110%
    p => { p.deals[0].closeMonth = 0; },
    p => { p.marketing.months = 1.5; },
    p => { p.ai.growthPct = -100; },
    p => { p.collections[0].payments[0].amount = "40000"; }, // strings are not numbers
    p => { p.slg.jacobsArr = 300000; },                // Jacobs larger than SLG
    p => { p.openAiCredit.months = 0; }
  ];
  for (const f of bad) {
    const p = D(); f(p);
    assert.throws(() => E.simulate(p, H));
  }
});

test('analyse never mutates its input', () => {
  const p = D(); p.deals[1].on = true; p.marketing.on = true;
  const snapshot = JSON.stringify(p);
  E.analyse(p);
  E.leverImpact(p, q => { q.deals[0].on = true; }, q => { q.deals[0].on = false; });
  assert.equal(JSON.stringify(p), snapshot);
});

// ── Preset scenarios ────────────────────────────────────────────────────────
test('scenarios set exactly the agreed switches and nothing else', () => {
  const p = D();
  const groupsOn = q => [...new Set(q.deals.filter(d => d.on).map(d => d.group))];
  const sw = q => ({
    deals: groupsOn(q),
    ar: q.collections.find(c => c.id === 'openingAr').on,
    churn: q.plg.churnReductionOn,
    ant: q.costs.anthropic,
    openAi: q.openAiCredit.on,
    mkt: q.marketing.on
  });
  const expected = {
    bear: { deals: ['lt', 'others'], ar: true, churn: false, ant: 80000, openAi: true, mkt: false },
    base: { deals: ['lt', 'carwash', 'others'], ar: true, churn: false, ant: 50000, openAi: true, mkt: false },
    bull: { deals: ['itc', 'lt', 'carwash', 'others'], ar: true, churn: false, ant: 25000, openAi: true, mkt: true }
  };
  assert.deepEqual(E.SCENARIOS.map(s => s.id), ['bear', 'base', 'bull']);
  for (const id of Object.keys(expected)) {
    const q = E.applyScenario(p, id);
    assert.deepEqual(sw(q), expected[id], id);
    assert.equal(E.matchScenario(q), id);
    // assumptions untouched: only switch fields differ
    const strip = x => { const c = E.clone(x); c.deals.forEach(d => { d.on = false; }); c.collections.forEach(k => { k.on = true; });
      c.plg.churnReductionOn = false; c.costs.anthropic = 0; c.openAiCredit.on = false; c.marketing.on = false; return JSON.stringify(c); };
    assert.equal(strip(q), strip(p), id + ' changed an assumption');
  }
  // Bull turns on both "Others" tranches
  assert.deepEqual(E.applyScenario(p, 'bull').deals.filter(d => d.group === 'others').map(d => d.on), [true, true]);
  assert.throws(() => E.applyScenario(p, 'nope'));
});

test('matchScenario returns null (Custom) once a switch differs', () => {
  const q = E.applyScenario(D(), 'base');
  q.marketing.on = true;
  assert.equal(E.matchScenario(q), null);
  q.marketing.on = false;
  assert.equal(E.matchScenario(q), 'base');
  q.deals.find(d => d.id === 'others-2').on = false; // half a group on = custom
  assert.equal(E.matchScenario(q), null);
});

// ── $1M rounding rule, preset headline numbers, hand-calc sense checks (Nov 11 audit) ──
test('$1M test uses ARR rounded to the nearest $10K: $995,000 counts, a cent less does not', () => {
  const p = D();
  assert.equal(p.arrRounding, 10000);
  assert.equal(E.meetsTarget(p, 995000), true);
  assert.equal(E.meetsTarget(p, 994999.99), false);
  assert.equal(E.meetsTarget(p, 994147), false); // Bear without L&T, Jul '27: still a near miss
  assert.equal(E.meetsTarget(p, 995234), true);  // Bull without Car Wash, Jan '27: now counts
  assert.equal(E.meetsTarget(p, 999669), true);  // the Base-without-Car-Wash May '27 near miss
  p.arrRounding = 0;
  assert.equal(E.meetsTarget(p, 999999.99), false);
  assert.equal(E.meetsTarget(p, 1000000), true);
});

test('rounding regression (audit case, pure 30% PLG rule): May \'27 ARR $999,669 counts as $1M', () => {
  const p = E.applyScenario(D(), 'base'); p.plg.newFixedMonths = 0; p.marketing.on = true; // Base as audited
  const q = E.clone(p); q.deals.forEach(d => { if (d.group === 'carwash') d.on = false; });
  const rows = E.simulate(q, 12);
  assert.ok(rows[6].arrTotal > 999000 && rows[6].arrTotal < 1000000); // May '27 just under exact $1M
  assert.equal(E.analyse(q).hit, 7);
  assert.equal(E.analyse(p).hit, 5);
});

test('preset headline numbers are pinned (any change that moves a board number must be explained)', () => {
  const expect = {
    // Nov 11 '26 (later): PLG new ARR fixed $81K/mo Nov-Jan (marketing users inside it).
    // Moved Bear Jun -> Apr '27; Base and Bull $1M months unchanged, runways ~+7-12 days.
    bear: { hit: 7, cash: 742522, runout: 10.2237, status: 'low-runway' }, // $70K PLG (was $81K): Apr -> May '27
    base: { hit: 5, cash: 1403137, runout: 12.1381, status: 'ok' }, // marketing out of Base; PLG $70K/mo Nov-Jan
    bull: { hit: 3, cash: 1769755, runout: 13.8587, status: 'ok' }  // marketing ARR now on top of PLG new ARR
  };
  Object.keys(expect).forEach(id => {
    const a = E.analyse(E.applyScenario(D(), id)), x = expect[id];
    assert.equal(a.hit, x.hit, id + ' $1M month');
    assert.ok(Math.abs(a.cashAtHit - x.cash) < 1, id + ' cash at $1M');
    assert.ok(Math.abs(a.runout - x.runout) < 1e-4, id + ' runout');
    assert.equal(a.status, x.status, id + ' status');
  });
});

test('sense check: Anthropic runway effect within 10% of extra cost x months / net burn', () => {
  ['bear', 'base', 'bull'].forEach(id => {
    const p = E.applyScenario(D(), id);
    [25000, 80000].forEach(alt => {
      const r = E.leverImpact(p, q => { q.costs.anthropic = alt; }, q => { q.costs.anthropic = 50000; });
      const exactDays = Math.abs(E.monthsToDays(r.runoutDelta));
      const chk = E.costCheck(p, alt, 50000);
      assert.ok(chk, id + ' ' + alt + ' has a check');
      assert.ok(Math.abs(chk.days - exactDays) <= 0.1 * exactDays,
        id + ' ' + alt + ': hand calc ' + chk.days + ' vs page ' + exactDays + ' days');
    });
  });
  // Base $50K -> $80K: $30K x ~10.3 mo / ~$210K net burn ~= 46 days (42 at audit; 47 with $81K PLG and marketing out of Base; 46 with $70K PLG)
  assert.equal(Math.abs(E.monthsToDays(E.leverImpact(E.applyScenario(D(), 'base'),
    q => { q.costs.anthropic = 80000; }, q => { q.costs.anthropic = 50000; }).runoutDelta)), 46);
});

test('sense check: removing a deal delays $1M by about (its ARR - margin above $1M) / monthly ARR growth (+/- 1.5 months)', () => {
  ['bear', 'base', 'bull'].forEach(id => {
    const p = E.applyScenario(D(), id);
    ['lt', 'carwash', 'others', 'itc'].forEach(g => {
      const deals = p.deals.filter(d => d.group === g);
      if (!deals[0].on) return;
      const arr = deals.reduce((s, d) => s + d.arr, 0);
      const q = E.clone(p); q.deals.forEach(d => { if (d.group === g) d.on = false; });
      const hitWith = E.analyse(p).hit, hitWithout = E.analyse(q).hit;
      const rows = E.simulate(q, 24);
      const growth = (rows[hitWith + 5].arrTotal - rows[hitWith - 1].arrTotal) / 6; // avg monthly growth after the hit
      const margin = E.simulate(p, 24)[hitWith - 1].arrTotal - p.targetArr; // ARR already above $1M at the hit
      const est = Math.max(arr - margin, 0) / growth;
      // +-1.5: both $1M dates are whole months, so a near miss (e.g. Bear -L&T: Jul '27 $994K) adds up to a month
      assert.ok(Math.abs((hitWithout - hitWith) - est) <= 1.5,
        id + ' -' + g + ': shift ' + (hitWithout - hitWith) + ' vs hand calc ' + est.toFixed(1));
    });
  });
});
