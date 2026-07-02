import React, { useEffect, useMemo, useRef, useState } from 'react';
import { loadRocketStructure } from '../../services/api';
import './RocketViewerModal.css';

/* ═══ Rocket Viewer Modal ════════════════════════════════════════
 *   Modal companion to the desktop's `_view_rocket_structure`. Shows
 *   the simulation's computed rocket geometry as a real 3D scene
 *   (three.js / WebGL) — interactive: drag to orbit, scroll to zoom,
 *   slider to slide the camera focus along the rocket's axis.
 *
 *   Three.js + the scene module are loaded via *dynamic import* so
 *   the ~600KB three.js bundle never lands on initial page load —
 *   only when a user actually clicks "View Rocket Structure".
 *
 *   Lifecycle:
 *     mount → fetch rocket_data.json from backend
 *           → dynamic-import('./rocketScene')
 *           → setupRocketScene(canvas, data)
 *     unmount → scene.dispose() (cancel rAF, free GPU memory)
 *
 *   The same .DFM-* backdrop/chrome styles as DebrisFilesModal are
 *   reused so the two modals feel like part of the same family.
 * ──────────────────────────────────────────────────────────────── */

/* Cover colour modes. `dot` is the swatch colour shown in the picker;
   `id` matches the palette keys in rocketScene's COVER_PALETTES. */
const COLOR_MODES = [
  { id: 'white',    label: 'White',      dot: '#E6E6EA' },
  { id: 'black',    label: 'Black',      dot: '#17181c' },
  { id: 'darkblue', label: 'Dark Blue',  dot: '#1a2740' },
  { id: 'metal',    label: 'Bare Metal', dot: '#b8bcc4' },
];

function RocketViewerModal({ onClose }) {
  const containerRef = useRef(null);
  const sceneRef = useRef(null);

  const [data, setData] = useState(null);
  const [loadingData, setLoadingData] = useState(true);
  const [bootingScene, setBootingScene] = useState(false);
  const [error, setError] = useState(null);
  const [autoRotate, setAutoRotate] = useState(true);
  /* ─ sequence state: 'idle' | 'launch' | 'tour' ─
     While a sequence runs the regular overlays hide and the launch
     HUD / tour letterbox takes over the canvas. */
  const [mode, setMode] = useState('idle');
  const [countdown, setCountdown] = useState(null);
  const [callout, setCallout] = useState(null);       // {label, sub, key}
  const [telemetry, setTelemetry] = useState(null);
  const [caption, setCaption] = useState(null);       // {text, key}
  const [fadeOut, setFadeOut] = useState(false);
  const [muted, setMuted] = useState(false);
  const [xrayOn, setXrayOn] = useState(false);
  const [flashKey, setFlashKey] = useState(null);
  const fadeTimers = useRef([]);
  /* Defaults to horizontal — matches the scene's initial tilt
     (rocketScene starts with tiltCurrent = -π/2, "vehicle on
     display" framing) so the toolbar button shows the correct
     "↑ Vertical" label on first paint. */
  const [horizontal, setHorizontal] = useState(true);
  const [focusFrac, setFocusFrac] = useState(0.5);
  const [exploded, setExploded] = useState(false);
  /* Outer cover on by default — the viewer opens on the finished,
     wrapped rocket and the user dissolves it to reveal the internals. */
  const [coverOn, setCoverOn] = useState(true);
  const [colorMode, setColorMode] = useState('white');
  /* Colour picker open state is JS-driven (not pure CSS :hover) so it
     stays reliably open while the cursor travels from the button to the
     swatches, and is available whether the shell is on or off. */
  const [colorOpen, setColorOpen] = useState(false);
  const colorMenuTimer = useRef(null);

  // Step 1 — fetch the rocket geometry from the backend.
  useEffect(() => {
    let cancelled = false;
    setLoadingData(true);
    setError(null);
    loadRocketStructure()
      .then((res) => {
        if (cancelled) return;
        if (res?.exists && res?.data) setData(res.data);
        else setError(res?.message || 'No rocket structure data available.');
      })
      .catch((err) => {
        if (cancelled) return;
        if (err.status === 404) {
          setError(err.body?.message || 'Run a simulation first — the rocket structure data is generated during a sim run.');
        } else {
          setError(err.message || String(err));
        }
      })
      .finally(() => { if (!cancelled) setLoadingData(false); });
    return () => { cancelled = true; };
  }, []);

  // Step 2 — once we have the data, dynamically import the heavy
  // three.js scene module and boot it.
  useEffect(() => {
    if (!data || !containerRef.current) return undefined;
    let cancelled = false;
    setBootingScene(true);

    (async () => {
      try {
        const { setupRocketScene } = await import('./rocketScene');
        if (cancelled || !containerRef.current) return;
        const scene = setupRocketScene(containerRef.current, data, {
          autoRotate: true,
        });
        sceneRef.current = scene;
        scene.setFocus(focusFrac);
      } catch (err) {
        if (!cancelled) setError(err.message || String(err));
      } finally {
        if (!cancelled) setBootingScene(false);
      }
    })();

    return () => {
      cancelled = true;
      sceneRef.current?.dispose();
      sceneRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  /* Esc: during a launch/tour sequence it bails out of the sequence;
     otherwise it closes the modal. Refs keep the handler stable. */
  const modeRef = useRef('idle');
  useEffect(() => { modeRef.current = mode; }, [mode]);
  const abortRef = useRef(() => {});
  const skipTourRef = useRef(() => {});
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      if (modeRef.current === 'launch') { abortRef.current(); return; }
      if (modeRef.current === 'tour')   { skipTourRef.current(); return; }
      onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  /* Clear any pending sequence-teardown timers on unmount. */
  useEffect(() => () => { fadeTimers.current.forEach(clearTimeout); }, []);

  /* ─── controls ─── */
  const onToggleRotate = () => {
    const next = sceneRef.current?.toggleAutoRotate?.();
    if (typeof next === 'boolean') setAutoRotate(next);
  };
  const onToggleHorizontal = () => {
    const next = sceneRef.current?.toggleHorizontal?.();
    setHorizontal(!!next);
  };
  const onToggleExplode = () => {
    const next = !exploded;
    setExploded(next);
    sceneRef.current?.setExploded?.(next);
    /* Disassembling auto-dissolves the cover in the scene, so keep the
       cover button's label in sync. */
    if (next) setCoverOn(false);
  };
  const onToggleCover = () => {
    const coverNowOn = sceneRef.current?.toggleCover?.();
    if (typeof coverNowOn === 'boolean') {
      setCoverOn(coverNowOn);
      /* Restoring the shell also reassembles the rocket in the scene,
         so keep the Disassemble button's label in sync. */
      if (coverNowOn) setExploded(false);
    }
  };
  const onPickColor = (mode) => {
    sceneRef.current?.setColorMode?.(mode);
    setColorMode(mode);
  };
  const openColorMenu = () => {
    if (colorMenuTimer.current) { clearTimeout(colorMenuTimer.current); colorMenuTimer.current = null; }
    setColorOpen(true);
  };
  const closeColorMenuSoon = () => {
    if (colorMenuTimer.current) clearTimeout(colorMenuTimer.current);
    colorMenuTimer.current = setTimeout(() => setColorOpen(false), 260);
  };
  useEffect(() => () => {
    if (colorMenuTimer.current) clearTimeout(colorMenuTimer.current);
  }, []);
  const onResetView = () => {
    sceneRef.current?.resetView?.();
    setExploded(false);
    /* The scene's reset lands in the horizontal showroom framing. */
    setHorizontal(true);
    setFocusFrac(0.5);
    setAutoRotate(true);
    setCoverOn(true);
    setXrayOn(false);
  };

  /* ─── launch / tour / X-ray / snapshot ─────────────────────────
     The scene owns the physics + camera; the modal just reflects
     the event stream onto the HUD and manages enter/exit fades. */

  /* Shared "sequence is over" teardown: fade the canvas to black,
     restore the showroom state behind the fade, sync every toggle
     label, fade back in. */
  const settleAfterSequence = (restoreFn) => {
    setFadeOut(true);
    fadeTimers.current.push(setTimeout(() => {
      restoreFn?.();
      setMode('idle');
      setCountdown(null);
      setCallout(null);
      setTelemetry(null);
      setCaption(null);
      setFlashKey(null);
      /* Scene's reset lands: cover on, horizontal, spinning, closed. */
      setExploded(false);
      setHorizontal(true);
      setFocusFrac(0.5);
      setAutoRotate(true);
      setCoverOn(true);
      setXrayOn(false);
      fadeTimers.current.push(setTimeout(() => setFadeOut(false), 80));
    }, 620));
  };

  const handleLaunchEvent = (evt) => {
    switch (evt.type) {
      case 'countdown':
        setCountdown(evt.n > 0 ? evt.n : null);
        break;
      case 'callout':
        setCallout({ label: evt.label, sub: evt.sub, key: Date.now() });
        break;
      case 'telemetry':
        setTelemetry(evt);
        break;
      case 'flash':
        setFlashKey(Date.now());
        /* Belt-and-braces: unmount the flash overlay shortly after
           its CSS fade completes so it can never linger over the
           scene, whatever the animation state ends up being. */
        fadeTimers.current.push(setTimeout(() => setFlashKey(null), 1300));
        break;
      case 'done':
        settleAfterSequence(() => sceneRef.current?.abortLaunch?.());
        break;
      default:
        break;
    }
  };

  const onLaunch = () => {
    const ok = sceneRef.current?.startLaunch?.(handleLaunchEvent);
    if (!ok) return;
    setMode('launch');
    setCountdown(null);
    setCallout(null);
    setTelemetry(null);
    setXrayOn(false);
    setCoverOn(true);
    setExploded(false);
  };

  const onAbortLaunch = () => {
    settleAfterSequence(() => sceneRef.current?.abortLaunch?.());
  };
  abortRef.current = onAbortLaunch;

  const handleTourEvent = (evt) => {
    switch (evt.type) {
      case 'caption':
        setCaption({ text: evt.text, key: Date.now() });
        break;
      case 'done':
      case 'cancelled':
        /* The scene has already reset itself (endTour → doResetView);
           just sync the UI. A short fade smooths the camera snap on
           cancel; on natural completion the camera is already home. */
        settleAfterSequence(null);
        break;
      default:
        break;
    }
  };

  const onTour = () => {
    const ok = sceneRef.current?.startTour?.(handleTourEvent);
    if (!ok) return;
    setMode('tour');
    setCaption(null);
    setXrayOn(false);
  };

  const onSkipTour = () => { sceneRef.current?.skipTour?.(); };
  skipTourRef.current = onSkipTour;

  const onToggleXRay = () => {
    const on = sceneRef.current?.toggleXRay?.();
    if (typeof on === 'boolean') {
      setXrayOn(on);
      if (on) setCoverOn(false);
    }
  };

  const onToggleMute = () => {
    const m = sceneRef.current?.toggleAudio?.();
    if (typeof m === 'boolean') setMuted(m);
  };

  const onSnapshot = () => {
    const url = sceneRef.current?.snapshot?.();
    if (!url) return;
    const a = document.createElement('a');
    a.href = url;
    a.download = `clearcut-rocket-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.png`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  /* ─── keyboard shortcuts (idle mode only) ──────────────────────
     L launch · T tour · X x-ray · D disassemble · C shell ·
     R reset · S snapshot · Space pause/resume spin. The handlers
     live in a ref so the single window listener never goes stale. */
  const keysRef = useRef({});
  keysRef.current = {
    onLaunch, onTour, onToggleXRay, onToggleExplode,
    onToggleCover, onResetView, onToggleRotate, onSnapshot,
  };
  useEffect(() => {
    const onKey = (e) => {
      if (modeRef.current !== 'idle') return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const tag = e.target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      const k = keysRef.current;
      switch (e.key === ' ' ? ' ' : e.key.toLowerCase()) {
        case 'l': k.onLaunch();        break;
        case 't': k.onTour();          break;
        case 'x': k.onToggleXRay();    break;
        case 'd': k.onToggleExplode(); break;
        case 'c': k.onToggleCover();   break;
        case 'r': k.onResetView();     break;
        case 's': k.onSnapshot();      break;
        case ' ': e.preventDefault(); k.onToggleRotate(); break;
        default: break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const onFocusInput = (e) => {
    const v = Number(e.target.value);
    setFocusFrac(v);
    sceneRef.current?.setFocus?.(v);
  };

  /* ─── zoom + pan controls (press-and-hold) ───────────────────
     Each nav button fires its action once on press, then repeats
     while held (≈60 fps) for smooth continuous zoom/pan, and stops
     on release / pointer-leave. The repeating timer is tracked in a
     ref so it survives re-renders and is cleared on unmount. */
  const repeatRef = useRef(null);
  const stopRepeat = () => {
    if (repeatRef.current) { clearInterval(repeatRef.current); repeatRef.current = null; }
  };
  const startRepeat = (fn) => {
    fn();
    stopRepeat();
    repeatRef.current = setInterval(fn, 16);
  };
  useEffect(() => stopRepeat, []);

  const ZOOM_IN  = 0.975;   // <1 → dolly toward target
  const ZOOM_OUT = 1.0256;  // reciprocal-ish → dolly away
  const PAN_STEP = 0.01;    // fraction of viewport per tick

  const zoomIn   = () => sceneRef.current?.zoom?.(ZOOM_IN);
  const zoomOut  = () => sceneRef.current?.zoom?.(ZOOM_OUT);
  const panBy    = (dx, dy) => () => sceneRef.current?.pan?.(dx, dy);

  /* ─── derived stats — total height + propellant + dry mass ─── */
  const stats = useMemo(() => {
    if (!data) return null;
    const totalHeight =
      data.payload_length + data.fairing_length +
      data.stage1_length + data.stage12_interstage_length +
      data.stage2_length + data.stage23_interstage_length +
      data.stage3_length;
    const propellant =
      (data.stage1_top_propellant_mass || 0) + (data.stage1_bottom_propellant_mass || 0) +
      (data.stage2_top_propellant_mass || 0) + (data.stage2_bottom_propellant_mass || 0) +
      (data.stage3_top_propellant_mass || 0) + (data.stage3_bottom_propellant_mass || 0);
    const dry =
      (data.payload_mass || 0) +
      (data.stage12_interstage_mass || 0) +
      (data.stage23_interstage_mass || 0);
    return {
      totalHeight,
      maxRadius: Math.max(
        data.fairing_radius || 0,
        data.stage1_radius || 0,
        data.stage2_radius || 0,
        data.stage3_radius || 0,
      ),
      stages: 3,
      propellant,
      dry,
      gross: propellant + dry,
    };
  }, [data]);

  return (
    <div
      className="DFM-backdrop RVM-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="rvm-title"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="DFM-modal RVM-modal">
        <header className="DFM-head RVM-head">
          <div>
            <span className="eyebrow">Trajectory</span>
            <h2 id="rvm-title" className="DFM-title">3D Rocket Structure</h2>
          </div>
          <div className="RVM-meta mono">
            {stats && (
              <>
                <span>{stats.stages} stages</span>
                <span className="RVM-sep">·</span>
                <span>{stats.totalHeight.toFixed(2)} m</span>
                <span className="RVM-sep">·</span>
                <span>{formatMass(stats.gross)} GLOM</span>
              </>
            )}
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

        <div className="RVM-body">
          {loadingData && (
            <div className="RVM-empty mono">{'// loading rocket geometry…'}</div>
          )}
          {error && (
            <div className="RVM-empty RVM-empty--err mono">⚠ {error}</div>
          )}

          {data && !error && (
            <>
              {/* Three.js mounts its canvas inside this div. The scene's
                  resize observer keeps it in sync with the wrap. */}
              <div ref={containerRef} className="RVM-canvas" />
              {bootingScene && (
                <div className="RVM-empty RVM-empty--overlay mono">
                  {'// building scene…'}
                </div>
              )}

              {/* Everything below is the idle-mode overlay suite; a
                  running launch/tour swaps it out for its own HUD. */}
              {mode === 'idle' && (
              <>
              {/* Bottom-left: legend. Same color codes as the desktop. */}
              <div className="RVM-legend mono">
                <Swatch color="#1a1a1a" label="Nozzle" />
                <Swatch color="#3a3a42" label="Engine" />
                <Swatch color="#E8860C" label="Fuel" />
                <Swatch color="#87CEEB" label="Oxidizer" />
                <Swatch color="#808088" label="Interstage" />
                <Swatch color="#C9A55A" label="Payload" />
                <Swatch color="rgba(220,220,230,0.5)" label="Fairing" />
                <Swatch color="#666" label="Fins" />
              </div>

              {/* Bottom-right: rotation / view-mode toggles.
                  Layout shape: a primary Disassemble button on its
                  own row at the top (the marquee action — pulling
                  the rocket apart is the core mechanical-inspection
                  feature), with the secondary toggles (auto-rotate,
                  vertical/horizontal, reset) underneath at the
                  smaller default size. */}
              <div className="RVM-toolbar">
                {/* Marquee action — the full launch sequence. Sits on
                    top of the stack in mission-red so it's the first
                    thing every visitor is drawn to. */}
                <button
                  type="button"
                  className="RVM-toolbtn-primary RVM-toolbtn-launch"
                  onClick={onLaunch}
                  title="Run the full launch sequence — countdown, ignition, staging, payload deploy"
                >
                  <span className="RVM-toolbtn-primary-glyph" aria-hidden="true">▲</span>
                  <span className="RVM-toolbtn-primary-label">Launch</span>
                </button>
                {/* Outer-cover control. Sits above Disassemble as its
                    own primary action: dissolves the finished-rocket
                    skin away to expose the internal structure. The
                    wrapping div is the anchor for the colour-mode
                    flyout added in a later phase. */}
                <div
                  className="RVM-cover-control"
                  onMouseEnter={openColorMenu}
                  onMouseLeave={closeColorMenuSoon}
                  onFocus={openColorMenu}
                  onBlur={closeColorMenuSoon}
                >
                  <button
                    type="button"
                    className={`RVM-toolbtn-primary RVM-toolbtn-cover${coverOn ? '' : ' RVM-toolbtn-cover--off'}`}
                    onClick={onToggleCover}
                    title={
                      coverOn
                        ? 'Dissolve the outer shell to reveal the internal structure'
                        : 'Restore the outer shell'
                    }
                  >
                    <span className="RVM-toolbtn-primary-glyph" aria-hidden="true">
                      {coverOn ? '◐' : '○'}
                    </span>
                    <span className="RVM-toolbtn-primary-label">
                      {coverOn ? 'Reveal Internals' : 'Restore Shell'}
                    </span>
                  </button>

                  {/* Colour-mode picker — flies out to the left when the
                      user hovers (or keyboard-focuses) the cover control.
                      Swatches recolour the whole rocket livery live. */}
                  <div
                    className={`RVM-color-flyout${colorOpen ? ' RVM-color-flyout--open' : ''}`}
                    role="group"
                    aria-label="Rocket colour"
                  >
                    {COLOR_MODES.map(({ id, label, dot }) => (
                      <button
                        key={id}
                        type="button"
                        className={`RVM-color-swatch${colorMode === id ? ' RVM-color-swatch--on' : ''}`}
                        style={{ '--swatch': dot }}
                        onClick={() => onPickColor(id)}
                        title={label}
                        aria-label={label}
                        aria-pressed={colorMode === id}
                      />
                    ))}
                  </div>
                </div>
                <button
                  type="button"
                  className={`RVM-toolbtn-primary${exploded ? ' RVM-toolbtn-primary--on' : ''}`}
                  onClick={onToggleExplode}
                  title="Pull stages apart to inspect inter-stage hardware"
                >
                  <span className="RVM-toolbtn-primary-glyph" aria-hidden="true">
                    {exploded ? '◆' : '◇'}
                  </span>
                  <span className="RVM-toolbtn-primary-label">
                    {exploded ? 'Reassemble' : 'Disassemble'}
                  </span>
                </button>
                <div className="RVM-toolbar-row">
                  <button
                    type="button"
                    className="RVM-toolbtn"
                    onClick={onTour}
                    title="Play a self-running cinematic tour of the vehicle"
                  >
                    ▶ Tour
                  </button>
                  <button
                    type="button"
                    className={`RVM-toolbtn${xrayOn ? ' RVM-toolbtn--xray-on' : ''}`}
                    onClick={onToggleXRay}
                    title="X-ray hologram view — see through every structure"
                  >
                    ◈ X-Ray
                  </button>
                  <button
                    type="button"
                    className="RVM-toolbtn"
                    onClick={onSnapshot}
                    title="Save the current view as a PNG"
                  >
                    ⬓ Snapshot
                  </button>
                </div>
                <div className="RVM-toolbar-row">
                  <button
                    type="button"
                    className={`RVM-toolbtn${autoRotate ? '' : ' RVM-toolbtn--off'}`}
                    onClick={onToggleRotate}
                    title="Pause / resume auto-rotate"
                  >
                    {autoRotate ? '⏸ Auto-rotate' : '▶ Auto-rotate'}
                  </button>
                  <button
                    type="button"
                    className="RVM-toolbtn"
                    onClick={onToggleHorizontal}
                    title="Tilt the rocket between vertical and horizontal"
                  >
                    {horizontal ? '↑ Vertical' : '→ Horizontal'}
                  </button>
                  <button
                    type="button"
                    className="RVM-toolbtn RVM-toolbtn--ghost"
                    onClick={onResetView}
                    title="Reset camera and view modes"
                  >
                    ↺ Reset
                  </button>
                </div>
              </div>

              {/* Top-right: navigation cluster — zoom + camera pan.
                  Pulled out of the bottom-right toolbar stack so it
                  doesn't sit awkwardly under the action buttons.
                  Together with the stats panel (top-left), the hint
                  (bottom-left) and the toolbar (bottom-right), each
                  canvas corner now holds one overlay. Press-and-hold
                  each button for continuous motion. */}
              <div className="RVM-nav" aria-label="Zoom and pan controls">
                  <div className="RVM-nav-zoom">
                    <button
                      type="button"
                      className="RVM-nav-btn"
                      title="Zoom out"
                      aria-label="Zoom out"
                      onPointerDown={() => startRepeat(zoomOut)}
                      onPointerUp={stopRepeat}
                      onPointerLeave={stopRepeat}
                    >
                      −
                    </button>
                    <button
                      type="button"
                      className="RVM-nav-btn"
                      title="Zoom in"
                      aria-label="Zoom in"
                      onPointerDown={() => startRepeat(zoomIn)}
                      onPointerUp={stopRepeat}
                      onPointerLeave={stopRepeat}
                    >
                      +
                    </button>
                  </div>
                  <div className="RVM-nav-pad">
                    <button
                      type="button"
                      className="RVM-nav-btn RVM-nav-up"
                      title="Pan up"
                      aria-label="Pan up"
                      onPointerDown={() => startRepeat(panBy(0, PAN_STEP))}
                      onPointerUp={stopRepeat}
                      onPointerLeave={stopRepeat}
                    >
                      ▲
                    </button>
                    <button
                      type="button"
                      className="RVM-nav-btn RVM-nav-left"
                      title="Pan left"
                      aria-label="Pan left"
                      onPointerDown={() => startRepeat(panBy(-PAN_STEP, 0))}
                      onPointerUp={stopRepeat}
                      onPointerLeave={stopRepeat}
                    >
                      ◀
                    </button>
                    <button
                      type="button"
                      className="RVM-nav-btn RVM-nav-center"
                      title="Recenter view"
                      aria-label="Recenter view"
                      onClick={onResetView}
                    >
                      ⌖
                    </button>
                    <button
                      type="button"
                      className="RVM-nav-btn RVM-nav-right"
                      title="Pan right"
                      aria-label="Pan right"
                      onPointerDown={() => startRepeat(panBy(PAN_STEP, 0))}
                      onPointerUp={stopRepeat}
                      onPointerLeave={stopRepeat}
                    >
                      ▶
                    </button>
                    <button
                      type="button"
                      className="RVM-nav-btn RVM-nav-down"
                      title="Pan down"
                      aria-label="Pan down"
                      onPointerDown={() => startRepeat(panBy(0, -PAN_STEP))}
                      onPointerUp={stopRepeat}
                      onPointerLeave={stopRepeat}
                    >
                      ▼
                    </button>
                  </div>
                </div>

              {/* Top-left: stats overlay panel. */}
              {stats && (
                <div className="RVM-stats">
                  <div className="RVM-stats-head">
                    <span className="eyebrow">Vehicle</span>
                  </div>
                  <div className="RVM-stats-grid mono">
                    <span className="RVM-stats-key">Height</span>
                    <span className="RVM-stats-val">{stats.totalHeight.toFixed(2)} m</span>
                    <span className="RVM-stats-key">Max ⌀</span>
                    <span className="RVM-stats-val">{(stats.maxRadius * 2).toFixed(2)} m</span>
                    <span className="RVM-stats-key">Stages</span>
                    <span className="RVM-stats-val">{stats.stages}</span>
                    <span className="RVM-stats-divider" />
                    <span className="RVM-stats-key">Payload</span>
                    <span className="RVM-stats-val">{formatMass(data.payload_mass)}</span>
                    <span className="RVM-stats-key">Propellant</span>
                    <span className="RVM-stats-val">{formatMass(stats.propellant)}</span>
                    <span className="RVM-stats-key">GLOM</span>
                    <span className="RVM-stats-val RVM-stats-val--bold">{formatMass(stats.gross)}</span>
                  </div>
                </div>
              )}

              {/* Left: focus slider — slides camera target along the
                  rocket's vertical axis to inspect engines or payload. */}
              <div className="RVM-focus">
                <span className="RVM-focus-label mono">FOCUS</span>
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.01"
                  value={focusFrac}
                  onChange={onFocusInput}
                  className="RVM-focus-slider"
                  aria-label="Focus along rocket axis"
                />
              </div>

              {/* Bottom-left: drag/scroll hint (toolbar now occupies
                  the bottom-right corner). */}
              <div className="RVM-hint mono">
                drag · scroll · slide
                <br />
                L launch · T tour · X x-ray · D explode
              </div>
              </>
              )}

              {/* ═══ LAUNCH HUD ═══════════════════════════════════
                  Countdown digits, event callouts, live telemetry
                  strip and the abort/mute controls. All plain DOM on
                  top of the canvas, fed by the scene's event stream. */}
              {mode === 'launch' && (
                <>
                  <div className="RVM-live mono">
                    <span className="RVM-live-dot" aria-hidden="true" />
                    LIVE · CLEARCUT MISSION CONTROL
                  </div>
                  {countdown != null && (
                    <div key={countdown} className="RVM-countdown mono" aria-live="assertive">
                      <span className="RVM-countdown-t">T−</span>{countdown}
                    </div>
                  )}
                  {callout && (
                    <div key={callout.key} className="RVM-callout" aria-live="polite">
                      <div className="RVM-callout-label">{callout.label}</div>
                      {callout.sub && <div className="RVM-callout-sub mono">{callout.sub}</div>}
                    </div>
                  )}
                  {telemetry && (
                    <div className="RVM-telemetry mono" aria-label="Live telemetry">
                      <div className="RVM-tele-cell RVM-tele-clock">
                        <span className="RVM-tele-key">MET</span>
                        <span className="RVM-tele-val">
                          T{telemetry.tSign}{formatClock(telemetry.tAbs)}
                        </span>
                      </div>
                      <TeleCell label="ALT" value={formatAltitude(telemetry.alt)} />
                      <TeleCell label="VEL" value={formatVelocity(telemetry.vel)} />
                      <TeleCell label="MACH" value={telemetry.mach.toFixed(1)} />
                      <TeleCell label="THR" value={`${Math.round(telemetry.throttle)}%`} />
                      <TeleCell label="G" value={telemetry.g.toFixed(1)} />
                    </div>
                  )}
                  <div className="RVM-seq-controls">
                    <button
                      type="button"
                      className="RVM-toolbtn"
                      onClick={onToggleMute}
                      title={muted ? 'Unmute launch audio' : 'Mute launch audio'}
                    >
                      {muted ? '∅ Sound off' : '≋ Sound on'}
                    </button>
                    <button
                      type="button"
                      className="RVM-toolbtn RVM-toolbtn-abort"
                      onClick={onAbortLaunch}
                      title="Abort the launch sequence (Esc)"
                    >
                      ✕ Abort
                    </button>
                  </div>
                </>
              )}

              {/* ═══ TOUR OVERLAY ═════════════════════════════════
                  Film-style letterbox bars + streaming captions. */}
              {mode === 'tour' && (
                <>
                  <div className="RVM-letterbox RVM-letterbox--top">
                    <span className="RVM-tour-title mono">CLEARCUT — VEHICLE TOUR</span>
                  </div>
                  <div className="RVM-letterbox RVM-letterbox--bottom" />
                  {caption && (
                    <div key={caption.key} className="RVM-tour-caption mono">
                      {caption.text}
                    </div>
                  )}
                  <div className="RVM-seq-controls">
                    <button
                      type="button"
                      className="RVM-toolbtn"
                      onClick={onSkipTour}
                      title="Skip the tour (Esc or click the canvas)"
                    >
                      ⏭ Skip tour
                    </button>
                  </div>
                </>
              )}

              {/* Ignition flash — remounts (via key) on every flash
                  event so the CSS animation restarts. */}
              {flashKey != null && <div key={flashKey} className="RVM-flash" />}

              {/* Fade-to-black used to hide the reset snap when a
                  sequence ends. Always mounted so the transition runs. */}
              <div className={`RVM-fade${fadeOut ? ' RVM-fade--on' : ''}`} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function TeleCell({ label, value }) {
  return (
    <div className="RVM-tele-cell">
      <span className="RVM-tele-key">{label}</span>
      <span className="RVM-tele-val">{value}</span>
    </div>
  );
}

/** T± mission clock, MM:SS. */
function formatClock(s) {
  const sec = Math.max(0, s);
  const m = Math.floor(sec / 60);
  const r = sec - m * 60;
  return `${String(m).padStart(2, '0')}:${String(Math.floor(r)).padStart(2, '0')}`;
}

function formatAltitude(m) {
  if (m >= 10000) return `${(m / 1000).toFixed(1)} km`;
  if (m >= 1000) return `${(m / 1000).toFixed(2)} km`;
  return `${Math.max(0, m).toFixed(0)} m`;
}

function formatVelocity(v) {
  if (v >= 1000) return `${(v / 1000).toFixed(2)} km/s`;
  return `${Math.max(0, v).toFixed(0)} m/s`;
}

function Swatch({ color, label }) {
  return (
    <div className="RVM-legend-row">
      <span className="RVM-legend-sw" style={{ background: color }} />
      <span>{label}</span>
    </div>
  );
}

/** Format a mass in kg with sensible precision: 1234.5 t for ≥ 1 t,
 *  otherwise plain kilograms. */
function formatMass(kg) {
  if (kg == null || !Number.isFinite(kg)) return '—';
  if (kg >= 1000) return `${(kg / 1000).toFixed(2)} t`;
  return `${kg.toFixed(0)} kg`;
}

export default RocketViewerModal;
