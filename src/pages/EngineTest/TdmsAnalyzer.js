import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import createPlotlyComponent from 'react-plotly.js/factory';
import Plotly from 'plotly.js-basic-dist-min';

import TopBar from '../../components/TopBar/TopBar';
import { getEngineTest, loadEngineTdms } from '../../services/api';
import ErrorToast from '../../components/ErrorToast/ErrorToast';
import './TdmsAnalyzer.css';

const Plot = createPlotlyComponent(Plotly);

/** Same plot palette as core/gui/config.py::PLOT_COLORS, retuned for dark bg. */
const PLOT_COLORS = [
  '#4DA8DA', '#E06070', '#4ADE9A', '#E8AB2D', '#A78BFA',
  '#F0825C', '#34D399', '#C084FC', '#60A5FA', '#FBBF24',
  '#F87171', '#22D3EE', '#A855F7', '#84CC16', '#FB923C',
];
const colorFor = (idx) => PLOT_COLORS[idx % PLOT_COLORS.length];

/** Distinct global-range colors. */
const RANGE_COLORS = [
  paletteFromHex('#5CB3E8'),  // steel blue
  paletteFromHex('#F0825C'),  // coral
  paletteFromHex('#4ADE80'),  // lime
  paletteFromHex('#E8AB2D'),  // amber
];
const MAX_GLOBAL_RANGES = RANGE_COLORS.length;

function rgbaFromHex(hex, alpha) {
  const m = hex.match(/^#([0-9a-f]{6})$/i);
  if (!m) return `rgba(255,255,255,${alpha})`;
  const v = parseInt(m[1], 16);
  return `rgba(${(v >> 16) & 255},${(v >> 8) & 255},${v & 255},${alpha})`;
}

function paletteFromHex(hex) {
  return {
    stroke: hex,
    fill: rgbaFromHex(hex, 0.12),
    soft: rgbaFromHex(hex, 0.18),
  };
}

let _rid = 0;
const newRangeId = () => `r${++_rid}`;

/* ─── Page ─────────────────────────────────────────────────────── */

function TdmsAnalyzer() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const testName = params.get('test') || '';

  const [tdmsFiles, setTdmsFiles] = useState([]);
  const [selectedFile, setSelectedFile] = useState(null);
  const [channels, setChannels] = useState({});
  const [selectedChannels, setSelectedChannels] = useState(new Set());
  const [loadingFile, setLoadingFile] = useState(false);
  const [loadingMeta, setLoadingMeta] = useState(true);
  const [error, setError] = useState(null);
  const [status, setStatus] = useState('Idle');

  const [baselineInputs, setBaselineInputs] = useState({});

  // Each range: { id, label, start, end, color, channelName? }
  // channelName === undefined → global range (applies to every channel)
  // channelName set          → scoped to that one channel/subplot
  const [ranges, setRanges] = useState([]);

  // pickingFor:
  //   null
  //   { type: 'new-global' }
  //   { type: 'new-channel', channelName }
  //   { type: 'repick', id }
  const [pickingFor, setPickingFor] = useState(null);

  // Bounce back if no test in URL.
  useEffect(() => {
    if (!testName) navigate('/engine-test', { replace: true });
  }, [testName, navigate]);

  // File list per test.
  useEffect(() => {
    if (!testName) return undefined;
    let cancelled = false;
    setLoadingMeta(true);
    setError(null);
    getEngineTest(testName)
      .then((data) => {
        if (cancelled) return;
        const files = data?.tdms_files || [];
        setTdmsFiles(files);
        setStatus(`${files.length} TDMS file${files.length === 1 ? '' : 's'} available`);
        // Auto-load the first file so the user lands directly in the
        // analysis view instead of having to click through an empty
        // "select a file" prompt. The user explicitly clicked the
        // Data Analysis card — they want to see data immediately.
        if (files.length > 0) loadFile(files[0].name);
      })
      .catch((e) => {
        if (cancelled) return;
        setError({
          kind: 'runtime',
          title: 'Could not list TDMS files',
          details: [e.message || String(e)],
        });
      })
      .finally(() => !cancelled && setLoadingMeta(false));
    return () => {
      cancelled = true;
    };
    // `loadFile` is intentionally omitted from deps: re-running the
    // file-list fetch every time it changes would defeat the purpose
    // of caching the list per testName. The callback is fresh each
    // render and reads `testName` from its own closure, so calling
    // it here is safe.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [testName]);

  const loadFile = async (fileName) => {
    setLoadingFile(true);
    setError(null);
    setStatus(`Loading ${fileName}…`);
    try {
      const data = await loadEngineTdms(testName, fileName);
      setSelectedFile(fileName);
      setChannels(data?.channels || {});
      setSelectedChannels(new Set());
      setBaselineInputs({});
      setRanges([]);
      setPickingFor(null);
      setStatus(
        `${fileName} — ${data.channel_count} channel${data.channel_count === 1 ? '' : 's'} in ${data.load_time_s.toFixed(2)}s`
      );
    } catch (e) {
      setError({
        kind: 'runtime',
        title: `Could not load ${fileName}`,
        details: [e.message || String(e)],
      });
      setStatus('Load failed');
    } finally {
      setLoadingFile(false);
    }
  };

  /* ── Derived data ──────────────────────────────────────────── */

  const channelNames = useMemo(
    () => Object.keys(channels).sort(),
    [channels]
  );

  const channelColors = useMemo(() => {
    const m = {};
    channelNames.forEach((n, i) => {
      m[n] = colorFor(i);
    });
    return m;
  }, [channelNames]);

  const baselines = useMemo(() => {
    const out = {};
    for (const [name, raw] of Object.entries(baselineInputs)) {
      const num = parseFloat(raw);
      out[name] = Number.isFinite(num) ? num : 0;
    }
    return out;
  }, [baselineInputs]);

  const globalRanges = useMemo(
    () => ranges.filter((r) => !r.channelName),
    [ranges]
  );
  const scopedRangeFor = useMemo(() => {
    const m = {};
    for (const r of ranges) {
      if (r.channelName) m[r.channelName] = r;
    }
    return m;
  }, [ranges]);

  // { [rangeId]: { [channelName]: avg | null } }
  const rangeAverages = useMemo(() => {
    const out = {};
    for (const r of ranges) {
      const lo = Math.min(r.start, r.end);
      const hi = Math.max(r.start, r.end);
      const inner = {};
      const namesToCompute = r.channelName ? [r.channelName] : [...selectedChannels];
      for (const name of namesToCompute) {
        const ch = channels[name];
        if (!ch?.data) {
          inner[name] = null;
          continue;
        }
        const a = Math.max(0, lo);
        const b = Math.min(ch.data.length, hi);
        if (b <= a) {
          inner[name] = null;
          continue;
        }
        let sum = 0;
        let count = 0;
        for (let i = a; i < b; i++) {
          const v = ch.data[i];
          if (v != null && Number.isFinite(v)) {
            sum += v;
            count += 1;
          }
        }
        inner[name] = count > 0 ? sum / count - (baselines[name] || 0) : null;
      }
      out[r.id] = inner;
    }
    return out;
  }, [channels, selectedChannels, ranges, baselines]);

  /* ── Handlers ──────────────────────────────────────────────── */

  const toggleChannel = (name) =>
    setSelectedChannels((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  const selectAll = () => setSelectedChannels(new Set(channelNames));
  const clearAll = () => setSelectedChannels(new Set());

  const setBaselineFor = (name, raw) =>
    setBaselineInputs((prev) => ({ ...prev, [name]: raw }));

  const resetBaselines = () => setBaselineInputs({});

  // Drop the scoped range belonging to a channel when its baseline-from-range
  // / set-from-first-global helpers fire.
  const setBaselineFromFirstGlobal = (name) => {
    const r = globalRanges[0];
    const ch = channels[name];
    if (!r || !ch?.data) return;
    const lo = Math.max(0, Math.min(r.start, r.end));
    const hi = Math.min(ch.data.length, Math.max(r.start, r.end));
    if (hi <= lo) return;
    let sum = 0;
    let count = 0;
    for (let i = lo; i < hi; i++) {
      const v = ch.data[i];
      if (v != null && Number.isFinite(v)) {
        sum += v;
        count += 1;
      }
    }
    if (count === 0) return;
    setBaselineInputs((prev) => ({ ...prev, [name]: (sum / count).toPrecision(6) }));
  };

  const addGlobalRange = () => {
    if (globalRanges.length >= MAX_GLOBAL_RANGES) return;
    setPickingFor({ type: 'new-global' });
  };

  const startChannelRange = (channelName) => {
    setPickingFor((prev) =>
      prev?.type === 'new-channel' && prev.channelName === channelName
        ? null
        : { type: 'new-channel', channelName }
    );
  };

  const repickRange = (id) => setPickingFor({ type: 'repick', id });

  const cancelPicking = () => setPickingFor(null);

  const removeRange = (id) =>
    setRanges((prev) => prev.filter((r) => r.id !== id));

  const renameRange = (id, label) =>
    setRanges((prev) => prev.map((r) => (r.id === id ? { ...r, label } : r)));

  const clearAllRanges = () => {
    setRanges([]);
    setPickingFor(null);
  };

  const onPlotSelected = (event) => {
    const pf = pickingFor;
    if (!event?.range || !pf) return;

    let xRange = event.range.x;
    if (!xRange) {
      for (const k of Object.keys(event.range)) {
        if (/^x\d*$/.test(k)) {
          const v = event.range[k];
          if (Array.isArray(v) && v.length === 2) {
            xRange = v;
            break;
          }
        }
      }
    }
    if (!xRange) return;
    const [a, b] = xRange;
    const lo = Math.round(Math.min(a, b));
    const hi = Math.round(Math.max(a, b));
    if (hi - lo < 1) return;

    if (pf.type === 'new-global') {
      const idx = globalRanges.length;
      const palette = RANGE_COLORS[idx % MAX_GLOBAL_RANGES];
      setRanges((prev) => [
        ...prev,
        {
          id: newRangeId(),
          label: `R${idx + 1}`,
          start: lo,
          end: hi,
          color: palette,
        },
      ]);
    } else if (pf.type === 'new-channel') {
      const palette = paletteFromHex(channelColors[pf.channelName] || '#4DA8DA');
      // Replace any existing scoped range for that channel.
      setRanges((prev) => [
        ...prev.filter((r) => r.channelName !== pf.channelName),
        {
          id: newRangeId(),
          label: shortLabel(pf.channelName),
          start: lo,
          end: hi,
          color: palette,
          channelName: pf.channelName,
        },
      ]);
    } else if (pf.type === 'repick') {
      setRanges((prev) =>
        prev.map((r) => (r.id === pf.id ? { ...r, start: lo, end: hi } : r))
      );
    }
    setPickingFor(null);
  };

  /* ── Render ───────────────────────────────────────────────── */

  const dragmode = pickingFor ? 'select' : 'zoom';
  const hasBaselines = Object.values(baselineInputs).some((v) => v && parseFloat(v) !== 0);
  const pickingMsg = pickingMessage(pickingFor);

  return (
    <>
      <TopBar
        title="TDMS Data Analysis"
        onBack={() => navigate('/engine-test')}
        backLabel="EXIT"
        backPosition="right"
        right={
          <span className="TA-status mono">
            {pickingMsg || status}
          </span>
        }
      />

      <div className="TA-main">
        {/* Sidebar: files + channels */}
        <aside className="TA-sidebar">
          <div className="TA-section">
            <header className="TA-section-head">
              <span className="eyebrow">Test</span>
            </header>
            <div className="TA-test-name" title={testName}>{testName}</div>
          </div>

          <div className="TA-section TA-section--scroll">
            <header className="TA-section-head">
              <span className="eyebrow">TDMS Files</span>
              {tdmsFiles.length > 0 && (
                <span className="TA-count mono">
                  {String(tdmsFiles.length).padStart(2, '0')}
                </span>
              )}
            </header>
            <div className="TA-list">
              {loadingMeta ? (
                <Empty text="Loading…" />
              ) : tdmsFiles.length === 0 ? (
                <Empty text="// no .tdms files" />
              ) : (
                tdmsFiles.map((f) => {
                  const active = f.name === selectedFile;
                  return (
                    <button
                      key={f.name}
                      type="button"
                      className={`TA-listItem${active ? ' TA-listItem--active' : ''}`}
                      onClick={() => loadFile(f.name)}
                      disabled={loadingFile}
                      title={f.name}
                    >
                      <span className="TA-listItem-name mono">{f.name}</span>
                    </button>
                  );
                })
              )}
            </div>
          </div>

          <div className="TA-section TA-section--scroll TA-section--grow">
            <header className="TA-section-head">
              <span className="eyebrow">Channels</span>
              {channelNames.length > 0 && (
                <div className="TA-section-actions">
                  <button type="button" className="TA-actionBtn" onClick={selectAll}>
                    All
                  </button>
                  <button type="button" className="TA-actionBtn" onClick={clearAll}>
                    None
                  </button>
                  {hasBaselines && (
                    <button type="button" className="TA-actionBtn" onClick={resetBaselines}>
                      Reset BL
                    </button>
                  )}
                </div>
              )}
            </header>
            <div className="TA-list TA-list--channels">
              {channelNames.length === 0 ? (
                <Empty text="// pick a TDMS file" />
              ) : (
                channelNames.map((name) => (
                  <ChannelRow
                    key={name}
                    name={name}
                    ch={channels[name] || {}}
                    color={channelColors[name]}
                    isOn={selectedChannels.has(name)}
                    onToggle={() => toggleChannel(name)}
                    blRaw={baselineInputs[name] ?? ''}
                    onBlChange={(v) => setBaselineFor(name, v)}
                    globalRanges={globalRanges}
                    rangeAverages={rangeAverages}
                    onSetBaselineFromFirstGlobal={() => setBaselineFromFirstGlobal(name)}
                    scopedRange={scopedRangeFor[name]}
                    isPickingScoped={
                      pickingFor?.type === 'new-channel' && pickingFor.channelName === name
                    }
                    onStartScopedRange={() => startChannelRange(name)}
                    onRepickScoped={() => scopedRangeFor[name] && repickRange(scopedRangeFor[name].id)}
                    onRemoveScoped={() => scopedRangeFor[name] && removeRange(scopedRangeFor[name].id)}
                  />
                ))
              )}
            </div>
          </div>
        </aside>

        {/* Chart pane */}
        <section className="TA-chart">
          <ChartToolbar
            globalRanges={globalRanges}
            allRangesCount={ranges.length}
            pickingFor={pickingFor}
            disabled={Object.keys(channels).length === 0}
            onAddGlobalRange={addGlobalRange}
            onCancelPicking={cancelPicking}
            onRepickRange={repickRange}
            onRemoveRange={removeRange}
            onRenameRange={renameRange}
            onClearAll={clearAllRanges}
          />

          <div className="TA-chart-canvas">
            <ChartArea
              channels={channels}
              selected={selectedChannels}
              colors={channelColors}
              baselines={baselines}
              dragmode={dragmode}
              ranges={ranges}
              onSelected={onPlotSelected}
              empty={
                !selectedFile
                  ? 'Select a TDMS file to load channels'
                  : selectedChannels.size === 0
                  ? 'Tick channels on the left to plot'
                  : null
              }
            />
          </div>
        </section>
      </div>

      {error && (
        <ErrorToast error={error} onDismiss={() => setError(null)} />
      )}
    </>
  );
}

/* ─── Channel row ─────────────────────────────────────────────── */

function ChannelRow({
  name, ch, color, isOn, onToggle,
  blRaw, onBlChange,
  globalRanges, rangeAverages,
  onSetBaselineFromFirstGlobal,
  scopedRange, isPickingScoped,
  onStartScopedRange, onRepickScoped, onRemoveScoped,
}) {
  return (
    <div className={`TA-channel${isOn ? ' TA-channel--on' : ''}`}>
      <label className="TA-channel-row">
        <input
          type="checkbox"
          className="TA-channel-cb"
          checked={isOn}
          onChange={onToggle}
        />
        <span
          className="TA-channel-dot"
          style={{
            background: color,
            boxShadow: isOn ? `0 0 8px ${color}` : 'none',
          }}
          aria-hidden="true"
        />
        <span className="TA-channel-name mono" title={name}>{name}</span>
        <span className="TA-channel-len mono">
          {ch.length ? `${(ch.length / 1000).toFixed(0)}k` : ''}
        </span>
      </label>

      {isOn && (
        <div className="TA-channel-extra">
          <div className="TA-channel-line">
            <span className="TA-channel-tag mono">BL</span>
            <input
              className="TA-channel-bl"
              type="text"
              inputMode="decimal"
              spellCheck={false}
              placeholder="0"
              value={blRaw}
              onChange={(e) => onBlChange(e.target.value)}
            />
            {globalRanges.length > 0 && (
              <button
                type="button"
                className="TA-channel-pick"
                onClick={onSetBaselineFromFirstGlobal}
                title={`Set baseline = mean of ${globalRanges[0].label}`}
              >
                ⟵{globalRanges[0].label}
              </button>
            )}

            {scopedRange ? (
              <ScopedRangeChip
                range={scopedRange}
                avg={rangeAverages[scopedRange.id]?.[name]}
                onRepick={onRepickScoped}
                onRemove={onRemoveScoped}
              />
            ) : (
              <button
                type="button"
                className={`TA-channel-mark${isPickingScoped ? ' TA-channel-mark--picking' : ''}`}
                style={isPickingScoped ? { color, borderColor: color } : undefined}
                onClick={onStartScopedRange}
                title="Mark a range scoped to this plot only"
              >
                {isPickingScoped ? 'Drag to mark…' : '+ Range'}
              </button>
            )}
          </div>

          {globalRanges.length > 0 && (
            <div className="TA-channel-avgs">
              {globalRanges.map((r) => {
                const v = rangeAverages[r.id]?.[name];
                if (v == null) return null;
                return (
                  <span
                    key={r.id}
                    className="TA-channel-avg mono"
                    style={{
                      color: r.color.stroke,
                      background: r.color.fill,
                      borderColor: r.color.stroke,
                    }}
                    title={`Mean within ${r.label} (after baseline)`}
                  >
                    <span
                      className="TA-channel-avg-tag"
                      style={{ color: r.color.stroke }}
                    >
                      {r.label}
                    </span>
                    {fmt(v)}
                  </span>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ScopedRangeChip({ range, avg, onRepick, onRemove }) {
  return (
    <span
      className="TA-channel-rangeChip"
      style={{ borderColor: range.color.stroke, background: range.color.fill }}
    >
      <span
        className="TA-channel-rangeChip-bar"
        style={{ background: range.color.stroke }}
      />
      <button
        type="button"
        className="TA-channel-rangeChip-info mono"
        onClick={onRepick}
        title="Click to re-mark"
        style={{ color: range.color.stroke }}
      >
        {range.start} → {range.end}
      </button>
      {avg != null && (
        <span
          className="TA-channel-rangeChip-avg mono"
          style={{ color: range.color.stroke }}
        >
          μ {fmt(avg)}
        </span>
      )}
      <button
        type="button"
        className="TA-channel-rangeChip-x"
        onClick={onRemove}
        title="Remove range"
      >
        ×
      </button>
    </span>
  );
}

/* ─── Chart toolbar (top of chart pane) ────────────────────────── */

function ChartToolbar({
  globalRanges, allRangesCount, pickingFor, disabled,
  onAddGlobalRange, onCancelPicking, onRepickRange, onRemoveRange, onRenameRange,
  onClearAll,
}) {
  const picking = pickingFor != null;
  const pickingNew = pickingFor?.type === 'new-global';

  return (
    <div className="TA-toolbar">
      <button
        type="button"
        className={`TA-tbtn${!picking ? ' TA-tbtn--on' : ''}`}
        onClick={onCancelPicking}
        disabled={disabled}
      >
        Zoom
      </button>

      <button
        type="button"
        className={`TA-tbtn${pickingNew ? ' TA-tbtn--on' : ''}`}
        onClick={pickingNew ? onCancelPicking : onAddGlobalRange}
        disabled={disabled || (globalRanges.length >= MAX_GLOBAL_RANGES && !pickingNew)}
        title={globalRanges.length >= MAX_GLOBAL_RANGES ? `Max ${MAX_GLOBAL_RANGES} global ranges` : 'Mark a range across all plots'}
      >
        {pickingNew ? 'Drag to mark…' : '+ Mark Range (all)'}
      </button>

      {allRangesCount > 0 && (
        <button
          type="button"
          className="TA-tbtn TA-tbtn--danger"
          onClick={onClearAll}
          title="Remove every range from every plot"
        >
          Clear All ({allRangesCount})
        </button>
      )}

      <span className="TA-toolbar-spacer" />

      {globalRanges.map((r) => (
        <RangeChip
          key={r.id}
          range={r}
          isPicking={pickingFor?.type === 'repick' && pickingFor.id === r.id}
          onRepick={() => onRepickRange(r.id)}
          onRemove={() => onRemoveRange(r.id)}
          onRename={(label) => onRenameRange(r.id, label)}
        />
      ))}
    </div>
  );
}

function RangeChip({ range, isPicking, onRepick, onRemove, onRename }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(range.label);

  useEffect(() => setDraft(range.label), [range.label]);

  const commit = () => {
    const v = draft.trim() || range.label;
    onRename(v);
    setEditing(false);
  };

  return (
    <span
      className={`TA-range-chip${isPicking ? ' TA-range-chip--picking' : ''}`}
      style={{
        borderColor: range.color.stroke,
        background: range.color.fill,
      }}
    >
      <span
        className="TA-range-chip-bar"
        style={{ background: range.color.stroke, boxShadow: `0 0 6px ${range.color.stroke}` }}
      />
      {editing ? (
        <input
          autoFocus
          className="TA-range-chip-input mono"
          value={draft}
          maxLength={12}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
            else if (e.key === 'Escape') {
              setDraft(range.label);
              setEditing(false);
            }
          }}
          style={{ color: range.color.stroke }}
        />
      ) : (
        <button
          type="button"
          className="TA-range-chip-label mono"
          style={{ color: range.color.stroke }}
          onDoubleClick={() => setEditing(true)}
          onClick={onRepick}
          title="Click to re-mark · Double-click to rename"
        >
          {range.label}
        </button>
      )}
      <span className="TA-range-chip-info mono">
        {range.start} → {range.end}
        <span className="TA-range-chip-len">· {Math.abs(range.end - range.start)}</span>
      </span>
      <button
        type="button"
        className="TA-range-chip-x"
        onClick={onRemove}
        title="Remove range"
      >
        ×
      </button>
    </span>
  );
}

/* ─── Plotly chart ──────────────────────────────────────────────── */

function ChartArea({
  channels, selected, colors, baselines,
  dragmode, ranges, onSelected, empty,
}) {
  const channelArray = useMemo(() => [...selected], [selected]);

  const traces = useMemo(() => {
    const out = [];
    let idx = 0;
    for (const name of channelArray) {
      const ch = channels[name];
      if (!ch || !Array.isArray(ch.data)) continue;
      idx += 1;
      const yaxis = idx === 1 ? 'y' : `y${idx}`;
      const xaxis = idx === 1 ? 'x' : `x${idx}`;
      const baseline = baselines[name] || 0;
      const x = ch.data.map((_, i) => i);
      const y = baseline === 0
        ? ch.data
        : ch.data.map((v) => (v == null ? null : v - baseline));
      out.push({
        type: 'scattergl',
        mode: 'lines',
        name,
        x,
        y,
        xaxis,
        yaxis,
        line: { color: colors[name], width: 1 },
        hovertemplate: '%{y:.4f}<extra>' + name + '</extra>',
      });
    }
    return out;
  }, [channels, channelArray, colors, baselines]);

  const layout = useMemo(() => {
    const n = traces.length;
    const layout = {
      paper_bgcolor: 'rgba(0,0,0,0)',
      plot_bgcolor: 'rgba(0,0,0,0)',
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
        // Solid dark cool grey — no more "white peeking through" border.
        bordercolor: '#2a3038',
        font: {
          family: "'Geist Mono', 'JetBrains Mono', monospace",
          size: 11,
          color: '#f5f5f5',
        },
      },
      dragmode,
      selectdirection: 'h',
    };

    if (n === 0) {
      layout.xaxis = { visible: false };
      layout.yaxis = { visible: false };
      return layout;
    }

    const gap = 0.04;
    const slotH = (1 - gap * (n - 1)) / n;
    layout.grid = { rows: n, columns: 1, pattern: 'independent' };

    // Build axes.
    const subplotMeta = []; // [{ xref, yDomainRef }]
    for (let i = 1; i <= n; i++) {
      const top = 1 - (i - 1) * (slotH + gap);
      const bottom = top - slotH;
      const ykey = i === 1 ? 'yaxis' : `yaxis${i}`;
      const xkey = i === 1 ? 'xaxis' : `xaxis${i}`;
      const xref = i === 1 ? 'x' : `x${i}`;
      const yDomainRef = i === 1 ? 'y domain' : `y${i} domain`;
      subplotMeta.push({ xref, yDomainRef });
      const name = channelArray[i - 1];
      const baseline = baselines[name] || 0;
      const ylabel = baseline !== 0
        ? `${name}  (BL ${baseline >= 0 ? '+' : ''}${baseline.toFixed(3)})`
        : name;

      layout[ykey] = {
        domain: [bottom, top],
        title: { text: ylabel, font: { size: 11, color: '#a3a3a3' } },
        // Cool dark grey (NOT pure white at low alpha — the alpha trick on
        // black always reads as "white-tinted").
        gridcolor: '#1c2026',
        zerolinecolor: '#2a3038',
        tickfont: { size: 10 },
        automargin: true,
        showspikes: false,
      };

      layout[xkey] = {
        anchor: i === 1 ? 'y' : `y${i}`,
        gridcolor: '#15181c',
        zerolinecolor: '#222831',
        showticklabels: i === n,
        title: i === n ? { text: 'Sample Index', font: { size: 11 } } : undefined,
        tickfont: { size: 10 },
        // Independent zoom per subplot.
        // Dark cool grey-blue, no transparency, dotted. Anything pixels of
        // this end up being a clearly NON-white guideline.
        showspikes: true,
        spikemode: 'across',
        spikesnap: 'cursor',
        spikecolor: '#2a3a4a',
        spikethickness: 1.5,
        spikedash: 'dot',
      };
    }

    // Range shapes:
    //   global → one rect on every selected subplot
    //   scoped → one rect on its channel's subplot only
    const shapes = [];
    for (const r of ranges) {
      if (r.channelName) {
        const idx = channelArray.indexOf(r.channelName);
        if (idx === -1) continue; // channel no longer plotted
        const meta = subplotMeta[idx];
        shapes.push(makeRangeShape(r, meta.xref, meta.yDomainRef));
      } else {
        for (const meta of subplotMeta) {
          shapes.push(makeRangeShape(r, meta.xref, meta.yDomainRef));
        }
      }
    }
    layout.shapes = shapes;

    return layout;
  }, [traces, channelArray, baselines, dragmode, ranges]);

  if (empty) {
    return (
      <div className="TA-chart-empty">
        <span>{empty}</span>
      </div>
    );
  }

  return (
    <Plot
      data={traces}
      layout={layout}
      config={{
        displaylogo: false,
        displayModeBar: false,   // hide the home / +/- / pan / etc. toolbar
        responsive: true,
        scrollZoom: true,
      }}
      style={{ width: '100%', height: '100%' }}
      onSelected={onSelected}
      useResizeHandler
    />
  );
}

function makeRangeShape(range, xref, yref) {
  return {
    type: 'rect',
    xref,
    yref,
    x0: range.start,
    x1: range.end,
    y0: 0,
    y1: 1,
    fillcolor: range.color.fill,
    line: { color: range.color.stroke, width: 1, dash: 'dot' },
    layer: 'below',
  };
}

/* ─── helpers ──────────────────────────────────────────────────── */

function Empty({ text }) {
  return <div className="TA-empty mono">{text}</div>;
}

function fmt(v) {
  if (v == null || !Number.isFinite(v)) return '—';
  const abs = Math.abs(v);
  if (abs >= 1000) return v.toFixed(0);
  if (abs >= 1) return v.toFixed(3);
  return v.toFixed(4);
}

function shortLabel(channelName) {
  if (!channelName) return '';
  // Try to keep a readable short label for the chip (first 8 chars).
  return channelName.length > 10 ? `${channelName.slice(0, 8)}…` : channelName;
}

function pickingMessage(pf) {
  if (!pf) return null;
  if (pf.type === 'new-global') return 'Drag any plot to mark a range across all channels';
  if (pf.type === 'new-channel') return `Drag any plot to mark a range for ${pf.channelName}`;
  if (pf.type === 'repick') return 'Drag to re-mark this range';
  return null;
}

export default TdmsAnalyzer;
