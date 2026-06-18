import React, { useState, useMemo, useEffect } from "react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine,
} from "recharts";

/* ----------------------------- math helpers ----------------------------- */
function erf(x) {
  const s = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741,
        a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const t = 1 / (1 + p * ax);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax);
  return s * y;
}
const nCdf = (x) => 0.5 * (1 + erf(x / Math.SQRT2));

// Black–Scholes call price as a fraction of spot. m = K/S (moneyness).
function callFrac(m, sigma, rc, T) {
  if (T <= 0) return Math.max(0, 1 - m);
  const v = sigma * Math.sqrt(T);
  const d1 = (-Math.log(m) + (rc + 0.5 * sigma * sigma) * T) / v;
  const d2 = d1 - v;
  return nCdf(d1) - m * Math.exp(-rc * T) * nCdf(d2);
}

// number grouping, Russian style: "89 600" and "1,2"
const grp = (n, d = 0) => {
  if (!isFinite(n)) return "—";
  const s = Number(n).toFixed(d);
  const [i, f] = s.split(".");
  const sign = i.startsWith("-") ? "-" : "";
  const digits = sign ? i.slice(1) : i;
  return sign + digits.replace(/\B(?=(\d{3})+(?!\d))/g, " ") + (f ? "," + f : "");
};
const pct = (x, d = 1) => `${x >= 0 ? "" : "−"}${grp(Math.abs(x * 100), d)}%`;

const SPEC = {
  30:  { name: "Conservative", target: "20–30%" },
  90:  { name: "Balanced",     target: "35–40%" },
  180: { name: "Growth",       target: "45–50%" },
};
// Рекомендованные пресеты («почти-защита» под каждый пакет).
// part/prot подобраны под рынок по умолчанию (волат. 50%, yield 5%) — при других
// допущениях участие пересчитается, и если оно выйдет за бюджет, модель это подсветит.
const PKG = {
  Conservative: { term: 30,  prot: 98.5, part: 18, minEntry: 10000 },
  Balanced:     { term: 90,  prot: 97,   part: 30, minEntry: 25000 },
  Growth:       { term: 180, prot: 95,   part: 40, minEntry: 50000 },
};
const SCENARIOS = [-0.5, -0.3, -0.1, 0, 0.1, 0.3, 0.5, 1.0];

/* --------------------------------- UI ------------------------------------ */
function Field({ label, unit, value, min, max, step, onChange, hint }) {
  return (
    <div className="ppn-field">
      <div className="ppn-field-head">
        <span className="ppn-field-label">{label}</span>
        <span className="ppn-field-val">{grp(value, step < 1 ? (step < 0.1 ? 2 : 1) : 0)}<i>{unit}</i></span>
      </div>
      <input
        className="ppn-range" type="range"
        min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
      />
      {hint && <div className="ppn-field-hint">{hint}</div>}
    </div>
  );
}
function NumField({ label, unit, value, onChange }) {
  return (
    <div className="ppn-field">
      <div className="ppn-field-head"><span className="ppn-field-label">{label}</span></div>
      <div className="ppn-numwrap">
        <input
          className="ppn-num" type="number" value={value}
          onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
        />
        <span className="ppn-numunit">{unit}</span>
      </div>
    </div>
  );
}
function Stat({ k, v, tone, sub }) {
  return (
    <div className={`ppn-stat ${tone ? "ppn-stat-" + tone : ""}`}>
      <div className="ppn-stat-k">{k}</div>
      <div className="ppn-stat-v">{v}</div>
      {sub && <div className="ppn-stat-sub">{sub}</div>}
    </div>
  );
}

export default function App() {
  const [principal, setPrincipal] = useState(80000);
  const [spot, setSpot] = useState(65000);
  const [termDays, setTermDays] = useState(90);
  const [volPct, setVolPct] = useState(50);
  const [yieldPct, setYieldPct] = useState(5);
  const [protPct, setProtPct] = useState(100);
  const [offeredPct, setOfferedPct] = useState(11);
  const [capOn, setCapOn] = useState(false);
  const [capPct, setCapPct] = useState(30);
  const [entryFeePct, setEntryFeePct] = useState(1);
  const [perfFeePct, setPerfFeePct] = useState(0);
  const [slipPct, setSlipPct] = useState(0.5);
  const [activePkg, setActivePkg] = useState(null);

  // выбор пакета задаёт срок + защиту + участие; кэп выключаем (пресеты без потолка)
  const selectPkg = (name) => {
    const p = PKG[name];
    setTermDays(p.term);
    setProtPct(p.prot);
    setOfferedPct(p.part);
    setCapOn(false);
    setActivePkg(name);
  };
  // любое ручное изменение ключевого параметра → конфигурация становится «Custom»
  const onTerm = (v) => { setTermDays(v); setActivePkg(null); };
  const onProt = (v) => { setProtPct(v); setActivePkg(null); };
  const onOffered = (v) => { setOfferedPct(v); setActivePkg(null); };
  const onCapToggle = () => { setCapOn(!capOn); setActivePkg(null); };

  const m = useMemo(() => {
    const T = termDays / 365;
    const r = yieldPct / 100;
    const rc = Math.log(1 + r);
    const sigma = volPct / 100;
    const prot = protPct / 100;
    const cap = capPct / 100;

    const DF = Math.pow(1 + r, -T);
    const budget = 1 - prot * DF;                 // option budget, % of principal
    const cATM = callFrac(1, sigma, rc, T);
    const cCap = capOn ? callFrac(1 + cap, sigma, rc, T) : 0;
    const unitCost = capOn ? cATM - cCap : cATM;   // cost per 1.0 of participation
    const maxPart = budget / unitCost;

    const part = offeredPct / 100;
    const optCost = part * unitCost;               // % of principal spent on options
    const structMargin = budget - optCost;         // before frictions
    const slip = slipPct / 100;
    const netStruct = structMargin - slip;
    const entry = entryFeePct / 100;
    const lockedMarginPct = netStruct + entry;     // locked at t0, path-independent
    const deposit = prot * DF;                      // safe-leg deposit, % of principal

    return { T, r, rc, sigma, prot, cap, DF, budget, cATM, cCap, unitCost,
             maxPart, part, optCost, structMargin, slip, netStruct, entry,
             lockedMarginPct, deposit };
  }, [principal, termDays, volPct, yieldPct, protPct, offeredPct, capOn, capPct, entryFeePct, perfFeePct, slipPct]);

  const feasible = m.part <= m.maxPart + 1e-9;

  const scen = useMemo(() => SCENARIOS.map((R) => {
    const up = capOn ? Math.min(Math.max(R, 0), m.cap) : Math.max(R, 0);
    const gross = m.prot * principal + m.part * principal * up;  // redemption pre perf-fee
    const gainGross = gross - principal;
    const perfFee = gainGross > 0 ? (perfFeePct / 100) * gainGross : 0;
    const netClient = gross - perfFee;
    const clientRet = netClient / principal - 1;
    const btcHold = principal * (1 + R);
    const projMargin = m.lockedMarginPct * principal + perfFee;
    return { R, btcPrice: spot * (1 + R), netClient, clientRet, btcHold, projMargin, perfFee };
  }), [m, principal, spot, capOn, perfFeePct]);

  const chart = useMemo(() => {
    const pts = [];
    for (let R = -0.6; R <= 1.2001; R += 0.02) {
      const up = capOn ? Math.min(Math.max(R, 0), m.cap) : Math.max(R, 0);
      const gross = m.prot * principal + m.part * principal * up;
      const gainGross = gross - principal;
      const perfFee = gainGross > 0 ? (perfFeePct / 100) * gainGross : 0;
      pts.push({
        x: Math.round(R * 100),
        client: Math.round(gross - perfFee),
        btc: Math.round(principal * (1 + R)),
      });
    }
    return pts;
  }, [m, principal, capOn, perfFeePct]);

  const breakevenR = m.prot >= 1 ? 0 : (m.part > 0 ? (1 - m.prot) / m.part : null);
  const spec = SPEC[termDays];

  // keep the term-preset highlight honest
  const presets = [30, 90, 180];

  return (
    <div className="ppn-wrap">
      <style>{CSS}</style>

      <div className="ppn-topbar">
        <div className="ppn-brand">
          <img src="https://fambf.com/assets/brand/logo-primary.svg" alt="FAMBF — Mandate-Backed Finance" className="ppn-brand-logo" />
        </div>
        <a className="ppn-topbar-link" href="https://fambf.com" target="_blank" rel="noopener">fambf.com</a>
      </div>

      <header className="ppn-head">
        <div className="ppn-eyebrow">Хедж-калькулятор · структурный продукт</div>
        <h1 className="ppn-title">Защита тела в USDT + участие в росте BTC</h1>
        <p className="ppn-sub">
          Модель «безрисковая нога + опцион колл» (principal-protected note). Меняйте параметры —
          расчёт участия, маржи и сценариев пересчитывается мгновенно.
        </p>
        <div className="ppn-chips">
          <span className="ppn-chip">BTC ≈ $65 000 <i>июнь 2026</i></span>
          <span className="ppn-chip">DVOL ≈ 50% <i>подразум. волат.</i></span>
          <span className="ppn-chip">USDT yield ≈ 4–5% <i>надёжный</i></span>
        </div>
      </header>

      {/* PACKAGE PRESETS */}
      <section>
        <div className="ppn-pkgs-lbl">
          Пакеты <span>· рекомендованная конфигурация в один клик</span>
        </div>
        <div className="ppn-pkgs">
          {Object.entries(PKG).map(([name, p]) => (
            <button key={name}
              className={`ppn-pkg ${activePkg === name ? "on" : ""}`}
              onClick={() => selectPkg(name)}>
              <span className="ppn-pkg-name">{name}</span>
              <span className="ppn-pkg-meta">{p.term} дн · защита {grp(p.prot, 1)}% · участие ≈{p.part}%</span>
              <span className="ppn-pkg-min">мин. вход {grp(p.minEntry, 0)} USDT</span>
            </button>
          ))}
        </div>
        <div className="ppn-pkgs-state">
          Активно: <b>{activePkg || "Custom (ручные параметры)"}</b>
          {" · "}проценты пакетов рассчитаны для волатильности 50% и доходности 5%; меняйте допущения ниже.
        </div>
      </section>

      {/* INPUTS */}
      <section className="ppn-card">
        <div className="ppn-card-h">Параметры продукта</div>

        <div className="ppn-presets">
          <span className="ppn-presets-lbl">Срок</span>
          {presets.map((d) => (
            <button key={d}
              className={`ppn-pill ${termDays === d ? "on" : ""}`}
              onClick={() => onTerm(d)}>
              {d} дн{SPEC[d] ? ` · ${SPEC[d].name}` : ""}
            </button>
          ))}
        </div>

        <div className="ppn-grid">
          <NumField label="Взнос клиента" unit="USDT" value={principal} onChange={setPrincipal} />
          <NumField label="Цена BTC на старте" unit="USDT" value={spot} onChange={setSpot} />
          <Field label="Срок" unit=" дн" value={termDays} min={7} max={365} step={1} onChange={onTerm} />
          <Field label="Подразум. волатильность BTC" unit="%" value={volPct} min={20} max={120} step={1}
                 onChange={setVolPct} hint="дороже опцион → меньше участия" />
          <Field label="Доходность USDT (надёжная)" unit="% год" value={yieldPct} min={0} max={15} step={0.25}
                 onChange={setYieldPct} hint="выше ставка → больше бюджет, но и больше риск" />
          <Field label="Защита тела" unit="%" value={protPct} min={85} max={100} step={0.5}
                 onChange={onProt} hint="главный рычаг участия (см. ниже)" />
          <Field label="Участие в росте (предлагаем клиенту)" unit="%" value={offeredPct} min={0} max={60} step={0.5}
                 onChange={onOffered} hint={`максимум при этих параметрах: ${grp(m.maxPart * 100, 1)}%`} />
          <Field label="Комиссия на входе" unit="%" value={entryFeePct} min={0} max={3} step={0.25} onChange={setEntryFeePct} />
          <Field label="Комиссия с прибыли клиента" unit="%" value={perfFeePct} min={0} max={30} step={1} onChange={setPerfFeePct} />
          <Field label="Буфер на спред/проскальзывание хеджа" unit="%" value={slipPct} min={0} max={2} step={0.1} onChange={setSlipPct} />
          <div className="ppn-field ppn-capfield">
            <div className="ppn-field-head">
              <span className="ppn-field-label">Кэп на рост (call-spread)</span>
              <button className={`ppn-toggle ${capOn ? "on" : ""}`} onClick={onCapToggle}>
                {capOn ? "включён" : "выключен"}
              </button>
            </div>
            {capOn && (
              <>
                <input className="ppn-range" type="range" min={10} max={100} step={5}
                       value={capPct} onChange={(e) => setCapPct(parseFloat(e.target.value))} />
                <div className="ppn-field-hint">апсайд ограничен ростом BTC на {capPct}% · участие растёт</div>
              </>
            )}
          </div>
        </div>
      </section>

      {/* KEY STATS */}
      <section className="ppn-stats">
        <Stat k="Бюджет на опцион" v={`${grp(m.budget * 100, 2)}%`} sub={`${grp(m.budget * principal, 0)} USDT`} />
        <Stat k="Цена ATM-колла" v={`${grp(m.cATM * 100, 1)}%`} sub={capOn ? `спред: ${grp(m.unitCost * 100, 1)}%` : "от спота"} />
        <Stat k="Максимум участия" v={`${grp(m.maxPart * 100, 1)}%`} sub="на весь бюджет, маржа = 0" tone="indigo" />
        <Stat k="Предлагаем клиенту"
              v={`${grp(offeredPct, 1)}%`}
              tone={feasible ? "" : "bad"}
              sub={feasible ? "в пределах бюджета" : "ВЫШЕ бюджета — нечем хеджировать"} />
        <Stat k="Маржа проекта (фикс.)"
              v={`${grp(m.lockedMarginPct * principal, 0)}`}
              sub={`USDT · ${grp(m.lockedMarginPct * 100, 2)}% · не зависит от BTC`}
              tone={m.lockedMarginPct >= 0 ? "good" : "bad"} />
        <Stat k="Резерв (защита тела)" v={`${grp(m.deposit * principal, 0)}`} sub={`USDT в надёжную ногу`} />
      </section>

      {/* spec reality-check */}
      {spec && (
        <div className={`ppn-reality ${m.maxPart * 100 + 0.05 >= parseFloat(spec.target) ? "ok" : "warn"}`}>
          <b>{spec.name}</b> ({termDays} дн): в ТЗ заявлено участие <b>{spec.target}</b>;
          при текущих параметрах реально доступно <b>до {grp(m.maxPart * 100, 0)}%</b>
          {m.prot >= 1
            ? ` при 100% защите. Чтобы дотянуть до цели из ТЗ — снизьте защиту тела ниже 100% или включите кэп.`
            : ` при защите ${grp(protPct, 1)}%.`}
        </div>
      )}

      {/* PAYOFF CHART */}
      <section className="ppn-card">
        <div className="ppn-card-h">Выплата клиенту в зависимости от BTC</div>
        <div className="ppn-chart">
          <ResponsiveContainer width="100%" height={320}>
            <LineChart data={chart} margin={{ top: 10, right: 16, left: 8, bottom: 18 }}>
              <CartesianGrid stroke="#E3E7EF" strokeDasharray="2 4" />
              <XAxis dataKey="x" tick={{ fontSize: 11, fill: "#5A6072" }}
                     tickFormatter={(v) => `${v > 0 ? "+" : ""}${v}%`}
                     label={{ value: "изменение BTC", position: "insideBottom", offset: -8, fontSize: 11, fill: "#5A6072" }} />
              <YAxis tick={{ fontSize: 11, fill: "#5A6072" }}
                     tickFormatter={(v) => grp(v / 1000, 0) + "k"} width={48} />
              <Tooltip
                formatter={(v, n) => [grp(v, 0) + " USDT", n === "client" ? "клиент" : "BTC в лоб"]}
                labelFormatter={(l) => `BTC ${l > 0 ? "+" : ""}${l}%`}
                contentStyle={{ fontSize: 12, borderRadius: 8, border: "1px solid #D7DBE3" }} />
              <ReferenceLine y={principal} stroke="#9AA1B2" strokeDasharray="4 4"
                             label={{ value: "взнос", position: "right", fontSize: 10, fill: "#9AA1B2" }} />
              <ReferenceLine x={0} stroke="#C9CFDB" />
              <Line type="monotone" dataKey="btc" name="btc" stroke="#9AA1B2" strokeWidth={1.5} dot={false} strokeDasharray="5 4" />
              <Line type="monotone" dataKey="client" name="client" stroke="#0E9F6E" strokeWidth={2.6} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
        <div className="ppn-legend">
          <span><i className="sw sw-i" /> выплата клиенту</span>
          <span><i className="sw sw-g" /> BTC «в лоб» (без защиты)</span>
          {breakevenR !== null && breakevenR > 0 &&
            <span className="ppn-be">безубыток клиента: BTC ≥ +{grp(breakevenR * 100, 1)}%</span>}
        </div>
      </section>

      {/* SCENARIO TABLE */}
      <section className="ppn-card">
        <div className="ppn-card-h">Сценарии (как в ТЗ)</div>
        <div className="ppn-tablewrap">
          <table className="ppn-table">
            <thead>
              <tr>
                <th>BTC</th>
                <th className="r">Цена BTC</th>
                <th className="r">Клиент получает</th>
                <th className="r">Доход клиента</th>
                <th className="r">Маржа проекта</th>
              </tr>
            </thead>
            <tbody>
              {scen.map((s) => (
                <tr key={s.R} className={s.R === 0 ? "zero" : ""}>
                  <td className={`mono ${s.R > 0 ? "up" : s.R < 0 ? "dn" : ""}`}>
                    {s.R > 0 ? "+" : ""}{grp(s.R * 100, 0)}%
                  </td>
                  <td className="r mono">{grp(s.btcPrice, 0)}</td>
                  <td className="r mono">{grp(s.netClient, 0)}</td>
                  <td className={`r mono ${s.clientRet > 0 ? "up" : s.clientRet < 0 ? "dn" : "flat"}`}>
                    {s.clientRet > 0 ? "+" : ""}{grp(s.clientRet * 100, 1)}%
                  </td>
                  <td className="r mono up">{grp(s.projMargin, 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="ppn-note">
          Все суммы в USDT. Маржа проекта зафиксирована в момент запуска (купленный опцион оплачен заранее,
          надёжная нога возвращает тело) — поэтому при <b>любом</b> движении BTC проект не уходит в минус
          по рынку. Реальные риски — не направление BTC, а контрагент/биржа, депег USDT, досрочный выход и операционные ошибки.
        </div>
      </section>

      <div className="ppn-brandfoot">
        <img src="https://fambf.com/assets/brand/logo-primary.svg" alt="FAMBF" className="ppn-brandfoot-logo" />
        <div className="ppn-brandfoot-txt">
          <b>Разработано FAMBF</b> — Framework for Automated, Mandate-Backed Finance · Подготовил: <b>Pavlo Filianov</b>, Founder
          <div className="ppn-brandfoot-c">
            <a href="mailto:pavlo@fambf.com">pavlo@fambf.com</a> · <a href="https://fambf.com" target="_blank" rel="noopener">fambf.com</a> · <a href="https://www.linkedin.com/in/pavlofilianov/" target="_blank" rel="noopener">LinkedIn</a> · <a href="https://cal.com/fambf/discovery" target="_blank" rel="noopener">Записаться на звонок</a>
          </div>
        </div>
      </div>

      <footer className="ppn-foot">
        Допущения: цена опциона по Блэку–Шоулзу (плоская волатильность, без учёта улыбки и реальных спредов сверх буфера);
        дисконт надёжной ноги по ставке {grp(yieldPct, 2)}% год. Это плановая модель, а не котировка и не инвестиционная рекомендация —
        перед запуском сверяйтесь с живыми ценами опционов на бирже и с юристом по лицензированию.
      </footer>
    </div>
  );
}

/* -------------------------------- styles -------------------------------- */
const CSS = `
.ppn-wrap{--ink:#14161F;--soft:#5A6072;--line:#D7DBE3;--line2:#E8EBF1;--paper:#fff;--bg:#EEF1F6;
  --indigo:#0E9F6E;--indigo2:#E4F5EE;--green:#0E9F6E;--green2:#E4F3EC;--red:#CF4A3C;--red2:#FBE9E6;--amber:#B5791F;
  font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
  color:var(--ink);background:var(--bg);padding:22px;border-radius:16px;line-height:1.45;}
.ppn-wrap *{box-sizing:border-box;}
.mono{font-family:ui-monospace,"SF Mono","JetBrains Mono",Menlo,monospace;font-variant-numeric:tabular-nums;}

.ppn-head{margin-bottom:18px;}
.ppn-eyebrow{font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:var(--indigo);font-weight:700;}
.ppn-title{font-size:25px;line-height:1.12;margin:6px 0 6px;font-weight:800;letter-spacing:-.01em;}
.ppn-sub{margin:0;color:var(--soft);font-size:13.5px;max-width:64ch;}
.ppn-chips{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px;}
.ppn-chip{font-size:12px;background:var(--paper);border:1px solid var(--line);border-radius:999px;
  padding:5px 11px;font-weight:600;}
.ppn-chip i{font-style:normal;color:var(--soft);font-weight:500;margin-left:5px;}

.ppn-card{background:var(--paper);border:1px solid var(--line);border-radius:13px;padding:16px 16px 18px;margin-bottom:14px;}
.ppn-card-h{font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--soft);
  font-weight:700;margin-bottom:14px;padding-bottom:9px;border-bottom:1px solid var(--line2);}

.ppn-presets{display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:16px;}
.ppn-presets-lbl{font-size:12px;color:var(--soft);font-weight:600;margin-right:2px;}
.ppn-pill{font:inherit;font-size:12.5px;font-weight:600;padding:7px 13px;border-radius:9px;cursor:pointer;
  border:1px solid var(--line);background:var(--paper);color:var(--ink);transition:.12s;}
.ppn-pill:hover{border-color:var(--indigo);}
.ppn-pill.on{background:var(--indigo);border-color:var(--indigo);color:#fff;}

.ppn-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(232px,1fr));gap:16px 20px;}
.ppn-field-head{display:flex;justify-content:space-between;align-items:baseline;gap:8px;margin-bottom:7px;}
.ppn-field-label{font-size:12.5px;font-weight:600;color:var(--ink);}
.ppn-field-val{font-family:ui-monospace,"SF Mono",Menlo,monospace;font-size:13px;font-weight:700;color:var(--indigo);white-space:nowrap;}
.ppn-field-val i{font-style:normal;color:var(--soft);font-weight:500;}
.ppn-field-hint{font-size:11px;color:var(--soft);margin-top:5px;}

.ppn-range{-webkit-appearance:none;appearance:none;width:100%;height:4px;border-radius:4px;
  background:var(--line);outline:none;margin:3px 0;}
.ppn-range::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:16px;height:16px;border-radius:50%;
  background:var(--indigo);cursor:pointer;border:2px solid #fff;box-shadow:0 0 0 1px var(--line);}
.ppn-range::-moz-range-thumb{width:16px;height:16px;border-radius:50%;background:var(--indigo);cursor:pointer;border:2px solid #fff;}

.ppn-numwrap{display:flex;align-items:center;border:1px solid var(--line);border-radius:9px;overflow:hidden;background:var(--paper);}
.ppn-num{font:inherit;font-family:ui-monospace,"SF Mono",Menlo,monospace;font-size:15px;font-weight:700;border:0;outline:none;
  padding:9px 11px;width:100%;background:transparent;color:var(--ink);}
.ppn-numunit{font-size:11px;color:var(--soft);padding:0 11px;font-weight:600;border-left:1px solid var(--line2);align-self:stretch;display:flex;align-items:center;}

.ppn-toggle{font:inherit;font-size:11px;font-weight:700;padding:4px 10px;border-radius:7px;cursor:pointer;
  border:1px solid var(--line);background:var(--paper);color:var(--soft);}
.ppn-toggle.on{background:var(--indigo);border-color:var(--indigo);color:#fff;}
.ppn-capfield{grid-column:1/-1;max-width:360px;}

.ppn-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:11px;margin-bottom:12px;}
.ppn-stat{background:var(--paper);border:1px solid var(--line);border-radius:11px;padding:13px 14px;}
.ppn-stat-k{font-size:10.5px;letter-spacing:.07em;text-transform:uppercase;color:var(--soft);font-weight:700;}
.ppn-stat-v{font-family:ui-monospace,"SF Mono",Menlo,monospace;font-size:21px;font-weight:800;margin-top:5px;letter-spacing:-.01em;}
.ppn-stat-sub{font-size:11px;color:var(--soft);margin-top:3px;}
.ppn-stat-indigo{border-color:var(--indigo);background:var(--indigo2);}
.ppn-stat-indigo .ppn-stat-v{color:var(--indigo);}
.ppn-stat-good{border-color:#bfe3d0;background:var(--green2);}
.ppn-stat-good .ppn-stat-v{color:var(--green);}
.ppn-stat-bad{border-color:#f1c4bd;background:var(--red2);}
.ppn-stat-bad .ppn-stat-v{color:var(--red);}

.ppn-reality{border-radius:11px;padding:12px 15px;font-size:13px;margin-bottom:14px;line-height:1.5;}
.ppn-reality.ok{background:var(--green2);border:1px solid #bfe3d0;}
.ppn-reality.warn{background:#FCF3E2;border:1px solid #ecd6a8;}
.ppn-reality b{font-weight:800;}

.ppn-chart{margin:0 -4px;}
.ppn-legend{display:flex;flex-wrap:wrap;gap:16px;margin-top:10px;font-size:12px;color:var(--soft);align-items:center;}
.ppn-legend .sw{display:inline-block;width:18px;height:3px;border-radius:2px;margin-right:6px;vertical-align:middle;}
.sw-i{background:var(--indigo);}
.sw-g{background:#9AA1B2;}
.ppn-be{margin-left:auto;color:var(--indigo);font-weight:600;}

.ppn-tablewrap{overflow-x:auto;}
.ppn-table{width:100%;border-collapse:collapse;font-size:13px;}
.ppn-table th{text-align:left;font-size:10.5px;letter-spacing:.06em;text-transform:uppercase;color:var(--soft);
  font-weight:700;padding:8px 12px;border-bottom:1.5px solid var(--line);}
.ppn-table th.r,.ppn-table td.r{text-align:right;}
.ppn-table td{padding:9px 12px;border-bottom:1px solid var(--line2);}
.ppn-table tr.zero td{background:#F7F8FB;}
.ppn-table td.up{color:var(--green);font-weight:700;}
.ppn-table td.dn{color:var(--red);font-weight:700;}
.ppn-table td.flat{color:var(--soft);}

.ppn-note,.ppn-foot{font-size:11.5px;color:var(--soft);line-height:1.5;margin-top:12px;}
.ppn-note b{color:var(--ink);font-weight:700;}
.ppn-foot{margin-top:4px;padding-top:12px;}

.ppn-pkgs-lbl{font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--soft);font-weight:700;margin-bottom:9px;}
.ppn-pkgs-lbl span{text-transform:none;letter-spacing:0;font-weight:500;}
.ppn-pkgs{display:grid;grid-template-columns:repeat(auto-fit,minmax(184px,1fr));gap:11px;}
.ppn-pkg{display:flex;flex-direction:column;gap:3px;text-align:left;cursor:pointer;font:inherit;color:var(--ink);
  background:var(--paper);border:1px solid var(--line);border-radius:12px;padding:13px 15px;transition:.12s;}
.ppn-pkg:hover{border-color:var(--indigo);}
.ppn-pkg.on{border:1.5px solid var(--indigo);background:var(--indigo2);}
.ppn-pkg-name{font-size:16px;font-weight:800;letter-spacing:-.01em;}
.ppn-pkg.on .ppn-pkg-name{color:var(--indigo);}
.ppn-pkg-meta{font-size:11.5px;color:var(--soft);font-weight:600;}
.ppn-pkg-min{font-size:11px;color:var(--soft);}
.ppn-pkgs-state{font-size:11.5px;color:var(--soft);margin:10px 0 16px;}
.ppn-pkgs-state b{color:var(--ink);font-weight:700;}

.ppn-topbar{display:flex;align-items:center;gap:12px;background:#0E1217;color:#EAF0F4;border-radius:11px;padding:11px 15px;margin-bottom:16px;flex-wrap:wrap;}
.ppn-brand{display:flex;align-items:center;gap:10px;}
.ppn-brand svg{display:block;flex:none;}
.ppn-brand-logo{height:24px;width:auto;display:block;background:#fff;border-radius:8px;padding:5px 9px;}
.ppn-brandfoot-logo{height:22px;width:auto;flex:none;background:#fff;border-radius:8px;padding:5px 9px;}
.ppn-brand-name{font-weight:800;letter-spacing:.14em;font-size:14px;}
.ppn-brand-desc{font-size:10.5px;color:#9AA6B2;letter-spacing:.02em;}
.ppn-topbar-link{margin-left:auto;color:#C7D0D9;text-decoration:none;font-size:12.5px;font-weight:600;}
.ppn-topbar-link:hover{text-decoration:underline;}
.ppn-brandfoot{display:flex;align-items:flex-start;gap:11px;background:#0E1217;color:#C7D0D9;border-radius:11px;padding:14px 16px;margin-top:16px;}
.ppn-brandfoot svg{flex:none;margin-top:1px;}
.ppn-brandfoot-txt{font-size:12px;line-height:1.5;}
.ppn-brandfoot-txt b{color:#EAF0F4;font-weight:700;}
.ppn-brandfoot-c{margin-top:5px;font-size:11.5px;}
.ppn-brandfoot-c a{color:#9FD9C2;text-decoration:none;}
.ppn-brandfoot-c a:hover{text-decoration:underline;}
`;
