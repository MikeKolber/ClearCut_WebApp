import React from 'react';
import './Results.css';

const fmt = (v, dec = 2) =>
  typeof v === 'number' && Number.isFinite(v)
    ? v.toLocaleString(undefined, {
        minimumFractionDigits: dec,
        maximumFractionDigits: dec,
      })
    : String(v ?? '');

const fmtKg = (v) => `${fmt(v)} kg`;

/**
 * Detailed results — per-stage breakdown + interstages.
 * The headline totals (dry / propellant / wet) live in the page-chrome
 * SummaryStrip above this panel, so we don't repeat them here.
 */
function Results({ results }) {
  if (!results) {
    return (
      <div className="Results-placeholder">
        Press Calculate Mass<br />to see results here
      </div>
    );
  }

  const stages = results.stages || {};
  const inter = results.interstages || {};
  const stageKeys = Object.keys(stages).sort((a, b) => Number(a) - Number(b));

  const totals = results.totals || {};

  return (
    <>
      <SummaryBanner totals={totals} />
      {stageKeys.map((k) => (
        <StageCard key={k} stageNum={k} sd={stages[k]} />
      ))}
      {inter.sections && Object.keys(inter.sections).length > 0 && (
        <InterstagesCard inter={inter} />
      )}
      <TotalsCard totals={totals} />
    </>
  );
}

/* ─── Summary banner ─────────────────────────────────────────────── */

function SummaryBanner({ totals }) {
  return (
    <div className="Banner">
      <div className="Banner-corner Banner-corner--tl" />
      <div className="Banner-corner Banner-corner--tr" />
      <div className="Banner-corner Banner-corner--bl" />
      <div className="Banner-corner Banner-corner--br" />

      <div className="Banner-cols">
        <BannerCol label="Dry"        value={totals.dry_mass}        tone="muted" />
        <BannerCol label="Propellant" value={totals.propellant_mass} tone="muted" />
        <BannerCol label="Wet"        value={totals.wet_mass}        tone="accent" big />
      </div>
    </div>
  );
}

function BannerCol({ label, value, tone, big = false }) {
  return (
    <div className={`Banner-col${big ? ' Banner-col--big' : ''}`}>
      <div className="Banner-col-label">{label}</div>
      <div className={`Banner-col-value Banner-col-value--${tone} mono`}>
        {fmt(value, 1)}
      </div>
      <div className="Banner-col-unit">KG</div>
    </div>
  );
}

/* ─── Stage card ─────────────────────────────────────────────────── */

function StageCard({ stageNum, sd = {} }) {
  const pt = sd.propellant_tanks || {};
  const cb = pt.fuel_details?.note;

  const rows = [
    ['Engine',                          sd.engine?.mass ?? 0],
    ['TVC',                             sd.tvc?.mass ?? 0],
    ['Thrust Structure',                sd.thrust_structure?.mass ?? 0],
    [cb ? 'Common Bulkhead Tank' : 'Ox Tank (shell)',   pt.ox_tank_mass ?? 0],
    ['Fuel Tank (shell)',               pt.fuel_tank_mass ?? 0],
    ['Pressurant',                      sd.pressurant?.mass ?? 0],
    ['Fairing',                         sd.fairing?.mass ?? 0],
    ['PLA',                             sd.pla?.mass ?? 0],
  ].filter(([label, v]) => !((label === 'Fairing' || label === 'PLA') && v === 0));

  const dry = sd.dry_mass ?? 0;
  const prop = sd.propellant_mass ?? 0;
  const wet = sd.wet_mass ?? 0;
  const frac = wet > 0 ? dry / wet : 0;

  const eng = sd.engine || {};
  const perf = eng.performance;
  const pres = sd.pressurant || {};

  return (
    <div className="Card">
      <div className="Card-stripe Card-stripe--accent" />
      <h3 className="Card-title">Stage {stageNum}</h3>

      {rows.map(([label, v], i) => (
        <Row key={label} label={label} value={fmtKg(v)} alt={i % 2 === 0} />
      ))}

      {Number(eng.num_engines) > 1 && (
        <Hint text={`${Number(eng.num_engines)} engines × ${fmt(eng.per_engine, 1)} kg each`} />
      )}

      {perf && (
        <>
          {(perf.Isp_s || perf.C_star || perf.Ve) && (
            <Hint text={[
              perf.Isp_s ? `Isp=${fmt(perf.Isp_s, 1)} s` : null,
              perf.C_star ? `C*=${fmt(perf.C_star, 1)} m/s` : null,
              perf.Ve ? `Ve=${fmt(perf.Ve, 1)} m/s` : null,
            ].filter(Boolean).join('  ')} />
          )}
          {(perf.A_t || perf.A_e || perf.De) && (
            <Hint text={[
              perf.A_t ? `At=${fmt(perf.A_t * 1e4, 2)} cm²` : null,
              perf.A_e ? `Ae=${fmt(perf.A_e * 1e4, 2)} cm²` : null,
              perf.De ? `De=${fmt(perf.De * 100, 1)} cm` : null,
            ].filter(Boolean).join('  ')} />
          )}
          {perf.De_fits === false && (
            <Warn text={`Exit diameter ${fmt(perf.De * 100, 1)} cm exceeds packaging limit ${fmt((perf.De_max ?? 0) * 100, 1)} cm`} />
          )}
          {perf.cea_note && <Hint text={perf.cea_note} />}
        </>
      )}

      {(pres.mass ?? 0) > 0 && (
        <Hint text={
          `gas ${fmt(pres.gas_mass, 2)} kg  |  tank ${fmt(pres.tank_mass, 2)} kg  |  ` +
          `r=${fmt((pres.tank_radius ?? 0) * 1000, 1)} mm  ` +
          `t=${fmt((pres.wall_thickness ?? 0) * 1000, 2)} mm`
        } />
      )}

      {[['Ox', 'ox_details'], ['Fuel', 'fuel_details']].map(([role, key]) => {
        const det = pt[key] || {};
        const parts = [];
        if (typeof det.internal_volume === 'number') parts.push(`V=${det.internal_volume.toFixed(4)} m³`);
        const tMax = det.maximum_thickness ?? det.head_thickness;
        if (typeof tMax === 'number' && tMax > 0) parts.push(`t_max=${(tMax * 1000).toFixed(2)} mm`);
        if (typeof det.effective_volume === 'number') parts.push(`V_eff=${det.effective_volume.toFixed(4)} m³`);
        return (
          <React.Fragment key={role}>
            {parts.length > 0 && <Hint text={`${role}: ${parts.join('  |  ')}`} />}
            {(det.formula_warnings || []).map((w, i) => (
              <Warn key={`${role}-${i}`} text={`${role}: ${w}`} />
            ))}
          </React.Fragment>
        );
      })}

      <div className="Card-divider" />

      <Row label="Dry Mass"        value={fmtKg(dry)}  bold />
      <Row label="Propellant Mass" value={fmtKg(prop)} bold tone="steel" />
      <Row label="Wet Mass"        value={fmtKg(wet)}  bold tone="accent" />

      <div className="Card-fraction">
        <div className="Card-fraction-bar">
          <div
            className="Card-fraction-fill"
            style={{ width: `${Math.max(0, Math.min(1, frac)) * 100}%` }}
          />
        </div>
        <span className="Card-fraction-label">
          {fmt(frac * 100, 1)}% structural
        </span>
      </div>

      {(sd.errors || []).map((e, i) => (
        <Warn key={`err-${i}`} text={e} />
      ))}
    </div>
  );
}

/* ─── Interstages card ───────────────────────────────────────────── */

function InterstagesCard({ inter }) {
  const sections = inter.sections || {};
  const keys = Object.keys(sections).sort((a, b) => Number(a) - Number(b));

  return (
    <div className="Card">
      <div className="Card-stripe Card-stripe--steel" />
      <h3 className="Card-title">Interstages</h3>
      {keys.map((k, i) => (
        <Row key={k}
          label={`Interstage ${k}–${Number(k) + 1}`}
          value={fmtKg(sections[k]?.mass ?? 0)}
          alt={i % 2 === 0} />
      ))}
      <div className="Card-divider" />
      <Row label="Total Interstages" value={fmtKg(inter.total_mass ?? 0)} bold />
    </div>
  );
}

/* ─── Vehicle totals card ────────────────────────────────────────── */

function TotalsCard({ totals }) {
  return (
    <div className="Card">
      <div className="Card-stripe Card-stripe--accent Card-stripe--thick" />
      <h3 className="Card-title">Vehicle Totals</h3>
      <Row label="Total Dry Mass"   value={fmtKg(totals.dry_mass)}        bold />
      <Row label="Total Propellant" value={fmtKg(totals.propellant_mass)} bold tone="steel" />
      <Row label="Total Wet Mass"   value={fmtKg(totals.wet_mass)}        bold tone="accent" />
    </div>
  );
}

/* ─── Shared row primitives ──────────────────────────────────────── */

function Row({ label, value, bold = false, tone, alt = false }) {
  const cls = [
    'MetricRow',
    bold ? 'MetricRow--bold' : '',
    tone ? `MetricRow--${tone}` : '',
    alt ? 'MetricRow--alt' : '',
  ].filter(Boolean).join(' ');
  return (
    <div className={cls}>
      <span className="MetricRow-label">{label}</span>
      <span className="MetricRow-value mono">{value}</span>
    </div>
  );
}

function Hint({ text }) {
  return <div className="Hint mono">{text}</div>;
}

function Warn({ text }) {
  return <div className="Warn">⚠ {text}</div>;
}

export default Results;
