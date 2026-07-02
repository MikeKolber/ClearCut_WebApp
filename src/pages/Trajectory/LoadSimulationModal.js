import React, { useEffect, useRef, useState } from 'react';
import {
  compareFilesList,
  loadSavedSimulation,
  deleteSavedSimulation,
} from '../../services/api';
import { TIPS, PATHS } from './paths';
import Tooltip from '../../components/Tooltip/Tooltip';
import ErrorToast from '../../components/ErrorToast/ErrorToast';
import './DebrisFilesModal.css';
import './LoadDebrisModal.css';

/* ═══ Load Simulation Modal ════════════════════════════════════════
 *
 *   Two-mode picker:
 *
 *     1.  "Saved Simulations" — clicking a row server-side copies
 *         that file into the current `output/simulation_output.csv`.
 *         The list comes from `Pre-loaded Trajectories/` — the same
 *         set the Compare page reads — so anything saved via the
 *         Save Simulation button shows up here automatically.
 *
 *     2.  "Browse from disk…" — falls back to the original
 *         <input type="file"> dialog for files that live outside
 *         the app.
 *
 *   ─── Select-to-delete mode ─────────────────────────────────────
 *   A small ⋮ button in the header toggles a "select" mode. In
 *   select mode rows become checkboxes (clicking toggles selection
 *   instead of loading), and a footer reveals Delete / Cancel
 *   buttons. Multi-select supported. Each delete is its own request
 *   so a partial failure (e.g. permissions on one file) doesn't
 *   block the rest.
 *
 *   Reuses the .DFM-* / .LDM-* style sheets from the debris modal
 *   so the two modals feel like part of the same family.
 * ───────────────────────────────────────────────────────────────── */

function LoadSimulationModal({ onClose, onLoaded, onBrowseDisk }) {
  const [files, setFiles] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadingFile, setLoadingFile] = useState(null); // filename mid-fetch
  const [error, setError] = useState(null);
  const inputRef = useRef(null);

  /* ─── select-to-delete state ──────────────────────────────────── */
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState(() => new Set());
  const [deleting, setDeleting] = useState(false);
  // Pretty confirm-style toast in place of `window.confirm`. Holds an
  // `ErrorToast` payload when a delete is pending user approval.
  const [confirmReq, setConfirmReq] = useState(null);

  /* ─── fetch the saved-sim list ─────────────────────────────── */
  const fetchList = async () => {
    try {
      const res = await compareFilesList();
      const list = (res?.files || []).filter((f) => f.kind === 'preloaded');
      setFiles(list);
      return list;
    } catch (e) {
      setError(e.message || String(e));
      return [];
    }
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await compareFilesList();
        if (cancelled) return;
        // Filter to *preloaded* entries only — the synthetic "Current run"
        // entry the Compare endpoint also returns isn't useful here:
        // loading the current run on top of itself is a no-op.
        const list = (res?.files || []).filter((f) => f.kind === 'preloaded');
        setFiles(list);
      } catch (e) {
        if (!cancelled) setError(e.message || String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  /* Esc closes — except when we're in select mode, where Esc first
     drops select mode (matches macOS-style escape-as-cancel). */
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      if (selectMode) {
        setSelectMode(false);
        setSelected(new Set());
        return;
      }
      onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, selectMode]);

  const onPickRow = async (filename) => {
    setLoadingFile(filename);
    setError(null);
    try {
      const res = await loadSavedSimulation(filename);
      onLoaded?.(res);
      onClose();
    } catch (e) {
      setError(e.message || String(e));
      setLoadingFile(null);
    }
  };

  const onClickBrowse = () => {
    /* Trigger the parent's hidden file input — handing off to the
       existing upload flow (`loadSimulationFile`). The parent closes
       this modal once the upload finishes. */
    onBrowseDisk?.();
  };

  /* ─── select-mode helpers ─────────────────────────────────────── */
  const toggleSelect = (filename) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(filename)) next.delete(filename);
      else next.add(filename);
      return next;
    });
  };

  const enterSelectMode = () => {
    setSelectMode(true);
    setSelected(new Set());
    setError(null);
  };

  const exitSelectMode = () => {
    setSelectMode(false);
    setSelected(new Set());
  };

  // Actual delete work — split from the confirm prompt so the toast's
  // action can run it after the user commits.
  const performDelete = async (names) => {
    if (!names || names.length === 0) return;
    setDeleting(true);
    setError(null);
    const failures = [];
    for (const fname of names) {
      try {
        await deleteSavedSimulation(fname);
      } catch (e) {
        failures.push(`${fname}: ${e.message || String(e)}`);
      }
    }
    // Refresh the list whether or not some deletes failed — at least
    // the successful ones should disappear immediately.
    await fetchList();
    setSelected(new Set());
    setSelectMode(false);
    setDeleting(false);
    if (failures.length > 0) {
      setError(
        failures.length === 1
          ? failures[0]
          : `${failures.length} deletions failed:\n${failures.join('\n')}`
      );
    }
  };

  // Trigger the confirm toast — replaces `window.confirm` so the
  // prompt matches the rest of the app's visual language.
  const onDeleteSelected = () => {
    if (selected.size === 0) return;
    const names = [...selected];
    const title = names.length === 1
      ? `Delete “${names[0]}”?`
      : `Delete ${names.length} saved simulations?`;
    setConfirmReq({
      kind: 'confirm',
      title,
      details: ['This cannot be undone.'],
      action: { label: 'Delete', onClick: () => performDelete(names) },
    });
  };

  return (
    <div
      className="DFM-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="lsm-title"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="DFM-modal LDM-modal">
        <header className="DFM-head">
          <div>
            <span className="eyebrow">Simulation</span>
            <h2 id="lsm-title" className="DFM-title">
              {selectMode ? 'Select to delete' : 'Load Simulation'}
            </h2>
            {selectMode && (
              <p className="LSM-select-sub mono">
                {selected.size} of {files?.length ?? 0} selected
              </p>
            )}
          </div>
          <div className="LSM-head-actions">
            {/* ⋮ menu button — toggles select mode. Hidden once
                we're already in select mode (the footer's Cancel
                button takes over). */}
            {!selectMode && files && files.length > 0 && (
              <Tooltip text="Select simulations to delete" placement="bottom">
                <button
                  type="button"
                  className="LSM-menu-btn"
                  onClick={enterSelectMode}
                  aria-label="Select simulations to delete"
                >
                  ⋮
                </button>
              </Tooltip>
            )}
            <button
              type="button"
              className="DFM-close"
              onClick={onClose}
              aria-label="Close"
              title="Close (Esc)"
            >
              ✕
            </button>
          </div>
        </header>

        <div className="DFM-body LDM-body">
          {!selectMode && (
            <p className="LSM-section-eyebrow mono">{'// Saved on this machine'}</p>
          )}

          {loading && (
            <div className="LDM-empty mono">{'// loading saved simulations…'}</div>
          )}

          {error && (
            <div className="LDM-empty LDM-empty--err mono">⚠ {error}</div>
          )}

          {!loading && !error && (!files || files.length === 0) && (
            <div className="LDM-empty mono">
              {'// no saved simulations yet'}
              <p className="LDM-empty-hint">
                Use <strong>Save Simulation</strong> on the results page to
                store the current run, or click <em>Browse from disk</em>
                below to load one from your computer.
              </p>
            </div>
          )}

          {!loading && !error && files && files.length > 0 && (
            <ul className="LDM-list">
              {files.map((f) => {
                const busy = loadingFile === f.filename;
                const isSelected = selected.has(f.filename);
                const tip = selectMode
                  ? null
                  : 'Loads this simulation\n' +
                    `Source: ${PATHS.preloadedDir}${f.filename}`;
                const rowClass =
                  'LDM-row' +
                  (busy ? ' LDM-row--busy' : '') +
                  (selectMode ? ' LDM-row--select' : '') +
                  (isSelected ? ' LDM-row--selected' : '');

                const RowInner = (
                  <button
                    type="button"
                    className={rowClass}
                    onClick={() =>
                      selectMode ? toggleSelect(f.filename) : onPickRow(f.filename)
                    }
                    disabled={!selectMode && loadingFile != null}
                    aria-pressed={selectMode ? isSelected : undefined}
                  >
                    {selectMode && (
                      <span
                        className={`LSM-check${isSelected ? ' LSM-check--on' : ''}`}
                        aria-hidden="true"
                      >
                        {isSelected ? '✓' : ''}
                      </span>
                    )}
                    <span className="LDM-row-name mono">{f.name}</span>
                    <span className="LDM-row-meta mono">
                      {f.filename.split('.').pop()?.toUpperCase() || ''}
                    </span>
                    {!selectMode && (
                      <span className="LDM-row-arrow" aria-hidden>
                        {busy ? '…' : '→'}
                      </span>
                    )}
                  </button>
                );

                return (
                  <li key={f.filename}>
                    {tip ? <Tooltip text={tip}>{RowInner}</Tooltip> : RowInner}
                  </li>
                );
              })}
            </ul>
          )}

          {!selectMode && (
            <>
              <div className="LSM-divider"><span>or</span></div>
              <Tooltip text={TIPS.loadSimulation}>
                <button
                  ref={inputRef}
                  type="button"
                  className="LSM-browse-btn"
                  onClick={onClickBrowse}
                  disabled={loadingFile != null}
                >
                  <span className="LSM-browse-glyph" aria-hidden>↥</span>
                  <span className="LSM-browse-label">
                    <span>Browse from disk…</span>
                    <span className="LSM-browse-sub mono">
                      Pick a CSV / XLSX from your computer
                    </span>
                  </span>
                </button>
              </Tooltip>
            </>
          )}

          {selectMode && (
            <div className="LSM-select-foot">
              <button
                type="button"
                className="LSM-select-cancel"
                onClick={exitSelectMode}
                disabled={deleting}
              >
                Cancel
              </button>
              <button
                type="button"
                className="LSM-select-delete"
                onClick={onDeleteSelected}
                disabled={selected.size === 0 || deleting}
              >
                {deleting
                  ? 'Deleting…'
                  : `Delete${selected.size > 0 ? ` (${selected.size})` : ''}`}
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Pretty confirm toast in place of `window.confirm`. Dismiss
          (× or Cancel) leaves the user back in select-mode with their
          ticks intact; the action fires the actual delete. */}
      {confirmReq && (
        <ErrorToast
          error={confirmReq}
          onDismiss={() => setConfirmReq(null)}
          accent="trajectory"
        />
      )}
    </div>
  );
}

export default LoadSimulationModal;
