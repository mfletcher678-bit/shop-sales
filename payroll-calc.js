// Payroll sums for the rota app's Payroll page: PAYE income tax, National Insurance, student loans,
// Statutory Sick Pay, NEST pension, and turning the rota into paid days. No screen code here, so the
// same file runs in the page and under Node for the tests (tools/payroll-calc.test.js).
//
// Money is held in whole pennies (integers) all the way through, so nothing drifts. Income tax follows
// HMRC's "Specification for PAYE tax table routines" (v24, Feb 2026): free pay from the tax code in
// 500 blocks, cumulative band thresholds to 4 decimal places, taxable pay rounded down to the pound,
// tax rounded down to the penny, and the 50% overriding limit. NI uses the exact percentage method.
(function (root) {
  "use strict";

  // ---- 2026/27 rates (GOV.UK "Rates and thresholds for employers 2026 to 2027") --------------------
  // Stored in the payroll_tax_years table as settings, so each April's figures can be typed in there.
  const RATES_2026_27 = {
    taxYear: "2026-27",
    personalAllowance: 12570,
    emergencyCode: "1257L",
    maxRatePct: 50, // overriding limit: tax taken in a period can't be more than half the pay
    // Bands above the personal allowance. The last band has no width (it runs on forever).
    bands: [{ width: 37700, rate: 20 }, { width: 87440, rate: 40 }, { rate: 45 }], // England, Wales, NI
    basicBand: 0, // which band is the basic rate (BR codes); D0 is the one after it, D1 the next
    scotBands: [{ width: 3967, rate: 19 }, { width: 12989, rate: 20 }, { width: 14136, rate: 21 }, { width: 31338, rate: 42 }, { width: 62710, rate: 45 }, { rate: 48 }],
    scotBasicBand: 1,
    ni: {
      // Monthly thresholds, as HMRC publishes them (not the annual figure divided by 12).
      monthly: { LEL: 559, PT: 1048, ST: 417, UEL: 4189, UST: 4189, AUST: 4189, VUST: 4189 },
      // Each letter: [threshold the rate starts at, %], in order. Earnings below the first threshold pay nothing.
      employee: {
        A: [["PT", 8], ["UEL", 2]], B: [["PT", 1.85], ["UEL", 2]], C: [], H: [["PT", 8], ["UEL", 2]],
        J: [["PT", 2], ["UEL", 2]], M: [["PT", 8], ["UEL", 2]], V: [["PT", 8], ["UEL", 2]], Z: [["PT", 2], ["UEL", 2]], X: [],
      },
      employer: {
        A: [["ST", 15]], B: [["ST", 15]], C: [["ST", 15]], J: [["ST", 15]],
        H: [["AUST", 15]], M: [["UST", 15]], V: [["VUST", 15]], Z: [["UST", 15]], X: [],
      },
      // A result of exactly half a penny: HMRC's regulation 12(1)(b) disregards less than 0.5p, so 0.5p rounds up.
      halfPenny: "up",
    },
    employmentAllowance: 10500,
    // SSP from 6 April 2026: paid from the first day off sick, no lower earnings limit, the lower of
    // £123.25 a week or 80% of average weekly earnings. A day's SSP = weekly rate / qualifying days
    // that week, and the total for a week is rounded up to the penny (HMRC's own table does this).
    ssp: { weekly: 123.25, awePct: 80, maxWeeks: 28 },
    studentLoans: { // monthly thresholds; deductions are rounded down to the whole pound
      plan1: { monthly: 2241.66, pct: 9 }, plan2: { monthly: 2448.75, pct: 9 }, plan4: { monthly: 2816.25, pct: 9 },
      plan5: { monthly: 2083.33, pct: 9 }, postgrad: { monthly: 1750, pct: 6 },
    },
    // Auto-enrolment qualifying earnings for a monthly pay period.
    pension: { qeLowerMonthly: 520, qeUpperMonthly: 4189, triggerMonthly: 833 },
  };

  // ---- Pennies ----------------------------------------------------------------------------------------
  const P = (pounds) => Math.round(Number(pounds || 0) * 100);
  const pounds = (p) => p / 100;
  const money = (p) => (p < 0 ? "-" : "") + "£" + (Math.abs(p) / 100).toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  /** pennies × pct%, rounded to a penny. Exact: works in hundredths of a percent. */
  function pct(p, rate, mode = "half-up") {
    const bp = Math.round(Number(rate) * 100);
    const n = p * bp; // value in 1/10000 of a penny
    const neg = n < 0, a = Math.abs(n), whole = Math.floor(a / 10000), rest = a % 10000;
    let r = whole;
    if (mode === "up" && rest > 0) r++;
    else if (mode === "half-up" && rest >= 5000) r++;
    else if (mode === "half-down" && rest > 5000) r++;
    return neg ? -r : r;
  }

  // ---- Tax codes ----------------------------------------------------------------------------------------
  /**
   * Reads a tax code like "1257L", "S1257L", "C1257L M1", "K475", "BR", "SD0", "NT", "0T W1".
   * Returns { region: "", "S" or "C", kind: "suffix" | "K" | "BR" | "D" | "NT", number, dIndex, cumulative }.
   */
  function parseTaxCode(text, week1month1 = false) {
    let t = String(text || "").toUpperCase().replace(/\s+/g, " ").trim();
    let cumulative = !week1month1;
    const nonCum = /\s*(W1\/?M1|W1|M1|X)$/;
    if (nonCum.test(t)) { cumulative = false; t = t.replace(nonCum, "").trim(); }
    t = t.replace(/\s/g, "");
    const base = t;
    // No UK code starts with S or C except as the Scotland / Wales marker.
    let region = "";
    if (/^[SC]/.test(t)) { region = t[0]; t = t.slice(1); }
    let m;
    const out = (o) => ({ region, cumulative, text: base, ...o });
    if (t === "BR") return out({ kind: "BR" });
    if (t === "NT") return out({ kind: "NT" });
    if ((m = /^D(\d)$/.exec(t))) return out({ kind: "D", dIndex: Number(m[1]) });
    if ((m = /^K(\d+)$/.exec(t))) return out({ kind: "K", number: Number(m[1]) });
    if ((m = /^(\d+)[LMNTPY]$/.exec(t))) return out({ kind: "suffix", number: Number(m[1]) });
    throw new Error(`"${text}" isn't a tax code this app understands.`);
  }

  /** Free pay (or K-code additional pay) for one period, in pennies. HMRC spec 4.3.1. */
  function periodAllowance(number, periodsPerYear = 12) {
    if (!number) return 0;
    const q = Math.floor((number - 1) / 500), r = ((number - 1) % 500) + 1;
    const remainder = Math.ceil(((r * 10 + 9) * 100) / periodsPerYear); // rounded up to the penny
    const block = periodsPerYear === 12 ? 41667 : 9616; // £416.67 a month, £96.16 a week for each 500
    return remainder + q * block;
  }

  const bandsFor = (rates, region) => (region === "S" ? rates.scotBands : rates.bands);
  const basicFor = (rates, region) => (region === "S" ? rates.scotBasicBand : rates.basicBand);

  /**
   * Tax due to date (pennies) on taxable pay to date `U` (pennies, unrounded) for period n.
   * Thresholds and threshold tax are worked to 4 decimal places of a pound (units of £0.0001),
   * taxable pay is rounded down to the pound, the answer is rounded down to the penny.
   */
  function taxToDate(U, n, rates, region, periodsPerYear = 12) {
    if (U <= 0) return 0;
    const bands = bandsFor(rates, region);
    if (!bands || !bands.length) throw new Error("No tax bands are set for this tax code's country (Tax rates).");
    const T = Math.floor(U / 100); // whole pounds
    let cumWidth = 0, cumTax4 = 0; // cumulative bandwidth (£) and tax on full bands (in £0.0001 × 100 per %)
    let prevC = 0, prevK = 0;
    for (let i = 0; i < bands.length; i++) {
      const b = bands[i], rbp = Math.round(b.rate * 100);
      const last = i === bands.length - 1 || b.width == null;
      if (!last) {
        const nextWidth = cumWidth + b.width;
        const cvalue = Math.ceil((nextWidth * n) / periodsPerYear); // whole pounds, rounded up
        if (U <= cvalue * 100) return Math.floor((prevK + Math.floor(((T * 10000 - prevC) * rbp) / 10000)) / 100);
        cumTax4 += b.width * rbp; // £ × basis points = £0.0001 units
        cumWidth = nextWidth;
        prevC = Math.floor((cumWidth * 10000 * n) / periodsPerYear);
        prevK = Math.floor((cumTax4 * n) / periodsPerYear);
      } else {
        return Math.floor((prevK + Math.floor(((T * 10000 - prevC) * rbp) / 10000)) / 100);
      }
    }
    return 0;
  }

  /**
   * PAYE for this period. `pay` = taxable pay this period, `prevPay`/`prevTax` = taxable pay and tax so
   * far this tax year (including a P45 from a previous job), `n` = tax month 1–12. Pennies throughout.
   */
  function paye({ code, week1month1 = false, pay, prevPay = 0, prevTax = 0, n, rates, periodsPerYear = 12 }) {
    const c = parseTaxCode(code, week1month1);
    const cum = c.cumulative;
    const k = cum ? n : 1;
    const payToDate = (cum ? prevPay : 0) + pay;
    const paidToDate = cum ? prevTax : 0;
    let due, freePay = 0, taxable;
    if (c.kind === "NT") return { tax: 0, freePay: 0, taxablePay: 0, code: c, limited: false };
    if (c.kind === "BR" || c.kind === "D") {
      const bands = bandsFor(rates, c.region);
      const idx = basicFor(rates, c.region) + (c.kind === "D" ? c.dIndex + 1 : 0);
      if (!bands[idx]) throw new Error(`No tax band for ${c.text}.`);
      taxable = payToDate;
      due = Math.floor((Math.max(0, Math.floor(payToDate / 100)) * Math.round(bands[idx].rate * 100)) / 100);
    } else {
      const per = periodAllowance(c.number, periodsPerYear) * k;
      freePay = c.kind === "K" ? -per : per;
      taxable = payToDate - freePay;
      due = taxToDate(taxable, k, rates, c.region, periodsPerYear);
    }
    let tax = due - paidToDate;
    let limited = false;
    const limit = pay > 0 ? Math.floor((pay * Math.round(rates.maxRatePct * 100)) / 10000) : 0;
    if (tax > limit) { tax = limit; limited = true; }
    return { tax, freePay, taxablePay: taxable, code: c, limited };
  }

  // ---- National Insurance ----------------------------------------------------------------------------------
  function niBands(rows, earnings, thresholds, mode) {
    if (earnings <= 0 || !rows || !rows.length) return 0;
    let n = 0;
    rows.forEach(([from, rate], i) => {
      const lo = P(thresholds[from]);
      const hi = i + 1 < rows.length ? P(thresholds[rows[i + 1][0]]) : Infinity;
      const part = Math.max(0, Math.min(earnings, hi) - lo);
      n += part * Math.round(rate * 100); // in 1/10000 penny
    });
    const whole = Math.floor(n / 10000), rest = n % 10000;
    return whole + ((mode === "half-down" ? rest > 5000 : rest >= 5000) ? 1 : 0);
  }
  /** Employee and employer NI on this period's NI-able pay, plus the earnings bands RTI asks for. */
  function ni({ letter = "A", earnings, rates }) {
    const L = String(letter || "A").toUpperCase();
    const t = rates.ni.monthly;
    if (!(L in rates.ni.employee) || !(L in rates.ni.employer)) throw new Error(`NI letter ${L} isn't set up in Tax rates.`);
    const mode = rates.ni.halfPenny === "down" ? "half-down" : "half-up";
    const e = Math.max(0, earnings);
    const LEL = P(t.LEL), PT = P(t.PT), UEL = P(t.UEL);
    return {
      employee: niBands(rates.ni.employee[L], e, t, mode),
      employer: niBands(rates.ni.employer[L], e, t, mode),
      // RTI earnings bands: up to the LEL, LEL to PT, PT to UEL (only if they reach the LEL).
      atLEL: e >= LEL ? LEL : 0,
      lelToPT: e >= LEL ? Math.min(e, PT) - LEL : 0,
      ptToUEL: e > PT ? Math.min(e, UEL) - PT : 0,
      letter: L,
    };
  }

  // ---- Student loans ----------------------------------------------------------------------------------------
  /** plans: e.g. ["plan2"] or ["plan1","plan2"], plus postgrad true/false. Whole pounds, rounded down. */
  function studentLoans({ plans = [], postgrad = false, earnings, rates }) {
    const sl = rates.studentLoans;
    let student = 0, pg = 0;
    const held = plans.filter((k) => sl[k]);
    if (held.length) {
      // More than one plan: one 9% deduction over the lowest threshold.
      const thr = Math.min(...held.map((k) => P(sl[k].monthly)));
      const rate = sl[held[0]].pct;
      student = Math.floor(Math.max(0, pct(earnings - thr, rate, "down")) / 100) * 100;
    }
    if (postgrad && sl.postgrad) pg = Math.floor(Math.max(0, pct(earnings - P(sl.postgrad.monthly), sl.postgrad.pct, "down")) / 100) * 100;
    return { student: Math.max(0, student), postgrad: Math.max(0, pg) };
  }

  // ---- Statutory Sick Pay --------------------------------------------------------------------------------------
  /** weeks: [{ days, qualifying }] sick qualifying days in each week. aweP = average weekly earnings (pennies). */
  function ssp({ weeks, aweP = null, rates }) {
    let weekly = P(rates.ssp.weekly);
    if (aweP != null && aweP > 0) weekly = Math.min(weekly, pct(aweP, rates.ssp.awePct, "half-up"));
    let total = 0, days = 0;
    for (const w of weeks) {
      if (!w.days) continue;
      const q = Math.max(1, w.qualifying || w.days);
      total += Math.ceil((weekly * Math.min(w.days, q)) / q);
      days += Math.min(w.days, q);
    }
    return { amount: total, days, weekly };
  }

  // ---- NEST ------------------------------------------------------------------------------------------------------
  /**
   * basis "qualifying": the part of pay between £520 and £4,189 a month; "all": every penny of pay.
   * NEST takes relief at source, so the member's deduction is their rate less basic-rate tax relief
   * (5% → 4% taken from pay) and NEST claims the rest from HMRC.
   */
  function nest({ pay, status, settings, rates }) {
    if (status !== "enrolled") return { pensionable: 0, employer: 0, employee: 0, employeeGross: 0 };
    const lo = P(rates.pension.qeLowerMonthly), hi = P(rates.pension.qeUpperMonthly);
    const pensionable = settings.basis === "all" ? Math.max(0, pay) : Math.max(0, Math.min(pay, hi) - lo);
    const er = pct(pensionable, settings.employerPct, "half-up");
    const eeGrossRate = Number(settings.employeePct);
    const eeRate = settings.reliefAtSource === false ? eeGrossRate : (eeGrossRate * 80) / 100;
    const ee = pct(pensionable, eeRate, "half-up");
    return { pensionable, employer: er, employee: ee, employeeGross: pct(pensionable, eeGrossRate, "half-up") };
  }

  // ---- Dates --------------------------------------------------------------------------------------------------------
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const parse = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
  const addDays = (s, n) => { const d = parse(s); d.setDate(d.getDate() + n); return iso(d); };
  const monday = (s) => { const d = parse(s); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return iso(d); };
  const dow = (s) => parse(s).getDay(); // 0 Sunday
  const lastOfMonth = (y, m) => iso(new Date(y, m, 0)); // m 1-12
  const ym = (y, m) => { const d = new Date(y, m - 1, 1); return [d.getFullYear(), d.getMonth() + 1]; };

  /** Tax month (1 = 6 Apr–5 May) and tax year ("2026-27") a payment on `payDate` falls in. */
  function taxPeriod(payDate) {
    const d = parse(payDate), y = d.getFullYear(), m = d.getMonth() + 1, day = d.getDate();
    const month = day >= 6 ? ((m - 4 + 12) % 12) + 1 : ((m - 5 + 12) % 12) + 1;
    const startYear = m > 4 || (m === 4 && day >= 6) ? y : y - 1;
    return { month, taxYear: `${startYear}-${String((startYear + 1) % 100).padStart(2, "0")}`, startYear };
  }
  /** HMRC wants the month's PAYE and NI cleared by the 22nd after the tax month ends (paying electronically). */
  function hmrcDue(taxYearStart, month) {
    const [y, m] = ym(taxYearStart, 4 + month); // tax month 1 ends 5 May → due 22 May
    return `${y}-${String(m).padStart(2, "0")}-22`;
  }
  /** Payment reference: Accounts Office reference + 2-digit year the tax year ends + 2-digit tax month. */
  function hmrcReference(accountsOfficeRef, taxYearStart, month) {
    const ao = String(accountsOfficeRef || "").replace(/\s/g, "").toUpperCase();
    if (!ao) return "";
    return ao + String((taxYearStart + 1) % 100).padStart(2, "0") + String(month).padStart(2, "0");
  }

  const workingDay = (d, bankHolidays) => dow(d) !== 0 && dow(d) !== 6 && !bankHolidays.has(d);
  /**
   * The pay run for calendar month `y`-`m`: the period it covers, its rota window (days counted for
   * extra days, hours and sickness, up to the cut-off), and payday. settings: periodStartDay (1 =
   * calendar month, 21 = 21st to 20th), cutoffDay (blank = period end), payday "last_working_day" |
   * "last_friday" | "fixed" with paydayDay.
   */
  function runDates(settings, y, m, bankHolidays = new Set()) {
    const s = Number(settings.periodStartDay) || 1;
    let periodStart, periodEnd;
    if (s === 1) { periodStart = `${y}-${String(m).padStart(2, "0")}-01`; periodEnd = lastOfMonth(y, m); }
    else { const [py, pm] = ym(y, m - 1); periodStart = `${py}-${String(pm).padStart(2, "0")}-${String(s).padStart(2, "0")}`; periodEnd = addDays(`${y}-${String(m).padStart(2, "0")}-${String(s).padStart(2, "0")}`, -1); }
    const cutoffIn = (yy, mm) => {
      const c = Number(settings.cutoffDay);
      if (!c) return null;
      const last = Number(lastOfMonth(yy, mm).slice(8));
      return `${yy}-${String(mm).padStart(2, "0")}-${String(Math.min(c, last)).padStart(2, "0")}`;
    };
    let rotaFrom = periodStart, rotaTo = periodEnd;
    if (Number(settings.cutoffDay)) { const [py, pm] = ym(y, m - 1); rotaFrom = addDays(cutoffIn(py, pm), 1); rotaTo = cutoffIn(y, m); }
    let payDate;
    const rule = settings.payday || "last_working_day";
    if (rule === "last_friday") { payDate = lastOfMonth(y, m); while (dow(payDate) !== 5) payDate = addDays(payDate, -1); }
    else {
      payDate = rule === "fixed" ? `${y}-${String(m).padStart(2, "0")}-${String(Math.min(Number(settings.paydayDay) || 28, Number(lastOfMonth(y, m).slice(8)))).padStart(2, "0")}` : lastOfMonth(y, m);
    }
    if (rule !== "last_friday") while (!workingDay(payDate, bankHolidays)) payDate = addDays(payDate, -1);
    return { periodStart, periodEnd, rotaFrom, rotaTo, payDate };
  }

  /** Mon–Fri days from `from` to `to` (for part-month salaries: a year has 260 of them). */
  function weekdays(from, to) {
    let n = 0;
    for (let d = from, i = 0; d <= to && i < 400; d = addDays(d, 1), i++) if (dow(d) >= 1 && dow(d) <= 5) n++;
    return n;
  }

  // ---- The rota as paid days ---------------------------------------------------------------------------------------
  /**
   * Works out, day by day, what the rota says someone did between `from` and `to`:
   * worked (a shift), holiday (booked and approved), closure (bank holiday or Christmas closure on one
   * of their days), sick (booked sick), other (other leave), overtime (extra days marked "Overtime").
   * The same weekly rules as the Holidays tab: a week has days_per_week working days, less one for each
   * bank holiday or closure; booked days off beyond that aren't counted.
   */
  function rotaDays({ person, from, to, closures = [], leave = [], shifts = [], extras = [], employedFrom = null, employedTo = null }) {
    const dpw = Math.ceil(Number(person.days_per_week)) || 0;
    const closed = new Map(closures.map((c) => [c.day, c]));
    const mine = leave.filter((l) => l.person_id === person.id && l.status === "approved");
    const shiftDays = new Set(shifts.filter((s) => s.person_id === person.id).map((s) => s.day));
    const inRange = (d) => d >= from && d <= to && (!employedFrom || d >= employedFrom) && (!employedTo || d <= employedTo);
    const out = { worked: [], holiday: [], closure: [], sick: [], other: [], overtime: [], sickWeeks: [] };
    for (let mon = monday(from); mon <= to; mon = addDays(mon, 7)) {
      const days = [0, 1, 2, 3, 4, 5].map((i) => addDays(mon, i));
      const closedDays = days.filter((d) => closed.has(d));
      const open = days.filter((d) => !closed.has(d));
      const working = Math.max(0, dpw - closedDays.length);
      const on = (d, kind) => mine.find((l) => l.kind === kind && l.first_day <= d && l.last_day >= d);
      const worked = days.filter((d) => shiftDays.has(d));
      const sick = open.filter((d) => !shiftDays.has(d) && on(d, "sick") && !on(d, "rest")).slice(0, working);
      const other = open.filter((d) => !shiftDays.has(d) && !sick.includes(d) && on(d, "other") && !on(d, "rest"));
      const holCandidates = open.filter((d) => !shiftDays.has(d) && !sick.includes(d) && !other.includes(d) && on(d, "holiday"));
      const holRoom = Math.max(0, working - worked.filter((d) => !closed.has(d)).length - sick.length - other.length);
      const holiday = holCandidates.slice(Math.max(0, holCandidates.length - holRoom)); // the later days, like the Holidays tab
      const closure = closedDays.filter((d) => !isSundayStr(d)).slice(0, dpw);
      out.worked.push(...worked.filter(inRange));
      out.holiday.push(...holiday.filter(inRange));
      out.closure.push(...closure.filter(inRange));
      out.other.push(...other.filter(inRange));
      const sickHere = sick.filter(inRange);
      out.sick.push(...sickHere);
      if (sickHere.length) out.sickWeeks.push({ week: mon, days: sickHere.length, qualifying: Math.max(1, working) });
    }
    for (const e of extras) {
      if (e.person_id !== person.id || e.kind !== "overtime") continue;
      const d = e.worked_on || String(e.created_at || "").slice(0, 10);
      if (inRange(d)) out.overtime.push({ day: d, days: Number(e.days) || 0, reason: e.reason || "" });
    }
    return out;
  }
  const isSundayStr = (d) => dow(d) === 0;

  // ---- One person's pay for one run ----------------------------------------------------------------------------------
  /**
   * Everything on one payslip. All money in pennies.
   *  pp       payroll details: pay_type "salary"|"hourly", annual_salary, hourly_rate, hours_per_day,
   *           tax_code, week1month1, ni_letter, student_loans [..], postgrad_loan, nest_status, start_date
   *  person   the rota row (days_per_week, left_on, started_on)
   *  run      { periodStart, periodEnd, payDate, taxMonth }
   *  days     from rotaDays() (already cut to the rota window)
   *  inputs   typed in for this run: bonus, expenses [{label, amount}], adjustments [{label, amount,
   *           taxed}], sickTopup (pounds) or sickTopupFull, overrides { worked, holiday, closure, sick, overtime }
   *  ytd      so far this tax year with this employer: { taxablePay, tax, eeNI, erNI, ... } (pennies),
   *           prevEmployment { pay, tax } from a P45
   *  employer settings (nest*, sickTopup default)
   */
  function payLine({ pp, person, run, days, inputs = {}, ytd = {}, employer = {}, rates }) {
    const warnings = [];
    const payments = [], deductions = [], info = [];
    const dpw = Number(person.days_per_week) || 5;
    const hourly = pp.pay_type === "hourly";
    const hoursPerDay = Number(pp.hours_per_day) || 8;
    const dayRate = hourly ? Math.round(Number(pp.hourly_rate || 0) * hoursPerDay * 100) : Math.round((Number(pp.annual_salary || 0) * 100) / (52 * dpw));
    const o = inputs.overrides || {};
    const count = (k, arr) => (o[k] !== undefined && o[k] !== null && o[k] !== "" ? Number(o[k]) : arr.length);
    const worked = count("worked", days.worked), holiday = count("holiday", days.holiday), closure = count("closure", days.closure);
    const sickDays = count("sick", days.sick);
    const overtime = o.overtime !== undefined && o.overtime !== null && o.overtime !== "" ? Number(o.overtime) : days.overtime.reduce((s, e) => s + e.days, 0);
    const add = (label, amount, extra = {}) => { if (amount) payments.push({ label, amount, taxed: true, pensionable: true, ...extra }); };

    // Starters and leavers part way through the period.
    const start = [pp.start_date, person.started_on].filter(Boolean).sort().pop() || null;
    const from = start && start > run.periodStart ? start : run.periodStart;
    const to = person.left_on && person.left_on < run.periodEnd ? person.left_on : run.periodEnd;
    const partMonth = from !== run.periodStart || to !== run.periodEnd;
    if (from > to) warnings.push("Not employed in this pay period.");

    if (!hourly) {
      const annual = Math.round(Number(pp.annual_salary || 0) * 100);
      if (!annual) warnings.push("No yearly salary set (Payroll › People).");
      if (from <= to) {
        if (partMonth) {
          const wd = weekdays(from, to);
          add(`Salary (part month, ${wd} weekdays × ${money(Math.round(annual / 260))})`, wd * Math.round(annual / 260));
        } else add("Salary", Math.round(annual / 12));
      }
      if (overtime) add(`Extra days worked: ${fmtDays(overtime)} × ${money(dayRate)}`, Math.round(overtime * dayRate));
      if (sickDays) add(`Sick days, normal pay stopped: ${fmtDays(sickDays)} × ${money(dayRate)}`, -Math.round(sickDays * dayRate));
    } else {
      if (!Number(pp.hourly_rate)) warnings.push("No hourly rate set (Payroll › People).");
      const per = `× ${hoursPerDay} h × ${money(Math.round(Number(pp.hourly_rate || 0) * 100))}`;
      if (worked) add(`Days worked: ${fmtDays(worked)} ${per}`, Math.round(worked * dayRate));
      if (holiday) add(`Holiday pay: ${fmtDays(holiday)} ${per}`, Math.round(holiday * dayRate));
      if (closure) add(`Bank holiday / closure: ${fmtDays(closure)} ${per}`, Math.round(closure * dayRate));
      if (overtime) info.push(`${fmtDays(overtime)} extra day${overtime === 1 ? "" : "s"} marked Overtime: paid through Days worked if they're on the rota.`);
    }
    if (days.other.length) warnings.push(`${days.other.length} day${days.other.length === 1 ? "" : "s"} of "other" leave (${days.other.map(shortDate).join(", ")}): add a one-off change if it's unpaid.`);

    // Sickness: SSP for qualifying days, plus any top-up.
    let sspPay = { amount: 0, days: 0 };
    if (sickDays) {
      const weeks = o.sick !== undefined && o.sick !== null && o.sick !== "" ? [{ days: sickDays, qualifying: Math.ceil(dpw) }] : days.sickWeeks;
      const awe = hourly ? Math.round(dayRate * dpw) : Math.round((Number(pp.annual_salary || 0) * 100) / 52);
      sspPay = ssp({ weeks, aweP: awe, rates });
      add(`Statutory Sick Pay: ${fmtDays(sspPay.days)}`, sspPay.amount, { ssp: true });
      const full = Math.max(0, Math.round(sickDays * dayRate) - sspPay.amount);
      const wantFull = inputs.sickTopupFull ?? (inputs.sickTopup == null && employer.sickTopup === "full");
      const top = wantFull ? full : P(inputs.sickTopup);
      add("Sick pay top-up", top);
    }
    if (P(inputs.bonus)) add(inputs.bonusLabel || "Bonus", P(inputs.bonus));
    for (const a of inputs.adjustments || []) {
      const amt = P(a.amount);
      if (!amt) continue;
      if (a.taxed === false) continue; // after-tax items are added below
      add(a.label || "Adjustment", amt, { pensionable: a.pensionable !== false });
    }

    const gross = payments.reduce((s, x) => s + x.amount, 0);
    const pensionablePay = payments.filter((x) => x.pensionable).reduce((s, x) => s + x.amount, 0);

    // Tax, NI, student loans, pension.
    const prevPay = (ytd.taxablePay || 0) + (ytd.prevEmploymentPay || 0);
    const prevTax = (ytd.tax || 0) + (ytd.prevEmploymentTax || 0);
    const t = paye({ code: pp.tax_code || rates.emergencyCode, week1month1: !!pp.week1month1, pay: gross, prevPay, prevTax, n: run.taxMonth, rates });
    if (t.limited) warnings.push("Tax was capped at half this month's pay (HMRC's overriding limit).");
    const n = ni({ letter: pp.ni_letter || "A", earnings: gross, rates });
    const sl = studentLoans({ plans: pp.student_loans || [], postgrad: !!pp.postgrad_loan, earnings: gross, rates });
    const pen = nest({ pay: pensionablePay, status: pp.nest_status, settings: { basis: employer.nestBasis || "qualifying", employerPct: employer.nestEmployerPct ?? 3, employeePct: employer.nestEmployeePct ?? 5, reliefAtSource: employer.nestReliefAtSource !== false }, rates });

    if (t.tax) deductions.push({ label: t.tax < 0 ? "Income tax refund" : "Income tax", amount: t.tax });
    if (n.employee) deductions.push({ label: "National Insurance", amount: n.employee });
    if (sl.student) deductions.push({ label: "Student loan", amount: sl.student });
    if (sl.postgrad) deductions.push({ label: "Postgraduate loan", amount: sl.postgrad });
    if (pen.employee) deductions.push({ label: `NEST pension (${employer.nestReliefAtSource === false ? "" : "after tax relief, "}${num(employer.nestReliefAtSource === false ? employer.nestEmployeePct ?? 5 : ((employer.nestEmployeePct ?? 5) * 80) / 100)}%)`, amount: pen.employee });
    for (const a of inputs.adjustments || []) {
      const amt = P(a.amount);
      if (amt && a.taxed === false) {
        if (amt < 0) deductions.push({ label: a.label || "Deduction", amount: -amt });
        else payments.push({ label: a.label || "Payment (not taxed)", amount: amt, taxed: false });
      }
    }
    const expenses = (inputs.expenses || []).filter((e) => P(e.amount)).map((e) => ({ label: e.label || "Expenses", amount: P(e.amount) }));
    const expensesTotal = expenses.reduce((s, e) => s + e.amount, 0);
    const untaxedPay = payments.filter((x) => !x.taxed).reduce((s, x) => s + x.amount, 0);
    const totalDeductions = deductions.reduce((s, d) => s + d.amount, 0);
    const net = gross + untaxedPay - totalDeductions + expensesTotal;
    if (net < 0) warnings.push("Net pay is below zero.");
    if (gross > 0 && pp.nest_status !== "enrolled" && pp.nest_status !== "opted_out" && gross >= P(rates.pension.triggerMonthly)) {
      warnings.push(`Earns over ${money(P(rates.pension.triggerMonthly))} this month but isn't in NEST: check auto-enrolment.`);
    }
    if (!pp.ni_number) warnings.push("No NI number (needed for PAYE Tools and NEST).");

    const thisYtd = {
      taxablePay: (ytd.taxablePay || 0) + gross, tax: (ytd.tax || 0) + t.tax, eeNI: (ytd.eeNI || 0) + n.employee, erNI: (ytd.erNI || 0) + n.employer,
      niEarnings: (ytd.niEarnings || 0) + gross, studentLoan: (ytd.studentLoan || 0) + sl.student, postgradLoan: (ytd.postgradLoan || 0) + sl.postgrad,
      nestEE: (ytd.nestEE || 0) + pen.employee, nestER: (ytd.nestER || 0) + pen.employer, ssp: (ytd.ssp || 0) + sspPay.amount,
    };
    return {
      payments, deductions, expenses, info, warnings,
      gross, net, expensesTotal, untaxedPay, totalDeductions,
      tax: t.tax, freePay: t.freePay, taxCode: t.code.text + (t.code.cumulative ? "" : " M1"),
      ni: n, studentLoan: sl.student, postgradLoan: sl.postgrad, nest: pen, ssp: sspPay.amount, sspDays: sspPay.days,
      dayRate, days: { worked, holiday, closure, sick: sickDays, overtime }, ytd: thisYtd, partMonth: partMonth ? { from, to } : null,
    };
  }
  const num = (x) => String(Math.round(Number(x) * 100) / 100);
  const fmtDays = (d) => `${num(d)} day${Number(d) === 1 ? "" : "s"}`;
  const shortDate = (s) => parse(s).toLocaleDateString("en-GB", { day: "numeric", month: "short" });

  // ---- NEST upload file ------------------------------------------------------------------------------------------------
  /** NEST contribution schedule CSV (Employer payroll guide 3.2): H header, D per member, T trailer. */
  function nestCsv({ employerRef, paymentSource, periodStart, periodEnd, dueDate = "", frequency = "Monthly", members }) {
    const clean = (s) => String(s ?? "").replace(/[,"\r\n]/g, " ").trim();
    const amt = (p) => (p / 100).toFixed(2);
    const lines = [["H", clean(employerRef), "CS", periodEnd, clean(paymentSource), dueDate, frequency, "", "", periodStart, ""].join(",")];
    for (const m of members) {
      lines.push(["D", clean(m.surname), clean(m.niNumber).replace(/\s/g, "").toUpperCase(), m.niNumber ? "" : clean(m.altId),
        amt(m.pensionable), "", amt(m.employer), amt(m.employee), m.reason ?? "", ""].join(","));
    }
    lines.push(["T", members.length, "4"].join(","));
    return lines.join("\r\n") + "\r\n";
  }

  const api = { RATES_2026_27, P, pounds, money, pct, parseTaxCode, periodAllowance, taxToDate, paye, ni, studentLoans, ssp, nest, taxPeriod, hmrcDue, hmrcReference, runDates, weekdays, rotaDays, payLine, nestCsv };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.PayrollCalc = api;
})(typeof window !== "undefined" ? window : globalThis);
