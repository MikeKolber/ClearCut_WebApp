import React, { useEffect, useState } from 'react';
import { listDebrisRuns } from '../../services/api';
import { TIPS } from './paths';
import Tooltip from '../../components/Tooltip/Tooltip';
import './DebrisFilesModal.css';
import './LoadDebrisModal.css';

/* ═══ Load Debris Modal ═══════════════════════════════════════════
 *   Web equivalent of the desktop's `_load_debris` action. Lists
 *   every debris run that's ever been computed (read from the
 *   `debris_data/` directory by the backend), and lets the user pick
 *   one to load as the active result for the current session.
 *
 *   On pick: parent sets `debrisDoneInSession` + the per-session
 *   storage flag and bounces to the map view, where MapView reads
 *   the latest run from `listDebrisRuns()` and renders it.
 *
 *   Reuses the .DFM-* styles from DebrisFilesModal for the chrome
 *   (backdrop + container + close button) so the two modals feel
 *   consistent. Adds a small .LDM-* override sheet for the
 *   list-of-runs body since the row layout is different.
 * ───────────────────────────────────────────────────────────────── */

function LoadDebrisModal({ onClose, onSelect }) {
  const [runs, setRuns] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await listDebrisRuns();
        if (cancelled) return;
        setRuns(res?.runs || []);
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

  return (
    <div
      className="DFM-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="ldm-title"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="DFM-modal LDM-modal">
        <header className="DFM-head">
          <div>
            <span className="eyebrow">Debris</span>
            <h2 id="ldm-title" className="DFM-title">Load Existing Debris Run</h2>
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
          {loading && (
            <div className="LDM-empty mono">{'// loading runs…'}</div>
          )}

          {error && (
            <div className="LDM-empty LDM-empty--err mono">⚠ {error}</div>
          )}

          {!loading && !error && (!runs || runs.length === 0) && (
            <div className="LDM-empty mono">
              {'// no debris runs found yet'}
              <p className="LDM-empty-hint">
                Run a debris analysis first — saved runs will appear
                here so you can revisit any of them later.
              </p>
            </div>
          )}

          {!loading && !error && runs && runs.length > 0 && (
            <ul className="LDM-list">
              {runs.map((r) => (
                <li key={r.id}>
                  <Tooltip text={TIPS.loadDebrisRow(r.id)}>
                    <button
                      type="button"
                      className="LDM-row"
                      onClick={() => onSelect(r.id)}
                    >
                      <span className="LDM-row-name mono">{r.id}</span>
                      <span className="LDM-row-meta mono">
                        {formatRunMeta(r)}
                      </span>
                      <span className="LDM-row-arrow" aria-hidden>→</span>
                    </button>
                  </Tooltip>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

function formatRunMeta(r) {
  const parts = [];
  if (r.created_at) parts.push(formatDate(r.created_at));
  if (Number.isFinite(r.row_count)) parts.push(`${r.row_count} rows`);
  if (Number.isFinite(r.harmful_count)) {
    parts.push(`${r.harmful_count} harmful`);
  }
  return parts.join(' · ') || '—';
}

function formatDate(s) {
  try {
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) return s;
    return d.toLocaleString(undefined, {
      month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit',
    });
  } catch {
    return s;
  }
}

export default LoadDebrisModal;
