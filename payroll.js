// Payroll: the admin-only Payroll page (payroll.html: pay runs, people's pay details, employers, tax
// rates) and everyone's Payslips tab in the rota (rota.html). Both pages load this file before their
// own script, so it uses their helpers (S, api, $, esc, openSheet, dates…) only inside functions.
// The sums are in payroll-calc.js (PayrollCalc); this file is screens and saving.
"use strict";

const PC = window.PayrollCalc;
const M = (p) => PC.money(p || 0);
const pounds2 = (p) => (Math.round(p || 0) / 100).toFixed(2);
const longDate = (s) => (s ? fmt(s, { day: "numeric", month: "long", year: "numeric" }) : "");
const shortD = (s) => (s ? fmt(s, { day: "numeric", month: "short" }) : "");
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const TAX_MONTH_NAMES = ["", "Month 1 (Apr–May)", "Month 2 (May–Jun)", "Month 3 (Jun–Jul)", "Month 4 (Jul–Aug)", "Month 5 (Aug–Sep)", "Month 6 (Sep–Oct)", "Month 7 (Oct–Nov)", "Month 8 (Nov–Dec)", "Month 9 (Dec–Jan)", "Month 10 (Jan–Feb)", "Month 11 (Feb–Mar)", "Month 12 (Mar–Apr)"];
const NEST_STATUS = { none: "Not in NEST", enrolled: "Enrolled", opted_out: "Opted out", postponed: "Postponed" };
const LOAN_PLANS = [["plan1", "Plan 1"], ["plan2", "Plan 2"], ["plan4", "Plan 4"], ["plan5", "Plan 5"]];

// ---- Data: Supabase ---------------------------------------------------------------------------------------
function payrollSupa(db, must) {
  return {
    async payIsAdmin() { const r = await db.rpc("payroll_is_admin"); return !r.error && r.data === true; },
    async myPayslips() {
      const r = await db.from("payroll_payslips").select("id, run_id, person_id, pay_date, payslip").order("pay_date", { ascending: false });
      return r.error ? [] : r.data;
    },
    async payLoad() {
      const [employers, years, people, opening, runs, lines] = await Promise.all([
        db.from("payroll_employers").select("*").order("sort"), db.from("payroll_tax_years").select("*"),
        db.from("payroll_people").select("*"), db.from("payroll_opening").select("*"),
        db.from("payroll_runs").select("*").order("pay_date", { ascending: false }), db.from("payroll_lines").select("*"),
      ]);
      return { employers: must(employers), taxYears: must(years), people: must(people), opening: must(opening), runs: must(runs), lines: must(lines) };
    },
    async paySaveEmployer(row) { return must(await db.from("payroll_employers").upsert(row).select().single()); },
    async paySaveTaxYear(tax_year, rates) { must(await db.from("payroll_tax_years").upsert({ tax_year, rates, updated_at: new Date().toISOString() })); },
    async paySavePerson(row) { must(await db.from("payroll_people").upsert({ ...row, updated_at: new Date().toISOString() })); },
    async paySaveOpening(row) { must(await db.from("payroll_opening").upsert(row)); },
    async payCreateRun(run, personIds) {
      const saved = must(await db.from("payroll_runs").insert(run).select().single());
      const lines = personIds.length ? must(await db.from("payroll_lines").insert(personIds.map((person_id) => ({ run_id: saved.id, person_id }))).select()) : [];
      return { run: saved, lines };
    },
    async payAddLines(runId, personIds) { return must(await db.from("payroll_lines").insert(personIds.map((person_id) => ({ run_id: runId, person_id }))).select()); },
    async paySaveLine(id, patch) { must(await db.from("payroll_lines").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", id)); },
    async payDeleteLine(id) { must(await db.from("payroll_lines").delete().eq("id", id)); },
    async payUpdateRun(id, patch) { must(await db.from("payroll_runs").update(patch).eq("id", id)); },
    async payDeleteRun(id) { must(await db.from("payroll_runs").delete().eq("id", id)); },
    async payFinalise(runId, payslips) {
      must(await db.from("payroll_payslips").delete().eq("run_id", runId));
      if (payslips.length) must(await db.from("payroll_payslips").insert(payslips));
      must(await db.from("payroll_runs").update({ status: "final", finalised_at: new Date().toISOString() }).eq("id", runId));
    },
    async payReopen(runId) {
      must(await db.from("payroll_payslips").delete().eq("run_id", runId));
      must(await db.from("payroll_runs").update({ status: "draft", finalised_at: null }).eq("id", runId));
    },
  };
}

// ---- Data: the demo (made-up people, kept in memory) -----------------------------------------------------------
function payrollDemo(people, me) {
  const id = () => Math.random().toString(36).slice(2);
  const ltd = { id: "em_ltd", name: "Fletchers Cobblers Ltd", kind: "ltd", active: true, sort: 1, settings: { periodStartDay: 1, payday: "last_working_day", cutoffDay: 20, employmentAllowance: true, payeRef: "123/AB45678", accountsOfficeRef: "123PA00012345", nestEmployerRef: "EMP123456789", nestPaymentSource: "Ps 1", nestBasis: "qualifying", nestEmployerPct: 3, nestEmployeePct: 5, nestReliefAtSource: true, nestFrequency: "Monthly", sickTopup: "none", address: "60 Market Place, Driffield, YO25 6AW" } };
  const sole = { id: "em_sole", name: "Michael Fletcher (sole trader)", kind: "sole_trader", active: true, sort: 2, settings: { ...ltd.settings, payeRef: "321/ZZ98765", accountsOfficeRef: "321PZ00098765", nestEmployerRef: "EMP987654321", address: "54 Castlegate, Malton, YO17 7DT" } };
  const pp = (name, employer, extra) => ({ person_id: "pe_" + name, employer_id: employer, pay_type: "salary", annual_salary: null, hourly_rate: null, hours_per_day: 8, tax_code: "1257L", week1month1: false, ni_letter: "A", ni_number: null, date_of_birth: null, start_date: null, works_number: null, student_loans: [], postgrad_loan: false, nest_status: "none", nest_enrolled_on: null, notes: null, ...extra });
  const store = {
    employers: [ltd, sole],
    taxYears: [{ tax_year: "2026-27", rates: JSON.parse(JSON.stringify(PC.RATES_2026_27)) }],
    people: [
      pp("ross", "em_ltd", { annual_salary: 24000, ni_number: "QQ123456A", works_number: "1", nest_status: "enrolled", student_loans: ["plan2"] }),
      pp("kyle", "em_ltd", { annual_salary: 23400, ni_number: "QQ123456B", works_number: "2", nest_status: "enrolled" }),
      pp("jamie", "em_ltd", { annual_salary: 22568, ni_number: "QQ123456C", works_number: "3", nest_status: "opted_out" }),
      pp("ady", "em_ltd", { pay_type: "hourly", hourly_rate: 16.25, ni_number: "QQ123456D", works_number: "4", tax_code: "BR" }),
      pp("mike", "em_sole", { pay_type: "hourly", hourly_rate: 13.5, ni_number: "QQ123456E", works_number: "1" }),
      pp("tony", "em_sole", { annual_salary: 23000, ni_number: "QQ123456F", works_number: "2", nest_status: "enrolled" }),
    ],
    opening: ["ross", "kyle"].map((n) => ({ person_id: "pe_" + n, employer_id: "em_ltd", tax_year: "2026-27", taxable_pay: n === "ross" ? 10000 : 9750, tax: n === "ross" ? 951.6 : 901.6, ee_ni: n === "ross" ? 380.8 : 360.8, er_ni: n === "ross" ? 1187.25 : 1149.75, ni_earnings: n === "ross" ? 10000 : 9750, student_loan: 0, postgrad_loan: 0, nest_ee: n === "ross" ? 296 : 286, nest_er: n === "ross" ? 222 : 214.5, ssp: 0, prev_employment_pay: 0, prev_employment_tax: 0, note: "Demo: April–August from the bureau" })),
    runs: [], lines: [], payslips: [],
  };
  // Two finished months for the Ltd so the demo has payslips to look at.
  const seeded = { done: false };
  const seed = () => {
    if (seeded.done) return;
    seeded.done = true;
    const now = new Date(), months = [2, 1].map((k) => new Date(now.getFullYear(), now.getMonth() - k, 1));
    const rates = store.taxYears[0].rates;
    for (const d of months) {
      const y = d.getFullYear(), m = d.getMonth() + 1;
      const dates = PC.runDates(ltd.settings, y, m);
      const tp = PC.taxPeriod(dates.payDate);
      if (tp.taxYear !== "2026-27") continue;
      const run = { id: id(), employer_id: "em_ltd", tax_year: tp.taxYear, tax_month: tp.month, period_start: dates.periodStart, period_end: dates.periodEnd, rota_from: dates.rotaFrom, rota_to: dates.rotaTo, pay_date: dates.payDate, status: "final", created_at: now.toISOString(), finalised_at: now.toISOString() };
      store.runs.push(run);
      for (const x of store.people.filter((q) => q.employer_id === "em_ltd" && q.person_id !== "pe_jamie")) {
        const person = people.find((q) => q.id === x.person_id);
        const inputs = x.person_id === "pe_ady" ? { overrides: { worked: 8, holiday: 1, closure: 0 } } : x.person_id === "pe_kyle" ? { bonus: 50 } : {};
        const ytd = payYtdFrom(store, x.person_id, "em_ltd", run);
        const empty = { worked: [], holiday: [], closure: [], sick: [], other: [], overtime: [], sickWeeks: [] };
        const result = PC.payLine({ pp: x, person, run: { periodStart: run.period_start, periodEnd: run.period_end, payDate: run.pay_date, taxMonth: run.tax_month }, days: empty, inputs, ytd, employer: ltd.settings, rates });
        const line = { id: id(), run_id: run.id, person_id: x.person_id, inputs, result };
        store.lines.push(line);
        store.payslips.push({ id: id(), run_id: run.id, person_id: x.person_id, pay_date: run.pay_date, payslip: payslipSnapshot(run, ltd, x, person, result) });
      }
    }
  };
  const later = () => new Promise((r) => setTimeout(r, 20));
  return {
    async payIsAdmin() { return !!me.is_admin; },
    async myPayslips() { seed(); await later(); return store.payslips.filter((s) => s.person_id === me.id).sort((a, b) => b.pay_date.localeCompare(a.pay_date)); },
    async payLoad() { seed(); await later(); return JSON.parse(JSON.stringify({ employers: store.employers, taxYears: store.taxYears, people: store.people, opening: store.opening, runs: store.runs, lines: store.lines })); },
    async paySaveEmployer(row) { const e = store.employers.find((x) => x.id === row.id); if (e) Object.assign(e, row); else store.employers.push((row = { id: id(), ...row })); return row; },
    async paySaveTaxYear(tax_year, rates) { const t = store.taxYears.find((x) => x.tax_year === tax_year); if (t) t.rates = rates; else store.taxYears.push({ tax_year, rates }); },
    async paySavePerson(row) { const e = store.people.find((x) => x.person_id === row.person_id); if (e) Object.assign(e, row); else store.people.push(row); },
    async paySaveOpening(row) { const i = store.opening.findIndex((o) => o.person_id === row.person_id && o.employer_id === row.employer_id && o.tax_year === row.tax_year); if (i >= 0) store.opening[i] = row; else store.opening.push(row); },
    async payCreateRun(run, personIds) { const r = { id: id(), created_at: new Date().toISOString(), ...run }; store.runs.push(r); const lines = personIds.map((person_id) => ({ id: id(), run_id: r.id, person_id, inputs: {}, result: null })); store.lines.push(...lines); return JSON.parse(JSON.stringify({ run: r, lines })); },
    async payAddLines(runId, personIds) { const lines = personIds.map((person_id) => ({ id: id(), run_id: runId, person_id, inputs: {}, result: null })); store.lines.push(...lines); return JSON.parse(JSON.stringify(lines)); },
    async paySaveLine(lid, patch) { Object.assign(store.lines.find((l) => l.id === lid), JSON.parse(JSON.stringify(patch))); },
    async payDeleteLine(lid) { store.lines = store.lines.filter((l) => l.id !== lid); },
    async payUpdateRun(rid, patch) { Object.assign(store.runs.find((r) => r.id === rid), patch); },
    async payDeleteRun(rid) { store.runs = store.runs.filter((r) => r.id !== rid); store.lines = store.lines.filter((l) => l.run_id !== rid); store.payslips = store.payslips.filter((s) => s.run_id !== rid); },
    async payFinalise(rid, payslips) { store.payslips = store.payslips.filter((s) => s.run_id !== rid).concat(payslips.map((s) => ({ id: id(), ...s }))); Object.assign(store.runs.find((r) => r.id === rid), { status: "final", finalised_at: new Date().toISOString() }); },
    async payReopen(rid) { store.payslips = store.payslips.filter((s) => s.run_id !== rid); Object.assign(store.runs.find((r) => r.id === rid), { status: "draft", finalised_at: null }); },
  };
}

// ---- Year to date --------------------------------------------------------------------------------------------------
/** Pennies so far this tax year with this employer, before `run`: carried-over figures plus finished runs. */
function payYtdFrom(D, personId, employerId, run) {
  const o = D.opening.find((x) => x.person_id === personId && x.employer_id === employerId && x.tax_year === run.tax_year) || {};
  const y = {
    taxablePay: PC.P(o.taxable_pay), tax: PC.P(o.tax), eeNI: PC.P(o.ee_ni), erNI: PC.P(o.er_ni), niEarnings: PC.P(o.ni_earnings),
    studentLoan: PC.P(o.student_loan), postgradLoan: PC.P(o.postgrad_loan), nestEE: PC.P(o.nest_ee), nestER: PC.P(o.nest_er), ssp: PC.P(o.ssp),
    prevEmploymentPay: PC.P(o.prev_employment_pay), prevEmploymentTax: PC.P(o.prev_employment_tax),
  };
  const earlier = D.runs.filter((r) => r.employer_id === employerId && r.tax_year === run.tax_year && r.status === "final" && r.id !== run.id && (r.tax_month < run.tax_month || (r.tax_month === run.tax_month && r.pay_date < run.pay_date)));
  for (const r of earlier) {
    const l = D.lines.find((x) => x.run_id === r.id && x.person_id === personId);
    const x = l?.result;
    if (!x) continue;
    y.taxablePay += x.gross; y.tax += x.tax; y.eeNI += x.ni.employee; y.erNI += x.ni.employer; y.niEarnings += x.gross;
    y.studentLoan += x.studentLoan; y.postgradLoan += x.postgradLoan; y.nestEE += x.nest.employee; y.nestER += x.nest.employer; y.ssp += x.ssp;
  }
  return y;
}

/** What staff see: frozen when the run is finalised, so later changes never rewrite an old payslip. */
function payslipSnapshot(run, employer, pp, person, r) {
  return {
    employer: { name: employer.name, payeRef: employer.settings?.payeRef || "", address: employer.settings?.address || "" },
    person: { name: person?.name || "", niNumber: pp.ni_number || "", worksNumber: pp.works_number || "" },
    payDate: run.pay_date, periodStart: run.period_start, periodEnd: run.period_end, taxYear: run.tax_year, taxMonth: run.tax_month,
    taxCode: r.taxCode, niLetter: r.ni.letter, payType: pp.pay_type,
    payments: r.payments.map((x) => ({ label: x.label, amount: x.amount })), deductions: r.deductions, expenses: r.expenses,
    gross: r.gross + r.untaxedPay, taxablePay: r.gross, totalDeductions: r.totalDeductions, expensesTotal: r.expensesTotal, net: r.net,
    nestEmployer: r.nest.employer, pensionable: r.nest.pensionable, ytd: r.ytd, note: r.note || "",
  };
}

// ---- Payroll state ------------------------------------------------------------------------------------------------
const PAY = { loaded: false, view: "runs", employerId: null, runId: null, shifts: new Map() };
const payRates = (taxYear) => PAY.taxYears.find((t) => t.tax_year === taxYear)?.rates ?? null;
const payEmployer = (id) => PAY.employers.find((e) => e.id === id);
const payPerson = (personId) => PAY.people.find((p) => p.person_id === personId);
const payRun = (id) => PAY.runs.find((r) => r.id === id);
const payLines = (runId) => PAY.lines.filter((l) => l.run_id === runId);

async function payLoad() {
  Object.assign(PAY, await api.payLoad(), { loaded: true });
  // First time: the 2026/27 rates go in from payroll-calc.js, so the figures live in one place.
  if (!PAY.taxYears.some((t) => t.tax_year === "2026-27")) {
    const rates = JSON.parse(JSON.stringify(PC.RATES_2026_27));
    await api.paySaveTaxYear("2026-27", rates);
    PAY.taxYears.push({ tax_year: "2026-27", rates });
  }
  if (!PAY.employerId || !payEmployer(PAY.employerId)) PAY.employerId = PAY.employers[0]?.id ?? null;
}

/** Shifts for a run's rota window (admins see every week, sent or not). */
async function payShifts(run) {
  const key = run.rota_from + run.rota_to;
  if (!PAY.shifts.has(key)) PAY.shifts.set(key, await api.shifts(run.rota_from, run.rota_to));
  return PAY.shifts.get(key);
}

/** Works out one line of a draft run from the rota and what's been typed in. */
function payCompute(run, line, shifts) {
  const pp = payPerson(line.person_id), person = S.people.find((p) => p.id === line.person_id);
  const employer = payEmployer(run.employer_id), rates = payRates(run.tax_year);
  if (!pp || !person) return { error: "Not on payroll any more." };
  if (!rates) return { error: `No tax rates for ${run.tax_year} (Payroll › Tax rates).` };
  try {
    const days = PC.rotaDays({ person, from: run.rota_from, to: run.rota_to, closures: S.closures, leave: S.leave, shifts, extras: S.extras,
      employedFrom: [pp.start_date, person.started_on].filter(Boolean).sort().pop() || null, employedTo: person.left_on || null });
    const r = PC.payLine({ pp, person, run: { periodStart: run.period_start, periodEnd: run.period_end, payDate: run.pay_date, taxMonth: run.tax_month },
      days, inputs: line.inputs || {}, ytd: payYtdFrom(PAY, line.person_id, run.employer_id, run), employer: employer.settings || {}, rates });
    r.rota = { worked: days.worked.length, holiday: days.holiday.length, closure: days.closure.length, sick: days.sick.length, overtime: days.overtime.reduce((s, e) => s + e.days, 0), other: days.other.length, sickDates: days.sick, overtimeDates: days.overtime };
    r.note = line.inputs?.note || "";
    return r;
  } catch (e) { return { error: e.message }; }
}

/** People who should be in a run: on this employer's payroll and employed at some point in the period. */
function payEligible(run) {
  return PAY.people.filter((pp) => pp.employer_id === run.employer_id).map((pp) => S.people.find((p) => p.id === pp.person_id))
    .filter((p) => p && p.active && !(p.left_on && p.left_on < run.period_start) && !(p.started_on && p.started_on > run.period_end));
}

// ---- The Payroll tab --------------------------------------------------------------------------------------------------
async function renderPayroll() {
  if (!PAY.loaded) {
    $("app").innerHTML = `<p class="muted">Loading payroll…</p>`;
    try { await payLoad(); } catch (e) { $("app").innerHTML = `<div class="card"><h2>Couldn't load payroll</h2><p class="muted">${esc(e.message)}</p></div>`; return; }
  }
  const views = [["runs", "Pay runs"], ["people", "People"], ["employers", "Employers"], ["rates", "Tax rates"]];
  let html = `<div class="seg" style="margin:0 0 12px">${views.map(([k, t]) => `<button class="${PAY.view === k ? "on" : ""}" data-pv="${k}">${t}</button>`).join("")}</div><div id="payBody"></div>`;
  $("app").innerHTML = html;
  $("app").querySelectorAll("[data-pv]").forEach((b) => (b.onclick = () => { PAY.view = b.dataset.pv; PAY.runId = null; renderPayroll(); }));
  if (PAY.view === "people") payPeopleView();
  else if (PAY.view === "employers") payEmployersView();
  else if (PAY.view === "rates") payRatesView();
  else if (PAY.runId && payRun(PAY.runId)) await payRunView(payRun(PAY.runId));
  else payRunsView();
}

function employerPicker() {
  return `<div class="seg" style="margin:0 0 12px">${PAY.employers.filter((e) => e.active).map((e) => `<button class="${PAY.employerId === e.id ? "on" : ""}" data-emp="${e.id}">${esc(e.name)}</button>`).join("")}</div>`;
}
function wireEmployerPicker(again) {
  $("payBody").querySelectorAll("[data-emp]").forEach((b) => (b.onclick = () => { PAY.employerId = b.dataset.emp; again(); }));
}

// ---- Pay runs -------------------------------------------------------------------------------------------------------------
function payRunsView() {
  const emp = payEmployer(PAY.employerId);
  const runs = PAY.runs.filter((r) => r.employer_id === PAY.employerId).sort((a, b) => b.pay_date.localeCompare(a.pay_date));
  const onPayroll = PAY.people.filter((p) => p.employer_id === PAY.employerId).length;
  let html = employerPicker();
  html += `<div class="card"><div class="row"><h2 style="margin:0">Pay runs</h2><span class="spacer"></span><button class="btn" id="newRun" ${emp ? "" : "disabled"}>New pay run</button></div>
    ${onPayroll ? "" : `<div class="msg warn">Nobody is on this payroll yet. Add people under <b>People</b>.</div>`}
    <ul class="list">${runs.map((r) => {
      const ls = payLines(r.id).filter((l) => l.result && !l.result.error);
      const net = ls.reduce((s, l) => s + l.result.net, 0);
      return `<li class="row" data-run="${r.id}" style="cursor:pointer"><div><b>${MONTHS[Number(r.pay_date.slice(5, 7)) - 1]} ${r.pay_date.slice(0, 4)}</b> ${r.status === "final" ? `<span class="chip hol">Finalised</span>` : `<span class="chip req">Draft</span>`}
        <div class="muted small">Paid ${longDate(r.pay_date)} · ${esc(r.tax_year)} ${TAX_MONTH_NAMES[r.tax_month]} · ${ls.length} ${ls.length === 1 ? "person" : "people"} · net ${M(net)}</div></div><span class="spacer"></span><span class="muted">›</span></li>`;
    }).join("") || `<li class="muted">No pay runs yet.</li>`}</ul></div>`;
  html += `<div class="card small muted">HMRC filing still goes through <b>Basic PAYE Tools</b>: each run has a "For PAYE Tools" screen with the figures to type in on or before payday. This app works the figures out; PAYE Tools sends them to HMRC.</div>`;
  $("payBody").innerHTML = html;
  wireEmployerPicker(payRunsView);
  $("payBody").querySelectorAll("[data-run]").forEach((li) => (li.onclick = () => { PAY.runId = li.dataset.run; renderPayroll(); }));
  if ($("newRun")) $("newRun").onclick = () => newRunSheet(emp, runs[0]);
}

function newRunSheet(emp, latest) {
  // Next month after the latest run, else this month.
  let y = Number(TODAY.slice(0, 4)), m = Number(TODAY.slice(5, 7));
  if (latest) { y = Number(latest.pay_date.slice(0, 4)); m = Number(latest.pay_date.slice(5, 7)) + 1; if (m > 12) { m = 1; y++; } }
  const banks = new Set(S.closures.filter((c) => c.kind === "bank").map((c) => c.day));
  const fill = () => {
    const [yy, mm] = $("nrMonth").value.split("-").map(Number);
    const d = PC.runDates(emp.settings || {}, yy, mm, banks);
    $("nrPS").value = d.periodStart; $("nrPE").value = d.periodEnd; $("nrRF").value = d.rotaFrom; $("nrRT").value = d.rotaTo; $("nrPay").value = d.payDate; info();
  };
  const info = () => {
    const pay = $("nrPay").value;
    if (!pay) return;
    const tp = PC.taxPeriod(pay);
    const dup = PAY.runs.some((r) => r.employer_id === emp.id && r.tax_year === tp.taxYear && r.tax_month === tp.month);
    $("nrInfo").innerHTML = `Tax year <b>${tp.taxYear}</b>, ${TAX_MONTH_NAMES[tp.month]}.${payRates(tp.taxYear) ? "" : ` <span style="color:var(--danger)">No tax rates for ${tp.taxYear} yet: add them under Tax rates first.</span>`}${dup ? ` <span style="color:var(--danger)">There's already a run for that tax month.</span>` : ""}`;
  };
  openSheet(`<h2>New pay run · ${esc(emp.name)}</h2>
    <label>Month</label><input type="month" id="nrMonth" value="${y}-${String(m).padStart(2, "0")}">
    <div class="grid2"><div><label>Pay period from</label><input type="date" id="nrPS"></div><div><label>to</label><input type="date" id="nrPE"></div>
      <div><label>Rota counted from</label><input type="date" id="nrRF"></div><div><label>to (cut-off)</label><input type="date" id="nrRT"></div></div>
    <label>Payday</label><input type="date" id="nrPay">
    <p class="small muted" id="nrInfo"></p>
    <p class="small muted">Extra days, hourly staff's days and sick days are counted from the rota between the two "rota" dates. Change the dates in <b>Employers</b> to set the defaults.</p>
    <div class="msg bad" id="nrErr" hidden></div>
    <div class="row" style="margin-top:12px"><span class="spacer"></span><button class="btn ghost" data-close>Cancel</button><button class="btn" id="nrGo">Start the run</button></div>`);
  $("nrMonth").onchange = fill; $("nrPay").oninput = info; fill();
  $("nrGo").onclick = async () => {
    const err = (t) => { $("nrErr").hidden = false; $("nrErr").textContent = t; };
    const run = { employer_id: emp.id, period_start: $("nrPS").value, period_end: $("nrPE").value, rota_from: $("nrRF").value, rota_to: $("nrRT").value, pay_date: $("nrPay").value, status: "draft" };
    if (Object.values(run).some((v) => !v)) return err("Fill in all the dates.");
    if (run.period_end < run.period_start || run.rota_to < run.rota_from) return err("A 'to' date is before its 'from' date.");
    const tp = PC.taxPeriod(run.pay_date);
    if (!payRates(tp.taxYear)) return err(`Add the ${tp.taxYear} tax rates first (Payroll › Tax rates).`);
    Object.assign(run, { tax_year: tp.taxYear, tax_month: tp.month });
    try {
      $("nrGo").disabled = true;
      const people = payEligible(run).map((p) => p.id);
      const made = await api.payCreateRun(run, people);
      PAY.runs.push(made.run); PAY.lines.push(...made.lines);
      PAY.runId = made.run.id; closeSheet(); renderPayroll();
    } catch (e) { $("nrGo").disabled = false; err("Couldn't start it: " + e.message); }
  };
}

async function payRunView(run) {
  const emp = payEmployer(run.employer_id);
  const draft = run.status === "draft";
  $("payBody").innerHTML = `<p class="muted">Working it out…</p>`;
  if (draft) {
    // Anyone added to this payroll since the run started joins it.
    const missing = payEligible(run).filter((p) => !payLines(run.id).some((l) => l.person_id === p.id)).map((p) => p.id);
    if (missing.length) PAY.lines.push(...(await api.payAddLines(run.id, missing)));
    // Drafts always follow the rota as it is now.
    const shifts = await payShifts(run);
    for (const l of payLines(run.id)) {
      const r = payCompute(run, l, shifts);
      if (JSON.stringify(r) !== JSON.stringify(l.result)) { l.result = r; api.paySaveLine(l.id, { result: r }).catch(() => {}); }
    }
  }
  const lines = payLines(run.id).map((l) => ({ l, p: S.people.find((x) => x.id === l.person_id) })).sort((a, b) => (a.p?.sort ?? 0) - (b.p?.sort ?? 0));
  const ok = lines.filter((x) => x.l.result && !x.l.result.error);
  const sum = (f) => ok.reduce((s, x) => s + f(x.l.result), 0);
  const warnCount = ok.reduce((s, x) => s + x.l.result.warnings.length, 0) + lines.filter((x) => x.l.result?.error).length;

  let html = `<div class="weeknav" style="margin:0 0 6px"><button id="backRuns" aria-label="Back">‹</button><div class="label">${esc(emp.name)} · ${MONTHS[Number(run.pay_date.slice(5, 7)) - 1]} ${run.pay_date.slice(0, 4)}
    <small>Paid ${longDate(run.pay_date)} · ${run.tax_year} ${TAX_MONTH_NAMES[run.tax_month]}</small></div><span style="width:44px"></span></div>`;
  html += `<div class="card"><div class="row"><div style="flex:1;min-width:200px">${draft ? `<b>Draft</b> <span class="muted small">· follows the rota as it changes</span>` : `<b>Finalised</b> <span class="muted small">· ${shortD(run.finalised_at?.slice(0, 10))}, payslips sent to staff</span>`}
    <div class="muted small">Pay period ${shortD(run.period_start)} – ${shortD(run.period_end)} · rota counted ${shortD(run.rota_from)} – ${shortD(run.rota_to)}</div></div>
    ${draft ? `<button class="btn ghost" id="runDates">Dates</button>` : ""}</div>
    ${warnCount ? `<div class="msg warn">${warnCount} thing${warnCount === 1 ? "" : "s"} to check: tap the names marked ⚠.</div>` : ""}</div>`;
  const Mn = (p) => M(p).replace("£", "");
  html += `<div class="scroll"><table class="simple paytable"><thead><tr><th>Name</th><th class="num">Gross £</th><th class="num">Tax</th><th class="num">NI</th><th class="num">Pension</th><th class="num">Net</th></tr></thead><tbody>
    ${lines.map(({ l, p }) => {
      const r = l.result;
      if (!r || r.error) return `<tr data-line="${l.id}" style="cursor:pointer"><td><b>${esc(p?.name ?? "?")}</b> ⚠</td><td colspan="5" class="muted small">${esc(r?.error || "Not worked out yet")}</td></tr>`;
      return `<tr data-line="${l.id}" style="cursor:pointer"><td><b>${esc(p?.name ?? "?")}</b>${r.warnings.length ? " ⚠" : ""}<div class="muted small">${payDaysLine(r, payPerson(l.person_id))}</div></td>
        <td class="num">${Mn(r.gross)}</td><td class="num">${Mn(r.tax)}</td><td class="num">${Mn(r.ni.employee)}</td><td class="num">${Mn(r.nest.employee)}</td><td class="num"><b>${Mn(r.net)}</b></td></tr>`;
    }).join("")}
    <tr><td><b>Total</b></td><td class="num"><b>${Mn(sum((r) => r.gross))}</b></td><td class="num"><b>${Mn(sum((r) => r.tax))}</b></td><td class="num"><b>${Mn(sum((r) => r.ni.employee))}</b></td><td class="num"><b>${Mn(sum((r) => r.nest.employee))}</b></td><td class="num"><b>${Mn(sum((r) => r.net))}</b></td></tr>
    </tbody></table></div>
    <p class="small muted" style="margin:6px 4px 12px">${draft ? "Tap a name to type in bonus, expenses, sick top-up or one-off changes, or to correct the days." : "Tap a name to see the payslip."} Employer's NI ${M(sum((r) => r.ni.employer))}, employer's pension ${M(sum((r) => r.nest.employer))}, expenses ${M(sum((r) => r.expensesTotal))}.</p>`;
  html += `<div class="card"><h2>What this run makes</h2><div class="choices">
    <button class="choice p0" id="outSlips">Payslips</button><button class="choice p1" id="outPaye">For PAYE Tools</button>
    <button class="choice p4" id="outNest">NEST file</button><button class="choice p2" id="outHmrc">Owed to HMRC</button></div>
    <div class="row" style="margin-top:14px">${draft
      ? `<button class="btn danger" id="delRun">Delete run</button><span class="spacer"></span><button class="btn ok" id="finalise" ${lines.length && ok.length === lines.length ? "" : "disabled"}>Finalise and send payslips</button>`
      : `<span class="spacer"></span><button class="btn ghost" id="reopen">Reopen (take payslips back)</button>`}</div></div>`;
  $("payBody").innerHTML = html;

  $("backRuns").onclick = () => { PAY.runId = null; renderPayroll(); };
  $("payBody").querySelectorAll("[data-line]").forEach((tr) => (tr.onclick = () => {
    const l = PAY.lines.find((x) => x.id === tr.dataset.line);
    if (draft) lineSheet(run, l); else if (l.result && !l.result.error) payslipSheet(payslipSnapshot(run, emp, payPerson(l.person_id) || {}, S.people.find((p) => p.id === l.person_id), l.result));
  }));
  if ($("runDates")) $("runDates").onclick = () => runDatesSheet(run);
  $("outSlips").onclick = () => allPayslipsSheet(run, ok.map((x) => x.l));
  $("outPaye").onclick = () => payeToolsSheet(run, ok);
  $("outNest").onclick = () => nestSheet(run, ok);
  $("outHmrc").onclick = () => hmrcSheet(run);
  if ($("delRun")) $("delRun").onclick = async () => {
    if (!confirm("Delete this draft pay run and everything typed into it?")) return;
    try { await api.payDeleteRun(run.id); PAY.runs = PAY.runs.filter((r) => r.id !== run.id); PAY.lines = PAY.lines.filter((l) => l.run_id !== run.id); PAY.runId = null; renderPayroll(); } catch (e) { alert(e.message); }
  };
  if ($("finalise")) $("finalise").onclick = async () => {
    const earlierDraft = PAY.runs.some((r) => r.employer_id === run.employer_id && r.tax_year === run.tax_year && r.status === "draft" && r.id !== run.id && r.pay_date < run.pay_date);
    if (earlierDraft && !confirm("An earlier run for this employer is still a draft, so its pay isn't in this run's year to date. Finalise anyway?")) return;
    if (!confirm(`Finalise ${MONTHS[Number(run.pay_date.slice(5, 7)) - 1]}'s pay run? Payslips appear for ${ok.length === 1 ? "1 person" : ok.length + " people"} in their Rota app. Do the PAYE Tools submission on or before ${longDate(run.pay_date)}.`)) return;
    try {
      $("finalise").disabled = true;
      const slips = ok.map(({ l, p }) => ({ run_id: run.id, person_id: l.person_id, pay_date: run.pay_date, payslip: payslipSnapshot(run, emp, payPerson(l.person_id), p, l.result) }));
      await api.payFinalise(run.id, slips);
      Object.assign(run, { status: "final", finalised_at: new Date().toISOString() });
      renderPayroll();
    } catch (e) { alert("Couldn't finalise: " + e.message); renderPayroll(); }
  };
  if ($("reopen")) $("reopen").onclick = async () => {
    const later = PAY.runs.some((r) => r.employer_id === run.employer_id && r.status === "final" && r.pay_date > run.pay_date);
    if (!confirm(`Reopen this run? Its payslips disappear from staff's app until you finalise it again.${later ? " A later run is already finalised: its year-to-date figures won't change, so check it too." : ""} If it's already gone to HMRC, fix it in PAYE Tools too.`)) return;
    try { await api.payReopen(run.id); Object.assign(run, { status: "draft", finalised_at: null }); renderPayroll(); } catch (e) { alert(e.message); }
  };
}

function payDaysLine(r, pp) {
  const d = r.days, bits = [];
  if (pp?.pay_type === "hourly") { bits.push(`${num(d.worked)} worked`); if (d.holiday) bits.push(`${num(d.holiday)} holiday`); if (d.closure) bits.push(`${num(d.closure)} bank hol`); }
  else bits.push("salary");
  if (d.sick) bits.push(`${num(d.sick)} sick`);
  if (d.overtime && pp?.pay_type !== "hourly") bits.push(`${num(d.overtime)} extra`);
  return bits.join(" · ");
}

function runDatesSheet(run) {
  openSheet(`<h2>Pay run dates</h2>
    <div class="grid2"><div><label>Pay period from</label><input type="date" id="rdPS" value="${run.period_start}"></div><div><label>to</label><input type="date" id="rdPE" value="${run.period_end}"></div>
      <div><label>Rota counted from</label><input type="date" id="rdRF" value="${run.rota_from}"></div><div><label>to (cut-off)</label><input type="date" id="rdRT" value="${run.rota_to}"></div></div>
    <label>Payday</label><input type="date" id="rdPay" value="${run.pay_date}">
    <div class="msg bad" id="rdErr" hidden></div>
    <div class="row" style="margin-top:12px"><span class="spacer"></span><button class="btn ghost" data-close>Cancel</button><button class="btn" id="rdSave">Save</button></div>`);
  $("rdSave").onclick = async () => {
    const patch = { period_start: $("rdPS").value, period_end: $("rdPE").value, rota_from: $("rdRF").value, rota_to: $("rdRT").value, pay_date: $("rdPay").value };
    const tp = PC.taxPeriod(patch.pay_date);
    if (!payRates(tp.taxYear)) { $("rdErr").hidden = false; $("rdErr").textContent = `No tax rates for ${tp.taxYear}.`; return; }
    Object.assign(patch, { tax_year: tp.taxYear, tax_month: tp.month });
    try { await api.payUpdateRun(run.id, patch); Object.assign(run, patch); closeSheet(); renderPayroll(); } catch (e) { $("rdErr").hidden = false; $("rdErr").textContent = e.message; }
  };
}

// ---- One person in a draft run ---------------------------------------------------------------------------------------------
function lineSheet(run, line) {
  const p = S.people.find((x) => x.id === line.person_id), pp = payPerson(line.person_id);
  const inp = JSON.parse(JSON.stringify(line.inputs || {}));
  inp.expenses = inp.expenses || []; inp.adjustments = inp.adjustments || []; inp.overrides = inp.overrides || {};
  const hourly = pp?.pay_type === "hourly";
  const draw = () => {
    const r = payCompute(run, { ...line, inputs: inp }, PAY.shifts.get(run.rota_from + run.rota_to) || []);
    const rota = r.rota || {};
    const dayBox = (k, label, fromRota) => `<div><label>${label} <span class="muted">(rota: ${num(fromRota ?? 0)})</span></label><input type="number" step="0.5" min="0" data-ov="${k}" value="${inp.overrides[k] ?? ""}" placeholder="${num(fromRota ?? 0)}"></div>`;
    const sickNote = rota.sickDates?.length ? `Sick on the rota: ${rota.sickDates.map(shortD).join(", ")}.` : "No sick days on the rota.";
    const otNote = rota.overtimeDates?.length ? `Extra days marked Overtime: ${rota.overtimeDates.map((e) => `${shortD(e.day)}${e.days !== 1 ? ` (${num(e.days)})` : ""}`).join(", ")}.` : "";
    $("sheet").innerHTML = `<h2>${esc(p?.name ?? "?")} · ${MONTHS[Number(run.pay_date.slice(5, 7)) - 1]}</h2>
      <div class="muted small">${hourly ? `Hourly: ${M(PC.P(pp.hourly_rate))} × ${num(pp.hours_per_day || 8)} h a day` : `Salary ${M(PC.P(pp?.annual_salary))} a year · day rate ${M(r.dayRate || 0)}`} · tax code ${esc(pp?.tax_code || "")}${pp?.week1month1 ? " M1" : ""} · NI ${esc(pp?.ni_letter || "")}</div>
      <h3>Days from the rota</h3>
      <div class="grid2">${hourly ? dayBox("worked", "Days worked", rota.worked) + dayBox("holiday", "Holiday days", rota.holiday) + dayBox("closure", "Bank hols / closures", rota.closure) : dayBox("overtime", "Extra days (overtime)", rota.overtime)}${dayBox("sick", "Sick days", rota.sick)}</div>
      <p class="small muted" style="margin:6px 0 0">${sickNote} ${otNote} Leave a box empty to use the rota.</p>
      ${r.days?.sick ? `<h3>Sick pay</h3><label class="check"><input type="checkbox" id="lsFull" ${inp.sickTopupFull ? "checked" : ""}> Top up to full pay</label>
        <label>Or a top-up of (£)</label><input type="number" step="0.01" id="lsTop" value="${inp.sickTopup ?? ""}" ${inp.sickTopupFull ? "disabled" : ""}>` : ""}
      <h3>This month</h3>
      <div class="grid2"><div><label>Bonus (£)</label><input type="number" step="0.01" id="lsBonus" value="${inp.bonus ?? ""}"></div><div><label>Bonus line says</label><input id="lsBonusLabel" value="${esc(inp.bonusLabel ?? "")}" placeholder="Bonus"></div></div>
      <label>Expenses (not taxed, shown on their own line)</label>
      ${inp.expenses.map((e, i) => `<div class="row" style="gap:6px;margin-bottom:6px"><input style="flex:2" data-exl="${i}" value="${esc(e.label ?? "")}" placeholder="e.g. Travel"><input style="flex:1" type="number" step="0.01" data-exa="${i}" value="${e.amount ?? ""}" placeholder="£"><button class="btn danger" data-exx="${i}">✕</button></div>`).join("")}
      <button class="btn ghost" id="lsAddEx">Add expenses</button>
      <label>One-off changes</label>
      ${inp.adjustments.map((a, i) => `<div class="row" style="gap:6px;margin-bottom:6px"><input style="flex:2" data-adl="${i}" value="${esc(a.label ?? "")}" placeholder="e.g. Holiday pay owed"><input style="flex:1" type="number" step="0.01" data-ada="${i}" value="${a.amount ?? ""}" placeholder="£ (− to take off)">
        <select style="flex:1.3" data-adt="${i}"><option value="1" ${a.taxed !== false ? "selected" : ""}>Taxed pay</option><option value="0" ${a.taxed === false ? "selected" : ""}>After tax</option></select><button class="btn danger" data-adx="${i}">✕</button></div>`).join("")}
      <button class="btn ghost" id="lsAddAdj">Add a one-off change</button>
      <label>Note on the payslip (optional)</label><input id="lsNote" value="${esc(inp.note ?? "")}">
      <h3>Result</h3>
      ${r.error ? `<div class="msg bad">${esc(r.error)}</div>` : `${r.warnings.map((w) => `<div class="msg warn">${esc(w)}</div>`).join("")}${r.info.map((w) => `<div class="msg">${esc(w)}</div>`).join("")}
      <table class="simple">${r.payments.map((x) => `<tr><td>${esc(x.label)}</td><td class="num">${M(x.amount)}</td></tr>`).join("")}
        <tr><td><b>Gross pay</b></td><td class="num"><b>${M(r.gross + r.untaxedPay)}</b></td></tr>
        ${r.deductions.map((x) => `<tr><td>${esc(x.label)}</td><td class="num">−${M(x.amount)}</td></tr>`).join("")}
        ${r.expenses.map((x) => `<tr><td>${esc(x.label)} (expenses)</td><td class="num">${M(x.amount)}</td></tr>`).join("")}
        <tr><td><b>Net pay</b></td><td class="num"><b>${M(r.net)}</b></td></tr>
        <tr class="muted"><td>Employer's NI / employer's pension</td><td class="num">${M(r.ni.employer)} / ${M(r.nest.employer)}</td></tr></table>`}
      <div class="row" style="margin-top:12px"><button class="btn danger" id="lsDrop">Leave out of this run</button><span class="spacer"></span><button class="btn ghost" data-close>Cancel</button><button class="btn" id="lsSave">Save</button></div>`;
    $("sheet").querySelectorAll("[data-close]").forEach((b) => (b.onclick = closeSheet));
    const val = (el) => (el.value === "" ? undefined : el.type === "number" ? Number(el.value) : el.value);
    const pull = () => {
      $("sheet").querySelectorAll("[data-ov]").forEach((el) => { const v = val(el); if (v === undefined) delete inp.overrides[el.dataset.ov]; else inp.overrides[el.dataset.ov] = v; });
      if ($("lsFull")) { inp.sickTopupFull = $("lsFull").checked || undefined; inp.sickTopup = val($("lsTop")); }
      inp.bonus = val($("lsBonus")); inp.bonusLabel = val($("lsBonusLabel")); inp.note = val($("lsNote"));
      $("sheet").querySelectorAll("[data-exl]").forEach((el) => (inp.expenses[el.dataset.exl].label = el.value));
      $("sheet").querySelectorAll("[data-exa]").forEach((el) => (inp.expenses[el.dataset.exa].amount = val(el)));
      $("sheet").querySelectorAll("[data-adl]").forEach((el) => (inp.adjustments[el.dataset.adl].label = el.value));
      $("sheet").querySelectorAll("[data-ada]").forEach((el) => (inp.adjustments[el.dataset.ada].amount = val(el)));
      $("sheet").querySelectorAll("[data-adt]").forEach((el) => (inp.adjustments[el.dataset.adt].taxed = el.value === "1"));
    };
    // Redraw (keeping the cursor's box) whenever something changes, so the result is always live.
    $("sheet").querySelectorAll("input, select").forEach((el) => (el.onchange = () => { pull(); const sc = $("sheet").scrollTop; draw(); $("sheet").scrollTop = sc; }));
    $("lsAddEx").onclick = () => { pull(); inp.expenses.push({ label: p?.name === "Mike" ? "Travel expenses" : "", amount: undefined }); draw(); };
    $("lsAddAdj").onclick = () => { pull(); inp.adjustments.push({ label: "", amount: undefined, taxed: true }); draw(); };
    $("sheet").querySelectorAll("[data-exx]").forEach((b) => (b.onclick = () => { pull(); inp.expenses.splice(Number(b.dataset.exx), 1); draw(); }));
    $("sheet").querySelectorAll("[data-adx]").forEach((b) => (b.onclick = () => { pull(); inp.adjustments.splice(Number(b.dataset.adx), 1); draw(); }));
    $("lsSave").onclick = async () => {
      pull();
      inp.expenses = inp.expenses.filter((e) => e.amount); inp.adjustments = inp.adjustments.filter((a) => a.amount);
      const result = payCompute(run, { ...line, inputs: inp }, PAY.shifts.get(run.rota_from + run.rota_to) || []);
      try { await api.paySaveLine(line.id, { inputs: inp, result }); Object.assign(line, { inputs: inp, result }); closeSheet(); renderPayroll(); }
      catch (e) { alert("Couldn't save: " + e.message); }
    };
    $("lsDrop").onclick = async () => {
      if (!confirm(`Leave ${p?.name} out of this run? (They come back if you open the run again while they're still on this payroll; take them off the payroll under People to stop that.)`)) return;
      try { await api.payDeleteLine(line.id); PAY.lines = PAY.lines.filter((l) => l.id !== line.id); closeSheet(); renderPayroll(); } catch (e) { alert(e.message); }
    };
  };
  openSheet("");
  draw();
}

// ---- Outputs: payslips, PAYE Tools, NEST, HMRC ----------------------------------------------------------------------------------
function allPayslipsSheet(run, lines) {
  const emp = payEmployer(run.employer_id);
  openSheet(`<h2>Payslips · ${MONTHS[Number(run.pay_date.slice(5, 7)) - 1]}</h2>
    <ul class="list">${lines.map((l) => `<li class="row" data-slip="${l.id}" style="cursor:pointer"><b>${esc(S.people.find((p) => p.id === l.person_id)?.name ?? "?")}</b><span class="spacer"></span>${M(l.result.net)} <span class="muted">›</span></li>`).join("")}</ul>
    <div class="row" style="margin-top:12px"><span class="spacer"></span><button class="btn ghost" data-close>Close</button><button class="btn" id="allPdf" ${lines.length ? "" : "disabled"}>Download all (PDF)</button></div>`);
  const snap = (l) => payslipSnapshot(run, emp, payPerson(l.person_id) || {}, S.people.find((p) => p.id === l.person_id), l.result);
  $("sheet").querySelectorAll("[data-slip]").forEach((li) => (li.onclick = () => payslipSheet(snap(lines.find((l) => l.id === li.dataset.slip)))));
  $("allPdf").onclick = () => payslipPdf(lines.map(snap), `Payslips ${emp.name} ${run.pay_date}.pdf`).catch((e) => alert(e.message));
}

function payeToolsSheet(run, ok) {
  const rows = ok.map(({ l, p }) => ({ p, pp: payPerson(l.person_id) || {}, r: l.result }));
  const field = (label, value) => `<tr><td>${label}</td><td class="num"><b>${value}</b></td></tr>`;
  openSheet(`<h2>For Basic PAYE Tools</h2>
    <p class="small muted">Payday ${longDate(run.pay_date)} · ${run.tax_year} ${TAX_MONTH_NAMES[run.tax_month]} · monthly. Send the FPS on or before payday. For each person, open them in PAYE Tools, add a payment for this period and type in the pay below. PAYE Tools works out its own tax and NI: check they match the "should come to" figures. If they don't, stop and look before sending.</p>
    ${rows.map(({ p, pp, r }) => `<div class="card" style="background:var(--shade)"><h2 style="margin-bottom:4px">${esc(p?.name ?? "?")}</h2>
      <div class="small muted">NI number ${esc(pp.ni_number || "missing")} · tax code ${esc(r.taxCode)} · NI letter ${esc(r.ni.letter)}${pp.works_number ? ` · payroll ID ${esc(pp.works_number)}` : ""}</div>
      <table class="simple">${field("Taxable pay this period", pounds2(r.gross))}${field("Pay subject to NI", pounds2(r.gross))}
        ${r.ssp ? field("of which Statutory Sick Pay", pounds2(r.ssp)) : ""}
        ${r.expensesTotal ? `<tr class="muted"><td>Expenses ${pounds2(r.expensesTotal)}: not reported, they're not pay</td><td></td></tr>` : ""}
        ${r.untaxedPay || r.deductions.some((d) => /^(?!Income tax|National|Student|Postgraduate|NEST)/.test(d.label)) ? `<tr class="muted"><td>After-tax changes: not reported</td><td></td></tr>` : ""}
        <tr><td colspan="2" class="muted small">Should come to:</td></tr>
        ${field("Tax deducted", pounds2(r.tax))}${field("Employee's NI", pounds2(r.ni.employee))}${field("Employer's NI", pounds2(r.ni.employer))}
        ${r.studentLoan ? field("Student loan", pounds2(r.studentLoan)) : ""}${r.postgradLoan ? field("Postgraduate loan", pounds2(r.postgradLoan)) : ""}
        <tr><td colspan="2" class="muted small">NI earnings bands (RTI):</td></tr>
        ${field("At the LEL", pounds2(r.ni.atLEL))}${field("LEL to PT", pounds2(r.ni.lelToPT))}${field("PT to UEL", pounds2(r.ni.ptToUEL))}
        ${field("Year to date: taxable pay / tax", `${pounds2(r.ytd.taxablePay)} / ${pounds2(r.ytd.tax)}`)}</table></div>`).join("")}
    <p class="small muted">NEST: PAYE Tools doesn't need the pension (NEST uses relief at source, so it comes off after tax). Employment Allowance is claimed once a year on an EPS in PAYE Tools; see "Owed to HMRC".</p>
    <div class="row"><span class="spacer"></span><button class="btn ghost" data-close>Close</button></div>`);
}

function nestSheet(run, ok) {
  const emp = payEmployer(run.employer_id), st = emp.settings || {};
  const members = ok.filter(({ l }) => (payPerson(l.person_id) || {}).nest_status === "enrolled" || l.result.nest.employee || l.result.nest.employer)
    .map(({ l, p }) => { const pp = payPerson(l.person_id) || {}; return { name: p?.name ?? "?", surname: (p?.name ?? "").split(" ").slice(-1)[0], niNumber: pp.ni_number || "", altId: pp.works_number || "", pensionable: l.result.nest.pensionable, employer: l.result.nest.employer, employee: l.result.nest.employee }; });
  const missing = [!st.nestEmployerRef && "NEST employer reference (EMP…)", !st.nestPaymentSource && "payment source name"].filter(Boolean);
  const total = members.reduce((s, m) => s + m.employer + m.employee, 0);
  openSheet(`<h2>NEST contributions</h2>
    <p class="small muted">${esc(emp.name)} · earnings period ${shortD(run.period_start)} – ${shortD(run.period_end)} · ${st.nestBasis === "all" ? "all pay" : "qualifying earnings"}, employer ${num(st.nestEmployerPct ?? 3)}%, member ${num(st.nestEmployeePct ?? 5)}% (${st.nestReliefAtSource === false ? "no relief at source" : `${num((st.nestEmployeePct ?? 5) * 0.8)}% taken from pay, NEST claims the tax relief`}).</p>
    <table class="simple"><tr><th>Member</th><th class="num">Pensionable</th><th class="num">Employer</th><th class="num">Member</th></tr>
      ${members.map((m) => `<tr><td>${esc(m.name)}${m.niNumber ? "" : " ⚠"}</td><td class="num">${M(m.pensionable)}</td><td class="num">${M(m.employer)}</td><td class="num">${M(m.employee)}</td></tr>`).join("") || `<tr><td colspan="4" class="muted">Nobody on this run is in NEST.</td></tr>`}
      <tr><td><b>To pay NEST</b></td><td></td><td></td><td class="num"><b>${M(total)}</b></td></tr></table>
    ${missing.length ? `<div class="msg warn">Fill in the ${missing.join(" and ")} under Employers first: the file has to match your NEST account exactly.</div>` : ""}
    ${members.some((m) => !m.niNumber) ? `<div class="msg warn">⚠ has no NI number: NEST will use the payroll ID instead, which must match what NEST holds.</div>` : ""}
    <p class="small muted">In NEST: Contributions › choose this schedule › Upload a file. The earnings period end date (${run.period_end}) must match the schedule NEST has made.</p>
    <div class="row" style="margin-top:12px"><span class="spacer"></span><button class="btn ghost" data-close>Close</button><button class="btn" id="nestDl" ${members.length ? "" : "disabled"}>Download the CSV file</button></div>`);
  $("nestDl").onclick = () => {
    const csv = PC.nestCsv({ employerRef: st.nestEmployerRef || "", paymentSource: st.nestPaymentSource || "", periodStart: run.period_start, periodEnd: run.period_end, frequency: st.nestFrequency || "Monthly", members });
    downloadFile(`NEST contributions ${run.period_end}.csv`, csv, "text/csv");
  };
}

/** Employment Allowance used in each finalised run this tax year, oldest first, plus what was used before the switch. */
function eaUsedBefore(run) {
  const emp = payEmployer(run.employer_id), st = emp.settings || {};
  if (!st.employmentAllowance) return { on: false };
  const cap = PC.P(payRates(run.tax_year)?.employmentAllowance ?? 0);
  let used = PC.P(st.eaUsed?.[run.tax_year] ?? 0);
  const runs = PAY.runs.filter((r) => r.employer_id === run.employer_id && r.tax_year === run.tax_year && r.status === "final" && r.id !== run.id && r.pay_date < run.pay_date).sort((a, b) => a.pay_date.localeCompare(b.pay_date));
  for (const r of runs) {
    const er = payLines(r.id).reduce((s, l) => s + (l.result?.ni?.employer || 0), 0);
    used += Math.min(Math.max(0, cap - used), er);
  }
  return { on: true, cap, used };
}

function hmrcSheet(run) {
  const emp = payEmployer(run.employer_id), st = emp.settings || {};
  const ls = payLines(run.id).filter((l) => l.result && !l.result.error).map((l) => l.result);
  const s = (f) => ls.reduce((a, r) => a + f(r), 0);
  const tax = s((r) => r.tax), ee = s((r) => r.ni.employee), er = s((r) => r.ni.employer), sl = s((r) => r.studentLoan), pg = s((r) => r.postgradLoan);
  const ea = eaUsedBefore(run);
  const eaNow = ea.on ? Math.min(Math.max(0, ea.cap - ea.used), er) : 0;
  const owed = tax + ee + er + sl + pg - eaNow;
  const tp = PC.taxPeriod(run.pay_date);
  const ref = PC.hmrcReference(st.accountsOfficeRef, tp.startYear, run.tax_month);
  const row = (a, b, strong) => `<tr><td>${strong ? `<b>${a}</b>` : a}</td><td class="num">${strong ? `<b>${b}</b>` : b}</td></tr>`;
  openSheet(`<h2>Owed to HMRC</h2>
    <p class="small muted">${esc(emp.name)} · ${run.tax_year} ${TAX_MONTH_NAMES[run.tax_month]} (to the 5th)</p>
    <table class="simple">${row("Income tax", M(tax))}${row("Employees' NI", M(ee))}${row("Employer's NI", M(er))}
      ${sl ? row("Student loans", M(sl)) : ""}${pg ? row("Postgraduate loans", M(pg)) : ""}
      ${ea.on ? row(`Employment Allowance (${M(Math.max(0, ea.cap - ea.used - eaNow))} left this year after this)`, "−" + M(eaNow)) : ""}
      ${row("To pay HMRC", M(owed), true)}</table>
    <p class="small">Pay by <b>${longDate(PC.hmrcDue(tp.startYear, run.tax_month))}</b> (bank transfer) to HMRC Cumbernauld, sort code 08 32 10, account 12001039${ref ? `, reference <b>${esc(ref)}</b>` : ". Add your Accounts Office reference under Employers to see the payment reference"}.</p>
    ${ea.on ? `<p class="small muted">Employment Allowance: claim it once each tax year on an EPS in PAYE Tools (Employer payment summary › Employment Allowance indicator). Until it's used up, HMRC takes your employer's NI off what you owe.</p>` : ""}
    ${st.hmrcQuarterly ? `<p class="small muted">You've said this employer pays HMRC quarterly: pay the three months' total by the 22nd after the quarter ends (5 Jul, 5 Oct, 5 Jan, 5 Apr).</p>` : ""}
    <p class="small muted">If nothing is owed for a month, tell HMRC on an EPS (no payment due) or it will estimate a bill.</p>
    <div class="row"><span class="spacer"></span><button class="btn ghost" data-close>Close</button></div>`);
}

function downloadFile(name, text, type) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// ---- People's pay details ---------------------------------------------------------------------------------------------------------
function payPeopleView() {
  const list = S.people.filter((p) => p.active && !(p.left_on && p.left_on < addDays(TODAY, -400)));
  let html = `<div class="card"><h2>Pay details</h2><ul class="list">${list.map((p) => {
    const pp = payPerson(p.id), emp = pp && payEmployer(pp.employer_id);
    const what = !pp || !emp ? `<span class="muted">Not on payroll</span>` : `${esc(emp.name)} · ${pp.pay_type === "hourly" ? `${M(PC.P(pp.hourly_rate))} an hour` : pp.annual_salary ? `${M(PC.P(pp.annual_salary))} a year` : "no salary set"} · ${esc(pp.tax_code)}${pp.week1month1 ? " M1" : ""} · NI ${esc(pp.ni_letter)} · ${NEST_STATUS[pp.nest_status]}`;
    const gaps = pp && emp ? [!pp.ni_number && "NI number", !pp.date_of_birth && "date of birth", !(pp.annual_salary || pp.hourly_rate) && "pay"].filter(Boolean) : [];
    return `<li class="row" data-pp="${p.id}" style="cursor:pointer"><div><b>${esc(p.name)}</b>${p.left_on && p.left_on < TODAY ? ` <span class="muted small">(left)</span>` : ""}<div class="small">${what}</div>${gaps.length ? `<div class="small" style="color:var(--warn-ink)">Missing: ${gaps.join(", ")}</div>` : ""}</div><span class="spacer"></span><span class="muted">›</span></li>`;
  }).join("")}</ul></div>
  <p class="small muted">Staff details are typed in here, not on the People tab, so only payroll admins ever see them.</p>`;
  $("payBody").innerHTML = html;
  $("payBody").querySelectorAll("[data-pp]").forEach((li) => (li.onclick = () => payPersonSheet(S.people.find((p) => p.id === li.dataset.pp))));
}

function payPersonSheet(p) {
  const cur = payPerson(p.id);
  const pp = cur ?? { person_id: p.id, employer_id: null, pay_type: "salary", annual_salary: null, hourly_rate: null, hours_per_day: 8, tax_code: "1257L", week1month1: false, ni_letter: "A", ni_number: "", date_of_birth: null, start_date: p.started_on || null, works_number: "", student_loans: [], postgrad_loan: false, nest_status: "none", nest_enrolled_on: null, notes: "" };
  const years = [...new Set(PAY.taxYears.map((t) => t.tax_year).concat(PAY.opening.filter((o) => o.person_id === p.id).map((o) => o.tax_year)))].sort().reverse();
  const yearNow = PC.taxPeriod(TODAY).taxYear;
  openSheet(`<h2>${esc(p.name)} · pay</h2>
    <label>Payroll</label><select id="ppEmp"><option value="">Not on payroll</option>${PAY.employers.map((e) => `<option value="${e.id}" ${pp.employer_id === e.id ? "selected" : ""}>${esc(e.name)}</option>`).join("")}</select>
    <div class="grid2"><div><label>Paid</label><select id="ppType"><option value="salary" ${pp.pay_type === "salary" ? "selected" : ""}>Salary</option><option value="hourly" ${pp.pay_type === "hourly" ? "selected" : ""}>By the hour</option></select></div>
      <div id="ppSalBox"><label>Yearly salary (£)</label><input type="number" step="0.01" id="ppSal" value="${pp.annual_salary ?? ""}"></div>
      <div id="ppRateBox"><label>Hourly rate (£)</label><input type="number" step="0.01" id="ppRate" value="${pp.hourly_rate ?? ""}"></div>
      <div><label>Paid hours a day</label><input type="number" step="0.25" id="ppHours" value="${pp.hours_per_day ?? 8}"></div></div>
    <p class="small muted" id="ppDayRate"></p>
    <div class="grid2"><div><label>Tax code</label><input id="ppCode" value="${esc(pp.tax_code)}" autocapitalize="characters"></div>
      <div><label>NI category letter</label><select id="ppNi">${["A", "B", "C", "H", "J", "M", "V", "Z", "X"].map((l) => `<option ${pp.ni_letter === l ? "selected" : ""}>${l}</option>`).join("")}</select></div></div>
    <label class="check"><input type="checkbox" id="ppM1" ${pp.week1month1 ? "checked" : ""}> Month 1 basis (non-cumulative, e.g. emergency code)</label>
    <div class="grid2"><div><label>NI number</label><input id="ppNino" value="${esc(pp.ni_number ?? "")}" autocapitalize="characters" placeholder="QQ123456C"></div>
      <div><label>Date of birth</label><input type="date" id="ppDob" value="${pp.date_of_birth ?? ""}"></div>
      <div><label>Start date</label><input type="date" id="ppStart" value="${pp.start_date ?? ""}"></div>
      <div><label>Payroll ID / works no.</label><input id="ppWorks" value="${esc(pp.works_number ?? "")}"></div></div>
    <label>Student loans</label><div class="row">${LOAN_PLANS.map(([k, t]) => `<label class="check" style="margin:0 8px 0 0"><input type="checkbox" data-loan="${k}" ${pp.student_loans?.includes(k) ? "checked" : ""}> ${t}</label>`).join("")}<label class="check" style="margin:0"><input type="checkbox" id="ppPg" ${pp.postgrad_loan ? "checked" : ""}> Postgraduate</label></div>
    <div class="grid2"><div><label>NEST</label><select id="ppNest">${Object.entries(NEST_STATUS).map(([k, t]) => `<option value="${k}" ${pp.nest_status === k ? "selected" : ""}>${t}</option>`).join("")}</select></div>
      <div><label>Enrolled on</label><input type="date" id="ppNestOn" value="${pp.nest_enrolled_on ?? ""}"></div></div>
    <label>Notes (only payroll admins see these)</label><input id="ppNotes" value="${esc(pp.notes ?? "")}">
    <h3>Year to date carried over</h3>
    <p class="small muted" style="margin:0">From the bureau's last payslip before the switch (or a P45 from a previous job). Pounds and pence.</p>
    <div class="grid2"><div><label>Tax year</label><select id="opYear">${(years.length ? years : [yearNow]).map((y) => `<option ${y === yearNow ? "selected" : ""}>${y}</option>`).join("")}</select></div><div><label>With</label><select id="opEmp">${PAY.employers.map((e) => `<option value="${e.id}" ${(pp.employer_id || PAY.employers[0]?.id) === e.id ? "selected" : ""}>${esc(e.name)}</option>`).join("")}</select></div></div>
    <div class="grid2" id="opBox"></div>
    <div class="msg bad" id="ppErr" hidden></div>
    <div class="row" style="margin-top:12px"><span class="spacer"></span><button class="btn ghost" data-close>Cancel</button><button class="btn" id="ppSave">Save</button></div>`);
  const OP = [["taxable_pay", "Taxable pay"], ["tax", "Tax"], ["ee_ni", "Employee's NI"], ["er_ni", "Employer's NI"], ["ni_earnings", "Earnings for NI"], ["nest_ee", "NEST (employee)"], ["nest_er", "NEST (employer)"], ["ssp", "SSP"], ["student_loan", "Student loan"], ["postgrad_loan", "Postgraduate loan"], ["prev_employment_pay", "P45: pay in previous job"], ["prev_employment_tax", "P45: tax in previous job"]];
  const drawOpening = () => {
    const o = PAY.opening.find((x) => x.person_id === p.id && x.tax_year === $("opYear").value && x.employer_id === $("opEmp").value) || {};
    $("opBox").innerHTML = OP.map(([k, t]) => `<div><label>${t}</label><input type="number" step="0.01" data-op="${k}" value="${o[k] ? o[k] : ""}" placeholder="0.00"></div>`).join("") + `<div style="grid-column:1/-1"><label>Note</label><input id="opNote" value="${esc(o.note ?? "")}" placeholder="e.g. Bureau payslip 30 Dec 2026"></div>`;
  };
  const showType = () => {
    const h = $("ppType").value === "hourly";
    $("ppSalBox").hidden = h; $("ppRateBox").hidden = !h;
    const dpw = Number(p.days_per_week) || 5;
    $("ppDayRate").textContent = h ? `A day = ${num(Number($("ppHours").value) || 8)} h × £${Number($("ppRate").value || 0).toFixed(2)} = ${M(Math.round(Number($("ppRate").value || 0) * (Number($("ppHours").value) || 8) * 100))}. Paid for the days on the rota, holidays and bank holidays.`
      : `Monthly ${M(Math.round(Number($("ppSal").value || 0) * 100 / 12))}. Day rate (for extra days and sick days) = salary ÷ ${52 * dpw} (52 weeks × ${num(dpw)} days) = ${M(Math.round(Number($("ppSal").value || 0) * 100 / (52 * dpw)))}.`;
  };
  $("ppType").onchange = showType; $("ppSal").oninput = showType; $("ppRate").oninput = showType; $("ppHours").oninput = showType; showType();
  $("opYear").onchange = drawOpening; $("opEmp").onchange = drawOpening; drawOpening();
  $("ppSave").onclick = async () => {
    const err = (t) => { $("ppErr").hidden = false; $("ppErr").textContent = t; };
    const nino = $("ppNino").value.replace(/\s/g, "").toUpperCase();
    if (nino && !/^[A-CEGHJ-PR-TW-Z][A-CEGHJ-NPR-TW-Z]\d{6}[A-D]$/.test(nino)) return err("That NI number doesn't look right (two letters, six numbers, a letter A–D).");
    const code = $("ppCode").value.trim().toUpperCase() || "1257L";
    try { PC.parseTaxCode(code); } catch (e) { return err(e.message); }
    const row = {
      person_id: p.id, employer_id: $("ppEmp").value || null, pay_type: $("ppType").value,
      annual_salary: $("ppSal").value === "" ? null : Number($("ppSal").value), hourly_rate: $("ppRate").value === "" ? null : Number($("ppRate").value),
      hours_per_day: Number($("ppHours").value) || 8, tax_code: code, week1month1: $("ppM1").checked, ni_letter: $("ppNi").value, ni_number: nino || null,
      date_of_birth: $("ppDob").value || null, start_date: $("ppStart").value || null, works_number: $("ppWorks").value.trim() || null,
      student_loans: [...$("sheet").querySelectorAll("[data-loan]")].filter((c) => c.checked).map((c) => c.dataset.loan), postgrad_loan: $("ppPg").checked,
      nest_status: $("ppNest").value, nest_enrolled_on: $("ppNestOn").value || null, notes: $("ppNotes").value.trim() || null,
    };
    const op = { person_id: p.id, employer_id: $("opEmp").value, tax_year: $("opYear").value, note: $("opNote").value.trim() || null };
    let anyOp = false;
    $("sheet").querySelectorAll("[data-op]").forEach((el) => { op[el.dataset.op] = Number(el.value) || 0; if (Number(el.value)) anyOp = true; });
    const hadOp = PAY.opening.some((x) => x.person_id === op.person_id && x.employer_id === op.employer_id && x.tax_year === op.tax_year);
    try {
      $("ppSave").disabled = true;
      await api.paySavePerson(row);
      const i = PAY.people.findIndex((x) => x.person_id === p.id); if (i >= 0) PAY.people[i] = { ...PAY.people[i], ...row }; else PAY.people.push(row);
      if (anyOp || hadOp) {
        await api.paySaveOpening(op);
        const j = PAY.opening.findIndex((x) => x.person_id === op.person_id && x.employer_id === op.employer_id && x.tax_year === op.tax_year);
        if (j >= 0) PAY.opening[j] = op; else PAY.opening.push(op);
      }
      closeSheet(); renderPayroll();
    } catch (e) { $("ppSave").disabled = false; err("Couldn't save: " + e.message); }
  };
}

// ---- Employers -----------------------------------------------------------------------------------------------------------------------------
function payEmployersView() {
  const pd = { last_working_day: "last working day of the month", last_friday: "last Friday of the month", fixed: "a set day" };
  $("payBody").innerHTML = PAY.employers.map((e) => {
    const s = e.settings || {};
    return `<div class="card" data-empedit="${e.id}" style="cursor:pointer"><div class="row"><h2 style="margin:0">${esc(e.name)}</h2><span class="spacer"></span><span class="muted">›</span></div>
      <div class="small muted">${e.kind === "ltd" ? "Limited company" : "Sole trader"} · PAYE ref ${esc(s.payeRef || "not set")} · Accounts Office ref ${esc(s.accountsOfficeRef || "not set")}</div>
      <div class="small">Paid ${s.payday === "fixed" ? `on the ${s.paydayDay || "?"}${ordinal(s.paydayDay)}` : `on the ${pd[s.payday || "last_working_day"]}`} · period ${Number(s.periodStartDay) > 1 ? `${s.periodStartDay}${ordinal(s.periodStartDay)} to ${Number(s.periodStartDay) - 1}${ordinal(Number(s.periodStartDay) - 1)}` : "calendar month"} · extra days up to ${s.cutoffDay ? `the ${s.cutoffDay}${ordinal(s.cutoffDay)}` : "the period end"}</div>
      <div class="small">Employment Allowance ${s.employmentAllowance ? "on" : "off"} · NEST ${esc(s.nestEmployerRef || "ref not set")}, ${s.nestBasis === "all" ? "all pay" : "qualifying earnings"} ${num(s.nestEmployerPct ?? 3)}% + ${num(s.nestEmployeePct ?? 5)}% · sick top-up: ${s.sickTopup === "full" ? "to full pay" : "typed in each time"}</div></div>`;
  }).join("");
  $("payBody").querySelectorAll("[data-empedit]").forEach((c) => (c.onclick = () => employerSheet(payEmployer(c.dataset.empedit))));
}
const ordinal = (n) => { n = Number(n); return n % 10 === 1 && n !== 11 ? "st" : n % 10 === 2 && n !== 12 ? "nd" : n % 10 === 3 && n !== 13 ? "rd" : "th"; };

function employerSheet(e) {
  const s = { periodStartDay: 1, payday: "last_working_day", employmentAllowance: true, nestBasis: "qualifying", nestEmployerPct: 3, nestEmployeePct: 5, nestReliefAtSource: true, nestFrequency: "Monthly", sickTopup: "none", ...(e.settings || {}) };
  const ty = PC.taxPeriod(TODAY).taxYear;
  openSheet(`<h2>${esc(e.name)}</h2>
    <label>Name on payslips</label><input id="emName" value="${esc(e.name)}">
    <label>Address on payslips</label><input id="emAddr" value="${esc(s.address ?? "")}">
    <div class="grid2"><div><label>Employer PAYE reference</label><input id="emPaye" value="${esc(s.payeRef ?? "")}" placeholder="123/AB45678"></div>
      <div><label>Accounts Office reference</label><input id="emAo" value="${esc(s.accountsOfficeRef ?? "")}" placeholder="123PA00012345"></div></div>
    <h3>Pay dates</h3>
    <div class="grid2"><div><label>Payday</label><select id="emPayday"><option value="last_working_day" ${s.payday === "last_working_day" ? "selected" : ""}>Last working day</option><option value="last_friday" ${s.payday === "last_friday" ? "selected" : ""}>Last Friday</option><option value="fixed" ${s.payday === "fixed" ? "selected" : ""}>A set day of the month</option></select></div>
      <div><label>Set day (earlier if it's a weekend)</label><input type="number" min="1" max="31" id="emPayDay" value="${s.paydayDay ?? ""}"></div>
      <div><label>Pay period starts on the</label><input type="number" min="1" max="28" id="emStart" value="${s.periodStartDay ?? 1}"><div class="small muted">1 = calendar month</div></div>
      <div><label>Cut-off for extra days</label><input type="number" min="1" max="31" id="emCut" value="${s.cutoffDay ?? ""}" placeholder="End of period"><div class="small muted">Days after it go in next month's pay</div></div></div>
    <h3>HMRC</h3>
    <label class="check"><input type="checkbox" id="emEA" ${s.employmentAllowance ? "checked" : ""}> Claims Employment Allowance (£10,500 a year off employer's NI)</label>
    <label>Employment Allowance already used in ${ty} before the switch (£)</label><input type="number" step="0.01" id="emEAUsed" value="${s.eaUsed?.[ty] ?? ""}" placeholder="From the bureau">
    <label class="check"><input type="checkbox" id="emQ" ${s.hmrcQuarterly ? "checked" : ""}> Pays HMRC quarterly (under £1,500 a month on average)</label>
    <h3>NEST</h3>
    <div class="grid2"><div><label>NEST employer reference</label><input id="emNest" value="${esc(s.nestEmployerRef ?? "")}" placeholder="EMP123456789"></div>
      <div><label>Payment source name</label><input id="emNestPs" value="${esc(s.nestPaymentSource ?? "")}" placeholder="Exactly as in NEST"></div>
      <div><label>Contributions on</label><select id="emNestBasis"><option value="qualifying" ${s.nestBasis !== "all" ? "selected" : ""}>Qualifying earnings (£520–£4,189 a month)</option><option value="all" ${s.nestBasis === "all" ? "selected" : ""}>All pay</option></select></div>
      <div><label>NEST frequency</label><select id="emNestFreq">${["Monthly", "Tax Monthly"].map((f) => `<option ${s.nestFrequency === f ? "selected" : ""}>${f}</option>`).join("")}</select></div>
      <div><label>Employer %</label><input type="number" step="0.01" id="emNestEr" value="${s.nestEmployerPct ?? 3}"></div>
      <div><label>Member % (before tax relief)</label><input type="number" step="0.01" id="emNestEe" value="${s.nestEmployeePct ?? 5}"></div></div>
    <label class="check"><input type="checkbox" id="emRas" ${s.nestReliefAtSource !== false ? "checked" : ""}> Relief at source (take 80% of the member % from pay; NEST claims the rest)</label>
    <h3>Sick pay</h3>
    <select id="emSick"><option value="none" ${s.sickTopup !== "full" ? "selected" : ""}>SSP only, top-up typed in each time</option><option value="full" ${s.sickTopup === "full" ? "selected" : ""}>Top up to full pay unless changed</option></select>
    <div class="msg bad" id="emErr" hidden></div>
    <div class="row" style="margin-top:12px"><span class="spacer"></span><button class="btn ghost" data-close>Cancel</button><button class="btn" id="emSave">Save</button></div>`);
  $("emSave").onclick = async () => {
    const n = (id) => ($(id).value === "" ? null : Number($(id).value));
    const settings = {
      ...s, address: $("emAddr").value.trim(), payeRef: $("emPaye").value.trim().toUpperCase(), accountsOfficeRef: $("emAo").value.replace(/\s/g, "").toUpperCase(),
      payday: $("emPayday").value, paydayDay: n("emPayDay"), periodStartDay: n("emStart") || 1, cutoffDay: n("emCut"),
      employmentAllowance: $("emEA").checked, hmrcQuarterly: $("emQ").checked, eaUsed: { ...(s.eaUsed || {}), [ty]: n("emEAUsed") || 0 },
      nestEmployerRef: $("emNest").value.trim().toUpperCase(), nestPaymentSource: $("emNestPs").value.trim(), nestBasis: $("emNestBasis").value, nestFrequency: $("emNestFreq").value,
      nestEmployerPct: n("emNestEr") ?? 3, nestEmployeePct: n("emNestEe") ?? 5, nestReliefAtSource: $("emRas").checked, sickTopup: $("emSick").value,
    };
    if (settings.nestEmployerRef && !/^EMP\d{9}$/.test(settings.nestEmployerRef)) { $("emErr").hidden = false; $("emErr").textContent = "The NEST reference is EMP and nine numbers."; return; }
    if (settings.payday === "fixed" && !settings.paydayDay) { $("emErr").hidden = false; $("emErr").textContent = "Type in the set payday."; return; }
    try { const saved = await api.paySaveEmployer({ id: e.id, name: $("emName").value.trim() || e.name, kind: e.kind, active: e.active, sort: e.sort, settings }); Object.assign(e, saved); closeSheet(); renderPayroll(); }
    catch (err) { $("emErr").hidden = false; $("emErr").textContent = err.message; }
  };
}

// ---- Tax rates ------------------------------------------------------------------------------------------------------------------------------
const RATE_LABELS = {
  personalAllowance: "Personal allowance (£ a year)", emergencyCode: "Emergency tax code", maxRatePct: "Most tax in one period (% of pay)",
  bands: "Income tax bands (England, Wales, NI)", scotBands: "Scottish bands", basicBand: "Basic rate is band no. (from 0)", scotBasicBand: "Scottish basic rate is band no.",
  width: "Band width (£)", rate: "Rate (%)", ni: "National Insurance", monthly: "a month (£)", halfPenny: "Half a penny rounds (up/down)",
  employmentAllowance: "Employment Allowance (£ a year)", ssp: "Statutory Sick Pay", weekly: "Weekly rate (£)", awePct: "% of average weekly earnings", maxWeeks: "Most weeks",
  studentLoans: "Student loans (monthly threshold £, %)", pension: "Auto-enrolment (monthly £)", qeLowerMonthly: "Qualifying earnings from", qeUpperMonthly: "Qualifying earnings to", triggerMonthly: "Enrolment trigger",
  plan1: "Plan 1", plan2: "Plan 2", plan4: "Plan 4", plan5: "Plan 5", postgrad: "Postgraduate", pct: "%",
};
function payRatesView() {
  const years = PAY.taxYears.map((t) => t.tax_year).sort().reverse();
  PAY.rateYear = PAY.rateYear && years.includes(PAY.rateYear) ? PAY.rateYear : years[0];
  const rates = JSON.parse(JSON.stringify(payRates(PAY.rateYear)));
  const leaf = (path, v) => `<input data-rp="${path}" value="${esc(v)}" ${typeof v === "number" ? `type="number" step="any"` : ""}>`;
  const walk = (obj, path) => Object.entries(obj).filter(([k]) => k !== "taxYear" && !(path === "ni" && (k === "employee" || k === "employer"))).map(([k, v]) => {
    const pth = path ? `${path}.${k}` : k;
    if (Array.isArray(v)) return `<h3>${RATE_LABELS[k] ?? k}</h3><div class="grid2">${v.map((b, i) => Object.entries(b).map(([bk, bv]) => `<div><label>Band ${i + 1}: ${RATE_LABELS[bk] ?? bk}</label>${leaf(`${pth}.${i}.${bk}`, bv)}</div>`).join("")).join("")}</div>`;
    if (v && typeof v === "object") return `<h3>${RATE_LABELS[k] ?? k}</h3><div class="grid2">${Object.entries(v).filter(([ik]) => !(k === "ni" && (ik === "employee" || ik === "employer"))).map(([ik, iv]) => (iv && typeof iv === "object" ? Object.entries(iv).map(([jk, jv]) => `<div><label>${RATE_LABELS[ik] ?? ik} ${RATE_LABELS[jk] ?? jk}</label>${leaf(`${pth}.${ik}.${jk}`, jv)}</div>`).join("") : `<div><label>${RATE_LABELS[ik] ?? ik}</label>${leaf(`${pth}.${ik}`, iv)}</div>`)).join("")}</div>${k === "ni" ? `<label>Rates for each NI letter: employee then employer, as [threshold, %] from the bottom up</label><textarea id="niRates" rows="8" style="font:13px/1.3 ui-monospace,monospace">${esc(JSON.stringify({ employee: v.employee, employer: v.employer }, null, 1))}</textarea>` : ""}`;
    return `<div><label>${RATE_LABELS[k] ?? k}</label>${leaf(pth, v)}</div>`;
  }).join("");
  $("payBody").innerHTML = `<div class="card"><div class="row"><h2 style="margin:0">Tax rates</h2><span class="spacer"></span><select id="ryPick" style="width:auto">${years.map((y) => `<option ${y === PAY.rateYear ? "selected" : ""}>${y}</option>`).join("")}</select></div>
    <p class="small muted">Each April, check GOV.UK "Rates and thresholds for employers" and type the new year's figures in. Pay runs use the rates for the tax year their payday falls in.</p>
    <div class="grid2">${walk(rates, "")}</div>
    <div class="msg bad" id="ryErr" hidden></div>
    <div class="row" style="margin-top:12px"><button class="btn ghost" id="ryNext">Start next tax year from these</button><span class="spacer"></span><button class="btn" id="rySave">Save ${esc(PAY.rateYear)}</button></div></div>`;
  $("ryPick").onchange = () => { PAY.rateYear = $("ryPick").value; payRatesView(); };
  const collect = () => {
    const out = JSON.parse(JSON.stringify(rates));
    $("payBody").querySelectorAll("[data-rp]").forEach((el) => {
      const keys = el.dataset.rp.split("."); let o = out;
      keys.slice(0, -1).forEach((k) => (o = o[k]));
      const last = keys[keys.length - 1];
      o[last] = typeof o[last] === "number" ? Number(el.value) : el.value;
    });
    const t = JSON.parse($("niRates").value);
    out.ni.employee = t.employee; out.ni.employer = t.employer;
    return out;
  };
  $("rySave").onclick = async () => {
    try { const r = collect(); await api.paySaveTaxYear(PAY.rateYear, r); PAY.taxYears.find((t) => t.tax_year === PAY.rateYear).rates = r; $("ryErr").hidden = false; $("ryErr").className = "msg good"; $("ryErr").textContent = "Saved."; }
    catch (e) { $("ryErr").hidden = false; $("ryErr").className = "msg bad"; $("ryErr").textContent = "Couldn't save: " + e.message; }
  };
  $("ryNext").onclick = async () => {
    const [a] = PAY.rateYear.split("-").map(Number);
    const next = `${a + 1}-${String((a + 2) % 100).padStart(2, "0")}`;
    if (PAY.taxYears.some((t) => t.tax_year === next)) { PAY.rateYear = next; return payRatesView(); }
    if (!confirm(`Copy these figures to ${next}? Then change whatever's new for that year.`)) return;
    try { const r = { ...collect(), taxYear: next }; await api.paySaveTaxYear(next, r); PAY.taxYears.push({ tax_year: next, rates: r }); PAY.rateYear = next; payRatesView(); }
    catch (e) { alert(e.message); }
  };
}

// ---- Payslips (everyone) ----------------------------------------------------------------------------------------------------------------------
function renderPayslips() {
  const list = S.myPayslips || [];
  $("app").innerHTML = `<div class="card"><h2>My payslips</h2>
    <ul class="list">${list.map((s) => `<li class="row" data-ps="${s.id}" style="cursor:pointer"><div><b>${longDate(s.pay_date)}</b><div class="muted small">${esc(s.payslip.employer.name)} · ${s.payslip.taxYear} month ${s.payslip.taxMonth}</div></div><span class="spacer"></span><b>${M(s.payslip.net)}</b> <span class="muted">›</span></li>`).join("") || `<li class="muted">No payslips yet. They appear here on payday.</li>`}</ul></div>`;
  $("app").querySelectorAll("[data-ps]").forEach((li) => (li.onclick = () => payslipSheet(list.find((s) => s.id === li.dataset.ps).payslip)));
}

function payslipHtml(s) {
  const rows = (items, sign = "") => items.map((x) => `<tr><td>${esc(x.label)}</td><td class="num">${sign}${M(x.amount)}</td></tr>`).join("");
  const y = s.ytd || {};
  return `<div class="small muted">${esc(s.employer.name)}${s.employer.payeRef ? ` · PAYE ref ${esc(s.employer.payeRef)}` : ""}</div>
    <h2 style="margin:4px 0">Payslip · ${longDate(s.payDate)}</h2>
    <div class="small">${esc(s.person.name)} · NI ${esc(s.person.niNumber || "–")} · tax code ${esc(s.taxCode)} · NI letter ${esc(s.niLetter)}<br>
      Pay period ${shortD(s.periodStart)} – ${shortD(s.periodEnd)} · ${s.taxYear} tax month ${s.taxMonth}</div>
    <h3>Pay</h3><table class="simple">${rows(s.payments)}<tr><td><b>Total pay</b></td><td class="num"><b>${M(s.gross)}</b></td></tr></table>
    <h3>Taken off</h3><table class="simple">${rows(s.deductions, "−") || `<tr><td class="muted">Nothing</td><td></td></tr>`}<tr><td><b>Total taken off</b></td><td class="num"><b>−${M(s.totalDeductions)}</b></td></tr></table>
    ${s.expenses?.length ? `<h3>Expenses paid back (not taxed)</h3><table class="simple">${rows(s.expenses)}</table>` : ""}
    <div class="row" style="margin:14px 0"><span class="big" style="font-size:16px;color:var(--ink)">Net pay</span><span class="spacer"></span><span class="big">${M(s.net)}</span></div>
    ${s.nestEmployer ? `<p class="small muted">Your employer also paid ${M(s.nestEmployer)} into your NEST pension.</p>` : ""}
    ${s.note ? `<div class="msg">${esc(s.note)}</div>` : ""}
    <h3>This tax year so far</h3><table class="simple">
      <tr><td>Taxable pay</td><td class="num">${M(y.taxablePay)}</td></tr><tr><td>Income tax</td><td class="num">${M(y.tax)}</td></tr>
      <tr><td>National Insurance</td><td class="num">${M(y.eeNI)}</td></tr>${y.nestEE || y.nestER ? `<tr><td>Pension: you / employer</td><td class="num">${M(y.nestEE)} / ${M(y.nestER)}</td></tr>` : ""}
      ${y.studentLoan ? `<tr><td>Student loan</td><td class="num">${M(y.studentLoan)}</td></tr>` : ""}${y.ssp ? `<tr><td>Statutory Sick Pay</td><td class="num">${M(y.ssp)}</td></tr>` : ""}</table>`;
}

function payslipSheet(s) {
  openSheet(`${payslipHtml(s)}<div class="row" style="margin-top:14px"><span class="spacer"></span><button class="btn ghost" data-close>Close</button><button class="btn" id="psPdf">Download</button></div>`);
  $("psPdf").onclick = async () => {
    try { $("psPdf").disabled = true; await payslipPdf([s], `Payslip ${s.person.name} ${s.payDate}.pdf`); }
    catch (e) { alert("Couldn't make the PDF: " + e.message); } finally { if ($("psPdf")) $("psPdf").disabled = false; }
  };
}

// ---- PDF (jsPDF, fetched the first time someone downloads) -------------------------------------------------------------------------------------------
let jsPdfLoading = null;
function loadJsPdf() {
  if (window.jspdf) return Promise.resolve(window.jspdf);
  jsPdfLoading ??= new Promise((ok, bad) => {
    const s = document.createElement("script");
    s.src = "https://cdn.jsdelivr.net/npm/jspdf@2.5.2/dist/jspdf.umd.min.js";
    s.onload = () => ok(window.jspdf); s.onerror = () => { jsPdfLoading = null; bad(new Error("Couldn't load the PDF maker. Check the internet connection.")); };
    document.head.appendChild(s);
  });
  return jsPdfLoading;
}

async function payslipPdf(slips, filename) {
  const { jsPDF } = await loadJsPdf();
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  const navy = [0, 54, 97], grey = [107, 114, 128];
  slips.forEach((s, i) => {
    if (i) doc.addPage();
    let y = 18;
    doc.setFillColor(...navy); doc.rect(0, 0, 210, 30, "F");
    doc.setTextColor(255, 255, 255); doc.setFont("helvetica", "bold"); doc.setFontSize(16); doc.text(s.employer.name, 15, 14);
    doc.setFont("helvetica", "normal"); doc.setFontSize(9); doc.text([s.employer.address, s.employer.payeRef ? `Employer PAYE reference ${s.employer.payeRef}` : ""].filter(Boolean), 15, 20);
    doc.setFont("helvetica", "bold"); doc.setFontSize(18); doc.text("PAYSLIP", 195, 16, { align: "right" });
    doc.setFont("helvetica", "normal"); doc.setFontSize(10); doc.text(`Paid ${longDate(s.payDate)}`, 195, 23, { align: "right" });
    y = 40; doc.setTextColor(27, 31, 36);
    const kv = [["Name", s.person.name], ["NI number", s.person.niNumber || "-"], ["Payroll ID", s.person.worksNumber || "-"], ["Tax code", s.taxCode], ["NI letter", s.niLetter],
      ["Pay period", `${shortD(s.periodStart)} - ${shortD(s.periodEnd)}`], ["Tax period", `${s.taxYear} month ${s.taxMonth}`]];
    doc.setFontSize(10);
    kv.forEach(([k, v], j) => { const x = j < 4 ? 15 : 110, yy = y + (j % 4) * 6; doc.setTextColor(...grey); doc.text(k, x, yy); doc.setTextColor(27, 31, 36); doc.text(String(v), x + 28, yy); });
    y += 28;
    const table = (title, items, total, sign) => {
      doc.setFont("helvetica", "bold"); doc.setFontSize(11); doc.text(title, 15, y); y += 2;
      doc.setDrawColor(227, 231, 236); doc.line(15, y, 195, y); y += 5;
      doc.setFont("helvetica", "normal"); doc.setFontSize(10);
      for (const it of items) { const lines = doc.splitTextToSize(it.label, 140); doc.text(lines, 15, y); doc.text(sign + M(it.amount), 195, y, { align: "right" }); y += 5 * lines.length; }
      if (total) { doc.line(15, y - 2, 195, y - 2); doc.setFont("helvetica", "bold"); doc.text(total[0], 15, y + 2); doc.text(total[1], 195, y + 2, { align: "right" }); doc.setFont("helvetica", "normal"); y += 6; }
      y += 5;
    };
    table("Pay", s.payments, ["Total pay", M(s.gross)], "");
    table("Taken off", s.deductions, ["Total taken off", "-" + M(s.totalDeductions)], "-");
    if (s.expenses?.length) table("Expenses paid back (not taxed)", s.expenses, null, "");
    doc.setFillColor(238, 241, 245); doc.rect(15, y - 4, 180, 14, "F");
    doc.setFont("helvetica", "bold"); doc.setFontSize(14); doc.setTextColor(...navy); doc.text("Net pay", 19, y + 5); doc.text(M(s.net), 191, y + 5, { align: "right" });
    doc.setTextColor(27, 31, 36); doc.setFont("helvetica", "normal"); doc.setFontSize(10); y += 18;
    if (s.nestEmployer) { doc.text(`Your employer also paid ${M(s.nestEmployer)} into your NEST pension.`, 15, y); y += 7; }
    if (s.note) { const l = doc.splitTextToSize(s.note, 180); doc.text(l, 15, y); y += 5 * l.length + 3; }
    const ytd = s.ytd || {};
    const ytdItems = [["Taxable pay", ytd.taxablePay], ["Income tax", ytd.tax], ["National Insurance", ytd.eeNI], ["Pension (you)", ytd.nestEE], ["Pension (employer)", ytd.nestER], ["Student loan", ytd.studentLoan], ["Statutory Sick Pay", ytd.ssp]].filter(([, v], j) => j < 3 || v);
    table("This tax year so far", ytdItems.map(([label, amount]) => ({ label, amount: amount || 0 })), null, "");
    doc.setFontSize(8); doc.setTextColor(...grey); doc.text("Keep your payslips: you may need them for mortgages, benefits or tax queries.", 15, 287);
  });
  doc.save(filename);
}

// ---- Made-up rota for payroll.html?demo=admin (the same people as the rota demo) ---------------------------------
function payrollDemoRota() {
  const P = (name, employer, dpw, home, extra = {}) => ({ id: "pe_" + name.toLowerCase(), name, employer, user_id: null, is_admin: false, days_per_week: dpw, chosen_days: 15, tracks_holiday: true, sort: 0, active: true, ...extra });
  const wk = monday(TODAY), y = Number(TODAY.slice(0, 4));
  const people = [
    P("Mike F", "Owner", 0, null, { id: "pe_owner", is_admin: true, tracks_holiday: false, user_id: "u-owner" }),
    P("Ross", "Fletchers Cobblers Ltd", 5, 0, { user_id: "u-ross" }), P("Kyle", "Fletchers Cobblers Ltd", 5, 1),
    P("Jamie", "Fletchers Cobblers Ltd", 5, null, { left_on: addDays(wk, 4) }), P("Ady", "Fletchers Cobblers Ltd", 2, 1),
    P("Lewis", "Newland Shoe Repairs", 5, 4), P("Mike", "Sole trader (Scarborough)", 2, 3, { started_on: `${y}-05-15` }), P("Tony", "Sole trader (Scarborough)", 5, 3),
  ];
  const closures = [[`${y}-12-24`, "closure"], [`${y}-12-25`, "bank"], [`${y}-12-26`, "closure"], [`${y}-12-28`, "bank"], [`${y}-12-29`, "closure"], [`${y}-12-30`, "closure"], [`${y}-12-31`, "closure"], [`${y + 1}-01-01`, "bank"]]
    .map(([day, kind]) => ({ day, kind, name: kind === "bank" ? "Bank holiday" : "Christmas closure" }));
  const leave = [{ id: "l1", person_id: "pe_kyle", kind: "sick", status: "approved", first_day: addDays(wk, -9), last_day: addDays(wk, -8), days: 0 }];
  const extras = [{ id: "x1", person_id: "pe_jamie", year: y, days: 1, kind: "overtime", worked_on: addDays(wk, -2), reason: "Overtime (covered Hull)" }];
  // Ady works Fridays and Saturdays, Mike Mondays and Thursdays: every week, made up on the fly.
  const shifts = (from, to) => {
    const out = [];
    for (let d = from, i = 0; d <= to && i < 400; d = addDays(d, 1), i++) {
      const w = parse(d).getDay();
      if (w === 5 || w === 6) out.push({ person_id: "pe_ady", day: d });
      if (w === 1 || w === 4) out.push({ person_id: "pe_mike", day: d });
    }
    return out;
  };
  return { people, closures, leave, extras, shifts };
}
