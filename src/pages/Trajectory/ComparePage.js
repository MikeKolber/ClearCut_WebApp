import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import createPlotlyComponent from 'react-plotly.js/factory';
import Plotly from 'plotly.js-basic-dist-min';

import TopBar from '../../components/TopBar/TopBar';
import { compareFilesList, compareFileData } from '../../services/api';
import { TIPS } from './paths';
import Tooltip from '../../components/Tooltip/Tooltip';
import './ComparePage.css';
import { PLOT_COLORS } from '../../constants/plotColors';

/* ═══ Compare page ═══════════════════════════════════════════════
 *
 *   Web port of the desktop `ComparisonPage`. Picks `.csv` / `.xlsx`
 *   files from `Pre-loaded Trajectories/` (plus the synthetic
 *   "Current run" entry pointing at the latest `simulation_output.csv`)
 *   and overlays them per-parameter in stacked Plotly subplots.
 *
 *   Layout
 *     ├── TopBar (EXIT back to /trajectory)
 *     └── Body (sidebar | plot)
 *         ├── Sidebar
 *         │   ├── Files panel — checkboxes + color swatches
 *         │   └── Channels panel — checkboxes per parameter
 *         └── Plot canvas — N subplots × M lines
 *
 *   Each enabled file contributes one line per enabled parameter, in
 *   that file's assigned color. Files that don't have a particular
 *   parameter just don't contribute a line to that subplot.
 *
 *   Data flow: a single `GET /api/trajectory/compare/files` populates
 *   the file list. Each toggled-on file fires its own
 *   `GET /api/trajectory/compare/data?file=…` which the backend
 *   decimates to ≤10k points before returning. Results are cached
 *   in component state so re-toggling doesn't refetch.
 */

const Plot = createPlotlyComponent(Plotly);

// Same palette as TdmsAnalyzer for consistency across the app.
// Shared palette — see src/constants/plotColors.js.
// X-axis defaults to whichever of these we find first in the data.
const X_AXIS_CANDIDATES = ['time_s', 'time', 't', 'sim_time'];

// Default channels for the first paint, in priority order. Picked
// because they're present in essentially every trajectory CSV
// (live sim + preloaded fixtures alike), so every selected file
// will contribute a line — vs. "first 4 alphabetically" which
// can land on per-file-only cols like `COM_m` or `I_xx_kg_m2`
// and silently exclude the live run from the plot.
const DEFAULT_CHANNELS_PRIORITY = [
  'height_m',
  'speed_ecef_m_s',
  'mach',
  'aoa_deg',
  'thrust_N',
  'mass_kg',
  'lat_deg',
  'lon_deg',
];

function ComparePage() {
  const navigate = useNavigate();

  // List of available files from the backend. `null` = still loading.
  const [files, setFiles] = useState(null);
  // Loaded data keyed by `filename` — { columns, row_count }. Cached
  // so re-toggling doesn't refetch. Failed loads stash an error string.
  const [fileData, setFileData] = useState({});
  // Filenames the user has toggled ON.
  const [activeFiles, setActiveFiles] = useState(new Set());
  // Channel/parameter names the user has toggled ON.
  const [activeChannels, setActiveChannels] = useState(new Set());
  // Color assignments for files (stable across renders).
  const [fileColors, setFileColors] = useState({});
  // Per-file load errors / states (`'loading'`, `'error'`, `'ok'`).
  const [fileStates, setFileStates] = useState({});
  const [listError, setListError] = useState(null);

  // Initial: pull the file list. Auto-enable the first file so the
  // user lands on a non-empty plot.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await compareFilesList();
        if (cancelled) return;
        const list = res?.files || [];
        setFiles(list);
        if (list.length > 0) {
          // Default selection: the first entry (Current run if a sim
          // was just executed, else the first preloaded file) plus
          // the first preloaded file if it isn't already selected.
          // This guarantees the page lands on a real 2-line overlay
          // instead of a single-trace plot — making the comparison
          // feature obviously functional at first sight.
          const initial = new Set([list[0].filename]);
          const firstPreloaded = list.find(
            (f) => f.kind === 'preloaded' && f.filename !== list[0].filename
          );
          if (firstPreloaded) initial.add(firstPreloaded.filename);
          setActiveFiles(initial);
          // Pre-assign colors for all files now so toggling order
          // doesn't reshuffle the palette later.
          setFileColors(
            Object.fromEntries(list.map((f, i) => [f.filename, PLOT_COLORS[i % PLOT_COLORS.length]]))
          );
        }
      } catch (e) {
        if (!cancelled) setListError(e.message || String(e));
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Fetch each newly-activated file. Already-loaded files are reused.
  //
  // Important: no per-effect-run cancellation flag. The previous
  // version aborted in-flight fetches every time `activeFiles`
  // changed (its cleanup set `cancelled = true`), which meant
  // toggling a *second* file on while the *first* was still loading
  // silently dropped the first file's response — its data never
  // landed in state and the row stayed stuck in "loading", leaving
  // the channels list empty. Now fetches always complete and write
  // their results regardless of further toggles. Cached entries are
  // free; if the user re-toggles a file, we skip the refetch.
  useEffect(() => {
    for (const filename of activeFiles) {
      if (fileData[filename] || fileStates[filename] === 'loading') continue;
      setFileStates((s) => ({ ...s, [filename]: 'loading' }));
      compareFileData(filename)
        .then((res) => {
          setFileData((d) => ({ ...d, [filename]: res }));
          setFileStates((s) => ({ ...s, [filename]: 'ok' }));
        })
        .catch((e) => {
          setFileStates((s) => ({ ...s, [filename]: 'error' }));
          setFileData((d) => ({ ...d, [filename]: { error: e.message || String(e) } }));
        });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeFiles]);

  // The set of parameters available across enabled+loaded files.
  // We exclude obvious non-plotting columns (the chosen x-axis is
  // handled separately).
  const availableChannels = useMemo(() => {
    const seen = new Map();
    for (const fname of activeFiles) {
      const d = fileData[fname];
      if (!d?.columns) continue;
      for (const [name, meta] of Object.entries(d.columns)) {
        if (X_AXIS_CANDIDATES.includes(name)) continue;
        if (!seen.has(name)) {
          seen.set(name, { name, label: meta.label || name, unit: meta.unit || '' });
        }
      }
    }
    return [...seen.values()].sort((a, b) => a.label.localeCompare(b.label));
  }, [activeFiles, fileData]);

  // Default-enable a useful starter set of parameters as soon as we
  // know what's available. Prefers the priority list (height_m, mach,
  // speed, …) which is present in essentially every trajectory CSV
  // — that way every active file contributes a line on first paint
  // instead of just one. Falls back to the first 4 alphabetically
  // only if none of the priority channels are present.
  //
  // Doesn't churn afterward: only fires once when the user has no
  // channels selected and we just got data for the first time.
  useEffect(() => {
    if (activeChannels.size > 0) return;
    if (availableChannels.length === 0) return;
    const availNames = new Set(availableChannels.map((c) => c.name));
    const picked = DEFAULT_CHANNELS_PRIORITY.filter((n) => availNames.has(n)).slice(0, 4);
    if (picked.length === 0) {
      // No priority channels in the dataset — fall back to first 4
      // alphabetical so the page isn't empty.
      setActiveChannels(new Set(availableChannels.slice(0, 4).map((c) => c.name)));
    } else {
      setActiveChannels(new Set(picked));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [availableChannels.length]);

  // Decide on the x-axis — first candidate present in any enabled file.
  const xAxis = useMemo(() => {
    for (const fname of activeFiles) {
      const cols = fileData[fname]?.columns;
      if (!cols) continue;
      for (const candidate of X_AXIS_CANDIDATES) {
        if (cols[candidate]) return candidate;
      }
    }
    return X_AXIS_CANDIDATES[0];
  }, [activeFiles, fileData]);

  const xMeta = useMemo(() => {
    for (const fname of activeFiles) {
      const cols = fileData[fname]?.columns;
      if (cols && cols[xAxis]) return cols[xAxis];
    }
    return null;
  }, [activeFiles, fileData, xAxis]);

  /* ── Build Plotly traces + layout ────────────────────────────── */
  const channels = useMemo(() => [...activeChannels], [activeChannels]);

  const traces = useMemo(() => {
    const out = [];
    channels.forEach((channelName, chIdx) => {
      const yaxis = chIdx === 0 ? 'y' : `y${chIdx + 1}`;
      const xaxisKey = chIdx === 0 ? 'x' : `x${chIdx + 1}`;
      for (const fname of activeFiles) {
        const data = fileData[fname];
        const x = data?.columns?.[xAxis]?.data;
        const y = data?.columns?.[channelName]?.data;
        if (!Array.isArray(x) || !Array.isArray(y)) continue;
        const fileEntry = files?.find((f) => f.filename === fname);
        out.push({
          type: 'scattergl',
          mode: 'lines',
          name: fileEntry?.name || fname,
          x, y,
          xaxis: xaxisKey,
          yaxis,
          line: { color: fileColors[fname] || '#4DA8DA', width: 1 },
          showlegend: chIdx === 0,
          legendgroup: fname,
          hovertemplate:
            `<b>${fileEntry?.name || fname}</b>: %{y:.4g}` +
            (data.columns[channelName]?.unit ? ` ${data.columns[channelName].unit}` : '') +
            `<extra></extra>`,
        });
      }
    });
    return out;
  }, [channels, activeFiles, fileData, fileColors, files, xAxis]);

  const layout = useMemo(() => {
    const n = channels.length;
    const xLabel = xMeta?.label
      ? (xMeta.unit ? `${xMeta.label} (${xMeta.unit})` : xMeta.label)
      : xAxis;

    const out = {
      paper_bgcolor: 'rgba(0,0,0,0)',
      plot_bgcolor:  'rgba(0,0,0,0)',
      font: {
        family: "'Inter Tight', -apple-system, system-ui, sans-serif",
        size: 11,
        color: '#a3a3a3',
      },
      margin: { l: 64, r: 24, t: 18, b: 38 },
      hovermode: 'x',
      hoverlabel: {
        bgcolor: '#0f0f0f',
        bordercolor: '#2a3038',
        font: {
          family: "'Geist Mono', 'JetBrains Mono', monospace",
          size: 11,
          color: '#f5f5f5',
        },
      },
      legend: {
        orientation: 'h',
        x: 0,
        y: 1.04,
        bgcolor: 'rgba(0,0,0,0)',
        font: { size: 11 },
      },
      dragmode: 'zoom',
    };

    if (n === 0) {
      out.xaxis = { visible: false };
      out.yaxis = { visible: false };
      return out;
    }

    const gap = 0.04;
    const slotH = (1 - gap * (n - 1)) / n;
    out.grid = { rows: n, columns: 1, pattern: 'independent' };

    // First channel index 0 → axis "y", "x"; subsequent → "y2", "x2", …
    channels.forEach((channelName, idx) => {
      const i = idx + 1;
      const top = 1 - idx * (slotH + gap);
      const bottom = top - slotH;
      const ykey = idx === 0 ? 'yaxis' : `yaxis${i}`;
      const xkey = idx === 0 ? 'xaxis' : `xaxis${i}`;

      // Pick a meta from any loaded file that has this channel, for label.
      let chanMeta = null;
      for (const fname of activeFiles) {
        const m = fileData[fname]?.columns?.[channelName];
        if (m) { chanMeta = m; break; }
      }
      const yLabel = chanMeta?.unit
        ? `${chanMeta.label || channelName} (${chanMeta.unit})`
        : chanMeta?.label || channelName;

      out[ykey] = {
        domain: [bottom, top],
        title: { text: yLabel, font: { size: 11, color: '#a3a3a3' } },
        gridcolor: '#1c2026',
        zerolinecolor: '#2a3038',
        tickfont: { size: 10 },
        automargin: true,
        showspikes: false,
      };
      out[xkey] = {
        anchor: idx === 0 ? 'y' : `y${i}`,
        gridcolor: '#15181c',
        zerolinecolor: '#222831',
        showticklabels: idx === n - 1,
        title: idx === n - 1 ? { text: xLabel, font: { size: 11 } } : undefined,
        tickfont: { size: 10 },
        showspikes: true,
        spikemode: 'across',
        spikesnap: 'cursor',
        spikecolor: '#2a3a4a',
        spikethickness: 1.5,
        spikedash: 'dot',
      };
    });

    return out;
  }, [channels, activeFiles, fileData, xAxis, xMeta]);

  /* ── Render ─────────────────────────────────────────────────── */

  const toggleFile = (filename) => {
    setActiveFiles((s) => {
      const next = new Set(s);
      if (next.has(filename)) next.delete(filename);
      else next.add(filename);
      return next;
    });
  };
  const toggleChannel = (name) => {
    setActiveChannels((s) => {
      const next = new Set(s);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const totalRows = useMemo(() => {
    let sum = 0;
    for (const fname of activeFiles) sum += fileData[fname]?.row_count || 0;
    return sum;
  }, [activeFiles, fileData]);

  const status = listError
    ? `⚠ ${listError}`
    : files == null
    ? 'Loading…'
    : files.length === 0
    ? 'No files in Pre-loaded Trajectories/'
    : `${activeFiles.size} of ${files.length} files · ${totalRows.toLocaleString()} pts`;

  return (
    <>
      <TopBar
        onBack={() => navigate('/trajectory')}
        backLabel="EXIT"
        backPosition="right"
        title="Compare Simulations"
        right={<span className={`CMP-status mono${listError ? ' CMP-status--err' : ''}`}>{status}</span>}
      />

      <div className="CMP-main">
        <aside className="CMP-sidebar">
          <section className="CMP-section">
            <header className="CMP-section-head">
              <span className="eyebrow">Files</span>
              <span className="CMP-section-count mono">{files?.length ?? 0}</span>
            </header>
            <div className="CMP-rows">
              {files == null && (
                <span className="CMP-empty mono">{'// loading…'}</span>
              )}
              {files != null && files.length === 0 && (
                <span className="CMP-empty mono">{'// none found'}</span>
              )}
              {files?.map((f) => {
                const checked = activeFiles.has(f.filename);
                const state = fileStates[f.filename];
                const color = fileColors[f.filename] || '#4DA8DA';
                const tip = f.kind === 'current'
                  ? TIPS.compareCurrent
                  : TIPS.comparePreloaded(f.filename);
                return (
                <Tooltip key={f.filename} text={tip}>
                  <label
                    className={
                      'CMP-row' +
                      (checked ? ' CMP-row--on' : '') +
                      (state === 'error' ? ' CMP-row--err' : '')
                    }
                  >
                    <input
                      type="checkbox"
                      className="CMP-row-cb"
                      checked={checked}
                      onChange={() => toggleFile(f.filename)}
                    />
                    <span
                      className="CMP-row-swatch"
                      style={{
                        background: color,
                        boxShadow: checked ? `0 0 6px ${color}` : 'none',
                      }}
                      aria-hidden
                    />
                    <span className="CMP-row-label">
                      {f.name}
                      {f.kind === 'current' && (
                        <span className="CMP-row-tag mono"> live</span>
                      )}
                    </span>
                    {state === 'loading' && (
                      <span className="CMP-row-meta mono">…</span>
                    )}
                    {state === 'error' && (
                      <span className="CMP-row-meta mono">err</span>
                    )}
                  </label>
                </Tooltip>
                );
              })}
            </div>
          </section>

          <section className="CMP-section">
            <header className="CMP-section-head">
              <span className="eyebrow">Channels</span>
              <span className="CMP-section-count mono">{availableChannels.length}</span>
            </header>
            <div className="CMP-rows CMP-rows--scroll">
              {availableChannels.length === 0 && (
                <span className="CMP-empty mono">{'// load a file'}</span>
              )}
              {availableChannels.map((c) => {
                const checked = activeChannels.has(c.name);
                return (
                  <label
                    key={c.name}
                    className={'CMP-row' + (checked ? ' CMP-row--on' : '')}
                    title={c.name}
                  >
                    <input
                      type="checkbox"
                      className="CMP-row-cb"
                      checked={checked}
                      onChange={() => toggleChannel(c.name)}
                    />
                    <span className="CMP-row-label">
                      {c.label}
                      {c.unit && <span className="CMP-row-unit mono"> {c.unit}</span>}
                    </span>
                  </label>
                );
              })}
            </div>
            <div className="CMP-section-foot">
              <button
                type="button"
                className="CMP-mini-btn"
                onClick={() =>
                  setActiveChannels(new Set(availableChannels.map((c) => c.name)))
                }
                disabled={availableChannels.length === 0}
              >
                All
              </button>
              <button
                type="button"
                className="CMP-mini-btn"
                onClick={() => setActiveChannels(new Set())}
                disabled={activeChannels.size === 0}
              >
                None
              </button>
            </div>
          </section>
        </aside>

        <section className="CMP-canvas">
          {channels.length === 0 ? (
            <div className="CMP-empty-canvas mono">
              {activeFiles.size === 0
                ? '// pick at least one file'
                : '// pick at least one channel'}
            </div>
          ) : (
            <Plot
              data={traces}
              layout={layout}
              useResizeHandler
              style={{ width: '100%', height: '100%' }}
              config={{
                displayModeBar: false,
                responsive: true,
                doubleClick: 'reset',
              }}
            />
          )}
        </section>
      </div>
    </>
  );
}

export default ComparePage;
