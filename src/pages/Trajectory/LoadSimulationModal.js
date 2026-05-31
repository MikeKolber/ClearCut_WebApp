import React, { useEffect, useRef, useState } from 'react';
import {
  compareFilesList,
  loadSavedSimulation,
} from '../../services/api';
import { TIPS, PATHS } from './paths';
import Tooltip from '../../components/Tooltip/Tooltip';
import './DebrisFilesModal.css';
import './LoadDebrisModal.css';

/* ═══ Load Simulation Modal ════════════════════════════════════════
 *
 *   Replaces the previous bare file-input with a two-mode picker:
 *
 *     1.  "Saved Simulations" — clicking a row server-side copies
 *         that file into the current `output/simulation_output.csv`.
 *         No OS file dialog, no path-picker friction. The list
 *         comes from `Pre-loaded Trajectories/` — the same set
 *         the Compare page reads — so anything saved via the
 *         Save Simulation button shows up here automatically.
 *
 *     2.  "Browse from disk…" — falls back to the original
 *         <input type="file"> dialog for files that live outside
 *         the app (e.g. an XLSX someone emailed you, or a fresh
 *         download from another machine).
 *
 *   Why both:
 *     The user's request was that load buttons "open the appropriate
 *     file" automatically *only when the path is fixed/known* —
 *     paths on the user's own disk shouldn't be auto-resolved
 *     because they vary between machines and would error out.
 *     Server-side saves are a fixed path, so they're always safe.
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

  /* ─── fetch the saved-sim list ─────────────────────────────── */
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

  /* Esc closes */
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

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
            <h2 id="lsm-title" className="DFM-title">Load Simulation</h2>
          </div>
          <button
            type="button"
            className="DFM-close"
            onClick={onClose}
            aria-label="Close"
            title="Close (Esc)"
          >
            ✕
          </button>
        </header>

        <div className="DFM-body LDM-body">
          <p className="LSM-section-eyebrow mono">// Saved on this machine</p>

          {loading && (
            <div className="LDM-empty mono">// loading saved simulations…</div>
          )}

          {error && (
            <div className="LDM-empty LDM-empty--err mono">⚠ {error}</div>
          )}

          {!loading && !error && (!files || files.length === 0) && (
            <div className="LDM-empty mono">
              // no saved simulations yet
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
                const tip =
                  'Loads this simulation\n' +
                  `Source: ${PATHS.preloadedDir}${f.filename}`;
                return (
                  <li key={f.filename}>
                    <Tooltip text={tip}>
                      <button
                        type="button"
                        className={`LDM-row${busy ? ' LDM-row--busy' : ''}`}
                        onClick={() => onPickRow(f.filename)}
                        disabled={loadingFile != null}
                      >
                        <span className="LDM-row-name mono">{f.name}</span>
                        <span className="LDM-row-meta mono">
                          {f.filename.split('.').pop()?.toUpperCase() || ''}
                        </span>
                        <span className="LDM-row-arrow" aria-hidden>
                          {busy ? '…' : '→'}
                        </span>
                      </button>
                    </Tooltip>
                  </li>
                );
              })}
            </ul>
          )}

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
        </div>
      </div>
    </div>
  );
}

export default LoadSimulationModal;
