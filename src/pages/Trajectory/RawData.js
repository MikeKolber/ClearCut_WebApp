import React, {
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useNavigate } from 'react-router-dom';

import TopBar from '../../components/TopBar/TopBar';
import { JumpTabs, getJumpTabs, LiveSimBadge } from './JumpTabs';
import {
  API_BASE,
  loadTrajectoryRawAll,
  trajectoryDownloadUrl,
  downloadFromBackend,
} from '../../services/api';
import { isTrajectoryFreshInSession } from './runState';
import EmptyState from './EmptyState';
import './RawData.css';

/* ═══ Raw Data — canvas-based high-performance viewer ═══════════════
 *   Read-only spreadsheet view for `simulation_output.csv`.
 *
 *   Architecture (intentionally NOT React-rendered cells):
 *     - One fetch on mount returns the entire dataset as a binary
 *       Float64Array (server-side `np.tobytes()`, client-side
 *       `new Float64Array(buf)` — zero per-cell parse cost).
 *     - Body is a `<canvas>` overlaying a scroll-spacer. The DOM never
 *       grows past the viewport, regardless of row count. Each scroll
 *       frame is one `clearRect` + ~30 background fillRects + ~1100
 *       fillTexts ≈ 2-3 ms paint.
 *     - HTML column header sits in the frozen sticky band and mirrors
 *       the body's horizontal scroll for visual alignment.
 *
 *   Tradeoffs:
 *     - No native row hover / cell selection / copy (canvas isn't a
 *       DOM table). Acceptable for a read-only viewer; downloads are
 *       there for export.
 *     - All data lives in one Float64Array — for a 1M-row, 36-col sim
 *       that's ~288 MB in JS heap. Fine on desktop; may struggle on
 *       very long sims with limited memory. The download buttons are
 *       always available as the escape hatch.                         */

const ROW_HEIGHT  = 24;
const COL_WIDTH   = 130;
const TIME_COL    = 'time_s';

// Same category palette we use everywhere else for consistency.
const CATEGORY_COLOR = {
  time:     '#94a3b8',
  position: '#4DA8DA',
  velocity: '#22D3EE',
  aero:     '#FB923C',
  mass:     '#34D399',
  thrust:   '#FBBF24',
  inertia:  '#A78BFA',
  derived:  '#E879F9',
  other:    '#94a3b8',
};

function RawData() {
  const navigate = useNavigate();

  /* ── data + meta ─────────────────────────────────────────── */
  const [dataset, setDataset] = useState(null);
  // shape:
  //   { total_rows, cols_count, columns: string[],
  //     columns_meta: { col: { label, unit, category, computed } },
  //     data: Float64Array (row-major: rowIdx*cols_count + colIdx) }
  const [loading, setLoading] = useState(true);
  const [progress, setProgress] = useState(0);    // 0..1 download progress
  const [error, setError] = useState(null);
  const [empty, setEmpty] = useState(null);
  const [hidden, setHidden] = useState(() => new Set());
  const [columnsOpen, setColumnsOpen] = useState(false);

  /* ── refs (scroll position lives outside React state to skip
   *        re-renders on every scroll event) ───────────────── */
  const scrollerRef    = useRef(null);
  const headerClipRef  = useRef(null);   // frozen header — overflow:hidden, scrollLeft mirrored
  const wrapRef        = useRef(null);   // table wrap (canvas anchor)
  const canvasRef      = useRef(null);
  const drawScheduled  = useRef(false);
  const viewportSize   = useRef({ w: 0, h: 0 });
  const dpr            = useRef(window.devicePixelRatio || 1);

  /* ── derived: visible columns + total dimensions ─────────── */
  const visibleCols = useMemo(() => {
    if (!dataset) return [];
    return dataset.columns.filter((c) => !hidden.has(c));
  }, [dataset, hidden]);

  // O(1) col-name → array-index in the row's float64 stride.
  const colIndexMap = useMemo(() => {
    if (!dataset) return null;
    const m = new Map();
    dataset.columns.forEach((c, i) => m.set(c, i));
    return m;
  }, [dataset]);

  const totalRows = dataset?.total_rows ?? 0;
  const totalH    = totalRows * ROW_HEIGHT;
  const totalW    = visibleCols.length * COL_WIDTH;

  /* ── fetch the whole dataset on mount, with progress ────── */
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setEmpty(null);
    setProgress(0);

    /* If the user hasn't run/loaded a sim in this session, the
       on-disk CSV is from a previous session and shouldn't be
       presented as the user's current dataset. Skip the (multi-MB)
       fetch and show the empty state instead. */
    if (!isTrajectoryFreshInSession()) {
      setEmpty('Run a simulation to see the raw data.');
      setLoading(false);
      return () => { cancelled = true; };
    }

    (async () => {
      try {
        // Use fetch + ReadableStream so we can show a progress bar
        // while the binary buffer arrives (could be 30-300 MB).
        // IMPORTANT: prepend API_BASE so this fetch goes directly to the
        // backend in production (REACT_APP_API_BASE=https://...backend...).
        // A bare relative path would route through the static site, which
        // 401s cross-origin via the auth gate and triggers cc:auth-expired,
        // logging the user out the moment they open the Raw Data tab.
        const res = await fetch(`${API_BASE}/api/trajectory/output/raw/all`, {
          credentials: 'include',
        });
        if (!res.ok) {
          let msg = `HTTP ${res.status}`;
          try { msg = (await res.json())?.error || msg; } catch { /* ignore */ }
          if (res.status === 401) {
            try { window.dispatchEvent(new CustomEvent('cc:auth-expired')); } catch {}
          }
          throw new Error(msg);
        }
        const ct = res.headers.get('content-type') || '';
        if (ct.includes('application/json')) {
          const json = await res.json();
          if (!cancelled) setEmpty(json.message || 'No simulation output yet.');
          return;
        }
        const colsHdr   = res.headers.get('X-Cc-Columns');
        const totalRows = parseInt(res.headers.get('X-Cc-Rows'), 10);
        const totalCols = parseInt(res.headers.get('X-Cc-Cols'), 10);
        if (!colsHdr) throw new Error('Missing X-Cc-Columns header');
        const { names, meta } = JSON.parse(colsHdr);
        const expected = totalRows * totalCols * 8;

        // Stream the body, accumulating chunks + reporting progress.
        const reader = res.body.getReader();
        const buf = new Uint8Array(expected);
        let received = 0;
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (cancelled) return;
          buf.set(value, received);
          received += value.byteLength;
          setProgress(received / expected);
        }
        if (cancelled) return;
        setDataset({
          total_rows:   totalRows,
          cols_count:   totalCols,
          columns:      names,
          columns_meta: meta,
          data:         new Float64Array(buf.buffer),
        });
      } catch (e) {
        if (!cancelled) setError(e.message || String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ── canvas drawing ──────────────────────────────────────── */
  const draw = () => {
    const canvas = canvasRef.current;
    const scroller = scrollerRef.current;
    if (!canvas || !scroller || !dataset || visibleCols.length === 0) return;

    const { w: vpW, h: vpH } = viewportSize.current;
    if (vpW <= 0 || vpH <= 0) return;

    const ctx = canvas.getContext('2d', { alpha: true });
    const ratio = dpr.current;

    ctx.save();
    ctx.scale(ratio, ratio);
    ctx.clearRect(0, 0, vpW, vpH);

    const scrollTop  = scroller.scrollTop;
    const scrollLeft = scroller.scrollLeft;

    // Visible row range
    const startRow = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT));
    const endRow   = Math.min(totalRows, Math.ceil((scrollTop + vpH) / ROW_HEIGHT));

    // Visible col range
    const startCol = Math.max(0, Math.floor(scrollLeft / COL_WIDTH));
    const endCol   = Math.min(visibleCols.length,
                              Math.ceil((scrollLeft + vpW) / COL_WIDTH));

    // Alternating row backgrounds
    ctx.fillStyle = 'rgba(255, 255, 255, 0.014)';
    for (let r = startRow; r < endRow; r++) {
      if (r % 2 === 1) {
        const y = r * ROW_HEIGHT - scrollTop;
        ctx.fillRect(0, y, vpW, ROW_HEIGHT);
      }
    }

    // Subtle vertical column separators
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.04)';
    ctx.lineWidth = 1;
    for (let c = startCol + 1; c <= endCol; c++) {
      const x = Math.round(c * COL_WIDTH - scrollLeft) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, vpH);
      ctx.stroke();
    }

    // Cell text — monospace, center-aligned within the column.
    ctx.font = '11px "Geist Mono", "JetBrains Mono", ui-monospace, monospace';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    ctx.fillStyle = '#e5e5e5';

    const data = dataset.data;
    const colsCount = dataset.cols_count;
    const halfCol = COL_WIDTH / 2;

    for (let r = startRow; r < endRow; r++) {
      const y = r * ROW_HEIGHT - scrollTop + ROW_HEIGHT / 2;
      const rowStart = r * colsCount;
      for (let c = startCol; c < endCol; c++) {
        const colName = visibleCols[c];
        const realColIdx = colIndexMap.get(colName);
        const v = data[rowStart + realColIdx];
        const x = c * COL_WIDTH - scrollLeft + halfCol;
        if (v !== v /* NaN */) {
          ctx.fillStyle = '#525252';
          ctx.fillText('—', x, y);
          ctx.fillStyle = '#e5e5e5';
          continue;
        }
        ctx.fillText(formatNumber(v, colName), x, y);
      }
    }

    /* ── Sticky-left first column (matches the HTML header's
     *     pinned `time_s` column). Drawn LAST so it always sits
     *     on top of any cells that scrolled underneath it. */
    if (scrollLeft > 0 && visibleCols.length > 0) {
      const stickyCol = visibleCols[0];
      const stickyIdx = colIndexMap.get(stickyCol);

      // Solid bg strip so cells underneath don't bleed through
      ctx.fillStyle = 'rgb(11, 14, 18)';
      ctx.fillRect(0, 0, COL_WIDTH, vpH);

      // Re-paint alternating rows for the sticky strip
      ctx.fillStyle = 'rgba(255, 255, 255, 0.014)';
      for (let r = startRow; r < endRow; r++) {
        if (r % 2 === 1) {
          const y = r * ROW_HEIGHT - scrollTop;
          ctx.fillRect(0, y, COL_WIDTH, ROW_HEIGHT);
        }
      }

      // Right-edge separator
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(COL_WIDTH + 0.5, 0);
      ctx.lineTo(COL_WIDTH + 0.5, vpH);
      ctx.stroke();

      // Cell text for the sticky column (centered like the rest)
      ctx.fillStyle = '#e5e5e5';
      const stickyMid = COL_WIDTH / 2;
      for (let r = startRow; r < endRow; r++) {
        const y = r * ROW_HEIGHT - scrollTop + ROW_HEIGHT / 2;
        const v = data[r * colsCount + stickyIdx];
        if (v !== v) {
          ctx.fillStyle = '#525252';
          ctx.fillText('—', stickyMid, y);
          ctx.fillStyle = '#e5e5e5';
          continue;
        }
        ctx.fillText(formatNumber(v, stickyCol), stickyMid, y);
      }
    }

    ctx.restore();
  };

  /* ── schedule a redraw on the next animation frame ───────── */
  const scheduleDraw = () => {
    if (drawScheduled.current) return;
    drawScheduled.current = true;
    requestAnimationFrame(() => {
      drawScheduled.current = false;
      draw();
    });
  };

  /* ── observe size of the wrap (the canvas anchor) ────────── */
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return undefined;
    const measure = () => {
      const scroller = scrollerRef.current;
      const r = wrap.getBoundingClientRect();
      // Crop the canvas so it covers only the scroller's *content
      // area* (clientWidth/Height). On Windows / Linux the vertical
      // scrollbar takes up ~15px and the horizontal scrollbar ~15px
      // — without subtracting them, the canvas paints UNDER the
      // scrollbars and looks visually clipped at the edges.
      const w = scroller
        ? Math.max(0, scroller.clientWidth)
        : Math.max(0, Math.floor(r.width));
      const h = scroller
        ? Math.max(0, scroller.clientHeight)
        : Math.max(0, Math.floor(r.height));
      viewportSize.current = { w, h };
      const canvas = canvasRef.current;
      if (canvas) {
        const ratio = window.devicePixelRatio || 1;
        dpr.current = ratio;
        canvas.width  = Math.max(1, Math.floor(w * ratio));
        canvas.height = Math.max(1, Math.floor(h * ratio));
        canvas.style.width  = `${w}px`;
        canvas.style.height = `${h}px`;
      }
      scheduleDraw();
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(wrap);
    window.addEventListener('resize', measure);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', measure);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ── re-draw whenever the data, columns, or hidden set changes */
  useEffect(() => { scheduleDraw(); /* eslint-disable-next-line */ }, [dataset, visibleCols, hidden]);

  /* ── scroll handler — mirror header + redraw canvas ─────── */
  const onScroll = () => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    if (headerClipRef.current) {
      headerClipRef.current.scrollLeft = scroller.scrollLeft;
    }
    scheduleDraw();
  };

  /* ── forward wheel events from the frozen header → body ──── */
  useEffect(() => {
    const head = headerClipRef.current;
    if (!head) return undefined;
    const onWheel = (e) => {
      const sc = scrollerRef.current;
      if (!sc) return;
      const dx = e.deltaX || 0;
      const dy = e.deltaY || 0;
      if (dx === 0 && dy === 0) return;
      e.preventDefault();
      sc.scrollBy({ left: dx, top: dy });
    };
    head.addEventListener('wheel', onWheel, { passive: false });
    return () => head.removeEventListener('wheel', onWheel);
  }, []);

  /* ── status text in the TopBar's right slot ──────────────── */
  const statusText = useMemo(() => {
    if (loading) {
      const pct = Math.round(progress * 100);
      return progress > 0 ? `Loading · ${pct}%` : 'Loading…';
    }
    if (error) return `⚠ ${error}`;
    if (empty) return 'No data';
    if (dataset) {
      const rows = dataset.total_rows.toLocaleString();
      const cols = dataset.columns.length;
      const mem = (dataset.data.byteLength / (1024 * 1024)).toFixed(1);
      return `${rows} rows · ${cols} cols · ${mem} MB`;
    }
    return '';
  }, [loading, progress, error, empty, dataset]);

  /* ── render ──────────────────────────────────────────────── */

  if (empty) {
    return (
      <>
        <TopBar
          onBack={() => navigate('/trajectory')}
          backLabel="EXIT"
          backPosition="right"
          leftExtras={<JumpTabs tabs={getJumpTabs({ navigate })} activeKey="raw" />}
        />
        <div className="RD-empty">
          <EmptyState
            title="No simulation loaded"
            body={empty}
            hint="Run Trajectory Simulation"
          />
        </div>
      </>
    );
  }

  return (
    <>
      <TopBar
        onBack={() => navigate('/trajectory')}
        backLabel="EXIT"
        backPosition="right"
        leftExtras={
          <>
            <JumpTabs
              tabs={getJumpTabs({ navigate, onRawClick: () => { /* already here */ } })}
              activeKey="raw"
            />
            <LiveSimBadge />
          </>
        }
        right={
          <span className={`RD-status mono${error ? ' RD-status--err' : ''}`}>
            {statusText}
          </span>
        }
      />

      <div className="RD-toolbar">
        <div className="RD-toolbar-left">
          <ColumnsButton
            dataset={dataset}
            hidden={hidden}
            setHidden={setHidden}
            open={columnsOpen}
            setOpen={setColumnsOpen}
          />
          {hidden.size > 0 && (
            <span className="RD-hidden-pill mono">{hidden.size} hidden</span>
          )}
        </div>

        <div className="RD-toolbar-right">
          {/*
            Buttons (not <a download>) so the click goes through
            `downloadFromBackend()` → `fetch()`. CRA's dev proxy
            short-circuits anchor navigations to index.html because
            the browser sends `Accept: text/html`, but it forwards
            `fetch()` (which sends `Accept: *​/​*`) to the Flask
            backend. Without this indirection the browser receives
            HTML and the user sees "file wasn't available on site".
          */}
          <button
            type="button"
            className="RD-dl-btn"
            onClick={() => {
              downloadFromBackend(
                trajectoryDownloadUrl('csv'),
                'simulation_output.csv',
              ).catch((err) => {
                alert(`Download failed: ${err.message || err}`);
              });
            }}
            title="Download CSV"
          >
            <span aria-hidden="true">⤓</span>
            <span>CSV</span>
          </button>
          <button
            type="button"
            className="RD-dl-btn RD-dl-btn--accent"
            onClick={() => {
              downloadFromBackend(
                trajectoryDownloadUrl('xlsx'),
                'simulation_output.xlsx',
              ).catch((err) => {
                alert(`Download failed: ${err.message || err}`);
              });
            }}
            title="Download XLSX"
          >
            <span aria-hidden="true">⤓</span>
            <span>XLSX</span>
          </button>
        </div>
      </div>

      {/* Frozen HTML column header (mirrors body horizontal scroll). */}
      <div className="RD-frozen">
        <div className="RD-header-clip" ref={headerClipRef}>
          <div className="RD-header" style={{ width: totalW }}>
            {visibleCols.map((c) => {
              const cm = dataset?.columns_meta?.[c] || {};
              return (
                <div
                  key={c}
                  className={`RD-cell RD-cell--head${c === TIME_COL ? ' RD-cell--sticky' : ''}`}
                  style={{
                    width: COL_WIDTH,
                    left:  c === TIME_COL ? 0 : undefined,
                    zIndex: c === TIME_COL ? 4 : 3,
                  }}
                  title={`${cm.label || c}${cm.unit ? ` (${cm.unit})` : ' (unitless)'}`}
                >
                  <span className="RD-cell-head-label">{cm.label || c}</span>
                  {/* Always render a unit pill so all columns share the
                      same vertical layout. Empty units (e.g. Mach) get
                      an italic dim "—" instead of disappearing. */}
                  <span
                    className={`RD-cell-head-unit mono${
                      cm.unit ? '' : ' RD-cell-head-unit--empty'
                    }`}
                  >
                    {cm.unit || '—'}
                  </span>
                  <span
                    className="RD-cell-head-cat"
                    style={{ background: CATEGORY_COLOR[cm.category] || CATEGORY_COLOR.other }}
                    aria-hidden="true"
                  />
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Body: canvas overlay + spacer-driven scroller. */}
      <div className="RD-canvas-wrap" ref={wrapRef}>
        <div
          ref={scrollerRef}
          className="RD-scroller"
          onScroll={onScroll}
        >
          <div
            className="RD-canvas-spacer"
            style={{ width: totalW, height: totalH }}
          />
        </div>
        <canvas
          ref={canvasRef}
          className="RD-canvas"
          aria-hidden="true"
        />

        {(loading || error) && (
          <div className="RD-overlay mono">
            {error
              ? <span className="RD-overlay--err">⚠ {error}</span>
              : (
                <div className="RD-overlay-loading">
                  <div className="RD-overlay-bar">
                    <div
                      className="RD-overlay-bar-fill"
                      style={{ width: `${Math.round(progress * 100)}%` }}
                    />
                  </div>
                  <span>
                    Loading dataset… {progress > 0 ? `${Math.round(progress * 100)}%` : ''}
                  </span>
                </div>
              )}
          </div>
        )}
      </div>
    </>
  );
}

/* ─── Columns toggle popover ───────────────────────────────── */

function ColumnsButton({ dataset, hidden, setHidden, open, setOpen }) {
  const containerRef = useRef(null);
  const [search, setSearch] = useState('');

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, setOpen]);

  if (!dataset) {
    return (
      <button type="button" className="RD-btn RD-btn--ghost" disabled>
        <span aria-hidden="true">☷</span>
        <span>Columns</span>
      </button>
    );
  }

  const groups = new Map();
  for (const c of dataset.columns) {
    const cm = dataset.columns_meta[c] || {};
    const cat = cm.category || 'other';
    if (!groups.has(cat)) groups.set(cat, []);
    groups.get(cat).push(c);
  }

  const filterMatch = (col, label) =>
    !search ||
    col.toLowerCase().includes(search.toLowerCase()) ||
    label.toLowerCase().includes(search.toLowerCase());

  return (
    <div className="RD-cols" ref={containerRef}>
      <button
        type="button"
        className={`RD-btn RD-btn--ghost${open ? ' RD-btn--on' : ''}`}
        onClick={() => setOpen((v) => !v)}
        title="Show / hide columns"
      >
        <span aria-hidden="true">☷</span>
        <span>Columns</span>
        <span className="RD-cols-count mono">
          {dataset.columns.length - hidden.size}/{dataset.columns.length}
        </span>
      </button>

      {open && (
        <div className="RD-cols-pop" role="dialog" aria-label="Columns">
          <header className="RD-cols-pop-head">
            <input
              type="text"
              className="RD-cols-search mono"
              placeholder="Search columns…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              autoFocus
            />
            <div className="RD-cols-pop-actions">
              <button
                type="button"
                className="RD-btn RD-btn--mini"
                onClick={() => setHidden(new Set())}
              >
                All
              </button>
              <button
                type="button"
                className="RD-btn RD-btn--mini"
                onClick={() => {
                  const next = new Set(dataset.columns);
                  next.delete(TIME_COL);
                  setHidden(next);
                }}
              >
                None
              </button>
            </div>
          </header>

          <div className="RD-cols-body">
            {[...groups.entries()].map(([cat, cols]) => {
              const filtered = cols.filter((c) => {
                const cm = dataset.columns_meta[c] || {};
                return filterMatch(c, cm.label || c);
              });
              if (filtered.length === 0) return null;
              return (
                <section key={cat} className="RD-cols-group">
                  <header className="RD-cols-group-head">
                    <span
                      className="RD-cols-group-dot"
                      style={{ background: CATEGORY_COLOR[cat] || CATEGORY_COLOR.other }}
                      aria-hidden="true"
                    />
                    <span className="eyebrow">{cat}</span>
                    <span className="RD-cols-group-count mono">{filtered.length}</span>
                  </header>
                  <ul className="RD-cols-list">
                    {filtered.map((c) => {
                      const cm = dataset.columns_meta[c] || {};
                      const isHidden = hidden.has(c);
                      return (
                        <li key={c}>
                          <label className={`RD-cols-row${isHidden ? '' : ' RD-cols-row--on'}`}>
                            <input
                              type="checkbox"
                              checked={!isHidden}
                              onChange={() => {
                                setHidden((prev) => {
                                  const next = new Set(prev);
                                  if (next.has(c)) next.delete(c);
                                  else next.add(c);
                                  return next;
                                });
                              }}
                            />
                            <span className="RD-cols-row-label">{cm.label || c}</span>
                            {cm.unit && (
                              <span className="RD-cols-row-unit mono">{cm.unit}</span>
                            )}
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

/* ─── Cell formatter ──────────────────────────────────────── */

function formatNumber(v, name) {
  if (v == null || !Number.isFinite(v)) return '—';
  if (name === 'time_s') return v.toFixed(3);
  const a = Math.abs(v);
  if (a !== 0 && (a >= 1e6 || a < 1e-3)) return v.toExponential(3);
  if (Number.isInteger(v) && a < 1e6)    return String(v);
  if (a >= 1000) return v.toFixed(1);
  if (a >= 1)    return v.toFixed(3);
  return v.toFixed(4);
}

export default RawData;
