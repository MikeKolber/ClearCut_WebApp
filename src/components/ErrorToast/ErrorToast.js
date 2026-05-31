import React, { useEffect, useState } from 'react';
import './ErrorToast.css';

/**
 * Top-screen error toast — used across the app whenever the user tries
 * to do something they can't yet do (validation errors, missing data,
 * backend failures, save conflicts, …).
 *
 *   Visual hallmarks: trembling rocket on a launch pad with a
 *   flickering flame and rising smoke puffs — same idea everywhere
 *   we surface an error so the UI's "you can't launch right now"
 *   metaphor stays consistent.
 *
 *   Behaviour:
 *     - Drops in from above (slide-in + scale + fade, ~360 ms).
 *     - × button slides it back up (animation lasts `TOAST_OUT_MS`,
 *       then `onDismiss` is called so React unmounts the component).
 *     - For validation errors with 2+ items, a "Show all" toggle
 *       expands an inline list of each missing field.
 *     - An optional CTA action button can sit beside the × — useful
 *       for empty-state cases ("Go to Trajectory" / "Run a Sim").
 *
 *   Props
 *     error    — accepts either a string or
 *                `{ kind, title, details, action? }` where:
 *                  kind:     'validation' | 'runtime' | 'success'
 *                  title:    headline string
 *                  details:  string[] — single message for runtime,
 *                            per-field list for validation
 *                  action:   optional `{ label, onClick }` CTA button
 *     onDismiss — called after the slide-out animation finishes.
 *     accent    — 'trajectory' (rose) | 'debris' (amber) | 'success'
 *                 (cyan-green). Drives the border + shadow + bullet
 *                 tint. Default 'trajectory'. For `kind: 'success'`
 *                 we override accent to 'success' automatically.
 *     autoDismissMs — optional auto-dismiss delay. Default null
 *                 (no auto-dismiss). Set ~3000 for success toasts.
 */

export const TOAST_OUT_MS = 240;

function ErrorToast({ error, onDismiss, accent = 'trajectory', autoDismissMs = null }) {
  const [expanded, setExpanded] = useState(false);
  const [leaving,  setLeaving]  = useState(false);

  // Reset both states whenever a new error object arrives, so the
  // toast renders fresh rather than inheriting the previous error's
  // expanded / leaving flags.
  useEffect(() => {
    setLeaving(false);
    setExpanded(false);
  }, [error]);

  // Schedule the unmount after the CSS exit animation finishes.
  // Cleanup cancels the timer if `leaving` toggles back to false
  // mid-flight (e.g. a brand-new error arrived during the animate
  // out), so the replacement toast survives.
  useEffect(() => {
    if (!leaving) return undefined;
    const t = setTimeout(onDismiss, TOAST_OUT_MS);
    return () => clearTimeout(t);
  }, [leaving, onDismiss]);

  // Optional auto-dismiss timer (used by success toasts so users
  // don't have to manually close every confirmation). Resets every
  // time a fresh `error` arrives, and is cleared on unmount.
  useEffect(() => {
    if (!autoDismissMs || leaving) return undefined;
    const t = setTimeout(() => setLeaving(true), autoDismissMs);
    return () => clearTimeout(t);
  }, [autoDismissMs, leaving, error]);

  const handleClose = () => {
    if (!leaving) setLeaving(true);
  };

  // Defensive normalisation — older call sites still pass a flat
  // string occasionally. Convert to the structured shape so render
  // logic only has one path.
  const norm = typeof error === 'string'
    ? { kind: 'runtime', title: 'Error', details: [error] }
    : (error || { title: 'Error', details: [] });
  const details = Array.isArray(norm.details) ? norm.details : [];
  const count = details.length;
  const isValidation = norm.kind === 'validation';
  const isSuccess    = norm.kind === 'success';
  // `kind: 'success'` always overrides the caller's accent — a green
  // checkmark with a debris-amber border would be visually confusing.
  const effectiveAccent = isSuccess ? 'success' : accent;
  const action = norm.action || null;

  const handleAction = () => {
    // Slide out first so the user sees the dismiss animation, then
    // fire the action callback. If they navigate, by the time the
    // new page is mounting the toast is already gone.
    if (leaving) return;
    setLeaving(true);
    setTimeout(() => {
      try { action?.onClick?.(); } catch { /* user-supplied — swallow */ }
      onDismiss();
    }, TOAST_OUT_MS);
  };

  return (
    <div
      className={
        `error-toast error-toast--${effectiveAccent}` +
        (leaving ? ' error-toast--leaving' : '')
      }
      role={isSuccess ? 'status' : 'alert'}
    >
      <div className="error-toast-head">
        {isSuccess ? <SuccessTick /> : <StuckRocket />}
        <div className="error-toast-body">
          <span className="error-toast-title">{norm.title}</span>
          {isValidation && count > 1 ? (
            <span className="error-toast-summary mono">
              {count} fields need a value before launch
            </span>
          ) : details.length >= 1 ? (
            <span className="error-toast-summary mono">{details[0]}</span>
          ) : null}
        </div>
        <button
          type="button"
          className="error-toast-x"
          onClick={handleClose}
          aria-label="Dismiss"
          title="Dismiss"
        >
          ×
        </button>
      </div>

      {(action || (isValidation && count > 1)) && (
        <div className="error-toast-foot">
          {isValidation && count > 1 && (
            <button
              type="button"
              className={`error-toast-toggle mono${expanded ? ' error-toast-toggle--open' : ''}`}
              onClick={() => setExpanded((x) => !x)}
              aria-expanded={expanded}
            >
              <span className="error-toast-toggle-chev" aria-hidden="true">▸</span>
              {expanded ? 'Hide list' : `Show all (${count})`}
            </button>
          )}
          {action && (
            <button
              type="button"
              className={`error-toast-action error-toast-action--${effectiveAccent}`}
              onClick={handleAction}
            >
              {action.label}
              <span className="error-toast-action-arrow" aria-hidden="true">→</span>
            </button>
          )}
        </div>
      )}

      {isValidation && count > 1 && expanded && (
        <ul className="error-toast-list mono">
          {details.map((d, i) => (
            <li key={i} className="error-toast-item">
              <span className="error-toast-bullet" aria-hidden="true">•</span>
              <span>{d}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Tiny inline SVG rocket on a launch pad — trembling, flame flickering,
 * smoke puffs drifting up. The "stuck on the pad" visual cue we use
 * anywhere an action can't proceed yet.
 *
 * Exported because EmptyState reuses the same drawing so the inline
 * empty-state cards (Plot / Map / Raw) share the toast's visual
 * language without rebuilding the SVG.
 */
export function StuckRocket() {
  return (
    <svg
      className="error-toast-rocket"
      viewBox="0 0 32 44"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="ErrTo-rocket-grad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"  stopColor="rgba(255,255,255,0.95)" />
          <stop offset="100%" stopColor="rgba(255,255,255,0.6)" />
        </linearGradient>
        <linearGradient id="ErrTo-flame-grad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"  stopColor="#ffe082" />
          <stop offset="55%" stopColor="#f59e0b" />
          <stop offset="100%" stopColor="rgba(245, 158, 11, 0)" />
        </linearGradient>
      </defs>

      <g className="error-toast-rocket-body">
        {/* nose cone */}
        <path d="M16 3 L21 12 L11 12 Z" fill="url(#ErrTo-rocket-grad)" />
        {/* main body */}
        <rect x="11" y="12" width="10" height="14" rx="1.2"
              fill="url(#ErrTo-rocket-grad)" />
        {/* porthole */}
        <circle cx="16" cy="17" r="1.6" fill="rgba(0,0,0,0.45)" />
        <circle cx="16" cy="17" r="1.6" fill="none"
                stroke="rgba(255,255,255,0.6)" strokeWidth="0.5" />
        {/* fins */}
        <path d="M11 21 L7 28 L11 26 Z"
              fill="rgba(255,255,255,0.85)" />
        <path d="M21 21 L25 28 L21 26 Z"
              fill="rgba(255,255,255,0.85)" />
        {/* engine nozzle */}
        <path d="M12 26 L11.5 30 L20.5 30 L20 26 Z"
              fill="rgba(255,255,255,0.7)"
              stroke="rgba(0,0,0,0.35)" strokeWidth="0.4" />
      </g>

      <g className="error-toast-rocket-flame">
        <path d="M12 30 L16 39 L20 30 Z" fill="url(#ErrTo-flame-grad)" />
        <path d="M14 30 L16 36 L18 30 Z" fill="#ffe082" opacity="0.85" />
      </g>

      <circle className="error-toast-rocket-smoke" cx="9" cy="34" r="1.4"
              fill="rgba(255,255,255,0.25)" />
      <circle className="error-toast-rocket-smoke error-toast-rocket-smoke--late"
              cx="23" cy="34" r="1.4" fill="rgba(255,255,255,0.25)" />

      <line x1="2" y1="42" x2="30" y2="42"
            stroke="rgba(255,255,255,0.18)" strokeWidth="1" strokeLinecap="round" />
    </svg>
  );
}

/**
 * Counterpart to `StuckRocket` for success toasts — a simple animated
 * checkmark inside a soft ring. We draw the tick using stroke-dashoffset
 * so it appears to "write itself in" once the toast lands, then settles.
 * Same 42×58 box as the rocket so the toast layout stays consistent.
 */
function SuccessTick() {
  return (
    <svg
      className="error-toast-tick"
      viewBox="0 0 44 44"
      aria-hidden="true"
    >
      {/* Soft ring */}
      <circle
        cx="22" cy="22" r="18"
        fill="none"
        stroke="rgba(74, 222, 128, 0.45)"
        strokeWidth="1.5"
        className="error-toast-tick-ring"
      />
      {/* Inner glow */}
      <circle cx="22" cy="22" r="14" fill="rgba(74, 222, 128, 0.10)" />
      {/* Check */}
      <path
        d="M 13 22 L 20 29 L 32 16"
        fill="none"
        stroke="#4ade80"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="error-toast-tick-path"
      />
    </svg>
  );
}

export default ErrorToast;
