/**
 * Client-side exporters — direct ports of
 * gui/PBS/pages/page.py::_results_to_text and ::_results_to_csv.
 */

const fmtKg = (v) => {
  if (typeof v === 'number' && Number.isFinite(v)) {
    return `${v.toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })} kg`;
  }
  return String(v ?? '');
};

const W = 60;

export function resultsToText(results, numStages) {
  const lines = [];
  const row = (lbl, val, indent = 2) => {
    const pad = ' '.repeat(indent);
    const left = lbl.padEnd(34);
    const right = typeof val === 'number' ? fmtKg(val).padStart(15) : String(val);
    lines.push(`${pad}${left}${right}`);
  };

  lines.push('═'.repeat(W));
  lines.push('  PBS  ─  Mass Breakdown Results');
  lines.push(`  ${numStages} stage${numStages > 1 ? 's' : ''}`);
  lines.push('═'.repeat(W));

  const stages = results.stages || {};
  const stageKeys = Object.keys(stages).sort((a, b) => Number(a) - Number(b));
  for (const k of stageKeys) {
    const sd = stages[k] || {};
    const pt = sd.propellant_tanks || {};
    lines.push('');
    lines.push('─'.repeat(W));
    lines.push(`  STAGE ${k}`);
    lines.push('─'.repeat(W));
    lines.push('');

    row('Engine',            sd.engine?.mass ?? 0);
    row('TVC',               sd.tvc?.mass ?? 0);
    row('Thrust Structure',  sd.thrust_structure?.mass ?? 0);
    row('Ox Tank (shell)',   pt.ox_tank_mass ?? 0);
    row('Fuel Tank (shell)', pt.fuel_tank_mass ?? 0);
    row('Pressurant',        sd.pressurant?.mass ?? 0);
    row('Fairing',           sd.fairing?.mass ?? 0);
    row('PLA',               sd.pla?.mass ?? 0);

    const perf = sd.engine?.performance;
    if (perf) {
      if (perf.Isp_s) {
        lines.push(
          `    Isp=${perf.Isp_s.toFixed(1)} s  ` +
          `C*=${(perf.C_star ?? 0).toFixed(1)} m/s  ` +
          `Ve=${(perf.Ve ?? 0).toFixed(1)} m/s`
        );
      }
      if (perf.A_t) {
        lines.push(
          `    At=${(perf.A_t * 1e4).toFixed(2)} cm²  ` +
          `Ae=${((perf.A_e ?? 0) * 1e4).toFixed(2)} cm²  ` +
          `De=${((perf.De ?? 0) * 100).toFixed(1)} cm`
        );
      }
    }

    for (const [role, key] of [['Ox', 'ox_details'], ['Fuel', 'fuel_details']]) {
      const det = pt[key] || {};
      if (typeof det.internal_volume === 'number') {
        const tMax = det.maximum_thickness ?? det.head_thickness ?? 0;
        lines.push(
          `    ${role}: V_int=${det.internal_volume.toFixed(4)} m³  ` +
          `t_max=${Number(tMax).toFixed(4)} m`
        );
      }
      for (const w of det.formula_warnings || []) {
        lines.push(`    ⚠ ${role}: ${w}`);
      }
    }

    lines.push(`  ${'─'.repeat(W - 2)}`);
    row('DRY MASS',        sd.dry_mass ?? 0);
    row('PROPELLANT MASS', sd.propellant_mass ?? 0);
    row('WET MASS',        sd.wet_mass ?? 0);
  }

  const inter = results.interstages || {};
  if (inter.sections && Object.keys(inter.sections).length > 0) {
    lines.push('');
    lines.push('─'.repeat(W));
    lines.push('  INTERSTAGES');
    lines.push('─'.repeat(W));
    lines.push('');
    const ikeys = Object.keys(inter.sections).sort((a, b) => Number(a) - Number(b));
    for (const idx of ikeys) {
      row(`Interstage ${idx}–${Number(idx) + 1}`, inter.sections[idx]?.mass ?? 0);
    }
    row('TOTAL', inter.total_mass ?? 0);
  }

  const t = results.totals || {};
  lines.push('');
  lines.push('═'.repeat(W));
  row('TOTAL DRY',        t.dry_mass ?? 0);
  row('TOTAL PROPELLANT', t.propellant_mass ?? 0);
  row('TOTAL WET',        t.wet_mass ?? 0);
  lines.push('═'.repeat(W));

  return lines.join('\n');
}

const csvEscape = (val) => {
  const s = String(val ?? '');
  if (/[,"\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
};

export function resultsToCsv(results) {
  const rows = [['Stage', 'Component', 'Mass (kg)']];

  const stages = results.stages || {};
  const stageKeys = Object.keys(stages).sort((a, b) => Number(a) - Number(b));
  for (const k of stageKeys) {
    const sd = stages[k] || {};
    const pt = sd.propellant_tanks || {};
    rows.push([k, 'Engine',           sd.engine?.mass ?? 0]);
    rows.push([k, 'TVC',              sd.tvc?.mass ?? 0]);
    rows.push([k, 'Thrust Structure', sd.thrust_structure?.mass ?? 0]);
    rows.push([k, 'Ox Tank (shell)',  pt.ox_tank_mass ?? 0]);
    rows.push([k, 'Fuel Tank (shell)', pt.fuel_tank_mass ?? 0]);
    rows.push([k, 'Pressurant',       sd.pressurant?.mass ?? 0]);
    rows.push([k, 'Fairing',          sd.fairing?.mass ?? 0]);
    rows.push([k, 'PLA',              sd.pla?.mass ?? 0]);
    rows.push([k, 'Dry Mass',         sd.dry_mass ?? 0]);
    rows.push([k, 'Propellant Mass',  sd.propellant_mass ?? 0]);
    rows.push([k, 'Wet Mass',         sd.wet_mass ?? 0]);
  }

  const inter = results.interstages || {};
  const ikeys = Object.keys(inter.sections || {}).sort((a, b) => Number(a) - Number(b));
  for (const idx of ikeys) {
    rows.push(['Inter', `Interstage ${idx}-${Number(idx) + 1}`,
               inter.sections[idx]?.mass ?? 0]);
  }

  const t = results.totals || {};
  rows.push(['Total', 'Dry Mass',        t.dry_mass ?? 0]);
  rows.push(['Total', 'Propellant Mass', t.propellant_mass ?? 0]);
  rows.push(['Total', 'Wet Mass',        t.wet_mass ?? 0]);

  return rows.map((r) => r.map(csvEscape).join(',')).join('\n');
}

export function downloadFile(filename, content, mime = 'text/plain;charset=utf-8') {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
    a.remove();
  }, 0);
}
