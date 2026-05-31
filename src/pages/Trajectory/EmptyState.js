import React from 'react';
import { StuckRocket } from '../../components/ErrorToast/ErrorToast';
import './EmptyState.css';

/**
 * A small, aesthetically polished "no data yet" panel for the
 * trajectory result pages (Plot Data, Map View, Raw Data) when the
 * user hasn't run or loaded a simulation in the current session.
 *
 * Pure content component — drop it inside whichever positioning
 * wrapper each page already uses (TP-chart-empty, MV-empty,
 * RD-empty). Those wrappers stretch / center / clip; this component
 * styles the actual *content* (icon, headline, body, hint).
 *
 * Props
 *   title — bold headline (defaults to "No data loaded").
 *   body  — single-sentence explanation, page-specific.
 *   hint  — optional small subtext shown under the body in dim type.
 *           Omit for a tighter card.
 */
function EmptyState({ title = 'No data loaded', body, hint }) {
  // Empty-state cards always show the same animated launch-pad rocket
  // from the shared `StuckRocket` component — keeps the "you're stuck
  // here, run something first" visual language identical to the
  // top-screen ErrorToast that surfaces transient validation /
  // runtime errors.
  return (
    <div className="TR-empty" role="status" aria-live="polite">
      <div className="TR-empty-card">
        <div className="TR-empty-glyph" aria-hidden="true">
          <StuckRocket />
        </div>
        <h3 className="TR-empty-title">{title}</h3>
        {body && <p className="TR-empty-body">{body}</p>}
        {hint && <p className="TR-empty-hint mono">{hint}</p>}
      </div>
    </div>
  );
}

export default EmptyState;
