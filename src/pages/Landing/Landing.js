import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import NavButton from '../../components/NavButton/NavButton';
import { ping, listEngineTests } from '../../services/api';
import logoUrl from '../../assets/clearcut-logo.png';
import { APP_VERSION } from '../../version';
import './Landing.css';

const BUILD_VERSION = APP_VERSION;

/**
 * Landing — front desk of the ClearCut suite.
 *
 *   • Top header   : version on the left, company logo on the right.
 *   • Center hero  : eyebrow / heading / subheading / status strip / 3 cards.
 *   • Footer       : brand + live build / backend / UTC telemetry.
 *   • Background   : drifting starfield + corner brackets on the hero.
 *
 * Live data:
 *   • UTC clock — re-renders every second.
 *   • Backend ping — measures /api/ping latency every 10 s.
 *   • Engine-test count — fetched once on mount for MOD-03's stat line.
 *
 * Keyboard shortcuts: 1 / 2 / 3 jump to the corresponding module.
 */
function Landing() {
  const navigate = useNavigate();

  /* ── live UTC clock ─────────────────────────────────────── */
  const [utc, setUtc] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setUtc(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  /* ── backend ping (every 10 s) ──────────────────────────── */
  const [pingState, setPingState] = useState({ status: 'checking', latency: null });
  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      const t0 = performance.now();
      try {
        await ping();
        const dt = Math.round(performance.now() - t0);
        if (!cancelled) setPingState({ status: 'online', latency: dt });
      } catch {
        if (!cancelled) setPingState({ status: 'offline', latency: null });
      }
    };
    check();
    const id = setInterval(check, 10000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  /* ── live module stats (engine-test count) ──────────────── */
  const [engineTestsCount, setEngineTestsCount] = useState(null);
  useEffect(() => {
    let cancelled = false;
    listEngineTests()
      .then((data) => {
        if (!cancelled) setEngineTestsCount(data?.tests?.length ?? 0);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const modules = useMemo(
    () => [
      {
        number: 1,
        code: 'MOD-01',
        glyph: '◎',
        title: 'Trajectory Simulation\n& Postprocessing',
        subtitle: '3-DOF flight simulation\nwith full trajectory analysis',
        stats: '4 presets · 3-DOF',
        status: 'Ready',
        Preview: TrajectoryPreview,
        route: '/trajectory',
      },
      {
        number: 2,
        code: 'MOD-02',
        glyph: '☰',
        title: 'Product Breakdown\nStructure',
        subtitle: 'Component hierarchy\nand mass budget overview',
        stats: 'Up to 4 stages',
        status: 'Ready',
        Preview: PbsPreview,
        route: '/pbs',
      },
      {
        number: 3,
        code: 'MOD-03',
        glyph: '»',
        title: 'Engine Test',
        subtitle: 'Test fire analysis\nand performance validation',
        stats:
          engineTestsCount !== null
            ? `${engineTestsCount} test${engineTestsCount === 1 ? '' : 's'} · TDMS`
            : 'TDMS support',
        status: 'Ready',
        Preview: EngineTestPreview,
        route: '/engine-test',
      },
    ],
    [engineTestsCount]
  );

  /* ── 1 / 2 / 3 keyboard shortcuts ───────────────────────── */
  useEffect(() => {
    const onKey = (e) => {
      // Skip when typing into an input
      const t = e.target;
      if (
        t &&
        (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)
      ) {
        return;
      }
      if (e.key === '1') navigate(modules[0].route);
      else if (e.key === '2') navigate(modules[1].route);
      else if (e.key === '3') navigate(modules[2].route);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navigate, modules]);

  return (
    <div className="Landing">
      <Starfield />

      <div className="Landing-topbar">
        <StatusStrip pingState={pingState} utc={utc} />
        <span className="Landing-topbar-version mono">v{BUILD_VERSION}</span>
      </div>

      <div className="Landing-inner">
        <section className="Landing-center">
          <div className="Landing-hero-logo-wrap">
            <img
              src={logoUrl}
              alt="ClearCut Space"
              className="Landing-hero-logo"
            />
            <span className="Landing-hero-logo-line" aria-hidden="true" />
          </div>
          <p className="Landing-subheading">Select a module to begin</p>

          <div className="Landing-nav">
            {modules.map((m, i) => (
              <NavButton
                key={m.code}
                glyph={m.glyph}
                title={m.title}
                subtitle={m.subtitle}
                stats={m.stats}
                status={m.status}
                Preview={m.Preview}
                index={i}
                shortcut={String(i + 1)}
                onClick={() => navigate(m.route)}
              />
            ))}
          </div>
        </section>
      </div>

      <footer className="Landing-footer mono">
        <span className="Landing-footer-brand">
          ClearCut Space · Internal Engineering Suite
        </span>
        <span className="Landing-footer-build">BUILD v{BUILD_VERSION}</span>
      </footer>
    </div>
  );
}

/* ═══ Status strip (telemetry band under subheading) ═══════════ */

function StatusStrip({ pingState, utc }) {
  return (
    <div className="Landing-status-strip mono" role="status">
      <span className="Landing-status-cell">
        <BackendDot status={pingState.status} />
        Backend ·{' '}
        {pingState.status === 'online'
          ? `Online · ${pingState.latency} ms`
          : pingState.status === 'offline'
          ? 'Offline'
          : 'Checking…'}
      </span>
      <span className="Landing-status-sep">|</span>
      <span className="Landing-status-cell">UTC · {formatUtc(utc)}</span>
    </div>
  );
}

function BackendDot({ status }) {
  const cls =
    status === 'online'
      ? 'Landing-dot Landing-dot--online'
      : status === 'offline'
      ? 'Landing-dot Landing-dot--offline'
      : 'Landing-dot Landing-dot--checking';
  return <span className={cls} aria-hidden="true" />;
}

function formatUtc(d) {
  // HH:MM:SS in UTC
  return d.toISOString().slice(11, 19);
}

/* ═══ Drifting starfield ═══════════════════════════════════════ */

function Starfield() {
  // Grid (12 × 7 = 84 cells) with per-cell jitter so stars are evenly
  // distributed across the page — no clumps, no voids — but still feel
  // organic. Sizes are skewed (Math.pow(rand, 4)) so most stars are
  // tiny pinpoints and only a handful read as bright; brightness scales
  // with size; the largest get a soft Gaussian-blur halo so they read
  // as actual stars instead of solid dots ("dirt").
  const stars = useMemo(() => {
    const cols = 22;
    const rows = 13;
    const cellW = 100 / cols;
    const cellH = 100 / rows;
    const out = [];
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const x = col * cellW + cellW * (0.2 + Math.random() * 0.6);
        const y = row * cellH + cellH * (0.2 + Math.random() * 0.6);
        const r = 0.25 + Math.pow(Math.random(), 4) * 1.05;
        const opacity = 0.35 + (r - 0.25) * 0.55;
        const delay = Math.random() * 8;
        const dur = 3.5 + Math.random() * 4.5;
        out.push({ x, y, r, opacity, delay, dur });
      }
    }
    return out;
  }, []);

  return (
    <svg className="Landing-starfield" aria-hidden="true">
      <defs>
        {/* Soft halo for the brighter stars — sharp dot + blurred copy. */}
        <filter
          id="Landing-star-bloom"
          x="-200%"
          y="-200%"
          width="500%"
          height="500%"
        >
          <feGaussianBlur stdDeviation="1.1" result="b" />
          <feMerge>
            <feMergeNode in="b" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
      {stars.map((s, i) => (
        <circle
          key={i}
          cx={`${s.x}%`}
          cy={`${s.y}%`}
          r={s.r}
          fill={`rgba(255, 255, 255, ${s.opacity.toFixed(2)})`}
          filter={s.r > 0.85 ? 'url(#Landing-star-bloom)' : undefined}
          style={{
            animation: `Landing-twinkle ${s.dur}s ease-in-out ${s.delay}s infinite`,
          }}
        />
      ))}
    </svg>
  );
}

/* ═══ Module preview SVGs ══════════════════════════════════════
 *   Same idiom as the trajectory result cards: 160 × 36 viewBox,
 *   accent palette, gradient fill, 1.4-px primary detail. Each one
 *   visually motifs the module it represents.
 * ────────────────────────────────────────────────────────────── */

function TrajectoryPreview() {
  return (
    <svg
      className="NavButton-preview"
      viewBox="0 0 160 36"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="L-prev-traj" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.30" />
          <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d="M 0,30 Q 80,20 160,30" fill="none" stroke="rgba(255,255,255,0.18)" strokeWidth="0.8" />
      <path d="M 8,32 Q 80,2 152,28 L 152,36 L 8,36 Z" fill="url(#L-prev-traj)" />
      <path d="M 8,32 Q 80,2 152,28" fill="none" stroke="var(--accent)" strokeWidth="1.4" strokeLinecap="round" />
      <circle cx="80" cy="11" r="3.4" fill="none" stroke="var(--accent)" strokeWidth="0.6" opacity="0.5" />
      <circle cx="80" cy="11" r="2"   fill="var(--accent-bright)" />
      <circle cx="8"   cy="32" r="1.6" fill="var(--accent)" opacity="0.85" />
      <circle cx="152" cy="28" r="1.6" fill="var(--accent)" opacity="0.85" />
    </svg>
  );
}

function PbsPreview() {
  // Three stacked rocket-stage bars, decreasing widths bottom→top to
  // suggest the mass-budget hierarchy.
  return (
    <svg
      className="NavButton-preview"
      viewBox="0 0 160 36"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="L-prev-pbs" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.10" />
          <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
        </linearGradient>
      </defs>
      <rect x="0" y="0" width="160" height="36" fill="url(#L-prev-pbs)" />

      {/* Stage 3 (smallest, top) */}
      <rect x="56" y="4"  width="48" height="6" fill="rgba(77, 168, 218, 0.10)" stroke="var(--accent)" strokeWidth="0.6" rx="0.5" />
      {/* Stage 2 */}
      <rect x="36" y="14" width="88" height="6" fill="rgba(77, 168, 218, 0.16)" stroke="var(--accent)" strokeWidth="0.6" rx="0.5" />
      {/* Stage 1 (largest, bottom) */}
      <rect x="14" y="24" width="132" height="6" fill="var(--accent-soft)"    stroke="var(--accent-bright)" strokeWidth="0.6" rx="0.5" />

      {/* Connecting tick marks */}
      <line x1="80" y1="10" x2="80" y2="14" stroke="var(--accent)" strokeWidth="0.6" />
      <line x1="80" y1="20" x2="80" y2="24" stroke="var(--accent)" strokeWidth="0.6" />
    </svg>
  );
}

function EngineTestPreview() {
  // Side-view of an engine firing — small bell nozzle on the left,
  // accent-blue flame plume jetting right with a couple of mach-diamond
  // accents along the core.
  return (
    <svg
      className="NavButton-preview"
      viewBox="0 0 160 36"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="L-prev-engine-flame" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%"   stopColor="var(--accent-bright)" stopOpacity="0.85" />
          <stop offset="55%"  stopColor="var(--accent)"        stopOpacity="0.55" />
          <stop offset="100%" stopColor="var(--accent)"        stopOpacity="0"    />
        </linearGradient>
      </defs>

      {/* Bell nozzle: trapezoid flaring right toward the exit */}
      <path
        d="M 6,15 L 13,15 L 19,9 L 19,27 L 13,21 L 6,21 Z"
        fill="rgba(255, 255, 255, 0.10)"
        stroke="rgba(255, 255, 255, 0.45)"
        strokeWidth="0.7"
        strokeLinejoin="round"
      />

      {/* Flame plume — pinched at the throat, billowing to the right */}
      <path
        d="M 19,18 Q 50,7 102,12 Q 138,15 152,18 Q 138,21 102,24 Q 50,29 19,18 Z"
        fill="url(#L-prev-engine-flame)"
      />

      {/* Mach-diamond accents along the core */}
      <circle cx="48"  cy="18" r="1.8" fill="var(--accent-bright)" opacity="0.95" />
      <circle cx="78"  cy="18" r="1.4" fill="var(--accent-bright)" opacity="0.75" />
      <circle cx="108" cy="18" r="1.0" fill="var(--accent-bright)" opacity="0.55" />
    </svg>
  );
}

export default Landing;
