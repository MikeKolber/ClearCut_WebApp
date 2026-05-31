import React from 'react';

/* ═══ Result-card preview SVGs ════════════════════════════════════
 *   Tiny accent-colored sketches used both as headers in the
 *   simulation-complete cards (`Trajectory.js > ResultsBlock`) and
 *   inside the hover tooltips on the plot page's tab strip.
 *
 *   All four share the same idiom: 160 × 36 viewBox, accent color,
 *   faint vertical gradient backdrop, sharp 1.4-px detail. The
 *   gradient `id`s are namespaced (TR-prev-*) so they keep working
 *   in either context — gradients are page-global in SVG.
 * ──────────────────────────────────────────────────────────────── */

export function TrajectoryPreview() {
  // Vertical-launch parabola sketch — a single arc curving up and over
  // to suggest a powered-flight trajectory. A small dot at apogee
  // doubles as the "rocket"/"satellite" reference.
  const arc = 'M 6,32 Q 28,30 56,16 Q 92,2 154,4';
  return (
    <svg
      className="TR-card-preview"
      width="100%"
      height="36"
      viewBox="0 0 160 36"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="TR-prev-traj" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stopColor="var(--accent)" stopOpacity="0.30" />
          <stop offset="100%" stopColor="var(--accent)" stopOpacity="0"    />
        </linearGradient>
      </defs>
      {/* Faint groundline */}
      <line x1="0" y1="33" x2="160" y2="33"
            stroke="rgba(255, 255, 255, 0.12)" strokeWidth="0.6" />
      {/* Filled wedge under the arc (gives it weight) */}
      <path d={`${arc} L 154,36 L 6,36 Z`} fill="url(#TR-prev-traj)" />
      {/* Arc */}
      <path d={arc} fill="none" stroke="var(--accent)"
            strokeWidth="1.4" strokeLinecap="round" />
      {/* Launch tick + apogee dot */}
      <circle cx="6"   cy="32" r="1.8" fill="var(--accent)" />
      <circle cx="154" cy="4"  r="2.2" fill="var(--accent-bright)" />
    </svg>
  );
}

export function PlotPreview() {
  const fill   = 'M 0,32 C 30,30 50,23 75,14 C 100,6 125,3 160,2 L 160,36 L 0,36 Z';
  const stroke = 'M 0,32 C 30,30 50,23 75,14 C 100,6 125,3 160,2';
  return (
    <svg
      className="TR-card-preview TR-card-preview--plot"
      width="100%"
      height="36"
      viewBox="0 0 160 36"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="TR-prev-plot" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stopColor="var(--accent)" stopOpacity="0.35" />
          <stop offset="100%" stopColor="var(--accent)" stopOpacity="0"    />
        </linearGradient>
      </defs>
      <path d={fill}   fill="url(#TR-prev-plot)" />
      <path
        className="TR-card-preview-stroke"
        d={stroke}
        fill="none"
        stroke="var(--accent)"
        strokeWidth="1.4"
      />
    </svg>
  );
}

export function DebrisPreview() {
  const dots = [
    [10, 24, 1.0, 0.30], [22, 16, 1.2, 0.45], [30, 28, 1.0, 0.35],
    [38, 12, 1.4, 0.55], [48, 24, 1.2, 0.45], [56, 18, 1.4, 0.60],
    [66, 26, 1.6, 0.70], [74, 14, 1.2, 0.50], [80, 22, 2.0, 0.90],
    [88, 16, 1.4, 0.60], [94, 28, 1.6, 0.70], [102, 18, 1.4, 0.60],
    [110, 24, 1.8, 0.80], [118, 14, 1.4, 0.55], [124, 22, 2.0, 0.95],
    [132, 28, 1.2, 0.50], [142, 18, 1.4, 0.60], [150, 24, 1.2, 0.45],
  ];
  return (
    <svg
      className="TR-card-preview"
      width="100%"
      height="36"
      viewBox="0 0 160 36"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <defs>
        <radialGradient id="TR-prev-debris" cx="58%" cy="55%" r="55%">
          <stop offset="0%"   stopColor="var(--accent)" stopOpacity="0.20" />
          <stop offset="100%" stopColor="var(--accent)" stopOpacity="0"    />
        </radialGradient>
      </defs>
      <rect x="0" y="0" width="160" height="36" fill="url(#TR-prev-debris)" />
      {dots.map(([x, y, r, op], i) => (
        <circle
          key={i}
          className="TR-card-preview-debris-dot"
          style={{ animationDelay: `${(i * 40) % 600}ms` }}
          cx={x} cy={y} r={r}
          fill="var(--accent)"
          opacity={op}
        />
      ))}
    </svg>
  );
}

export function ExcelPreview() {
  const rows = 3;
  const cols = 5;
  const cellW = 30;
  const cellH = 9;
  const startX = 5;
  const startY = 4;
  const values = [
    [0.65, 0.40, 0.85, 0.30, 0.70],
    [0.50, 0.75, 0.45, 0.92, 0.55],
    [0.40, 0.55, 0.60, 0.35, 0.80],
  ];
  const highlights = new Set(['1-3', '2-4']);
  const cells = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      cells.push({
        x: startX + c * cellW,
        y: startY + r * cellH,
        w: cellW,
        h: cellH,
        highlight: highlights.has(`${r}-${c}`),
        value: values[r][c],
      });
    }
  }
  return (
    <svg
      className="TR-card-preview"
      width="100%"
      height="36"
      viewBox="0 0 160 36"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="TR-prev-excel" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stopColor="var(--accent)" stopOpacity="0.10" />
          <stop offset="100%" stopColor="var(--accent)" stopOpacity="0"    />
        </linearGradient>
      </defs>
      <rect x="0" y="0" width="160" height="36" fill="url(#TR-prev-excel)" />
      {cells.map((cell, i) => {
        // Per-row delay so the "data streams in" animation cascades
        // top-to-bottom rather than firing all rows in unison.
        const row = Math.floor(i / cols);
        const col = i - row * cols;
        return (
          <g
            key={i}
            className="TR-card-preview-excel-cell"
            style={{ animationDelay: `${row * 90 + col * 30}ms` }}
          >
            <rect
              x={cell.x}
              y={cell.y}
              width={cell.w}
              height={cell.h}
              fill={cell.highlight ? 'var(--accent-soft)' : 'transparent'}
              stroke={cell.highlight ? 'var(--accent)' : 'rgba(255,255,255,0.10)'}
              strokeWidth="0.6"
            />
            <rect
              x={cell.x + 3}
              y={cell.y + (cell.h - 2) / 2}
              width={(cell.w - 6) * cell.value}
              height="2"
              fill={cell.highlight ? 'var(--accent)' : 'rgba(255, 255, 255, 0.22)'}
              rx="0.5"
            />
          </g>
        );
      })}
    </svg>
  );
}

export function DebrisFolderPreview() {
  // Sleek file-listing idiom — four rows of varying-width filename bars
  // with size-column dashes on the right, one row accent-highlighted as
  // the "selected file". No literal folder shape; reads cleanly as
  // "directory listing" rather than a cartoon folder icon.
  const rows = [
    { y:  9, fname: 102, size: 14, accent: false },
    { y: 16, fname: 130, size: 16, accent: true  },
    { y: 23, fname:  82, size: 12, accent: false },
    { y: 30, fname: 112, size: 18, accent: false },
  ];
  const sizeRight = 148;
  return (
    <svg
      className="TR-card-preview"
      width="100%"
      height="36"
      viewBox="0 0 160 36"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="TR-prev-debris-folder" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stopColor="var(--accent)" stopOpacity="0.10" />
          <stop offset="100%" stopColor="var(--accent)" stopOpacity="0"    />
        </linearGradient>
      </defs>
      <rect x="0" y="0" width="160" height="36" fill="url(#TR-prev-debris-folder)" />

      {rows.map((r, i) => (
        <g key={i}>
          {/* Filename bar */}
          <rect
            x="10"
            y={r.y - 1.25}
            width={r.fname}
            height="2.5"
            rx="0.6"
            fill={r.accent ? 'var(--accent)' : 'rgba(255, 255, 255, 0.30)'}
            opacity={r.accent ? 0.95 : 0.55}
          />
          {/* Size column on the right */}
          <rect
            x={sizeRight - r.size}
            y={r.y - 1.25}
            width={r.size}
            height="2.5"
            rx="0.6"
            fill={r.accent ? 'var(--accent)' : 'rgba(255, 255, 255, 0.18)'}
            opacity={r.accent ? 0.65 : 0.55}
          />
        </g>
      ))}
    </svg>
  );
}

export function KmlPreview() {
  return (
    <svg
      className="TR-card-preview"
      width="100%"
      height="36"
      viewBox="0 0 160 36"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="TR-prev-kml" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stopColor="var(--accent)" stopOpacity="0.22" />
          <stop offset="100%" stopColor="var(--accent)" stopOpacity="0"    />
        </linearGradient>
      </defs>
      <path d="M 14,30 Q 80,4 146,28 L 146,30 L 14,30 Z" fill="url(#TR-prev-kml)" />
      <path
        d="M 0,30 Q 80,22 160,30"
        fill="none"
        stroke="rgba(255, 255, 255, 0.22)"
        strokeWidth="0.9"
      />
      <circle cx="40"  cy="26.4" r="0.8" fill="rgba(255,255,255,0.30)" />
      <circle cx="120" cy="26.4" r="0.8" fill="rgba(255,255,255,0.30)" />
      <path
        className="TR-card-preview-kml-arc"
        d="M 14,30 Q 80,4 146,28"
        fill="none"
        stroke="var(--accent)"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
      <circle cx="80" cy="13" r="4"   fill="none" stroke="var(--accent)" strokeWidth="0.6" opacity="0.4" />
      <circle cx="80" cy="13" r="2.2" fill="var(--accent-bright)" />
      <circle cx="14"  cy="30" r="1.6" fill="var(--accent)" opacity="0.85" />
      <circle cx="146" cy="28" r="1.6" fill="var(--accent)" opacity="0.85" />
    </svg>
  );
}
