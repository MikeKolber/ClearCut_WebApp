import React from 'react';
import './Tooltip.css';

/**
 * Generic CSS-only tooltip wrapper.
 *
 * Usage:
 *   <Tooltip text={TIPS.cardPlot}>
 *     <button className="TR-result-card" onClick={...}>...</button>
 *   </Tooltip>
 *
 * Behavior:
 *   - Pure CSS hover/focus animation. No JavaScript listeners, no
 *     positioning math, no portals — the bubble lives inside the
 *     same React tree as the wrapped element.
 *   - Multi-line `text` is split on `\n`. The first line renders in
 *     a slightly larger, weightier "headline" style; subsequent
 *     lines render as monospace path/details text.
 *   - Hover delay: 500 ms (matches the user's requested feel —
 *     much faster than the OS's native ~1500 ms).
 *   - Slight transparency + backdrop blur for the "frosted glass"
 *     look that doesn't fully obscure what's underneath.
 *
 * Why we strip the wrapped element's `title` attribute:
 *   If both our custom tooltip AND the browser's native title
 *   tooltip appeared, the user would see TWO floating boxes on
 *   long hover — once at 0.5 s (ours) and once at ~1.5 s (theirs).
 *   We swap the `title` for an `aria-label` so screen readers and
 *   keyboard users still get the same info, just without the
 *   visual collision.
 */
function Tooltip({ text, placement = 'bottom', maxWidth = 340, children }) {
  if (!text) return children;

  // Split into headline + body paragraphs.
  const lines = text.split('\n');
  const head = lines[0];
  const rest = lines.slice(1);

  // Strip the child's native `title` and back-fill an `aria-label`
  // so the info is still accessible to screen readers / keyboards.
  const child = React.Children.only(children);
  const cloned = React.cloneElement(child, {
    'aria-label': child.props['aria-label'] || text,
    title: undefined,
  });

  return (
    <span className={`TT-anchor TT-anchor--${placement}`}>
      {cloned}
      <span
        className="TT-bubble"
        role="tooltip"
        style={{ maxWidth }}
      >
        <span className="TT-line TT-line--head">{head}</span>
        {rest.map((line, i) => (
          <span key={i} className="TT-line">{line}</span>
        ))}
      </span>
    </span>
  );
}

export default Tooltip;
