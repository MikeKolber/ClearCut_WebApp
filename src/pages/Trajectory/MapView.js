import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import TopBar from '../../components/TopBar/TopBar';
import { JumpTabs, getJumpTabs, LiveSimBadge } from './JumpTabs';
import Map3D from './Map3D';
import {
  loadTrajectoryOutput,
  listDebrisRuns,
  loadDebrisRun,
} from '../../services/api';
import {
  isTrajectoryFreshInSession,
  isDebrisFreshInSession,
} from './runState';
import EmptyState from './EmptyState';
import './MapView.css';

/* ═══ Map View — unified geo viewer ════════════════════════════════
 *
 *   Both the Globe (3D) and Flat (Mercator) modes render through
 *   Map3D (`Map3D.js`, deck.gl). The Globe / Flat radio in the
 *   sidebar switches the projection + camera behaviour; the debris
 *   layers (origins / impacts / 3-σ ellipses) and the sidebar UI are
 *   shared between the two modes.
 *
 *   Tiles: EOX Sentinel-2 + CARTO raster tiles (see Map3D.js).      */

/* `isTrajectoryFreshInSession` / `isDebrisFreshInSession` come from
   `./runState.js` — see that module for what each flag means. The
   short version: both reads from the same sessionStorage snapshot
   the Trajectory page writes; trajectory-fresh gates whether to
   load the ground track at all, debris-fresh gates the impact
   layer (a stale on-disk debris CSV from a previous session is
   suppressed until the user re-runs). */

function MapView() {
  const navigate = useNavigate();

  /* ── data ────────────────────────────────────────────────── */
  const [traj, setTraj] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [empty, setEmpty] = useState(null);

  /* ── debris data ──────────────────────────────────────────── */
  const [debris, setDebris] = useState(null);

  /* ── ui state ─────────────────────────────────────────────── */
  const [projection, setProjection] = useState('globe'); // 'globe' | 'mercator'
  const [showTrack, setShowTrack] = useState(true);     // 2D ground shadow
  const [showAltitude, setShowAltitude] = useState(true); // 3D trajectory line
  const [showOrigins, setShowOrigins] = useState(true);
  const [showImpacts, setShowImpacts] = useState(true);
  const [showEllipses, setShowEllipses] = useState(true);
  // The currently-selected failure-point row (number) or null. Drives
  // the dim-others / highlight-this paint behavior + camera fly-to from
  // the failure-points list. `userInitiated` flags whether to fly the
  // camera (true when the user clicked a list row, false when the
  // selection came from a map-pin click).
  const [selectedRow, setSelectedRow] = useState(null);

  /* ── playback (rocket follow-cam) ─────────────────────────── */
  // 'idle'    — not playing; no overlay layers
  // 'playing' — animation running; camera locked to rocket
  // 'paused'  — frozen at current frame; camera released
  const [playState, setPlayState] = useState('idle');
  const [playSpeed, setPlaySpeed] = useState(1);     // 1, 2, 4, 8
  // UI-only mirror of the progress; refreshed each frame so the
  // bar/time display update. The actual progress used by the loop
  // lives in `playProgressRef` to avoid React re-render churn.
  const [playProgressUI, setPlayProgressUI] = useState(0);

  /* ── refs ─────────────────────────────────────────────────── */
  // Map3D imperative ref — exposes fitToBounds / flyTo / reset so the
  // sidebar's Fit-to buttons work in either projection.
  const map3DRef = useRef(null);

  /* ── playback refs (60Hz state, kept out of React) ────────── */
  // 0..1 — fractional position along the trajectory
  const playProgressRef = useRef(0);
  const playRafRef = useRef(null);
  // Last time the React-visible progress mirror was refreshed (the
  // rAF loop throttles those updates to ~8 Hz).
  const lastUiUpdateRef = useRef(0);
  // Set when a play tick begins so we can compute "elapsed since
  // resume" without losing the prior progress on pause/play cycles.
  const playStartTimeRef = useRef(0);
  const playStartProgressRef = useRef(0);

  /* ── fetch trajectory + latest debris on mount ───────────── */
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setEmpty(null);

    /* Gate the trajectory fetch on session freshness. If the user
       hasn't run/loaded a sim in this session, the on-disk
       `simulation_output.csv` (if any) is from a previous session
       — showing it on the map would misrepresent the current state
       of the UI as "this is your trajectory" when nothing has
       actually been loaded. Bail early with the empty state. */
    if (!isTrajectoryFreshInSession()) {
      setEmpty('Run a simulation to see the trajectory map.');
      setLoading(false);
      return () => { cancelled = true; };
    }

    // Only fetch debris if the user explicitly ran it for the current
    // trajectory. Running a new trajectory sim resets `debrisDone` in
    // the persisted run-state, so the previous run's debris cleanly
    // disappears from the map until the user runs debris again.
    const debrisFresh = isDebrisFreshInSession();

    Promise.allSettled([
      loadTrajectoryOutput(),
      debrisFresh
        ? listDebrisRuns()
            .then((res) => {
              const newest = (res?.runs || [])[0];
              if (!newest?.id) return null;
              return loadDebrisRun(newest.id);
            })
            .catch(() => null)
        : Promise.resolve(null),
    ])
      .then(([trajRes, debrisRes]) => {
        if (cancelled) return;
        if (trajRes.status === 'fulfilled') {
          const d = trajRes.value;
          if (!d.exists) {
            setEmpty(d.message || 'No simulation output yet.');
          } else {
            setTraj(d);
          }
        } else {
          setError(trajRes.reason?.message || String(trajRes.reason));
        }
        if (debrisRes.status === 'fulfilled' && debrisRes.value) {
          setDebris(debrisRes.value);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, []);

  /* ── derived: ground-track coordinates [[lon, lat], …] ────── */
  const trackCoords = useMemo(() => {
    if (!traj?.columns) return null;
    const lat = traj.columns.lat_deg?.data;
    const lon = traj.columns.lon_deg?.data;
    if (!Array.isArray(lat) || !Array.isArray(lon)) return null;
    const n = Math.min(lat.length, lon.length);
    const out = [];
    for (let i = 0; i < n; i++) {
      const a = lat[i];
      const o = lon[i];
      if (a == null || o == null || !Number.isFinite(a) || !Number.isFinite(o)) continue;
      out.push([o, a]);
    }
    return out.length >= 2 ? out : null;
  }, [traj]);

  /* ── derived: 3D trajectory [[lon, lat, height_m], …] ────── */
  // Fed to Map3D's PathLayer when the user picks the Globe view —
  // height_m straight from the simulation. Values clamped to >= 0 so
  // any pre-launch noise doesn't drag the line below the surface.
  // We also build a parallel `trajectoryTimes` array (sim seconds at
  // each sample) so the playback panel can show "T+ 12.4 s" style
  // captions without re-deriving the trajectory.
  const trajectory3D = useMemo(() => {
    if (!traj?.columns) return null;
    const lat = traj.columns.lat_deg?.data;
    const lon = traj.columns.lon_deg?.data;
    const h   = traj.columns.height_m?.data;
    if (!Array.isArray(lat) || !Array.isArray(lon) || !Array.isArray(h)) return null;
    const n = Math.min(lat.length, lon.length, h.length);
    const out = [];
    for (let i = 0; i < n; i++) {
      const a = lat[i];
      const o = lon[i];
      const z = h[i];
      if (!Number.isFinite(a) || !Number.isFinite(o) || !Number.isFinite(z)) continue;
      out.push([o, a, Math.max(0, z)]);
    }
    return out.length >= 2 ? out : null;
  }, [traj]);

  // Sim-time (in seconds) at each surviving trajectory3D sample.
  // Indexes line up 1:1 so playback can map progress→time without
  // re-running the validity filter. Falls back to sample index if the
  // run somehow lacks a `time_s` column.
  const trajectoryTimes = useMemo(() => {
    if (!traj?.columns) return null;
    const lat = traj.columns.lat_deg?.data;
    const lon = traj.columns.lon_deg?.data;
    const h   = traj.columns.height_m?.data;
    const t   = traj.columns.time_s?.data;
    if (!Array.isArray(lat) || !Array.isArray(lon) || !Array.isArray(h)) return null;
    const n = Math.min(lat.length, lon.length, h.length);
    const out = [];
    for (let i = 0; i < n; i++) {
      if (!Number.isFinite(lat[i]) || !Number.isFinite(lon[i]) || !Number.isFinite(h[i])) continue;
      const ti = Array.isArray(t) ? t[i] : i;
      out.push(Number.isFinite(ti) ? ti : i);
    }
    return out.length >= 2 ? out : null;
  }, [traj]);

  // Cumulative 3D arc length (meters) at each trajectory3D sample.
  //
  //   Why? The simulation outputs samples that are *not* uniform in
  //   space — early in flight the rocket barely moves between two
  //   adjacent samples, while at apogee or descent the same sample
  //   step might cover tens of kilometers. If we played the
  //   animation by linearly stepping the sample index, the rocket
  //   would appear to slow-crawl off the pad and then *snap* to high
  //   speed mid-flight (which the user noticed). Parameterizing by
  //   arc length instead gives a constant-velocity feel: 1× plays
  //   the *whole* path at the same on-screen pace.
  //
  //   Distances are computed in meters using a flat-Earth lat/lon
  //   approximation per segment plus the altitude delta — accurate
  //   enough at the per-segment scale of a trajectory, and avoids
  //   the cost of full great-circle math at 60 Hz.
  const trajectoryDist = useMemo(() => {
    if (!trajectory3D || trajectory3D.length < 2) return null;
    const N = trajectory3D.length;
    const dist = new Float64Array(N);
    dist[0] = 0;
    for (let i = 1; i < N; i++) {
      const a = trajectory3D[i - 1];
      const b = trajectory3D[i];
      const cosLat = Math.cos((a[1] * Math.PI) / 180);
      // Wrap the longitude delta to [-180, 180] so that a sample at
      // lon=179 followed by lon=-179 (a normal antimeridian crossing
      // for any orbit) is recognized as a 2° step, not 358°. Without
      // this, every wrap injects a fake ~40,000 km jump into the
      // cumulative distance and `progressToIndex` skips wildly.
      let dLonDeg = b[0] - a[0];
      if (dLonDeg >  180) dLonDeg -= 360;
      else if (dLonDeg < -180) dLonDeg += 360;
      const dLatM = (b[1] - a[1]) * 111320;
      const dLonM = dLonDeg * 111320 * cosLat;
      const dAltM = b[2] - a[2];
      dist[i] = dist[i - 1] + Math.sqrt(dLatM * dLatM + dLonM * dLonM + dAltM * dAltM);
    }
    return dist;
  }, [trajectory3D]);

  // Launch site — first valid lat/lon of the run. Used as the camera
  // target on first load.
  const launchSite = useMemo(() => {
    if (!trackCoords || trackCoords.length === 0) return null;
    return trackCoords[0];   // [lon, lat]
  }, [trackCoords]);

  // Bounding box for the fit-to-trajectory button.
  const trackBounds = useMemo(() => {
    if (!trackCoords) return null;
    let minLon = Infinity, maxLon = -Infinity;
    let minLat = Infinity, maxLat = -Infinity;
    for (const [lon, lat] of trackCoords) {
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
    }
    if (!Number.isFinite(minLon)) return null;
    return [[minLon, minLat], [maxLon, maxLat]];
  }, [trackCoords]);

  /* ── debris GeoJSON features (origins / impacts / ellipses) ─── */
  const debrisFeatures = useMemo(() => {
    if (!debris?.rows?.length) {
      return { origins: null, impacts: null, ellipses: null, bounds: null };
    }

    const origins = [];
    const impacts = [];
    const ellipses = [];
    let minLon = Infinity, maxLon = -Infinity;
    let minLat = Infinity, maxLat = -Infinity;

    const expand = (lon, lat) => {
      if (lon == null || lat == null) return;
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) return;
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
    };

    for (const row of debris.rows) {
      const harmful = row.harmful_count || 0;

      // Origin pin
      if (row.lat != null && row.lon != null) {
        origins.push({
          type: 'Feature',
          properties: {
            row:           row.row,
            time_s:        row.time_s,
            altitude_m:    row.altitude_m,
            harmful:       harmful,
            impact_count:  (row.impacts || []).length,
            mean_speed:    row.mean_impact_speed,
            mean_distance: row.mean_impact_distance,
          },
          geometry: { type: 'Point', coordinates: [row.lon, row.lat] },
        });
        expand(row.lon, row.lat);
      }

      // 3-σ ellipse
      if (row.ellipse && row.lat != null && row.lon != null) {
        const ringCoords = ellipseToPolygon(
          row.lat, row.lon,
          row.ellipse.a_m, row.ellipse.b_m,
          row.ellipse.azimuth_deg
        );
        if (ringCoords) {
          ellipses.push({
            type: 'Feature',
            properties: {
              row:     row.row,
              harmful: harmful,
            },
            geometry: { type: 'Polygon', coordinates: [ringCoords] },
          });
          for (const [lon, lat] of ringCoords) expand(lon, lat);
        }
      }

      // Individual impact dots
      for (const imp of row.impacts || []) {
        if (imp.lat == null || imp.lon == null) continue;
        if (!Number.isFinite(imp.lat) || !Number.isFinite(imp.lon)) continue;
        impacts.push({
          type: 'Feature',
          properties: {
            row:       row.row,
            speed_mps: imp.speed_mps,
            mass_kg:   imp.mass_kg,
            ke_j:      imp.ke_j,
            // Booleans go through MapLibre's source serialization fine,
            // but a string is foolproof for the data-driven `case`.
            status:    imp.unharmed ? 'unharmed' : 'harmful',
          },
          geometry: { type: 'Point', coordinates: [imp.lon, imp.lat] },
        });
        expand(imp.lon, imp.lat);
      }
    }

    const bounds = Number.isFinite(minLon)
      ? [[minLon, minLat], [maxLon, maxLat]]
      : null;

    return {
      origins:  origins.length  ? { type: 'FeatureCollection', features: origins  } : null,
      impacts:  impacts.length  ? { type: 'FeatureCollection', features: impacts  } : null,
      ellipses: ellipses.length ? { type: 'FeatureCollection', features: ellipses } : null,
      bounds,
    };
  }, [debris]);

  // Combined bounds for the auto-fit on first load — picks whichever
  // data is available (debris alone, trajectory alone, or both).
  const allBounds = useMemo(() => {
    const t = trackBounds;
    const d = debrisFeatures.bounds;
    if (t && d) {
      return [
        [Math.min(t[0][0], d[0][0]), Math.min(t[0][1], d[0][1])],
        [Math.max(t[1][0], d[1][0]), Math.max(t[1][1], d[1][1])],
      ];
    }
    return t || d || null;
  }, [trackBounds, debrisFeatures.bounds]);

  /* All map rendering (Globe + Flat) is handled by Map3D (deck.gl).
     The old MapLibre engine for the Flat view was removed after
     MapLibre 5.x shipped unfixable production errors on the CDN
     build — Map3D was extended to cover mercator instead. */

  /* ── auto-fit Map3D to launch site on first load ──────────── */
  // Map3D internally fly-to launch on its own first data load too,
  // but we also want a clean initial frame when toggling Globe ⇄ Flat
  // mid-session: any time the globe engine mounts and we already have
  // a launch site, fly there. Map3D guards against repeated auto-fits.
  // (The actual logic lives inside Map3D — this is just a hook.)

  /* ── handlers ─────────────────────────────────────────────── */
  // Camera-control dispatchers. Map3D handles both projections, so
  // these no longer branch on projection mode.
  const fitTo = (bounds, maxZoom = 7) => {
    if (!bounds) return;
    map3DRef.current?.fitToBounds(bounds, { maxZoom });
  };
  const fitToTrajectory = () => fitTo(trackBounds, 7);
  const fitToDebris     = () => fitTo(debrisFeatures.bounds, 13);
  const fitToAll        = () => fitTo(allBounds, 7);

  // Mirror of `selectedRow` accessible from event handlers without the
  // stale-closure problem (handlers are attached inside a useEffect).
  const selectedRowRef = useRef(null);
  useEffect(() => { selectedRowRef.current = selectedRow; }, [selectedRow]);

  /**
   * Toggle selection of a failure-point row. When `fly === true` (the
   * default; used by sidebar list clicks), the camera flies to the row's
   * mean impact center (or origin if mean is missing). When called with
   * `fly: false` (used by clicks on map pins), the camera stays put —
   * the user already moved their viewport to find that pin.
   */
  const selectRow = (row, { fly = true } = {}) => {
    if (!row) return;
    const isClearing = selectedRowRef.current === row.row;
    setSelectedRow(isClearing ? null : row.row);
    if (isClearing || !fly) return;
    const lat = row.mean_impact_lat ?? row.lat;
    const lon = row.mean_impact_lon ?? row.lon;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
    map3DRef.current?.flyTo({ longitude: lon, latitude: lat, zoom: 9 });
  };

  const resetView = () => {
    setSelectedRow(null);
    map3DRef.current?.reset();
  };

  /* ═══ Playback (rocket follow-cam) ════════════════════════════
   *
   *   The play button traces the rocket along its actual flight path
   *   while keeping the camera locked to the rocket's current 3D
   *   position — so as the vehicle ascends, the view rises with it.
   *
   *   Globe (Map3D) has true altitude tracking: lon/lat follow the
   *   sub-rocket point and zoom pulls back as height climbs, so the
   *   rocket stays roughly centered and the receding planet sells the
   *   altitude visually. Mercator (MapLibre) follows just the ground
   *   shadow (no z to track).
   *
   *   The animation runs entirely off `requestAnimationFrame`, with
   *   per-frame camera + layer mutations going *imperatively* into the
   *   active map engine to stay clear of React's render path. */

  // Total simulated seconds (last sample's `time_s`, or 0 if missing).
  const totalSimTime = useMemo(() => {
    if (!trajectoryTimes || trajectoryTimes.length < 2) return 0;
    return trajectoryTimes[trajectoryTimes.length - 1];
  }, [trajectoryTimes]);

  // Sim seconds at the playback head — uses the same arc-length
  // parameterization as `applyPlaybackFrame` so the timecode advances
  // in lockstep with the rocket's on-screen position. (A purely
  // linear progress→time map would say "T+ 200s" while the rocket is
  // visually only a fifth of the way through the trace.)
  const currentSimTime = useMemo(() => {
    if (!trajectoryTimes || trajectoryTimes.length < 2 || !trajectoryDist) return 0;
    const { i0, i1, f } = progressToIndex(playProgressUI, trajectoryDist);
    const t0 = trajectoryTimes[i0] ?? 0;
    const t1 = trajectoryTimes[i1] ?? t0;
    return t0 + (t1 - t0) * f;
  }, [playProgressUI, trajectoryTimes, trajectoryDist]);

  // Map zoom from rocket altitude — closer when on the pad, farther
  // out at orbital altitudes. Range is intentionally compressed
  // (3 ≈ continent / 6.5 ≈ country): every additional pyramid level
  // we sweep through means the basemap has to fetch + rasterize a
  // fresh set of tiles, which manifests as zoom-lag during playback.
  // 3 levels of swing is enough altitude tracking to feel right
  // without thrashing the tile cache.
  const zoomForAltitude = (altMeters) => {
    const altKm = Math.max(0.05, (altMeters || 0) / 1000);
    return Math.max(3, Math.min(6.5, 6.5 - Math.log2(altKm + 1) * 0.45));
  };

  // Last bearing we sent to the camera. Smoothed so it doesn't jitter
  // when the trajectory has a kink (a stage cutoff, a course change).
  const lastBearingRef = useRef(0);
  // Inertial copy of the camera zoom — each frame we lerp toward the
  // altitude-driven target instead of snapping. Keeps tile-pyramid
  // changes smooth and predictable even when the rocket suddenly
  // accelerates upward (e.g. stage 3 ignition).
  const zoomSmoothRef = useRef(6);

  // Per-i0 cache of the decimated playback trail (see
  // applyPlaybackFrame) — avoids re-slicing the full trajectory
  // on every animation frame. Reset whenever the trajectory data
  // itself changes so a newly-loaded run can't serve stale points.
  const trailCacheRef = useRef({ i0: -1, trail: null });
  useEffect(() => {
    trailCacheRef.current = { i0: -1, trail: null };
  }, [trajectory3D]);

  // ── apply one frame to whichever engine is active ───────────
  // `p` ∈ [0, 1]. We map progress to a position via *cumulative arc
  // length* (not linear sample-index) so the rocket moves at a
  // constant on-screen speed for the entire flight — same pace
  // during slow vertical ascent as during fast apogee/descent.
  const applyPlaybackFrame = useCallback((p) => {
    if (!trajectory3D || trajectory3D.length < 2 || !trajectoryDist) return;
    const N = trajectory3D.length;
    const { i0, i1, f } = progressToIndex(p, trajectoryDist);
    const a = trajectory3D[i0];
    const b = trajectory3D[i1];

    // Antimeridian-aware longitude lerp: if the next sample is on
    // the other side of the dateline, take the short way around the
    // sphere — otherwise the interpolated rocket marker teleports
    // through lon=0 mid-step (visible as a "sharp turn" sweep across
    // an entire hemisphere).
    let dLon = b[0] - a[0];
    if (dLon >  180) dLon -= 360;
    else if (dLon < -180) dLon += 360;
    let lon = a[0] + dLon * f;
    if (lon >  180) lon -= 360;
    else if (lon < -180) lon += 360;

    const lat = a[1] + (b[1] - a[1]) * f;
    const alt = a[2] + (b[2] - a[2]) * f;

    // Camera bearing — initial heading of the segment ahead of us, in
    // degrees clockwise from north. Smoothed via exponential lerp so
    // the view rotates calmly into stage-changes instead of snapping.
    const lookahead = Math.min(N - 1, i0 + 4);
    const heading = bearingDeg(
      trajectory3D[i0][1], trajectory3D[i0][0],
      trajectory3D[lookahead][1], trajectory3D[lookahead][0],
    );
    const prev = lastBearingRef.current;
    let smooth = prev + 0.08 * shortestAngleDelta(prev, heading);
    smooth = ((smooth % 360) + 360) % 360;
    lastBearingRef.current = smooth;

    // Sin-driven pulse used for the rocket halos — finishes a full
    // breath every ~1.7 s for a calm, deliberate beacon feel.
    const pulse = 1 + 0.18 * Math.sin(performance.now() / 280);

    // Map3D handles both projections — only difference is the camera
    // pose (3D pitch+follow in globe, top-down at fixed zoom in
    // mercator). The trail/rocket-overlay payload is identical.
    //
    // Trail construction is the per-frame hot spot: a naive
    // `slice(0, i0 + 1)` re-allocates an ever-growing array (10k+
    // points late in flight) 60 times a second. Instead the base
    // trail is (a) decimated to a bounded vertex count — deck.gl
    // draws a visually identical comet tail from ~1.5k points — and
    // (b) cached per `i0`, so per frame we only copy the bounded
    // array to append the interpolated tip.
    const MAX_TRAIL_POINTS = 1500;
    let base = trailCacheRef.current.i0 === i0
      ? trailCacheRef.current.trail
      : null;
    if (!base) {
      const count = i0 + 1;
      if (count <= MAX_TRAIL_POINTS) {
        base = trajectory3D.slice(0, count);
      } else {
        const stride = Math.ceil(count / MAX_TRAIL_POINTS);
        base = [];
        for (let i = 0; i < count; i += stride) base.push(trajectory3D[i]);
        if (base[base.length - 1] !== trajectory3D[i0]) {
          base.push(trajectory3D[i0]);
        }
      }
      trailCacheRef.current = { i0, trail: base };
    }
    const trail = (f > 0 && i0 < N - 1)
      ? [...base, [lon, lat, alt]]
      : base;

    if (projection === 'globe') {
      // Smooth zoom toward the altitude target. Two-stage smoothing:
      //   (1) lerp at 12% per frame closes small gaps gracefully.
      //   (2) clamp the per-frame delta to ZOOM_MAX_DELTA so even a
      //       big initial gap (e.g. play-start or after a scrub)
      //       moves at a calm cinematic pace instead of mouse-wheel
      //       snap. ~0.0067/frame ≈ 0.4 zoom levels per second at 60Hz —
      //       very gentle, almost imperceptible until you watch a few
      //       seconds of playback.
      const ZOOM_MAX_DELTA = 0.0067;
      const targetZoom = zoomForAltitude(alt);
      const wantDelta = (targetZoom - zoomSmoothRef.current) * 0.12;
      const clampedDelta =
        Math.sign(wantDelta) *
        Math.min(Math.abs(wantDelta), ZOOM_MAX_DELTA);
      const smoothZoom = zoomSmoothRef.current + clampedDelta;
      zoomSmoothRef.current = smoothZoom;

      map3DRef.current?.setPlaybackView({
        longitude: lon,
        latitude:  lat,
        zoom:      smoothZoom,
        pitch:     60,
        bearing:   smooth,
      });
    } else {
      // 2D playback: hold the camera at a wide whole-world zoom so
      // the entire orbital ground track is visible at once. (We
      // still keep `center` tracking the rocket so it stays in view,
      // but at zoom ~1.5 you can see ~half the planet either way of
      // the rocket's current sub-point.) Bearing is locked to north
      // because rotation at wide zoom is disorienting.
      map3DRef.current?.setPlaybackView({
        longitude: lon,
        latitude:  lat,
        zoom:      1.5,
        pitch:     0,
        bearing:   0,
      });
    }

    map3DRef.current?.setPlaybackOverlay({
      trail,
      rocketPos: [lon, lat, alt],
      pulse,
    });
  }, [trajectory3D, trajectoryDist, projection]);

  // Drop the playback overlay from Map3D. Called on Stop / unmount /
  // projection-switch.
  const clearPlaybackOverlays = useCallback(() => {
    map3DRef.current?.clearPlayback();
  }, []);

  /* ── animation loop ───────────────────────────────────────── */
  //
  // Playback duration scales with the trajectory's *spatial* extent
  // rather than its time extent, so the rocket dot moves across the
  // screen at a roughly constant visual velocity regardless of how
  // long the simulation lasted. The previous version locked playback
  // at 240 s flat, which meant a 300-second suborbital with a tiny
  // ground track crawled — same wall-clock, much less ground to
  // cover, so the dot looked stuck. Now: total arc length / target
  // speed = wall-clock duration. A typical full-orbit run (~40,000
  // km) lands near the previous 240 s feel; shorter runs play
  // proportionally faster, longer ones slower, with min/max clamps
  // at the extremes so neither end becomes unwatchable.
  //
  //   PLAYBACK_TARGET_ARC_PER_SEC_M = arc-length advance per real
  //   second at 1×. Higher value → faster playback. 167 km/s of
  //   arc maps the previous 40,000 km / 240 s reference exactly.
  //
  // Speed multipliers still compress proportionally:
  //   1× → baseDur   2× → baseDur/2   4× → baseDur/4   8× → baseDur/8
  const PLAYBACK_TARGET_ARC_PER_SEC_M = 167_000;
  const PLAYBACK_MIN_DURATION_SEC = 25;   // even sub-orbital hops get this
  const PLAYBACK_MAX_DURATION_SEC = 300;  // even multi-orbit runs cap here

  useEffect(() => {
    if (playState !== 'playing') return undefined;
    if (!trajectory3D || trajectory3D.length < 2) return undefined;

    /* Pick a base duration sized to this trajectory's arc length. */
    const totalArcM = trajectoryDist
      ? trajectoryDist[trajectoryDist.length - 1] || 0
      : 0;
    const idealDurationSec = totalArcM > 0
      ? totalArcM / PLAYBACK_TARGET_ARC_PER_SEC_M
      : PLAYBACK_MAX_DURATION_SEC;
    const baseDurationSec = Math.max(
      PLAYBACK_MIN_DURATION_SEC,
      Math.min(PLAYBACK_MAX_DURATION_SEC, idealDurationSec),
    );
    const playbackDurationMs = (baseDurationSec * 1000) / playSpeed;

    playStartTimeRef.current = performance.now();
    playStartProgressRef.current = playProgressRef.current;

    const tick = (now) => {
      const elapsed = now - playStartTimeRef.current;
      const remaining = 1 - playStartProgressRef.current;
      let progress = playStartProgressRef.current + (elapsed / playbackDurationMs) * remaining;

      if (progress >= 1) {
        progress = 1;
        applyPlaybackFrame(progress);
        playProgressRef.current = 1;
        setPlayProgressUI(1);
        // End-of-flight: drop into idle but leave the final overlay
        // visible so the user can still see where the rocket ended up.
        setPlayState('paused');
        return;
      }

      playProgressRef.current = progress;
      applyPlaybackFrame(progress);
      // The sidebar progress bar/time display doesn't need 60 fps —
      // updating React state every frame re-renders the whole sidebar
      // at animation rate. ~8 Hz is visually indistinguishable on a
      // minutes-long playback.
      if (now - lastUiUpdateRef.current > 120) {
        lastUiUpdateRef.current = now;
        setPlayProgressUI(progress);
      }
      playRafRef.current = requestAnimationFrame(tick);
    };

    playRafRef.current = requestAnimationFrame(tick);

    return () => {
      if (playRafRef.current) {
        cancelAnimationFrame(playRafRef.current);
        playRafRef.current = null;
      }
    };
  }, [playState, playSpeed, applyPlaybackFrame, trajectory3D, trajectoryDist]);

  // When the user toggles Globe ⇄ Flat mid-playback, Map3D rebuilds
  // its deck.gl instance with the new view. We defer one frame so the
  // new instance is mounted, then re-apply the current frame so the
  // trail/rocket reappear on the new view immediately.
  useEffect(() => {
    if (playState === 'idle') return;
    const id = window.requestAnimationFrame(() => {
      applyPlaybackFrame(playProgressRef.current);
    });
    return () => window.cancelAnimationFrame(id);
  }, [projection, applyPlaybackFrame, playState]);

  /* ── playback control handlers ────────────────────────────── */
  const handlePlay = () => {
    if (!trajectory3D || trajectory3D.length < 2) return;
    if (playState === 'playing') {
      setPlayState('paused');
      return;
    }
    // First-time start (or resume from a stopped state): jump the
    // camera to the launch site so the trace begins right at lift-off.
    if (playProgressRef.current === 0 || playProgressRef.current >= 1) {
      playProgressRef.current = 0;
      setPlayProgressUI(0);
      // Reset the inertial zoom to the playback range's "near" end —
      // the rocket starts on the pad. This keeps the very first
      // frames of the lerp from chasing a target far from where we
      // start, which would briefly show in-between pyramid levels.
      zoomSmoothRef.current = 6;
      if (launchSite) {
        // Fly in at the same zoom the playback frames will use
        // immediately after — eliminates a pyramid-level sweep on
        // the first second of every play.
        map3DRef.current?.flyTo({
          longitude: launchSite[0],
          latitude:  launchSite[1],
          zoom:      projection === 'globe' ? 6 : 1.5,
          pitch:     projection === 'globe' ? 60 : 0,
        });
      }
    }
    setPlayState('playing');
  };

  const handleStop = () => {
    setPlayState('idle');
    playProgressRef.current = 0;
    setPlayProgressUI(0);
    zoomSmoothRef.current = 6;
    clearPlaybackOverlays();
  };

  // Clicking EXIT should always succeed, even mid-playback. We stop
  // the rAF loop + clear overlays first so React's unmount of this
  // page isn't fighting a still-active animation, then navigate.
  const handleExit = () => {
    if (playRafRef.current) {
      cancelAnimationFrame(playRafRef.current);
      playRafRef.current = null;
    }
    if (playState !== 'idle') {
      // Imperatively clear overlays — setting state alone wouldn't be
      // observed before the route change unmounts us.
      try { clearPlaybackOverlays(); } catch { /* ignore */ }
    }
    navigate('/trajectory');
  };

  // Defensive cleanup on unmount — covers Esc-to-landing and any
  // other route change that doesn't go through the EXIT button.
  // Without this, a user pressing Esc mid-playback can leave the
  // rAF loop holding references to the (already-destroyed) deck.gl
  // instance, which surfaces as the page appearing "stuck".
  useEffect(() => {
    return () => {
      if (playRafRef.current) {
        cancelAnimationFrame(playRafRef.current);
        playRafRef.current = null;
      }
    };
  }, []);

  const handleSeek = (p) => {
    const clamped = Math.max(0, Math.min(1, p));
    playProgressRef.current = clamped;
    setPlayProgressUI(clamped);
    // Snap zoomSmoothRef to whatever the target zoom *should* be at
    // this scrubbed-to position so the very next applyPlaybackFrame
    // doesn't lerp through a dozen pyramid levels to catch up.
    if (trajectory3D && trajectoryDist) {
      const { i0, i1, f } = progressToIndex(clamped, trajectoryDist);
      const a = trajectory3D[i0];
      const b = trajectory3D[i1];
      const alt = a[2] + (b[2] - a[2]) * f;
      zoomSmoothRef.current = zoomForAltitude(alt);
    }
    applyPlaybackFrame(clamped);
  };

  // Cleanup on unmount.
  useEffect(() => () => clearPlaybackOverlays(), [clearPlaybackOverlays]);

  /* ── status text shown in the TopBar ──────────────────────── */
  const statusText = useMemo(() => {
    if (loading) return 'Loading…';
    if (error) return `⚠ ${error}`;
    if (empty) return 'No data';
    if (traj) {
      const rows = (traj.row_count || 0).toLocaleString();
      const t = traj.run_meta?.config?.simulation_time;
      return `${rows} pts${t ? ` · ${t} s` : ''}`;
    }
    return '';
  }, [loading, error, empty, traj]);

  /* ── render ───────────────────────────────────────────────── */
  return (
    <>
      <TopBar
        onBack={handleExit}
        backLabel="EXIT"
        backPosition="right"
        leftExtras={
          <>
            <JumpTabs
              tabs={getJumpTabs({
                navigate,
                // Map View tab is the current page — clicking is a no-op.
                onMapClick: () => { /* already here */ },
              })}
              activeKey="map"
            />
            <LiveSimBadge />
          </>
        }
        right={
          <span className={`MV-status mono${error ? ' MV-status--err' : ''}`}>
            {statusText}
          </span>
        }
      />

      <div className="MV-main">
        {/* Sidebar */}
        <aside className="MV-sidebar">
          <RunInfo traj={traj} loading={loading} empty={empty} />

          <Section title="View">
            <RadioRow
              checked={projection === 'globe'}
              label="Globe"
              hint="3D · best for full mission"
              onChange={() => setProjection('globe')}
            />
            <RadioRow
              checked={projection === 'mercator'}
              label="Flat"
              hint="2D · best for impact zoom"
              onChange={() => setProjection('mercator')}
            />
          </Section>

          <Section title="Layers">
            {/* The trajectory toggle is mode-aware: in Globe it controls
                the 3D arc (Map3D), in Flat it controls the surface
                ground track (MapLibre). Only the relevant one renders. */}
            {projection === 'globe' ? (
              <CheckRow
                checked={showAltitude}
                disabled={!trajectory3D}
                onChange={() => setShowAltitude((v) => !v)}
                label="Trajectory (3D)"
                hint={!trajectory3D ? 'No data' : undefined}
                dot="#95d5ff"
              />
            ) : (
              <CheckRow
                checked={showTrack}
                onChange={() => setShowTrack((v) => !v)}
                label="Trajectory (surface)"
                dot="#80c8f0"
              />
            )}
            <CheckRow
              checked={showOrigins}
              disabled={!debrisFeatures.origins}
              onChange={() => setShowOrigins((v) => !v)}
              label="Debris origins"
              hint={!debrisFeatures.origins ? 'No debris run' : undefined}
              dot="#f59e0b"
            />
            <CheckRow
              checked={showImpacts}
              disabled={!debrisFeatures.impacts}
              onChange={() => setShowImpacts((v) => !v)}
              label="Debris impacts"
              hint={!debrisFeatures.impacts ? 'No debris run' : undefined}
              dot="#a78bfa"
            />
            <CheckRow
              checked={showEllipses}
              disabled={!debrisFeatures.ellipses}
              onChange={() => setShowEllipses((v) => !v)}
              label="3-σ ellipses"
              hint={!debrisFeatures.ellipses ? 'No debris run' : undefined}
              dot="#ef4444"
            />
          </Section>

          {debris && (
            <DebrisStats debris={debris} />
          )}

          {debris?.rows?.length > 0 && (
            <FailurePointsList
              rows={debris.rows}
              selected={selectedRow}
              onSelect={(row) => selectRow(row, { fly: true })}
            />
          )}

          <Section title="Fit to">
            <button
              type="button"
              className="MV-fitBtn"
              onClick={fitToTrajectory}
              disabled={!trackBounds}
              title="Frame the whole trajectory"
            >
              Trajectory
            </button>
            <button
              type="button"
              className="MV-fitBtn"
              onClick={fitToDebris}
              disabled={!debrisFeatures.bounds}
              title={debrisFeatures.bounds ? 'Frame the debris dispersion area' : 'Run debris analysis first'}
            >
              Debris
            </button>
            <button
              type="button"
              className="MV-fitBtn"
              onClick={fitToAll}
              disabled={!allBounds}
              title="Frame trajectory + debris together"
            >
              All
            </button>
            <button
              type="button"
              className="MV-fitBtn MV-fitBtn--ghost"
              onClick={resetView}
              title="Reset to default view"
            >
              Reset
            </button>
          </Section>
        </aside>

        {/* Map canvas — single deck.gl-based component handles both
            Globe (3D) and Flat (mercator 2D) modes via its `projection`
            prop. The deck instance is rebuilt when the user flips the
            Globe/Flat radio (cheap because tiles are HTTP-cached). */}
        <section className="MV-canvas-wrap">
          {empty ? (
            <div className="MV-empty">
              <EmptyState
                title="No simulation loaded"
                body={empty}
                hint="Run Trajectory Simulation"
              />
            </div>
          ) : (
            <>
              <Map3D
                ref={map3DRef}
                visible
                projection={projection}
                trajectory3D={trajectory3D}
                debrisFeatures={debrisFeatures}
                launchSite={launchSite}
                selectedRow={selectedRow}
                /* Hide the static blue arc while playback is running
                   or paused — at self-intersections it overlaps the
                   live orange trace and makes it look like the
                   rocket "jumped" arms. Stop puts state back to
                   'idle' and the full arc reappears. Also honour the
                   user's "Show track" toggle in the sidebar. */
                showAltitude={showAltitude && showTrack && playState === 'idle'}
                showOrigins={showOrigins && !!debrisFeatures.origins}
                showImpacts={showImpacts && !!debrisFeatures.impacts}
                showEllipses={showEllipses && !!debrisFeatures.ellipses}
                onSelectRow={(rowNum) => {
                  const row = (debris?.rows || []).find((r) => r.row === rowNum);
                  if (row) selectRow(row, { fly: false });
                }}
              />

              {trajectory3D && (
                <PlaybackPanel
                  state={playState}
                  speed={playSpeed}
                  progress={playProgressUI}
                  currentSimTime={currentSimTime}
                  totalSimTime={totalSimTime}
                  onPlay={handlePlay}
                  onStop={handleStop}
                  onSeek={handleSeek}
                  onSetSpeed={setPlaySpeed}
                />
              )}
            </>
          )}
        </section>
      </div>
    </>
  );
}

/* ═══ Playback panel ═══════════════════════════════════════════
 *
 *   Floating control bar pinned to the bottom of the map. Play /
 *   pause / stop, a clickable progress scrubber, the current sim
 *   timecode, and 1× / 2× / 4× / 8× speed pills (mirroring the
 *   video review module).
 */

function PlaybackPanel({
  state,
  speed,
  progress,
  currentSimTime,
  totalSimTime,
  onPlay,
  onStop,
  onSeek,
  onSetSpeed,
}) {
  const barRef = useRef(null);
  const seekDraggingRef = useRef(false);

  const handleBarPoint = (e) => {
    const el = barRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const ratio = (e.clientX - rect.left) / Math.max(1, rect.width);
    onSeek(ratio);
  };

  const handleBarMouseDown = (e) => {
    seekDraggingRef.current = true;
    handleBarPoint(e);
    const onMove = (ev) => { if (seekDraggingRef.current) handleBarPoint(ev); };
    const onUp = () => {
      seekDraggingRef.current = false;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  return (
    <div className="MV-playback" role="region" aria-label="Trajectory playback">
      <button
        type="button"
        className={`MV-pb-btn MV-pb-play${state === 'playing' ? ' MV-pb-play--on' : ''}`}
        onClick={onPlay}
        title={state === 'playing' ? 'Pause' : 'Play'}
        aria-label={state === 'playing' ? 'Pause' : 'Play'}
      >
        {state === 'playing' ? (
          // Pause icon
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden>
            <rect x="6" y="5" width="4" height="14" rx="1" fill="currentColor" />
            <rect x="14" y="5" width="4" height="14" rx="1" fill="currentColor" />
          </svg>
        ) : (
          // Play icon
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden>
            <path d="M8 5v14l11-7L8 5z" fill="currentColor" />
          </svg>
        )}
      </button>

      <button
        type="button"
        className="MV-pb-btn MV-pb-stop"
        onClick={onStop}
        disabled={state === 'idle' && progress === 0}
        title="Stop and reset to launch"
        aria-label="Stop"
      >
        <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden>
          <rect x="6" y="6" width="12" height="12" rx="1" fill="currentColor" />
        </svg>
      </button>

      <div
        ref={barRef}
        className="MV-pb-bar"
        onMouseDown={handleBarMouseDown}
        role="slider"
        aria-label="Seek"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(progress * 100)}
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'ArrowLeft')  onSeek(Math.max(0, progress - 0.02));
          if (e.key === 'ArrowRight') onSeek(Math.min(1, progress + 0.02));
        }}
      >
        <div className="MV-pb-bar-fill" style={{ width: `${progress * 100}%` }} />
        <div className="MV-pb-bar-handle" style={{ left: `${progress * 100}%` }} />
      </div>

      <span className="MV-pb-time mono">
        T+ {formatPlaybackTime(currentSimTime)}
        <span className="MV-pb-time-sep">/</span>
        {formatPlaybackTime(totalSimTime)}
      </span>

      <div className="MV-pb-speeds" role="group" aria-label="Playback speed">
        {[1, 2, 4, 8].map((s) => (
          <button
            key={s}
            type="button"
            className={`MV-pb-speed${speed === s ? ' MV-pb-speed--on' : ''}`}
            onClick={() => onSetSpeed(s)}
            title={`${s}× playback speed`}
          >
            {s}×
          </button>
        ))}
      </div>
    </div>
  );
}

function formatPlaybackTime(seconds) {
  if (!Number.isFinite(seconds)) return '0:00.0';
  const sign = seconds < 0 ? '-' : '';
  const t = Math.abs(seconds);
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${sign}${m}:${s.toFixed(1).padStart(4, '0')}`;
}

/* ═══ Sidebar bits ════════════════════════════════════════════ */

function RunInfo({ traj, loading, empty }) {
  if (loading) {
    return (
      <div className="MV-runinfo MV-runinfo--dim">
        <span className="eyebrow">Run Info</span>
        <span className="MV-runinfo-status mono">{'// loading…'}</span>
      </div>
    );
  }
  if (empty || !traj) {
    return (
      <div className="MV-runinfo MV-runinfo--dim">
        <span className="eyebrow">Run Info</span>
        <span className="MV-runinfo-status mono">{'// no run yet'}</span>
      </div>
    );
  }
  const cfg = traj.run_meta?.config || {};
  const finishedAt = traj.run_meta?.finished_at;
  const lat = cfg.lat_launch;
  const lon = cfg.lon_launch;
  return (
    <div className="MV-runinfo">
      <span className="eyebrow">Run Info</span>
      <div className="MV-runinfo-grid mono">
        {cfg.simulation_time != null && (
          <>
            <span className="MV-runinfo-key">Sim time</span>
            <span className="MV-runinfo-val">{cfg.simulation_time} s</span>
          </>
        )}
        {cfg.no_of_stages != null && (
          <>
            <span className="MV-runinfo-key">Stages</span>
            <span className="MV-runinfo-val">{cfg.no_of_stages}</span>
          </>
        )}
        {(lat != null && lon != null) && (
          <>
            <span className="MV-runinfo-key">Launch</span>
            <span className="MV-runinfo-val">
              {Number(lat).toFixed(2)}°, {Number(lon).toFixed(2)}°
            </span>
          </>
        )}
        {finishedAt && (
          <>
            <span className="MV-runinfo-key">Finished</span>
            <span className="MV-runinfo-val">{formatTimestamp(finishedAt)}</span>
          </>
        )}
      </div>
    </div>
  );
}

function FailurePointsList({ rows, selected, onSelect }) {
  const containerRef = useRef(null);
  // When selection changes (e.g. user clicked a map pin), scroll the
  // matching list row into view so the visual sync is two-way.
  useEffect(() => {
    if (selected == null || !containerRef.current) return;
    const el = containerRef.current.querySelector(`[data-row="${selected}"]`);
    if (el) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [selected]);

  if (!rows?.length) return null;

  return (
    <div className="MV-section MV-fpsection">
      <header className="MV-section-head">
        <span className="eyebrow">Failure Points</span>
        <span className="MV-section-count mono">{rows.length}</span>
      </header>
      <ul className="MV-fplist" ref={containerRef}>
        {rows.map((row) => {
          const isSelected = selected === row.row;
          const harmful = row.harmful_count || 0;
          const impacts = (row.impacts || []).length;
          return (
            <li key={row.row}>
              <button
                type="button"
                data-row={row.row}
                className={
                  'MV-fp' +
                  (isSelected ? ' MV-fp--on' : '') +
                  (harmful > 0 ? ' MV-fp--harmful' : '')
                }
                onClick={() => onSelect(row)}
                title={`Row ${row.row} · click to fly camera here`}
              >
                <span className="MV-fp-num mono">#{String(row.row).padStart(2, '0')}</span>
                <span className="MV-fp-time mono">
                  {row.time_s != null ? `${row.time_s.toFixed(1)}s` : '—'}
                </span>
                <span className="MV-fp-stats mono">
                  <span>{impacts}<span className="MV-fp-stats-unit">imp</span></span>
                  <span className={harmful > 0 ? 'MV-pop-harmful' : ''}>
                    {harmful}<span className="MV-fp-stats-unit">harm</span>
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function DebrisStats({ debris }) {
  const t = debris?.totals || {};
  return (
    <div className="MV-debrisstats">
      <span className="eyebrow">Debris</span>
      <div className="MV-debrisstats-grid mono">
        <span className="MV-runinfo-key">Failure pts</span>
        <span className="MV-runinfo-val">{t.rows ?? '—'}</span>
        <span className="MV-runinfo-key">Impacts</span>
        <span className="MV-runinfo-val">{t.impacts ?? '—'}</span>
        <span className="MV-runinfo-key">Harmful</span>
        <span className={`MV-runinfo-val ${(t.harmful || 0) > 0 ? 'MV-pop-harmful' : ''}`}>
          {t.harmful ?? 0}
        </span>
      </div>
    </div>
  );
}

function Section({ title, children }) {
  return (
    <div className="MV-section">
      <header className="MV-section-head">
        <span className="eyebrow">{title}</span>
      </header>
      <div className="MV-section-body">{children}</div>
    </div>
  );
}

function CheckRow({ checked, onChange, label, hint, dot, disabled = false }) {
  return (
    <label className={`MV-row${disabled ? ' MV-row--disabled' : ''}${checked ? ' MV-row--on' : ''}`}>
      <input
        type="checkbox"
        className="MV-row-cb"
        checked={!!checked}
        onChange={onChange}
        disabled={disabled}
      />
      {dot && (
        <span
          className="MV-row-dot"
          style={{ background: dot, boxShadow: checked ? `0 0 8px ${dot}` : 'none' }}
        />
      )}
      <span className="MV-row-label">{label}</span>
      {hint && <span className="MV-row-hint mono">{hint}</span>}
    </label>
  );
}

function RadioRow({ checked, label, hint, onChange }) {
  return (
    <label className={`MV-row MV-row--radio${checked ? ' MV-row--on' : ''}`}>
      <input
        type="radio"
        className="MV-row-cb MV-row-cb--radio"
        checked={!!checked}
        onChange={onChange}
      />
      <span className="MV-row-label">{label}</span>
      {hint && <span className="MV-row-hint mono">{hint}</span>}
    </label>
  );
}

/* ─── helpers ──────────────────────────────────────────────── */

function formatTimestamp(s) {
  if (!s) return '—';
  try {
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) return s;
    return d.toLocaleString(undefined, {
      month: 'short', day: '2-digit',
      hour: '2-digit', minute: '2-digit',
    });
  } catch {
    return s;
  }
}

/**
 * Convert a 3-σ dispersion ellipse (semi-major a, semi-minor b in meters,
 * azimuth in degrees clockwise from north) at a (lat, lon) center into a
 * GeoJSON polygon ring. Uses a flat-Earth meters-per-degree approximation
 * — fine for 3-σ ellipses, which are typically <10 km across.
 *
 * Returns an array of `[lon, lat]` pairs ready to feed into a GeoJSON
 * `Polygon` `coordinates[0]`. Returns null if any required input is bad.
 */
function ellipseToPolygon(centerLat, centerLon, aMeters, bMeters, azimuthDeg, npoints = 64) {
  if (!Number.isFinite(centerLat) || !Number.isFinite(centerLon)) return null;
  if (!Number.isFinite(aMeters) || !Number.isFinite(bMeters)) return null;
  if (!Number.isFinite(azimuthDeg)) return null;
  if (aMeters <= 0 || bMeters <= 0) return null;

  const azRad = (azimuthDeg * Math.PI) / 180;
  const cosAz = Math.cos(azRad);
  const sinAz = Math.sin(azRad);
  const metersPerDegLat = 111320;
  const metersPerDegLon = 111320 * Math.cos((centerLat * Math.PI) / 180);
  if (metersPerDegLon <= 0) return null;

  const ring = [];
  for (let i = 0; i < npoints; i++) {
    const t = (i / npoints) * 2 * Math.PI;
    // Local (along major, perp) — major axis is `a`, perp is `b`.
    const xAlong = aMeters * Math.cos(t);
    const yPerp  = bMeters * Math.sin(t);
    // Rotate so major axis points along `azimuthDeg` (cw from north):
    //   East  =  xAlong * sin(az) + yPerp * cos(az)
    //   North =  xAlong * cos(az) - yPerp * sin(az)
    const east  = xAlong * sinAz + yPerp * cosAz;
    const north = xAlong * cosAz - yPerp * sinAz;
    const lon = centerLon + east  / metersPerDegLon;
    const lat = centerLat + north / metersPerDegLat;
    ring.push([lon, lat]);
  }
  // Close the polygon
  ring.push(ring[0]);
  return ring;
}

/**
 * Map a fractional progress p ∈ [0, 1] to a (i0, i1, f) triple along
 * a cumulative-distance array, so playback advances by *equal arc
 * length per second* instead of equal sample-index per second.
 *
 *   distArr[k] is the cumulative 3D distance from sample 0 to k.
 *   The returned i0/i1 bracket the location at p·totalDist; f is the
 *   normalized fraction within that segment, ready for lerp.
 *
 *   Falls back to linear-index parameterization when the trajectory
 *   collapses to a single point (totalDist ≈ 0).
 */
function progressToIndex(progress, distArr) {
  const N = distArr.length;
  if (N < 2) return { i0: 0, i1: 0, f: 0 };
  const total = distArr[N - 1];
  if (!Number.isFinite(total) || total < 1e-3) {
    const fIdx = progress * (N - 1);
    const i0 = Math.max(0, Math.min(N - 1, Math.floor(fIdx)));
    const i1 = Math.min(N - 1, i0 + 1);
    return { i0, i1, f: fIdx - i0 };
  }
  const target = Math.max(0, Math.min(1, progress)) * total;
  let lo = 0;
  let hi = N - 1;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (distArr[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  const i1 = Math.min(N - 1, lo);
  const i0 = Math.max(0, i1 - 1);
  const segLen = distArr[i1] - distArr[i0];
  const f = segLen > 1e-6 ? (target - distArr[i0]) / segLen : 0;
  return { i0, i1, f };
}


/**
 * Initial bearing on a great-circle path from (lat1, lon1) to
 * (lat2, lon2), in degrees clockwise from true north. Used to align
 * the playback camera with the rocket's direction of flight, so the
 * trail always points "up" on screen as the rocket climbs.
 */
function bearingDeg(lat1, lon1, lat2, lon2) {
  if (![lat1, lon1, lat2, lon2].every(Number.isFinite)) return 0;
  const φ1 = (lat1 * Math.PI) / 180;
  const φ2 = (lat2 * Math.PI) / 180;
  const Δλ = ((lon2 - lon1) * Math.PI) / 180;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  const θ = Math.atan2(y, x);
  return ((θ * 180) / Math.PI + 360) % 360;
}

/**
 * Signed minimum angular delta between two compass bearings, in
 * degrees ∈ [-180, 180]. Lets us blend toward a new bearing along the
 * shorter arc instead of unwinding 350° to land on 10°.
 */
function shortestAngleDelta(from, to) {
  let d = ((to - from + 540) % 360) - 180;
  if (d === -180) d = 180;
  return d;
}


export default MapView;
