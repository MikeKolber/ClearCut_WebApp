import React from 'react';
import './NavButton.css';

/**
 * Module card on the landing page.
 *
 * Layout:
 *   ┌──────────────────────────────────┐
 *   │ MOD-01                       [1] │  ← code  ·  shortcut chip
 *   │ ◎                                │  ← glyph
 *   │ Title                            │
 *   │ Subtitle                         │
 *   │  ╱╲ preview SVG                  │  ← module-specific motif
 *   │ stats · ● Ready              →   │  ← meta + arrow
 *   └──────────────────────────────────┘
 */
function NavButton({
  glyph, code, title, subtitle,
  stats, status, Preview, shortcut, index,
  onClick,
}) {
  return (
    <button
      type="button"
      className="NavButton"
      onClick={onClick}
      style={index !== undefined ? { animationDelay: `${360 + index * 80}ms` } : undefined}
    >
      <div className="NavButton-head">
        {code && <span className="NavButton-code mono">{code}</span>}
        {shortcut !== undefined && (
          <kbd className="NavButton-shortcut mono" aria-hidden="true">{shortcut}</kbd>
        )}
      </div>

      <div className="NavButton-title-row">
        <span className="NavButton-title">{title}</span>
        {glyph && (
          <span className="NavButton-glyph" aria-hidden="true">{glyph}</span>
        )}
      </div>

      {Preview && (
        <div className="NavButton-preview-wrap">
          <Preview />
        </div>
      )}

      <div className="NavButton-foot">
        <div className="NavButton-meta mono">
          {stats && <span className="NavButton-stats">{stats}</span>}
          {stats && status && <span className="NavButton-meta-sep">·</span>}
          {status && (
            <span className="NavButton-status">
              <span className="NavButton-status-dot" />
              {status}
            </span>
          )}
        </div>
        <span className="NavButton-arrow" aria-hidden="true">→</span>
      </div>

      {/* Tooltip — subtitle moved here, revealed on hover */}
      {subtitle && (
        <span className="NavButton-tooltip" role="tooltip">
          {subtitle}
        </span>
      )}
    </button>
  );
}

export default NavButton;
