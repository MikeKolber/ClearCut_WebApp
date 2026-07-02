import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import TopBar from '../../components/TopBar/TopBar';
import { getEngineTest, engineVideoUrl } from '../../services/api';
import ErrorToast from '../../components/ErrorToast/ErrorToast';
import './VideoReview.css';
import { formatSize } from '../../utils/format';

const SPEEDS = [0.25, 0.5, 1, 2, 4, 8];
// Order of speeds visited when pressing « or » — first press from 1× → 2×, then 4×, 8×, back to 1×.
const CYCLE_SPEEDS = [2, 4, 8, 1];
// Slow-motion cycle — first press from 1× → 0.5×, then 0.25×, then back to 1×.
const SLOMO_CYCLE = [0.5, 0.25, 1];

function VideoReview() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const testName = params.get('test') || '';

  const videoRef = useRef(null);
  const wrapRef = useRef(null);

  const [videoFiles, setVideoFiles] = useState([]);
  const [selectedFile, setSelectedFile] = useState(null);
  const [loadingMeta, setLoadingMeta] = useState(true);
  const [error, setError] = useState(null);

  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [speed, setSpeed] = useState(1);
  const [direction, setDirection] = useState('forward'); // 'forward' | 'reverse'
  const [fps, setFps] = useState(30);
  const [fpsDetected, setFpsDetected] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);
  const hideTimerRef = useRef(null);
  const reverseRafRef = useRef(null);

  // Bounce back if no test in URL.
  useEffect(() => {
    if (!testName) navigate('/engine-test', { replace: true });
  }, [testName, navigate]);

  // Load video file list for the test.
  useEffect(() => {
    if (!testName) return undefined;
    let cancelled = false;
    setLoadingMeta(true);
    setError(null);
    getEngineTest(testName)
      .then((data) => {
        if (cancelled) return;
        const files = data?.video_files || [];
        setVideoFiles(files);
        if (files.length > 0) setSelectedFile(files[0].name);
      })
      .catch((e) => {
        if (cancelled) return;
        setError({
          kind: 'runtime',
          title: 'Could not list videos',
          details: [e.message || String(e)],
        });
      })
      .finally(() => !cancelled && setLoadingMeta(false));
    return () => {
      cancelled = true;
    };
  }, [testName]);

  // True from file switch until the new video's metadata arrives —
  // drives a small loading overlay so switching between multi-GB
  // files isn't a silent black stage.
  const [videoLoading, setVideoLoading] = useState(false);

  // When the file changes, reset the player state.
  useEffect(() => {
    setCurrentTime(0);
    setDuration(0);
    setIsPlaying(false);
    setFpsDetected(false);
    setFps(30);
    setSpeed(1);
    setDirection('forward');
    setVideoLoading(Boolean(selectedFile));
  }, [selectedFile]);

  // Drive playback.
  //   forward & speed ≤ 1 → native playbackRate (smooth, real audio).
  //   forward & speed > 1 → seek-paced manual loop (matches reverse).
  //   reverse             → seek-paced manual loop.
  //
  // Native fast-forward (playbackRate = 4/8) makes the browser decode
  // every frame at high speed, which drops frames and feels chunkier
  // than the rewind. Driving forward fast-play through the same
  // seeked-event loop the rewind uses gives matched smoothness — the
  // browser only decodes the frames we actually request.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return undefined;

    const cancelLoop = () => {
      if (reverseRafRef.current) {
        cancelAnimationFrame(reverseRafRef.current);
        reverseRafRef.current = null;
      }
    };

    cancelLoop();

    const isManualForward = direction === 'forward' && speed > 1;
    const isReverse = direction === 'reverse';

    if (!isManualForward && !isReverse) {
      // Native forward at speed ≤ 1×.
      v.playbackRate = speed;
      return undefined;
    }

    // Manual seek-paced loop (used for both forward fast-play and reverse).
    v.pause();
    const sign = isReverse ? -1 : 1;
    let stopped = false;
    let pending = false;
    let lastTick = performance.now();

    const step = () => {
      if (stopped) return;
      const live = videoRef.current;
      if (!live) return;
      const now = performance.now();
      // Cap dt so a long render hitch doesn't teleport us too far.
      const dt = Math.min(0.1, (now - lastTick) / 1000);
      lastTick = now;
      const target = live.currentTime + sign * speed * dt;

      if (target <= 0) {
        live.currentTime = 0;
        setDirection('forward');
        setSpeed(1);
        return;
      }
      if (live.duration > 0 && target >= live.duration) {
        live.currentTime = live.duration;
        setSpeed(1);
        return;
      }

      pending = true;
      live.currentTime = target;
    };

    const onSeeked = () => {
      if (!pending || stopped) return;
      pending = false;
      // Hand back to the renderer for one frame so the new image actually
      // paints before we ask for the next seek.
      reverseRafRef.current = requestAnimationFrame(step);
    };

    v.addEventListener('seeked', onSeeked);
    reverseRafRef.current = requestAnimationFrame(step);

    return () => {
      stopped = true;
      v.removeEventListener('seeked', onSeeked);
      cancelLoop();
    };
  }, [direction, speed, selectedFile]);

  // Detect FPS using requestVideoFrameCallback.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return undefined;
    if (typeof v.requestVideoFrameCallback !== 'function') return undefined;

    let cancelled = false;
    let prevMedia = null;
    const samples = [];
    let handle = 0;

    const onFrame = (_now, metadata) => {
      if (cancelled) return;
      if (prevMedia != null) {
        const dt = metadata.mediaTime - prevMedia;
        if (dt > 0 && dt < 1) samples.push(dt);
        if (samples.length >= 6) {
          const sorted = [...samples].sort((a, b) => a - b);
          const med = sorted[Math.floor(sorted.length / 2)];
          const detected = Math.round(1 / med);
          if (detected >= 5 && detected <= 240) {
            setFps(detected);
            setFpsDetected(true);
            return; // stop scheduling more frames
          }
        }
      }
      prevMedia = metadata.mediaTime;
      handle = v.requestVideoFrameCallback(onFrame);
    };

    handle = v.requestVideoFrameCallback(onFrame);

    return () => {
      cancelled = true;
      if (typeof v.cancelVideoFrameCallback === 'function') {
        try {
          v.cancelVideoFrameCallback(handle);
        } catch {
          /* ignore */
        }
      }
    };
  }, [selectedFile]);

  /* ── Player controls ─────────────────────────────────────────── */

  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    // If we're in seek-paced mode (rewinding OR fast-forwarding faster
    // than 1×), pressing play/pause stops the loop cleanly and drops back
    // to forward 1× paused, ready for normal play.
    if (direction === 'reverse' || speed > 1) {
      setDirection('forward');
      setSpeed(1);
      return;
    }
    if (v.paused) {
      v.play().catch(() => {});
    } else {
      v.pause();
    }
  }, [direction, speed]);

  const seekTo = useCallback((t) => {
    const v = videoRef.current;
    if (!v || !Number.isFinite(t)) return;
    setDirection('forward');
    v.currentTime = Math.max(0, Math.min(v.duration || t, t));
  }, []);

  const stepFrames = useCallback(
    (deltaFrames) => {
      const v = videoRef.current;
      if (!v) return;
      setDirection('forward');
      v.pause();
      const dt = deltaFrames / Math.max(1, fps);
      const next = Math.max(0, Math.min(v.duration || 0, v.currentTime + dt));
      v.currentTime = next;
    },
    [fps]
  );

  const cycleSpeed = (dir = 1) => {
    setDirection('forward');
    const idx = SPEEDS.indexOf(speed);
    const next = SPEEDS[(idx + dir + SPEEDS.length) % SPEEDS.length];
    setSpeed(next);
  };

  // « / » — pressing the same direction advances through CYCLE_SPEEDS
  // (2× → 4× → 8× → 1× → 2× …). Pressing the opposite direction switches
  // direction and resets to 2× (the first cycle entry), like a TV remote.
  const cycleButtonSpeed = useCallback(
    (newDir) => {
      if (direction === newDir) {
        setSpeed((cur) => {
          const idx = CYCLE_SPEEDS.indexOf(cur);
          if (idx === -1) return CYCLE_SPEEDS[0];
          return CYCLE_SPEEDS[(idx + 1) % CYCLE_SPEEDS.length];
        });
      } else {
        setSpeed(CYCLE_SPEEDS[0]);
        setDirection(newDir);
      }
      if (newDir === 'forward') {
        const v = videoRef.current;
        if (v && v.paused) v.play().catch(() => {});
      }
    },
    [direction]
  );

  // ½ — slow-motion cycle. Same advance-through-cycle semantics as the
  // wind buttons, but for slow speeds: 1× → 0.5× → 0.25× → 1×. Pressing
  // it from reverse or fast-forward jumps straight to the start (0.5×).
  const cycleSlowMo = useCallback(() => {
    const inSlowCycle = direction === 'forward' && speed <= 1;
    if (inSlowCycle) {
      setSpeed((cur) => {
        const idx = SLOMO_CYCLE.indexOf(cur);
        if (idx === -1) return SLOMO_CYCLE[0];
        return SLOMO_CYCLE[(idx + 1) % SLOMO_CYCLE.length];
      });
    } else {
      setDirection('forward');
      setSpeed(SLOMO_CYCLE[0]);
    }
    const v = videoRef.current;
    if (v && v.paused) v.play().catch(() => {});
  }, [direction, speed]);

  const toggleFullscreen = useCallback(() => {
    const target = wrapRef.current;
    if (!target) return;
    if (!document.fullscreenElement) {
      target.requestFullscreen?.();
    } else {
      document.exitFullscreen?.();
    }
  }, []);

  useEffect(() => {
    const onChange = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  /* ── Auto-hide controls (YouTube-style) ───────────────────── */

  const scheduleHide = useCallback(() => {
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    hideTimerRef.current = setTimeout(() => {
      const v = videoRef.current;
      // Only auto-hide while the video is actually moving — native play
      // (v.paused === false), reverse rewind, or seek-paced fast-forward
      // (both of which have the <video> element technically paused).
      const moving = (v && !v.paused) || direction === 'reverse' || speed > 1;
      if (!moving) return;
      setControlsVisible(false);
    }, 2000);
  }, [direction, speed]);

  const showControls = useCallback(() => {
    setControlsVisible(true);
    scheduleHide();
  }, [scheduleHide]);

  // Always show controls when idle; arm the timer once playback resumes
  // (native, reverse, or seek-paced fast-forward).
  useEffect(() => {
    const isMoving = isPlaying || direction === 'reverse' || speed > 1;
    if (!isMoving) {
      setControlsVisible(true);
      if (hideTimerRef.current) {
        clearTimeout(hideTimerRef.current);
        hideTimerRef.current = null;
      }
    } else {
      scheduleHide();
    }
  }, [isPlaying, direction, speed, scheduleHide]);

  useEffect(
    () => () => {
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    },
    []
  );

  // Keyboard shortcuts (avoid intercepting input fields).
  useEffect(() => {
    const onKey = (e) => {
      const t = e.target;
      if (
        t &&
        (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)
      ) {
        return;
      }
      if (e.code === 'Space') {
        e.preventDefault();
        togglePlay();
      } else if (e.code === 'ArrowLeft') {
        e.preventDefault();
        if (e.shiftKey) stepFrames(-fps); // ~1 second
        else stepFrames(-1);
      } else if (e.code === 'ArrowRight') {
        e.preventDefault();
        if (e.shiftKey) stepFrames(fps);
        else stepFrames(1);
      } else if (e.key === 'f' || e.key === 'F') {
        e.preventDefault();
        toggleFullscreen();
      } else if (e.key === ',') {
        cycleSpeed(-1);
      } else if (e.key === '.') {
        cycleSpeed(1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [togglePlay, stepFrames, toggleFullscreen, fps, speed]);

  /* ── Derived ────────────────────────────────────────────────── */

  const src = useMemo(
    () => (testName && selectedFile ? engineVideoUrl(testName, selectedFile) : null),
    [testName, selectedFile]
  );

  const frameNumber = Math.round(currentTime * fps);
  const totalFrames = Math.round(duration * fps);

  /* ── Render ─────────────────────────────────────────────────── */

  return (
    <>
      <TopBar
        title="Video Review"
        onBack={() => navigate('/engine-test')}
        backLabel="EXIT"
        backPosition="right"
        right={
          <span className="VR-status mono">
            {selectedFile
              ? `${selectedFile} · ${fps} fps${fpsDetected ? '' : ' (assumed)'}`
              : 'Pick a video'}
          </span>
        }
      />

      <div className="VR-main">
        {/* Sidebar */}
        <aside className="VR-sidebar">
          <div className="VR-section">
            <header className="VR-section-head">
              <span className="eyebrow">Test</span>
            </header>
            <div className="VR-test-name" title={testName}>{testName}</div>
          </div>

          <div className="VR-section VR-section--scroll VR-section--grow">
            <header className="VR-section-head">
              <span className="eyebrow">Videos</span>
              {videoFiles.length > 0 && (
                <span className="VR-count mono">
                  {String(videoFiles.length).padStart(2, '0')}
                </span>
              )}
            </header>
            <div className="VR-list">
              {loadingMeta ? (
                <div className="VR-empty mono">Loading…</div>
              ) : videoFiles.length === 0 ? (
                <div className="VR-empty mono">{'// no video files'}</div>
              ) : (
                videoFiles.map((f) => {
                  const active = f.name === selectedFile;
                  return (
                    <button
                      key={f.name}
                      type="button"
                      className={`VR-listItem${active ? ' VR-listItem--active' : ''}`}
                      aria-current={active ? 'true' : undefined}
                      onClick={() => setSelectedFile(f.name)}
                      title={f.name}
                    >
                      <span className="VR-listItem-name mono">{f.name}</span>
                      <span className="VR-listItem-size mono">
                        {formatSize(f.size_bytes)}
                      </span>
                    </button>
                  );
                })
              )}
            </div>
          </div>

          <div className="VR-section">
            <header className="VR-section-head">
              <span className="eyebrow">Shortcuts</span>
            </header>
            <ul className="VR-shortcuts mono">
              <li><kbd>Space</kbd><span>play / pause</span></li>
              <li><kbd>←</kbd><kbd>→</kbd><span>step 1 frame</span></li>
              <li><kbd>⇧</kbd><kbd>←</kbd><kbd>→</kbd><span>step 1 sec</span></li>
              <li><kbd>,</kbd><kbd>.</kbd><span>speed −/+</span></li>
              <li><kbd>F</kbd><span>fullscreen</span></li>
            </ul>
          </div>
        </aside>

        {/* Main */}
        <section
          className={`VR-stage${!controlsVisible ? ' VR-stage--idle' : ''}`}
          ref={wrapRef}
          onMouseMove={showControls}
          onMouseLeave={() => {
            if (isPlaying || direction === 'reverse' || speed > 1) {
              setControlsVisible(false);
            }
          }}
        >
          {!src ? (
            <div className="VR-placeholder">
              {videoFiles.length === 0
                ? 'No video files in this test'
                : 'Pick a video on the left'}
            </div>
          ) : (
            <>
              <div className="VR-corner VR-corner--tl" />
              <div className="VR-corner VR-corner--tr" />
              <div className="VR-corner VR-corner--bl" />
              <div className="VR-corner VR-corner--br" />

              <video
                ref={videoRef}
                key={src}
                className="VR-video"
                src={src}
                playsInline
                preload="metadata"
                onLoadedMetadata={(e) => {
                  setDuration(e.currentTarget.duration || 0);
                  setVideoLoading(false);
                }}
                onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime || 0)}
                onPlay={() => setIsPlaying(true)}
                onPause={() => setIsPlaying(false)}
                onEnded={() => setIsPlaying(false)}
                onError={() => {
                  // Missing/corrupt/unsupported file previously failed
                  // silently, leaving a black stage with a stuck player.
                  setIsPlaying(false);
                  setVideoLoading(false);
                  setError({
                    kind: 'runtime',
                    title: 'Could not play this video',
                    details: [
                      'The file may be missing, corrupt, or use a codec '
                      + 'this browser cannot decode.',
                    ],
                  });
                }}
                onClick={togglePlay}
              />

              {videoLoading && (
                <div className="VR-loading mono" role="status">
                  Loading video…
                </div>
              )}

              {(speed !== 1 || direction === 'reverse') && (
                <div className="VR-rate-badge mono" aria-live="polite">
                  <span className="VR-rate-icon" aria-hidden="true">
                    {direction === 'reverse' ? '«' : speed < 1 ? '½' : '»'}
                  </span>
                  <span className="VR-rate-value">{speed}×</span>
                  <span className="VR-rate-label">
                    {direction === 'reverse'
                      ? 'rewind'
                      : speed < 1
                      ? 'slo-mo'
                      : 'fast-forward'}
                  </span>
                </div>
              )}

              <ControlBar
                isPlaying={isPlaying}
                direction={direction}
                currentTime={currentTime}
                duration={duration}
                speed={speed}
                fps={fps}
                fpsDetected={fpsDetected}
                frameNumber={frameNumber}
                totalFrames={totalFrames}
                isFullscreen={isFullscreen}
                onTogglePlay={togglePlay}
                onSeek={seekTo}
                onSpeedDown={() => cycleButtonSpeed('reverse')}
                onSpeedUp={() => cycleButtonSpeed('forward')}
                onSlowMo={cycleSlowMo}
                onToggleFullscreen={toggleFullscreen}
              />
            </>
          )}
        </section>
      </div>

      {error && (
        <ErrorToast error={error} onDismiss={() => setError(null)} />
      )}
    </>
  );
}

/* ─── Control bar ─────────────────────────────────────────────── */

function ControlBar({
  isPlaying, direction, speed, currentTime, duration, fps, fpsDetected,
  frameNumber, totalFrames, isFullscreen,
  onTogglePlay, onSeek, onSpeedDown, onSpeedUp, onSlowMo, onToggleFullscreen,
}) {
  const isMoving =
    isPlaying || direction === 'reverse' || (direction === 'forward' && speed > 1);
  const rewindActive = direction === 'reverse';
  const ffActive = direction === 'forward' && speed > 1;
  const slomoActive = direction === 'forward' && speed < 1;
  return (
    <div className="VR-controls">
      <button
        type="button"
        className="VR-btn VR-btn--primary"
        onClick={onTogglePlay}
        title="Space"
        aria-label={isMoving ? 'Pause' : 'Play'}
      >
        {isMoving ? '⏸' : '▶'}
      </button>

      <button
        type="button"
        className={`VR-btn VR-btn--wind${rewindActive ? ' VR-btn--active' : ''}`}
        onClick={onSpeedDown}
        title="Rewind · 2× → 4× → 8× → 1×"
        aria-label="Rewind"
      >
        «
      </button>
      <button
        type="button"
        className={`VR-btn VR-btn--wind${ffActive ? ' VR-btn--active' : ''}`}
        onClick={onSpeedUp}
        title="Fast-forward · 2× → 4× → 8× → 1×"
        aria-label="Fast-forward"
      >
        »
      </button>
      <button
        type="button"
        className={`VR-btn VR-btn--slomo${slomoActive ? ' VR-btn--active' : ''}`}
        onClick={onSlowMo}
        title="Slow motion · 0.5× → 0.25× → 1×"
        aria-label="Slow motion"
      >
        ½
      </button>

      <input
        type="range"
        className="VR-scrubber"
        aria-label="Seek video"
        min={0}
        max={duration > 0 ? duration : 0.001}
        step="any"
        value={currentTime}
        onChange={(e) => onSeek(parseFloat(e.target.value))}
        style={{
          background: scrubberGradient(currentTime, duration),
        }}
      />

      <div className="VR-time mono">
        <div className="VR-time-row">
          <span className="VR-time-cur">{formatTime(currentTime)}</span>
          <span className="VR-time-sep">/</span>
          <span className="VR-time-tot">{formatTime(duration)}</span>
        </div>
        <div className="VR-time-frame">
          frame {frameNumber}{totalFrames > 0 ? ` / ${totalFrames}` : ''}
          {' · '}{fps}{fpsDetected ? '' : '?'} fps
        </div>
      </div>

      <button
        type="button"
        className="VR-btn"
        onClick={onToggleFullscreen}
        title="Fullscreen · F"
        aria-label="Toggle fullscreen"
      >
        {isFullscreen ? '⤡' : '⛶'}
      </button>
    </div>
  );
}

/* ─── helpers ──────────────────────────────────────────────────── */

// formatSize moved to src/utils/format.js (shared).

function pad(n, w = 2) {
  return String(n).padStart(w, '0');
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '00:00.000';
  const ms = Math.floor((seconds % 1) * 1000);
  const s = Math.floor(seconds % 60);
  const m = Math.floor((seconds / 60) % 60);
  const h = Math.floor(seconds / 3600);
  if (h > 0) return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(ms, 3)}`;
  return `${pad(m)}:${pad(s)}.${pad(ms, 3)}`;
}

function scrubberGradient(currentTime, duration) {
  const pct = duration > 0 ? Math.max(0, Math.min(100, (currentTime / duration) * 100)) : 0;
  return `linear-gradient(90deg, var(--accent) 0%, var(--accent) ${pct}%, #1a1f26 ${pct}%, #1a1f26 100%)`;
}

export default VideoReview;
