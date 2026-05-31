import React, { useEffect } from 'react';
import './ShortcutsOverlay.css';

/**
 * Global keyboard-shortcuts overlay — opened with `?` (Shift+/) from
 * anywhere in the app. Close with `Esc` or by clicking outside the
 * card. Lists the application-wide shortcuts the user can use.
 *
 * Page-local shortcuts (within Run Simulation, etc.) live alongside
 * the buttons that trigger them and aren't repeated here.
 */
function ShortcutsOverlay({ onClose }) {
  // Ensure Esc closes even when the overlay isn't focused.
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="SO-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="so-title"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="SO-card">
        <header className="SO-head">
          <span className="eyebrow">Keyboard Shortcuts</span>
          <h2 id="so-title" className="SO-title">Move faster</h2>
          <button
            type="button"
            className="SO-close"
            onClick={onClose}
            aria-label="Close shortcuts"
            title="Close (Esc)"
          >
            ×
          </button>
        </header>

        <div className="SO-grid">
          <Group title="Navigation">
            <Shortcut keys={['1']}    label="Open Trajectory Simulation"   note="from landing page" />
            <Shortcut keys={['2']}    label="Open PBS"                     note="from landing page" />
            <Shortcut keys={['3']}    label="Open Engine Test"             note="from landing page" />
            <Shortcut keys={['Esc']}  label="Return to landing"            note="from any page" />
          </Group>

          <Group title="Anywhere">
            <Shortcut keys={['?']}    label="Open this shortcuts overlay" />
            <Shortcut keys={['Esc']}  label="Close any open modal / overlay" />
          </Group>
        </div>

        <footer className="SO-foot mono">
          Tip · Most shortcuts are disabled while typing into a form field.
        </footer>
      </div>
    </div>
  );
}

function Group({ title, children }) {
  return (
    <div className="SO-group">
      <h3 className="SO-group-title">{title}</h3>
      <div className="SO-rows">{children}</div>
    </div>
  );
}

function Shortcut({ keys, label, note }) {
  return (
    <div className="SO-row">
      <div className="SO-keys">
        {keys.map((k, i) => (
          <React.Fragment key={i}>
            {i > 0 && <span className="SO-key-sep" aria-hidden="true">+</span>}
            <kbd className="SO-key mono">{k}</kbd>
          </React.Fragment>
        ))}
      </div>
      <div className="SO-row-text">
        <span className="SO-row-label">{label}</span>
        {note && <span className="SO-row-note mono">{note}</span>}
      </div>
    </div>
  );
}

export default ShortcutsOverlay;
