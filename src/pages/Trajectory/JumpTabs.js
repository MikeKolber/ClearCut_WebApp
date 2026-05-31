import React, { useEffect, useRef, useState } from 'react';
import {
  TrajectoryPreview,
  PlotPreview,
  ExcelPreview,
  KmlPreview,
} from './previews';
import { currentSimName } from './runState';
import './JumpTabs.css';

/* ═══ Shared jump-tabs definition ═════════════════════════════════
 *   The four post-run result views — Plot Data, Debris Analysis,
 *   Open Excel, Google Earth — that live at the top of every page
 *   inside the trajectory simulation section. Each tab carries the
 *   same metadata as its sibling card on the simulation-complete
 *   results block (`Trajectory.js > ResultsBlock`) so the hover
 *   tooltip renders an exact mini-version of that card.            */

/**
 * Build the tabs array. Caller supplies the click handlers — usually
 * `navigate` from React Router for routing.
 *
 *   getJumpTabs({
 *     navigate,                      // useNavigate()
 *     onTrajectoryClick: () => …,    // optional
 *     onPlotClick: () => …,          // optional
 *     onMapClick: () => …,           // optional
 *     onRawClick: () => …,           // optional
 *   })
 *
 * The Debris flow lives on the result cards inside the trajectory page
 * (via the run-then-results stack), not in this tab strip — clicking
 * "Run Simulation" gets the user back to that view. The Map View tab
 * is one unified geo viewer that shows trajectory + debris together.
 */
export function getJumpTabs({
  navigate,
  onTrajectoryClick,
  onPlotClick,
  onMapClick,
  onRawClick,
} = {}) {
  return [
    {
      key:      'trajectory',
      glyph:    '▶',
      label:    'Run Simulation',
      subtitle: 'Setup & launch',
      title:    'Trajectory simulation setup & run',
      Preview:  TrajectoryPreview,
      onClick:  onTrajectoryClick || (() => navigate && navigate('/trajectory')),
    },
    {
      key:      'plot',
      glyph:    '∿',
      label:    'Plot Data',
      subtitle: 'Interactive charts',
      title:    'Open interactive plots',
      Preview:  PlotPreview,
      onClick:  onPlotClick || (() => navigate && navigate('/trajectory/plot')),
    },
    {
      key:      'map',
      glyph:    '◉',
      label:    'Map View',
      subtitle: 'Globe + impacts',
      title:    'Trajectory ground track + debris dispersion',
      Preview:  KmlPreview,
      onClick:  onMapClick || (() => navigate && navigate('/trajectory/map')),
    },
    {
      key:      'raw',
      glyph:    '☷',
      label:    'Raw Data',
      subtitle: 'Spreadsheet · CSV/XLSX',
      title:    'Browse the full simulation output as a table',
      Preview:  ExcelPreview,
      onClick:  onRawClick || (() => navigate && navigate('/trajectory/raw')),
    },
  ];
}

/**
 * Material/Chrome-style sliding-underline tab strip. Inline nav tabs
 * meant for the TopBar's `leftExtras` slot.
 *
 *   <TopBar leftExtras={<JumpTabs tabs={…} activeKey="plot" />} />
 *
 * The underline is positioned in JS via refs + ResizeObserver so it
 * tracks responsive label-collapse breakpoints, font loads, and
 * window resize. Pass `activeKey={null}` (or any string that doesn't
 * match a tab) to hide the underline — useful on parent pages where
 * none of the tabs is "the current view".
 */
export function JumpTabs({ tabs, activeKey }) {
  const containerRef = useRef(null);
  const [indicator, setIndicator] = useState({ left: 0, width: 0, ready: false });

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;

    const measure = () => {
      const active = container.querySelector(`[data-tab-key="${activeKey}"]`);
      if (!active) {
        setIndicator((s) => ({ ...s, ready: false }));
        return;
      }
      const cb = container.getBoundingClientRect();
      const ab = active.getBoundingClientRect();
      setIndicator({
        left: ab.left - cb.left,
        width: ab.width,
        ready: true,
      });
    };

    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(container);
    window.addEventListener('resize', measure);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [activeKey, tabs.length]);

  return (
    <nav
      ref={containerRef}
      className="TP-jump-row"
      role="tablist"
      aria-label="Result views"
    >
      {tabs.map(({ key, glyph, label, subtitle, title, Preview, onClick }) => {
        const isActive = key === activeKey;
        return (
          <button
            key={key}
            type="button"
            data-tab-key={key}
            className={`TP-jump-tab${isActive ? ' TP-jump-tab--active' : ''}`}
            onClick={onClick}
            title={title}
            role="tab"
            aria-selected={isActive}
            aria-current={isActive ? 'page' : undefined}
          >
            <span className="TP-jump-tab-glyph" aria-hidden="true">{glyph}</span>
            <span className="TP-jump-tab-label">{label}</span>

            {/* Hover tooltip — mirrors the result card from the
                simulation-complete page (preview sketch + glyph + title
                + subtitle). Only rendered for inactive tabs. */}
            {!isActive && (
              <span className="TP-jump-tooltip" aria-hidden="true">
                <span className="TP-jump-tooltip-card">
                  <span className="TP-jump-tooltip-head">
                    <span className="TP-jump-tooltip-glyph">{glyph}</span>
                    <span className="TP-jump-tooltip-arrow">→</span>
                  </span>
                  {Preview && <Preview />}
                  <span className="TP-jump-tooltip-title">{label}</span>
                  <span className="TP-jump-tooltip-subtitle mono">{subtitle}</span>
                </span>
              </span>
            )}
          </button>
        );
      })}
      <span
        className={`TP-jump-underline${indicator.ready ? ' TP-jump-underline--ready' : ''}`}
        aria-hidden="true"
        style={{
          transform: `translateX(${indicator.left}px)`,
          width: `${indicator.width}px`,
        }}
      />
    </nav>
  );
}

/**
 * Small "● ‹sim name›" pill rendered to the right of the JumpTabs
 * strip on the result pages (Plot / Map / Raw). Tells the user at
 * a glance which simulation they're viewing. The pulsing dot signals
 * that the page is reading current session state; the label gives
 * the name. Silent (renders nothing) when no sim is loaded.
 */
export function LiveSimBadge() {
  const name = currentSimName();
  if (!name) return null;
  return (
    <span className="TP-jump-livebadge" title={`Current simulation · ${name}`}>
      <span className="TP-jump-livebadge-dot" aria-hidden="true" />
      <span className="TP-jump-livebadge-name">{name}</span>
    </span>
  );
}
