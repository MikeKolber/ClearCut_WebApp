import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import createPlotlyComponent from 'react-plotly.js/factory';
import Plotly from 'plotly.js-basic-dist-min';

import TopBar from '../../components/TopBar/TopBar';
import { loadTrajectoryOutput } from '../../services/api';
import { JumpTabs, getJumpTabs, LiveSimBadge } from './JumpTabs';
import { isTrajectoryFreshInSession } from './runState';
import EmptyState from './EmptyState';
import './TrajectoryPlot.css';
import { colorFor } from '../../constants/plotColors';

const Plot = createPlotlyComponent(Plotly);

/** Channels pre-checked when the page first opens — matches the desktop
 *  `plot.py` defaults. Falls back to whatever's in the CSV if any are
 *  missing. */
const DEFAULT_Y_COLUMNS = ['height_m', 'speed_ecef_m_s', 'mass_kg'];

/* ═══ Page ═════════════════════════════════════════════════════ */

function TrajectoryPlot() {
  const navigate = useNavigate();

  const [data, setData] = useState(null);
  const [xAxis, setXAxis] = useState(null);
  const [selectedY, setSelectedY] = useState(() => new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [empty, setEmpty] = useState(null);   // populated when sim CSV doesn't exist
  const [status, setStatus] = useState('Loading…');
  const [overlayOpen, setOverlayOpen] = useState(false);
  // Slider — clips the upper bound of the x-axis range (lower is pinned to data min)
  const [xUpper, setXUpper] = useState(null);

  // Fetch on mount
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setEmpty(null);

    /* Gate the fetch on session freshness — if the user hasn't
       run or loaded a simulation in this session, the on-disk
       `simulation_output.csv` (if any) is from a previous session
       and shouldn't be presented as if it's the user's current
       data. Show a "run a simulation" empty state instead. */
    if (!isTrajectoryFreshInSession()) {
      setEmpty('Run a simulation to see plots.');
      setStatus('No data');
      setLoading(false);
      return () => { cancelled = true; };
    }

    loadTrajectoryOutput()
      .then((d) => {
        if (cancelled) return;
        if (!d.exists) {
          setEmpty(d.message || 'No simulation output yet.');
          setStatus('No data');
          return;
        }
        setData(d);
        setXAxis(d.default_x || null);
        // Default Y selection: height / speed / mass (or first 3 if not present)
        const available = Object.keys(d.columns || {});
        const presets = DEFAULT_Y_COLUMNS.filter((c) => available.includes(c));
        const fallback = available
          .filter((c) => c !== d.default_x)
          .slice(0, 3);
        setSelectedY(new Set(presets.length ? presets : fallback));

        const dec = d.decimation_factor;
        const rows = (d.row_count || 0).toLocaleString();
        const orig = (d.original_row_count || 0).toLocaleString();
        setStatus(
          dec > 1
            ? `${rows} rows · decimated ${dec}× from ${orig}`
            : `${rows} rows · ${d.load_time_s.toFixed(2)}s`
        );
      })
      .catch((e) => {
        if (!cancelled) {
          setError(e.message || String(e));
          setStatus('Load failed');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  /* ── Derived ─────────────────────────────────────────────── */

  const columns = useMemo(() => data?.columns || {}, [data]);
  const allColumnNames = useMemo(() => Object.keys(columns), [columns]);

  // Reset the slider's upper bound whenever the X-axis column changes.
  const xColMeta = xAxis ? columns[xAxis] : null;
  const xColMin = xColMeta?.min ?? 0;
  const xColMax = xColMeta?.max ?? 1;
  useEffect(() => {
    setXUpper(xColMax);
  }, [xAxis, xColMax]);

  // Stable color per channel
  const channelColors = useMemo(() => {
    const m = {};
    allColumnNames.forEach((n, i) => {
      m[n] = colorFor(i);
    });
    return m;
  }, [allColumnNames]);

  // Y options excluded from the X axis dropdown's selection
  const yColumnNames = useMemo(
    () => allColumnNames.filter((n) => n !== xAxis),
    [allColumnNames, xAxis]
  );

  /* ── Handlers ──────────────────────────────────────────── */

  const toggleY = (name) =>
    setSelectedY((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  const selectAll = () => setSelectedY(new Set(yColumnNames));
  const clearAll = () => setSelectedY(new Set());

  /* ── Render ───────────────────────────────────────────── */

  const xMeta = xAxis ? columns[xAxis] : null;

  return (
    <>
      <TopBar
        onBack={() => navigate('/trajectory')}
        backLabel="EXIT"
        backPosition="right"
        leftExtras={
          <>
            <JumpTabs
              tabs={getJumpTabs({
                navigate,
                // Plot tab is the current page — clicking it is a no-op.
                onPlotClick: () => { /* already here */ },
              })}
              activeKey="plot"
            />
            <LiveSimBadge />
          </>
        }
        right={
          <span className={`TP-status mono${error ? ' TP-status--err' : ''}`}>
            {error ? `⚠ ${error}` : status}
          </span>
        }
      />

      <div className="TP-main">
        {/* Sidebar */}
        <aside className="TP-sidebar">
          <div className="TP-section">
            <header className="TP-section-head">
              <span className="eyebrow">X Axis</span>
            </header>
            <div className="TP-x-wrap">
              <select
                className="TP-x-select mono"
                value={xAxis || ''}
                onChange={(e) => setXAxis(e.target.value)}
                disabled={!data || allColumnNames.length === 0}
              >
                {allColumnNames.length === 0 && (
                  <option value="">—</option>
                )}
                {allColumnNames.map((c) => {
                  const m = columns[c];
                  return (
                    <option key={c} value={c}>
                      {m.label}{m.unit ? ` (${m.unit})` : ''}
                    </option>
                  );
                })}
              </select>

              {xColMeta && Number.isFinite(xColMax) && Number.isFinite(xColMin) && xColMax > xColMin && (
                <div className="TP-x-slider-wrap">
                  <div className="TP-x-slider-row mono">
                    <span className="TP-x-slider-label">Upper</span>
                    <span className="TP-x-slider-value">
                      {formatTick(xUpper ?? xColMax)}
                      {xColMeta.unit && (
                        <span className="TP-x-slider-unit">{xColMeta.unit}</span>
                      )}
                    </span>
                  </div>
                  <input
                    type="range"
                    className="TP-x-slider"
                    min={xColMin}
                    max={xColMax}
                    step={(xColMax - xColMin) / 1000}
                    value={xUpper ?? xColMax}
                    onChange={(e) => setXUpper(parseFloat(e.target.value))}
                  />
                  <div className="TP-x-slider-bounds mono">
                    <span>{formatTick(xColMin)}</span>
                    <button
                      type="button"
                      className="TP-x-slider-reset"
                      onClick={() => setXUpper(xColMax)}
                      disabled={xUpper === xColMax}
                      title="Reset to full range"
                    >
                      reset
                    </button>
                    <span>{formatTick(xColMax)}</span>
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="TP-section TP-section--scroll TP-section--grow">
            <header className="TP-section-head">
              <span className="eyebrow">Y Axis</span>
              {yColumnNames.length > 0 && (
                <div className="TP-section-actions">
                  <button type="button" className="TP-actionBtn" onClick={selectAll}>
                    All
                  </button>
                  <button type="button" className="TP-actionBtn" onClick={clearAll}>
                    None
                  </button>
                </div>
              )}
            </header>
            <div className="TP-list">
              {loading ? (
                <Empty text="Loading…" />
              ) : yColumnNames.length === 0 ? (
                <Empty text="// no numeric columns" />
              ) : (
                yColumnNames.map((name) => (
                  <YRow
                    key={name}
                    name={name}
                    meta={columns[name]}
                    color={channelColors[name]}
                    isOn={selectedY.has(name)}
                    onToggle={() => toggleY(name)}
                  />
                ))
              )}
            </div>
          </div>

          <div className="TP-sidebar-foot">
            <button
              type="button"
              className="TP-overlay-btn"
              onClick={() => setOverlayOpen(true)}
              disabled={!data || selectedY.size < 2}
              title={
                !data
                  ? 'Load simulation output first'
                  : selectedY.size < 2
                  ? 'Pick at least 2 channels to overlay'
                  : 'Open overlay view (normalized 0–1)'
              }
            >
              <span className="TP-overlay-btn-glyph" aria-hidden="true">⌇</span>
              <span>Overlay Selected</span>
              {selectedY.size >= 2 && (
                <span className="TP-overlay-btn-count mono">{selectedY.size}</span>
              )}
            </button>
          </div>
        </aside>

        {/* Chart pane */}
        <section className="TP-chart">
          <div className="TP-chart-canvas">
            {empty ? (
              <div className="TP-chart-empty">
                <EmptyState
                  title="No simulation loaded"
                  body={empty}
                  hint="Run Trajectory Simulation"
                />
              </div>
            ) : (
              <ChartArea
                columns={columns}
                xAxis={xAxis}
                xMeta={xMeta}
                xRange={
                  xColMeta && xUpper != null
                    ? [xColMin, xUpper]
                    : null
                }
                selected={selectedY}
                colors={channelColors}
                empty={
                  loading
                    ? null
                    : !xAxis
                    ? 'Pick an X axis on the left'
                    : selectedY.size === 0
                    ? 'Tick channels on the left to plot'
                    : null
                }
              />
            )}
          </div>
        </section>
      </div>

      {overlayOpen && (
        <OverlayModal
          columns={columns}
          xAxis={xAxis}
          xMeta={xMeta}
          selected={selectedY}
          colors={channelColors}
          onClose={() => setOverlayOpen(false)}
        />
      )}
    </>
  );
}

/* ═══ Y-axis row ═══════════════════════════════════════════════ */

function YRow({ name, meta, color, isOn, onToggle }) {
  return (
    <label className={`TP-channel${isOn ? ' TP-channel--on' : ''}`}>
      <input
        type="checkbox"
        className="TP-channel-cb"
        checked={isOn}
        onChange={onToggle}
      />
      <span
        className="TP-channel-dot"
        style={{
          background: color,
          boxShadow: isOn ? `0 0 8px ${color}` : 'none',
        }}
        aria-hidden="true"
      />
      <span className="TP-channel-name" title={`${meta.label} — ${name}`}>
        {meta.label}
      </span>
      {meta.unit && (
        <span className="TP-channel-unit mono">{meta.unit}</span>
      )}
    </label>
  );
}

/* ═══ Plotly chart ═════════════════════════════════════════════ */

function ChartArea({ columns, xAxis, xMeta, xRange, selected, colors, empty }) {
  const channelArray = useMemo(() => [...selected], [selected]);

  const xData = useMemo(
    () => (xAxis && columns[xAxis] ? columns[xAxis].data : null),
    [columns, xAxis]
  );

  const traces = useMemo(() => {
    if (!xData) return [];
    const out = [];
    let idx = 0;
    for (const name of channelArray) {
      const ch = columns[name];
      if (!ch || !Array.isArray(ch.data)) continue;
      idx += 1;
      const yaxis = idx === 1 ? 'y' : `y${idx}`;
      const xaxis = idx === 1 ? 'x' : `x${idx}`;
      out.push({
        type: 'scattergl',
        mode: 'lines',
        name: ch.label,
        x: xData,
        y: ch.data,
        xaxis,
        yaxis,
        line: { color: colors[name], width: 1 },
        hovertemplate:
          `<b>${ch.label}</b>: %{y:.4g}` +
          (ch.unit ? ` ${ch.unit}` : '') +
          `<extra></extra>`,
      });
    }
    return out;
  }, [columns, channelArray, xData, colors]);

  const layout = useMemo(() => {
    const n = traces.length;
    const xLabel =
      xMeta?.label && xMeta?.unit
        ? `${xMeta.label} (${xMeta.unit})`
        : xMeta?.label || xAxis || '';

    const layout = {
      paper_bgcolor: 'rgba(0,0,0,0)',
      plot_bgcolor:  'rgba(0,0,0,0)',
      font: {
        family: "'Inter Tight', -apple-system, system-ui, sans-serif",
        size: 11,
        color: '#a3a3a3',
      },
      margin: { l: 64, r: 24, t: 18, b: 38 },
      showlegend: false,
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
      dragmode: 'zoom',
    };

    if (n === 0) {
      layout.xaxis = { visible: false };
      layout.yaxis = { visible: false };
      return layout;
    }

    const gap = 0.04;
    const slotH = (1 - gap * (n - 1)) / n;
    layout.grid = { rows: n, columns: 1, pattern: 'independent' };

    for (let i = 1; i <= n; i++) {
      const top = 1 - (i - 1) * (slotH + gap);
      const bottom = top - slotH;
      const ykey = i === 1 ? 'yaxis' : `yaxis${i}`;
      const xkey = i === 1 ? 'xaxis' : `xaxis${i}`;

      const name = channelArray[i - 1];
      const meta = columns[name] || {};
      const yLabel = meta.unit ? `${meta.label} (${meta.unit})` : meta.label || name;

      layout[ykey] = {
        domain: [bottom, top],
        title: { text: yLabel, font: { size: 11, color: '#a3a3a3' } },
        gridcolor: '#1c2026',
        zerolinecolor: '#2a3038',
        tickfont: { size: 10 },
        automargin: true,
        showspikes: false,
      };

      layout[xkey] = {
        anchor: i === 1 ? 'y' : `y${i}`,
        // Independent x-axis per subplot — same as TdmsAnalyzer. Each pane
        // gets its own clean spike line on hover instead of one shared
        // line spanning every pane (which reads as visually stiffer).
        ...(xRange ? { range: xRange } : {}),
        gridcolor: '#15181c',
        zerolinecolor: '#222831',
        showticklabels: i === n,
        title: i === n ? { text: xLabel, font: { size: 11 } } : undefined,
        tickfont: { size: 10 },
        showspikes: true,
        spikemode: 'across',
        spikesnap: 'cursor',
        spikecolor: '#2a3a4a',
        spikethickness: 1.5,
        spikedash: 'dot',
      };
    }

    return layout;
  }, [traces, channelArray, columns, xMeta, xAxis, xRange]);

  if (empty) {
    return (
      <div className="TP-chart-empty">
        <EmptyState
          title="No simulation loaded"
          body={empty}
          hint="Run Trajectory Simulation"
        />
      </div>
    );
  }

  return (
    <Plot
      data={traces}
      layout={layout}
      config={{
        displaylogo: false,
        displayModeBar: false,    // matches TdmsAnalyzer — no top-right toolbar
        responsive: true,
        scrollZoom: true,
      }}
      style={{ width: '100%', height: '100%' }}
      useResizeHandler
    />
  );
}

/* ═══ Overlay modal (normalized comparison) ═══════════════════ */

function OverlayModal({ columns, xAxis, xMeta, selected, colors, onClose }) {
  const channelArray = useMemo(() => [...selected], [selected]);

  const xData = useMemo(
    () => (xAxis && columns[xAxis] ? columns[xAxis].data : null),
    [columns, xAxis]
  );

  // Min-max normalize each selected channel into 0–1 so curves at very
  // different scales (m vs N vs kg) can be compared on a shared y-axis.
  // Mirrors the desktop plot.py overlay pane.
  const traces = useMemo(() => {
    if (!xData) return [];
    const out = [];
    for (const name of channelArray) {
      const ch = columns[name];
      if (!ch || !Array.isArray(ch.data)) continue;
      let min = Infinity;
      let max = -Infinity;
      for (const v of ch.data) {
        if (v != null && Number.isFinite(v)) {
          if (v < min) min = v;
          if (v > max) max = v;
        }
      }
      if (!Number.isFinite(min) || !Number.isFinite(max)) continue;
      const range = max - min || 1;
      const normalized = ch.data.map((v) =>
        v == null || !Number.isFinite(v) ? null : (v - min) / range
      );
      out.push({
        type: 'scattergl',
        mode: 'lines',
        name: ch.unit ? `${ch.label} (${ch.unit})` : ch.label,
        x: xData,
        y: normalized,
        line: { color: colors[name], width: 1.4 },
        // Show normalized value in hover; raw range in name suffix lets the
        // user decode what 0/1 mean for each channel.
        hovertemplate:
          `<b>${ch.label}</b><br>` +
          `norm %{y:.3f}<br>` +
          `min ${formatTick(min)} ${ch.unit || ''} → max ${formatTick(max)} ${ch.unit || ''}` +
          `<extra></extra>`,
      });
    }
    return out;
  }, [columns, channelArray, xData, colors]);

  const xLabel =
    xMeta?.label && xMeta?.unit
      ? `${xMeta.label} (${xMeta.unit})`
      : xMeta?.label || xAxis || '';

  const layout = useMemo(
    () => ({
      paper_bgcolor: 'rgba(0,0,0,0)',
      plot_bgcolor: 'rgba(0,0,0,0)',
      font: {
        family: "'Inter Tight', -apple-system, system-ui, sans-serif",
        size: 11,
        color: '#a3a3a3',
      },
      margin: { l: 64, r: 24, t: 18, b: 64 },
      showlegend: true,
      legend: {
        orientation: 'h',
        yanchor: 'top',
        y: -0.16,
        xanchor: 'center',
        x: 0.5,
        bgcolor: 'rgba(0,0,0,0)',
        font: { size: 11, color: '#a3a3a3' },
      },
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
      xaxis: {
        title: { text: xLabel, font: { size: 11 } },
        gridcolor: '#15181c',
        zerolinecolor: '#222831',
        tickfont: { size: 10 },
        showspikes: true,
        spikemode: 'across',
        spikesnap: 'cursor',
        spikecolor: '#2a3a4a',
        spikethickness: 1.5,
        spikedash: 'dot',
      },
      yaxis: {
        title: { text: 'Normalized (0 – 1)', font: { size: 11 } },
        gridcolor: '#1c2026',
        zerolinecolor: '#2a3038',
        tickfont: { size: 10 },
        range: [-0.05, 1.05],
        fixedrange: false,
      },
    }),
    [xLabel]
  );

  // Close on Escape
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="TP-overlay-backdrop" onClick={onClose} role="dialog" aria-modal="true">
      <div
        className="TP-overlay-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="TP-overlay-head">
          <div className="TP-overlay-head-text">
            <h2 className="TP-overlay-title">
              Overlay <span className="TP-overlay-title-count mono">·  {channelArray.length} channels</span>
            </h2>
            <p className="TP-overlay-sub mono">
              Min–max normalized · shared {xMeta?.label || 'X'} axis
            </p>
          </div>
          <button
            type="button"
            className="TP-overlay-close"
            onClick={onClose}
            aria-label="Close overlay"
            title="Close · Esc"
          >
            ×
          </button>
        </header>

        <div className="TP-overlay-canvas">
          <Plot
            data={traces}
            layout={layout}
            config={{
              displaylogo: false,
              displayModeBar: false,  // matches TdmsAnalyzer — no top-right toolbar
              responsive: true,
              scrollZoom: true,
            }}
            style={{ width: '100%', height: '100%' }}
            useResizeHandler
          />
        </div>
      </div>
    </div>
  );
}

/* ─── helpers ──────────────────────────────────────────────── */

function Empty({ text }) {
  return <div className="TP-empty mono">{text}</div>;
}

function formatTick(v) {
  if (v == null || !Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a >= 1e6 || (a !== 0 && a < 1e-2)) return v.toExponential(2);
  if (a >= 100) return v.toFixed(0);
  if (a >= 1)   return v.toFixed(2);
  return v.toFixed(3);
}

export default TrajectoryPlot;
