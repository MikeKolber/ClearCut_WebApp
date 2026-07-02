import React, { useEffect, useMemo, useState } from 'react';
import {
  listDebrisRuns,
  loadDebrisTree,
  debrisFileUrl,
  debrisZipUrl,
} from '../../services/api';
import './DebrisFilesModal.css';

/* ═══ Debris Files Modal ══════════════════════════════════════════
 *   Web equivalent of the desktop's `_open_debris_folder` action: an
 *   in-app file browser for the most recent debris run. Backdrop +
 *   blur, click-outside / Esc to dismiss. Shows top-level files plus
 *   per-row collapsible accordions with inline row stats.
 * ──────────────────────────────────────────────────────────────── */

function DebrisFilesModal({ onClose }) {
  // Three states the modal can be in: loading the run / showing the
  // tree / showing an error or empty message.
  const [tree, setTree] = useState(null);
  const [runId, setRunId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [openRows, setOpenRows] = useState(() => new Set());

  // On mount: pick the newest debris run, fetch its tree.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setTree(null);

    (async () => {
      try {
        const list = await listDebrisRuns();
        const newest = (list?.runs || [])[0];
        if (!newest) {
          if (!cancelled) {
            setError('No debris runs found yet. Run a debris analysis first.');
            setLoading(false);
          }
          return;
        }
        if (cancelled) return;
        setRunId(newest.id);
        const t = await loadDebrisTree(newest.id);
        if (cancelled) return;
        setTree(t);
        // Default-open the first row so the modal isn't empty-feeling.
        const firstRow = (t.rows || [])[0]?.row;
        if (firstRow != null) setOpenRows(new Set([firstRow]));
      } catch (e) {
        if (!cancelled) setError(e.message || String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, []);

  // Esc closes
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const toggleRow = (rowNum) => {
    setOpenRows((prev) => {
      const next = new Set(prev);
      if (next.has(rowNum)) next.delete(rowNum);
      else next.add(rowNum);
      return next;
    });
  };

  const totals = tree?.totals || {};
  const totalSize = useMemo(
    () => formatBytes(totals.total_size_bytes || 0),
    [totals.total_size_bytes]
  );

  return (
    <div
      className="DFM-backdrop"
      role="dialog"
      aria-modal="true"
      onClick={onClose}
    >
      <div
        className="DFM-modal"
        onClick={(e) => e.stopPropagation()}
        role="document"
      >
        <header className="DFM-head">
          <div className="DFM-head-text">
            <h2 className="DFM-title">Results Folder</h2>
            <p className="DFM-sub mono">
              {runId ? runId : '—'}
              {tree?.generated_at && (
                <> · finished {formatTimestamp(tree.generated_at)}</>
              )}
            </p>
          </div>
          <div className="DFM-head-actions">
            {runId && (
              <a
                className="DFM-zip-btn"
                href={debrisZipUrl(runId)}
                title="Download ZIP"
              >
                <span aria-hidden="true">⤓</span>
                <span>Download ZIP</span>
              </a>
            )}
            <button
              type="button"
              className="DFM-close"
              onClick={onClose}
              aria-label="Close"
              title="Close · Esc"
            >
              ×
            </button>
          </div>
        </header>

        {tree && (
          <div className="DFM-stats mono">
            <span><b>{totals.rows}</b> rows</span>
            <span className="DFM-stats-sep">·</span>
            <span><b>{totals.impacts}</b> impacts</span>
            <span className="DFM-stats-sep">·</span>
            <span>
              <b className={totals.harmful > 0 ? 'DFM-harmful' : ''}>
                {totals.harmful}
              </b> harmful
            </span>
            <span className="DFM-stats-sep">·</span>
            <span>{totalSize}</span>
          </div>
        )}

        <div className="DFM-body">
          {loading && (
            <div className="DFM-empty mono">{'// loading run…'}</div>
          )}
          {error && !loading && (
            <div className="DFM-empty DFM-empty--err mono">
              ⚠ {error}
            </div>
          )}

          {tree && !loading && (
            <>
              {tree.top_files?.length > 0 && (
                <section className="DFM-section">
                  <header className="DFM-section-head">
                    <span className="eyebrow">Top-level</span>
                    <span className="DFM-section-count mono">
                      {tree.top_files.length}
                    </span>
                  </header>
                  <ul className="DFM-filelist">
                    {tree.top_files.map((f) => (
                      <FileRow key={f.path} file={f} runId={runId} />
                    ))}
                  </ul>
                </section>
              )}

              {tree.rows?.length > 0 && (
                <section className="DFM-section">
                  <header className="DFM-section-head">
                    <span className="eyebrow">Failure points</span>
                    <span className="DFM-section-count mono">
                      {tree.rows.length}
                    </span>
                    <div className="DFM-section-actions">
                      <button
                        type="button"
                        className="DFM-actionBtn"
                        onClick={() =>
                          setOpenRows(new Set(tree.rows.map((r) => r.row)))
                        }
                      >
                        Expand all
                      </button>
                      <button
                        type="button"
                        className="DFM-actionBtn"
                        onClick={() => setOpenRows(new Set())}
                      >
                        Collapse all
                      </button>
                    </div>
                  </header>
                  <ul className="DFM-rowlist">
                    {tree.rows.map((row) => (
                      <RowEntry
                        key={row.row}
                        row={row}
                        runId={runId}
                        isOpen={openRows.has(row.row)}
                        onToggle={() => toggleRow(row.row)}
                      />
                    ))}
                  </ul>
                </section>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/* ─── Row accordion ───────────────────────────────────────────── */

function RowEntry({ row, runId, isOpen, onToggle }) {
  const m = row.meta || {};
  return (
    <li className={`DFM-row${isOpen ? ' DFM-row--open' : ''}`}>
      <button
        type="button"
        className="DFM-row-head"
        onClick={onToggle}
        aria-expanded={isOpen}
      >
        <span className="DFM-row-chevron" aria-hidden="true">▸</span>
        <span className="DFM-row-name mono">{row.name}</span>
        <span className="DFM-row-meta mono">
          {m.time_s != null && (
            <span>t = <b>{formatNumber(m.time_s)}</b> s</span>
          )}
          {m.altitude_m != null && (
            <>
              <span className="DFM-row-sep">·</span>
              <span>alt <b>{formatAltitude(m.altitude_m)}</b></span>
            </>
          )}
          {m.impacts != null && (
            <>
              <span className="DFM-row-sep">·</span>
              <span><b>{m.impacts}</b> imp</span>
            </>
          )}
          {m.harmful_count != null && (
            <>
              <span className="DFM-row-sep">·</span>
              <span className={m.harmful_count > 0 ? 'DFM-harmful' : ''}>
                <b>{m.harmful_count}</b> harm
              </span>
            </>
          )}
        </span>
      </button>
      {isOpen && (
        <ul className="DFM-filelist DFM-filelist--nested">
          {row.files.map((f) => (
            <FileRow key={f.path} file={f} runId={runId} />
          ))}
        </ul>
      )}
    </li>
  );
}

/* ─── Single file row ─────────────────────────────────────────── */

function FileRow({ file, runId }) {
  const ext = (file.ext || '').toLowerCase();
  const isHtml = ext === 'html' || ext === 'htm';
  const url = runId ? debrisFileUrl(runId, file.path) : '#';

  return (
    <li className="DFM-file">
      <span className={`DFM-file-tag DFM-file-tag--${ext || 'misc'}`}>
        {extLabel(ext)}
      </span>
      <span className="DFM-file-name mono" title={file.path}>
        {file.name}
      </span>
      <span className="DFM-file-size mono">{formatBytes(file.size)}</span>
      <a
        className="DFM-file-action"
        href={url}
        target={isHtml ? '_blank' : undefined}
        rel={isHtml ? 'noopener noreferrer' : undefined}
        // For non-HTML the backend already sets Content-Disposition:
        // attachment, so the browser will save it. The `download` attr
        // belt-and-suspenders the same intent in case Safari doesn't.
        download={isHtml ? undefined : file.name}
        title={isHtml ? 'Open in new tab' : 'Download'}
      >
        {isHtml ? 'Open ↗' : 'Download ↓'}
      </a>
    </li>
  );
}

/* ─── Helpers ─────────────────────────────────────────────────── */

function extLabel(ext) {
  if (!ext) return 'FILE';
  if (ext.length <= 4) return ext.toUpperCase();
  return ext.slice(0, 4).toUpperCase();
}

function formatBytes(n) {
  if (n == null || !Number.isFinite(n)) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatNumber(v) {
  if (v == null || !Number.isFinite(v)) return '—';
  if (Math.abs(v) >= 100) return v.toFixed(0);
  if (Math.abs(v) >= 1)   return v.toFixed(1);
  return v.toFixed(3);
}

function formatAltitude(m) {
  if (m == null || !Number.isFinite(m)) return '—';
  if (Math.abs(m) >= 1000) return `${(m / 1000).toFixed(1)} km`;
  return `${m.toFixed(0)} m`;
}

function formatTimestamp(s) {
  if (!s) return '—';
  try {
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) return s;
    return d.toLocaleString(undefined, {
      year: 'numeric', month: 'short', day: '2-digit',
      hour: '2-digit', minute: '2-digit',
    });
  } catch {
    return s;
  }
}

export default DebrisFilesModal;
