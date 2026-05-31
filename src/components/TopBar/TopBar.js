import React from 'react';
import './TopBar.css';

/**
 * Mirror of gui.widgets.build_top_bar:
 *   - back button (default left, can be moved to the right)
 *   - optional page title (centered, omit to skip)
 *   - optional inline content right of the Back button (`leftExtras`)
 *   - optional right-slot widgets (`right`)
 *
 * `leftExtras` is meant for inline navigation tabs, e.g. the plot
 * page's plot/debris/excel/kml jump tabs.
 */
function TopBar({
  title,
  onBack,
  right,
  leftExtras,
  backLabel = 'Back',
  backPosition = 'left',
}) {
  const backButton = (
    <button
      type="button"
      className={`TopBar-back TopBar-back--${backPosition}`}
      onClick={onBack}
      aria-label={backLabel}
    >
      {backPosition === 'left' && (
        <span className="TopBar-back-arrow" aria-hidden="true">←</span>
      )}
      <span className="TopBar-back-label">{backLabel}</span>
      {backPosition === 'right' && (
        <span className="TopBar-back-arrow TopBar-back-arrow--right" aria-hidden="true">→</span>
      )}
    </button>
  );

  return (
    <header className="TopBar">
      <div className="TopBar-left">
        {backPosition === 'left' && backButton}
        {leftExtras}
      </div>

      {title ? <h1 className="TopBar-title">{title}</h1> : <span className="TopBar-title-spacer" aria-hidden="true" />}

      <div className="TopBar-right">
        {right}
        {backPosition === 'right' && backButton}
      </div>
    </header>
  );
}

export default TopBar;
