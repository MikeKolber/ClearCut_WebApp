import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';

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
 *   The Globe / Flat radio in the sidebar is more than a projection
 *   toggle: it swaps the entire map engine.
 *     • Flat (Mercator) → MapLibre, surface ground track only.
 *     • Globe (3D)      → deck.gl GlobeView (`Map3D.js`), 3D arc only.
 *
 *   Why split? MapLibre's globe projection + a deck.gl PathLayer with
 *   altitude z-values renders the 3D line shifted off the planet —
 *   their reprojection matrices don't agree on what z means. Each
 *   engine is great at one of the two jobs, so we let each handle its
 *   own. From the user's perspective the radio still flips between
 *   a flat top-down view and a 3D globe view; the underlying engine
 *   change is invisible.
 *
 *   Both engines share the same debris layers (origins / impacts /
 *   3-σ ellipses) and the same sidebar UI.
 *
 *   Tiles: MapLibre uses OpenFreeMap dark vector tiles; Map3D uses
 *   Carto Dark Matter raster tiles (see Map3D.js). Both are free.   */

const TILE_STYLE = 'https://tiles.openfreemap.org/styles/dark';

// MapLibre layer / source ids for the 2D playback overlay. Module-
// scoped so the cleanup paths can reference them without churning
// React effect dependency arrays.
const PLAYBACK_2D_LAYERS = [
  'playback-trail-glow',
  'playback-trail-line',
  'playback-rocket-halo2',
  'playback-rocket-halo',
  'playback-rocket-dot',
];
const PLAYBACK_2D_SOURCES = ['playback-trail', 'playback-rocket'];

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
  // MapLibre (Flat / Mercator) refs
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  // Track whether the map's `style.load` has fired so we don't call
  // map.addSource before the style is ready.
  const styleLoadedRef = useRef(false);
  // Once the camera has done its first auto-fit we leave it alone —
  // the user's panning/zooming shouldn't get stomped on every refetch.
  const autoFittedRef = useRef(false);
  // Map3D (Globe) imperative ref — exposes fitToBounds / flyTo / reset
  // so the sidebar's Fit-to buttons work in either engine.
  const map3DRef = useRef(null);

  /* ── playback refs (60Hz state, kept out of React) ────────── */
  // 0..1 — fractional position along the trajectory
  const playProgressRef = useRef(0);
  const playRafRef = useRef(null);
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

  /* ── create the MapLibre instance once (Flat / Mercator only) ─ */
  // The Globe view is handled by Map3D (deck.gl GlobeView). MapLibre
  // here is locked to Mercator projection and renders only the
  // surface ground track + native debris layers — no 3D arc.
  useEffect(() => {
    if (mapRef.current || !containerRef.current) return undefined;

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: TILE_STYLE,
      projection: { type: 'mercator' },
      center: [0, 20],
      zoom: 1.0,
      attributionControl: { compact: true },
    });

    map.addControl(new maplibregl.NavigationControl({
      visualizePitch: true,
      showZoom: true,
      showCompass: true,
    }), 'top-right');

    map.on('style.load', () => {
      styleLoadedRef.current = true;
    });

    mapRef.current = map;
    return () => {
      try { map.remove(); } catch { /* ignore */ }
      mapRef.current = null;
      styleLoadedRef.current = false;
    };
  }, []);

  /* ── resize MapLibre when it comes back into view from globe ─ */
  // While the globe view is showing the MapLibre <div> is hidden via
  // CSS. Without a manual resize, switching back leaves the canvas at
  // its last drawn size and MapLibre paints with the wrong viewport.
  useEffect(() => {
    if (projection !== 'mercator') return;
    const map = mapRef.current;
    if (!map) return;
    // Wait one frame so the layout has settled after the display flip.
    const id = window.requestAnimationFrame(() => {
      try { map.resize(); } catch { /* ignore */ }
    });
    return () => window.cancelAnimationFrame(id);
  }, [projection]);

  /* ── render the trajectory track when data + map are ready ─ */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !trackCoords) return undefined;

    const apply = () => {
      if (!styleLoadedRef.current) return;

      const SOURCE_ID = 'traj-track';
      const LAYER_ID = 'traj-track-line';
      const GLOW_ID = 'traj-track-glow';

      // Split the path at antimeridian crossings so MapLibre draws
      // each orbit as its own clean line in [-180, 180] instead of
      // bridging 179° → -179° with a giant horizontal "geodesic"
      // across the entire map. We use a FeatureCollection of separate
      // LineStrings (rather than a single MultiLineString Feature) so
      // each segment lives in its own tile pyramid and can't leak a
      // connecting line at tile boundaries — the simulation's vertex
      // values themselves are the untouched output.
      const data =
        featureCollectionFromSegments(splitAtAntimeridian(trackCoords)) ||
        // Fallback to an empty FC if there are no segments yet (the
        // run hasn't filled in lat/lon columns yet, etc).
        { type: 'FeatureCollection', features: [] };

      // Update source if it exists, otherwise create.
      if (map.getSource(SOURCE_ID)) {
        map.getSource(SOURCE_ID).setData(data);
      } else {
        map.addSource(SOURCE_ID, { type: 'geojson', data, lineMetrics: false });
      }

      // Soft outer glow underneath the line. `line-cap: butt`
      // (instead of round) so segment endpoints don't stack up as
      // fuzzy circles where consecutive orbits all cross the
      // antimeridian — that pile would otherwise fuse into a fake
      // vertical glow line at the dateline as orbits accumulate.
      if (!map.getLayer(GLOW_ID)) {
        map.addLayer({
          id: GLOW_ID,
          type: 'line',
          source: SOURCE_ID,
          layout: { 'line-cap': 'butt', 'line-join': 'round' },
          paint: {
            'line-color': '#4DA8DA',
            'line-width': 7,
            'line-opacity': 0.18,
            'line-blur': 3,
          },
        });
      }

      // Crisp main line
      if (!map.getLayer(LAYER_ID)) {
        map.addLayer({
          id: LAYER_ID,
          type: 'line',
          source: SOURCE_ID,
          layout: { 'line-cap': 'butt', 'line-join': 'round' },
          paint: {
            'line-color': '#80c8f0',
            'line-width': 2.2,
            'line-opacity': 0.95,
          },
        });
      }

      // Endpoint markers (launch ↔ last sample) using a tiny
      // `circle` layer on a separate one-feature source.
      const ENDS_SOURCE = 'traj-track-ends';
      const ENDS_LAYER = 'traj-track-ends-layer';
      const endsData = {
        type: 'FeatureCollection',
        features: [
          { type: 'Feature', properties: { kind: 'launch' },
            geometry: { type: 'Point', coordinates: trackCoords[0] } },
          { type: 'Feature', properties: { kind: 'tip'    },
            geometry: { type: 'Point', coordinates: trackCoords[trackCoords.length - 1] } },
        ],
      };
      if (map.getSource(ENDS_SOURCE)) {
        map.getSource(ENDS_SOURCE).setData(endsData);
      } else {
        map.addSource(ENDS_SOURCE, { type: 'geojson', data: endsData });
      }
      if (!map.getLayer(ENDS_LAYER)) {
        map.addLayer({
          id: ENDS_LAYER,
          type: 'circle',
          source: ENDS_SOURCE,
          paint: {
            'circle-radius': 5,
            'circle-color': '#80c8f0',
            'circle-stroke-color': '#0b1118',
            'circle-stroke-width': 1.5,
          },
        });
      }

      // First-time camera placement: fly to the launch site at a
      // medium zoom so the user starts staring at where the rocket
      // actually lifted off, not at the whole arc framed at 100k ft.
      // The `Fit to Trajectory` button (sidebar) gives the wide view
      // when needed.
      if (!autoFittedRef.current && launchSite) {
        try {
          map.flyTo({
            center: launchSite,
            zoom: 9,
            pitch: 0,
            duration: 900,
            essential: true,
          });
          autoFittedRef.current = true;
        } catch { /* ignore on edge cases */ }
      }
    };

    if (styleLoadedRef.current) {
      apply();
    } else {
      const onceLoaded = () => apply();
      map.once('style.load', onceLoaded);
      return () => map.off('style.load', onceLoaded);
    }
    return undefined;
  }, [trackCoords, launchSite]);

  /* ── render debris layers (origins / impacts / 3-σ ellipses) ─ */
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return undefined;
    const { origins, impacts, ellipses } = debrisFeatures;
    if (!origins && !impacts && !ellipses) return undefined;

    const apply = () => {
      if (!styleLoadedRef.current) return;

      // ── 3-σ ellipses (filled + outlined) ─────────────────────
      if (ellipses) {
        const SRC = 'debris-ellipses';
        const FILL = 'debris-ellipses-fill';
        const LINE = 'debris-ellipses-line';
        if (map.getSource(SRC)) {
          map.getSource(SRC).setData(ellipses);
        } else {
          map.addSource(SRC, { type: 'geojson', data: ellipses });
        }
        if (!map.getLayer(FILL)) {
          map.addLayer({
            id: FILL,
            type: 'fill',
            source: SRC,
            paint: {
              'fill-color': [
                'case',
                ['>', ['get', 'harmful'], 0], '#ef4444',
                '#f59e0b',
              ],
              'fill-opacity': 0.10,
            },
          });
        }
        if (!map.getLayer(LINE)) {
          map.addLayer({
            id: LINE,
            type: 'line',
            source: SRC,
            paint: {
              'line-color': [
                'case',
                ['>', ['get', 'harmful'], 0], '#ef4444',
                '#f59e0b',
              ],
              'line-width': 1.5,
              'line-opacity': 0.65,
              'line-dasharray': [3, 2],
            },
          });
        }
      }

      // ── Per-fragment impact dots ─────────────────────────────
      if (impacts) {
        const SRC = 'debris-impacts';
        const LAYER = 'debris-impacts-circle';
        if (map.getSource(SRC)) {
          map.getSource(SRC).setData(impacts);
        } else {
          map.addSource(SRC, { type: 'geojson', data: impacts });
        }
        if (!map.getLayer(LAYER)) {
          map.addLayer({
            id: LAYER,
            type: 'circle',
            source: SRC,
          });
        }
        // Apply paint each effect run so color/size edits show up after
        // a hot reload without needing a full browser refresh.
        const paint = {
          'circle-radius': [
            'interpolate', ['linear'], ['zoom'],
            3,  1.6,
            10, 3.0,
            14, 4.5,
          ],
          'circle-color': [
            'case',
            ['==', ['get', 'status'], 'harmful'], '#ef4444',
            '#a78bfa',                          // purple — distinct from
          ],                                     // the blue trajectory line
          'circle-opacity': 0.78,
          'circle-stroke-color': '#0b1118',
          'circle-stroke-width': 0.5,
          'circle-stroke-opacity': 0.6,
        };
        for (const [k, v] of Object.entries(paint)) {
          try { map.setPaintProperty(LAYER, k, v); } catch { /* ignore */ }
        }
      }

      // ── Origin pins (failure points) — drawn last → on top ───
      if (origins) {
        const SRC = 'debris-origins';
        const RING = 'debris-origins-ring';
        const DOT  = 'debris-origins-dot';
        if (map.getSource(SRC)) {
          map.getSource(SRC).setData(origins);
        } else {
          map.addSource(SRC, { type: 'geojson', data: origins });
        }
        if (!map.getLayer(RING)) {
          // Halo ring around each origin (red if any harmful in row)
          map.addLayer({
            id: RING,
            type: 'circle',
            source: SRC,
            paint: {
              'circle-radius': 11,
              'circle-color':  [
                'case',
                ['>', ['get', 'harmful'], 0], 'rgba(239, 68, 68, 0.18)',
                'rgba(245, 158, 11, 0.20)',
              ],
              'circle-stroke-color': [
                'case',
                ['>', ['get', 'harmful'], 0], '#ef4444',
                '#f59e0b',
              ],
              'circle-stroke-width': 1,
              'circle-stroke-opacity': 0.6,
            },
          });
        }
        if (!map.getLayer(DOT)) {
          map.addLayer({
            id: DOT,
            type: 'circle',
            source: SRC,
            paint: {
              'circle-radius': 5,
              'circle-color': [
                'case',
                ['>', ['get', 'harmful'], 0], '#ef4444',
                '#f59e0b',
              ],
              'circle-stroke-color': '#0b1118',
              'circle-stroke-width': 1.5,
            },
          });
        }
      }
    };

    if (styleLoadedRef.current) apply();
    else map.once('style.load', apply);
    return undefined;
  }, [debrisFeatures]);

  /* ── debris layer toggles ─────────────────────────────────── */
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const set = (id, on) => {
      if (map.getLayer(id)) {
        map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
      }
    };
    set('debris-ellipses-fill',  showEllipses);
    set('debris-ellipses-line',  showEllipses);
    set('debris-impacts-circle', showImpacts);
    set('debris-origins-ring',   showOrigins);
    set('debris-origins-dot',    showOrigins);
  }, [showEllipses, showImpacts, showOrigins]);

  /* ── highlight the selected row, dim the others ───────────── */
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const r = selectedRow;
    const matches = ['==', ['get', 'row'], r];

    const safeSet = (id, key, value) => {
      if (map.getLayer(id)) {
        try { map.setPaintProperty(id, key, value); } catch { /* ignore */ }
      }
    };

    // ── Impacts ─────────────────────────────────────────────
    safeSet('debris-impacts-circle', 'circle-opacity',
      r == null
        ? 0.78
        : ['case', matches, 0.95, 0.18]
    );
    safeSet('debris-impacts-circle', 'circle-radius',
      r == null
        ? ['interpolate', ['linear'], ['zoom'], 3, 1.6, 10, 3.0, 14, 4.5]
        : [
            'interpolate', ['linear'], ['zoom'],
            3,  ['case', matches, 2.4, 1.2],
            10, ['case', matches, 4.6, 2.2],
            14, ['case', matches, 6.5, 3.2],
          ]
    );

    // ── Origin pins ─────────────────────────────────────────
    safeSet('debris-origins-ring', 'circle-radius',
      r == null
        ? 11
        : ['case', matches, 16, 9]
    );
    safeSet('debris-origins-ring', 'circle-stroke-width',
      r == null
        ? 1
        : ['case', matches, 1.6, 0.8]
    );
    safeSet('debris-origins-ring', 'circle-stroke-opacity',
      r == null
        ? 0.6
        : ['case', matches, 0.95, 0.30]
    );
    safeSet('debris-origins-dot', 'circle-radius',
      r == null
        ? 5
        : ['case', matches, 7, 4]
    );
    safeSet('debris-origins-dot', 'circle-opacity',
      r == null
        ? 1
        : ['case', matches, 1, 0.45]
    );

    // ── Ellipses ────────────────────────────────────────────
    safeSet('debris-ellipses-fill', 'fill-opacity',
      r == null
        ? 0.10
        : ['case', matches, 0.22, 0.04]
    );
    safeSet('debris-ellipses-line', 'line-opacity',
      r == null
        ? 0.65
        : ['case', matches, 0.95, 0.20]
    );
    safeSet('debris-ellipses-line', 'line-width',
      r == null
        ? 1.5
        : ['case', matches, 2.4, 1.2]
    );
  }, [selectedRow, debrisFeatures]);

  /* ── click + hover behavior on debris layers ──────────────── */
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return undefined;

    const popupRef = { current: null };

    const showPopup = (e, kind) => {
      const f = e.features?.[0];
      if (!f) return;
      const p = f.properties || {};
      const coords = f.geometry.coordinates.slice();
      // wrap longitude to keep popup on the same world copy as click
      while (Math.abs(e.lngLat.lng - coords[0]) > 180) {
        coords[0] += e.lngLat.lng > coords[0] ? 360 : -360;
      }

      let html;
      if (kind === 'impact') {
        const harmful = p.status === 'harmful';
        html = `
          <div class="MV-pop">
            <div class="MV-pop-head">
              <span class="MV-pop-tag${harmful ? ' MV-pop-tag--harmful' : ''}">
                ${harmful ? 'HARMFUL' : 'UNHARMED'}
              </span>
              <span class="MV-pop-row">Row ${p.row}</span>
            </div>
            <div class="MV-pop-grid">
              <span>Speed</span><span>${formatNumber(p.speed_mps)} m/s</span>
              <span>Mass</span><span>${formatNumber(p.mass_kg, 3)} kg</span>
              <span>KE</span><span>${formatEnergy(p.ke_j)}</span>
            </div>
          </div>
        `;
      } else {
        // origin
        html = `
          <div class="MV-pop">
            <div class="MV-pop-head">
              <span class="MV-pop-tag MV-pop-tag--origin">FAILURE PT</span>
              <span class="MV-pop-row">Row ${p.row}</span>
            </div>
            <div class="MV-pop-grid">
              <span>Time</span><span>${formatNumber(p.time_s)} s</span>
              <span>Altitude</span><span>${formatAltKm(p.altitude_m)}</span>
              <span>Impacts</span><span>${p.impact_count ?? '—'}</span>
              <span>Harmful</span><span class="${(p.harmful || 0) > 0 ? 'MV-pop-harmful' : ''}">${p.harmful ?? 0}</span>
              ${p.mean_distance != null ? `<span>Mean dist</span><span>${formatDistance(p.mean_distance)}</span>` : ''}
            </div>
          </div>
        `;
      }

      if (popupRef.current) popupRef.current.remove();
      popupRef.current = new maplibregl.Popup({
        offset: kind === 'origin' ? 14 : 10,
        closeButton: true,
        closeOnClick: true,
        maxWidth: '260px',
      })
        .setLngLat(coords)
        .setHTML(html)
        .addTo(map);
    };

    const onImpactClick = (e) => {
      showPopup(e, 'impact');
      const rowNum = e.features?.[0]?.properties?.row;
      if (rowNum != null) {
        // Find the row object in the loaded debris data — needed for
        // sidebar list highlight + correct camera target on next click.
        const row = (debris?.rows || []).find((r) => r.row === rowNum);
        if (row) selectRow(row, { fly: false });
      }
    };
    const onOriginClick = (e) => {
      showPopup(e, 'origin');
      const rowNum = e.features?.[0]?.properties?.row;
      if (rowNum != null) {
        const row = (debris?.rows || []).find((r) => r.row === rowNum);
        if (row) selectRow(row, { fly: false });
      }
    };
    const onEnter = () => { map.getCanvas().style.cursor = 'pointer'; };
    const onLeave = () => { map.getCanvas().style.cursor = ''; };

    map.on('click',      'debris-impacts-circle', onImpactClick);
    map.on('mouseenter', 'debris-impacts-circle', onEnter);
    map.on('mouseleave', 'debris-impacts-circle', onLeave);
    map.on('click',      'debris-origins-dot',    onOriginClick);
    map.on('mouseenter', 'debris-origins-dot',    onEnter);
    map.on('mouseleave', 'debris-origins-dot',    onLeave);

    return () => {
      map.off('click',      'debris-impacts-circle', onImpactClick);
      map.off('mouseenter', 'debris-impacts-circle', onEnter);
      map.off('mouseleave', 'debris-impacts-circle', onLeave);
      map.off('click',      'debris-origins-dot',    onOriginClick);
      map.off('mouseenter', 'debris-origins-dot',    onEnter);
      map.off('mouseleave', 'debris-origins-dot',    onLeave);
      if (popupRef.current) popupRef.current.remove();
    };
  }, [debrisFeatures]);

  /* ── react to track-visibility toggle ─────────────────────── */
  // We also hide the static (blue) ground track while playback is
  // running or paused — at self-intersections of the trajectory, the
  // static line and the dynamic orange trace overlap and the eye
  // can't tell which arm the rocket "really" took. Stop returns the
  // state to 'idle', the static line comes back, and you see the
  // full trace again.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const ids = ['traj-track-line', 'traj-track-glow', 'traj-track-ends-layer'];
    const visible = showTrack && playState === 'idle';
    ids.forEach((id) => {
      if (map.getLayer(id)) {
        map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none');
      }
    });
  }, [showTrack, playState]);

  /* ── auto-fit Map3D to launch site on first load ──────────── */
  // Map3D internally fly-to launch on its own first data load too,
  // but we also want a clean initial frame when toggling Globe ⇄ Flat
  // mid-session: any time the globe engine mounts and we already have
  // a launch site, fly there. Map3D guards against repeated auto-fits.
  // (The actual logic lives inside Map3D — this is just a hook.)

  /* ── handlers ─────────────────────────────────────────────── */
  // Dispatchers — every camera-control button picks the right engine
  // automatically based on the current projection mode.
  const fitTo = (bounds, maxZoom = 7) => {
    if (!bounds) return;
    if (projection === 'globe') {
      map3DRef.current?.fitToBounds(bounds, { maxZoom });
      return;
    }
    const map = mapRef.current;
    if (!map) return;
    map.fitBounds(bounds, {
      padding: { top: 80, bottom: 80, left: 80, right: 80 },
      duration: 900,
      maxZoom,
    });
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
    if (projection === 'globe') {
      map3DRef.current?.flyTo({ longitude: lon, latitude: lat, zoom: 9 });
    } else if (mapRef.current) {
      mapRef.current.flyTo({
        center: [lon, lat],
        zoom: 12,
        duration: 1200,
        essential: true,
      });
    }
  };

  const resetView = () => {
    setSelectedRow(null);
    if (projection === 'globe') {
      map3DRef.current?.reset();
      return;
    }
    const map = mapRef.current;
    if (!map) return;
    map.flyTo({ center: [0, 20], zoom: 1.0, pitch: 0, bearing: 0, duration: 900 });
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

    if (projection === 'globe') {
      // Trail = the rocket's complete path so far, straight from the
      // simulation. (No artificial cap — the data is correct, every
      // sample shown is a real point the rocket actually passed
      // through. Self-intersections at multi-orbit overlap are real.)
      // GlobeView normalizes lon to a sphere position, so antimeridian
      // crossings need no special handling here.
      const trail = trajectory3D.slice(0, i0 + 1);
      if (f > 0 && i0 < N - 1) trail.push([lon, lat, alt]);

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
      map3DRef.current?.setPlaybackOverlay({
        trail,
        rocketPos: [lon, lat, alt],
        pulse,
      });
    } else {
      // 2D playback: hold the camera at a wide whole-world zoom so
      // the entire orbital ground track is visible at once. (We
      // still keep `center` tracking the rocket so it stays in view,
      // but at zoom ~1.5 you can see ~half the planet either way of
      // the rocket's current sub-point.) Bearing is locked to north
      // because rotation at wide zoom is disorienting.
      const map = mapRef.current;
      if (!map) return;

      try {
        map.jumpTo({
          center: [lon, lat],
          zoom: 1.5,
          bearing: 0,
        });
      } catch { /* ignore */ }

      const TRAIL_SRC        = 'playback-trail';
      const TRAIL_GLOW_LAYER = 'playback-trail-glow';
      const TRAIL_LAYER      = 'playback-trail-line';
      const ROCKET_SRC       = 'playback-rocket';
      const ROCKET_HALO2     = 'playback-rocket-halo2';
      const ROCKET_HALO      = 'playback-rocket-halo';
      const ROCKET_LAYER     = 'playback-rocket-dot';

      // Trail line — re-uses existing source if any, otherwise creates
      // it on first frame. Wrapped in try/catch so a style still
      // loading mid-animation doesn't kill the whole tick.
      const trailData = buildTrail2D(trackCoords, i0, [lon, lat]);
      if (trailData) {
        try {
          if (map.getSource(TRAIL_SRC)) {
            map.getSource(TRAIL_SRC).setData(trailData);
          } else {
            map.addSource(TRAIL_SRC, { type: 'geojson', data: trailData, lineMetrics: false });
            // Same exact dimensions as the static blue track (which
            // renders cleanly across antimeridian crossings) — just
            // amber instead of blue. `line-cap: butt` is critical:
            // with `round` and a wide blur radius, the round caps
            // at every per-orbit segment endpoint stack up at the
            // dateline and fuse into a fake vertical glow line.
            map.addLayer({
              id: TRAIL_GLOW_LAYER,
              type: 'line',
              source: TRAIL_SRC,
              layout: { 'line-cap': 'butt', 'line-join': 'round' },
              paint: {
                'line-color': '#ffc864',
                'line-width': 7,
                'line-opacity': 0.32,
                'line-blur': 3,
              },
            });
            map.addLayer({
              id: TRAIL_LAYER,
              type: 'line',
              source: TRAIL_SRC,
              layout: { 'line-cap': 'butt', 'line-join': 'round' },
              paint: {
                'line-color': '#fff0b4',
                'line-width': 2.2,
                'line-opacity': 0.95,
              },
            });
          }
        } catch { /* ignore */ }
      }

      // Rocket marker — outer pulse, inner pulse, core dot.
      const rocketData = {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [lon, lat] },
        properties: {},
      };
      try {
        if (map.getSource(ROCKET_SRC)) {
          map.getSource(ROCKET_SRC).setData(rocketData);
        } else {
          map.addSource(ROCKET_SRC, { type: 'geojson', data: rocketData });
          map.addLayer({
            id: ROCKET_HALO2,
            type: 'circle',
            source: ROCKET_SRC,
            paint: {
              'circle-radius': 22,
              'circle-color': '#ffc864',
              'circle-opacity': 0.18,
              'circle-blur': 1,
            },
          });
          map.addLayer({
            id: ROCKET_HALO,
            type: 'circle',
            source: ROCKET_SRC,
            paint: {
              'circle-radius': 13,
              'circle-color': '#ffd884',
              'circle-opacity': 0.45,
              'circle-blur': 0.6,
            },
          });
          map.addLayer({
            id: ROCKET_LAYER,
            type: 'circle',
            source: ROCKET_SRC,
            paint: {
              'circle-radius': 5.5,
              'circle-color': '#fff5dc',
              'circle-stroke-color': '#ffb04a',
              'circle-stroke-width': 1.6,
            },
          });
        }
        // Apply the per-frame pulse to the two halo radii.
        if (map.getLayer(ROCKET_HALO2)) {
          map.setPaintProperty(ROCKET_HALO2, 'circle-radius', 22 * pulse);
        }
        if (map.getLayer(ROCKET_HALO)) {
          map.setPaintProperty(ROCKET_HALO, 'circle-radius', 13 * pulse);
        }
      } catch { /* ignore */ }
    }
  }, [trajectory3D, trajectoryDist, trackCoords, projection]);

  // Drop every overlay layer/source from both engines. Called when
  // the user hits Stop, when projection switches, and on unmount.
  const clearPlaybackOverlays = useCallback(() => {
    map3DRef.current?.clearPlayback();
    const map = mapRef.current;
    if (map) {
      PLAYBACK_2D_LAYERS.forEach((id) => {
        if (map.getLayer(id)) {
          try { map.removeLayer(id); } catch { /* ignore */ }
        }
      });
      PLAYBACK_2D_SOURCES.forEach((id) => {
        if (map.getSource(id)) {
          try { map.removeSource(id); } catch { /* ignore */ }
        }
      });
    }
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
      setPlayProgressUI(progress);
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

  // Wipe overlays whenever the user toggles between Globe and Flat
  // mid-playback — the active engine changed, so the old layers are
  // no longer relevant. We don't auto-pause; the next tick will
  // repopulate the new engine's overlay.
  useEffect(() => {
    if (playState === 'idle') return;
    // Defer one frame so the engine swap has a chance to mount/show.
    const id = window.requestAnimationFrame(() => {
      // Clear stale overlays from the engine we just switched away from.
      if (projection === 'globe') {
        const map = mapRef.current;
        if (map) {
          PLAYBACK_2D_LAYERS.forEach((lid) => {
            if (map.getLayer(lid)) { try { map.removeLayer(lid); } catch {} }
          });
          PLAYBACK_2D_SOURCES.forEach((sid) => {
            if (map.getSource(sid)) { try { map.removeSource(sid); } catch {} }
          });
        }
      } else {
        map3DRef.current?.clearPlayback();
      }
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
        if (projection === 'globe') {
          // Fly in at the same zoom the playback frames will use
          // immediately after — eliminates a 11→3 pyramid sweep on
          // the first second of every play.
          map3DRef.current?.flyTo({
            longitude: launchSite[0],
            latitude:  launchSite[1],
            zoom:      6,
            pitch:     60,
          });
        } else {
          mapRef.current?.flyTo({
            center: launchSite,
            zoom: 5,
            duration: 600,
            essential: true,
          });
        }
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

        {/* Map canvas — both engines stay mounted in the same wrap.
            MapLibre is hidden via `display: none` when in Globe mode;
            Map3D is hidden via `visibility: hidden` when in Flat mode.
            Why keep both alive? deck.gl's WebGL context + tile cache
            only pay their ~1s setup once, so toggling Globe ⇄ Flat
            after that is instantaneous instead of cold-starting the
            whole stack each time. */}
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
              <div
                ref={containerRef}
                className="MV-canvas"
                style={{ display: projection === 'mercator' ? 'block' : 'none' }}
              />
              <Map3D
                ref={map3DRef}
                visible={projection === 'globe'}
                trajectory3D={trajectory3D}
                debrisFeatures={debrisFeatures}
                launchSite={launchSite}
                selectedRow={selectedRow}
                /* Hide the static blue arc while playback is running
                   or paused — at self-intersections it overlaps the
                   live orange trace and makes it look like the
                   rocket "jumped" arms. Stop puts state back to
                   'idle' and the full arc reappears. */
                showAltitude={showAltitude && playState === 'idle'}
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
        <span className="MV-runinfo-status mono">// loading…</span>
      </div>
    );
  }
  if (empty || !traj) {
    return (
      <div className="MV-runinfo MV-runinfo--dim">
        <span className="eyebrow">Run Info</span>
        <span className="MV-runinfo-status mono">// no run yet</span>
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
 * Split a `[lon, lat]` (or `[lon, lat, …]`) path into separate
 * sub-arrays at every antimeridian crossing — i.e. wherever two
 * adjacent vertices are more than 180° apart in longitude.
 *
 * The simulation outputs longitude via arctan2, so multi-orbit data
 * naturally has a 179.9 → -179.9 jump every lap. If we hand a single
 * LineString with that jump straight to MapLibre, it draws a
 * horizontal line across the whole world to bridge the two vertices.
 * Splitting into a MultiLineString lets each orbit render cleanly
 * in [-180, 180] without touching the simulation's actual values.
 *
 * Returns an array of segments, each ≥ 2 vertices long. Returns []
 * if the input is empty / has fewer than 2 valid vertices.
 */
function splitAtAntimeridian(coords) {
  if (!coords || coords.length < 2) return [];
  const segments = [];
  let current = [coords[0]];
  for (let i = 1; i < coords.length; i++) {
    const prevLon = coords[i - 1][0];
    const currLon = coords[i][0];
    if (Math.abs(currLon - prevLon) > 180) {
      // Antimeridian crossing — close the current segment and start
      // a new one at the post-crossing vertex.
      if (current.length >= 2) segments.push(current);
      current = [coords[i]];
    } else {
      current.push(coords[i]);
    }
  }
  if (current.length >= 2) segments.push(current);
  return segments;
}

/**
 * Build a GeoJSON FeatureCollection for the dynamic 2D playback
 * trail. One Feature per antimeridian-split segment — that buys us
 * cleaner tiling than a single MultiLineString (each segment lives
 * in its own tile pyramid, so antimeridian crossings can't leak a
 * connecting line at tile boundaries).
 *
 * Slices the ground track from sample 0 through the current index,
 * appends the fractional tip so the trail terminates exactly at the
 * rocket marker, then splits at antimeridian crossings — same data,
 * just multiple LineStrings.
 *
 * Pure function — kept at module scope so applyPlaybackFrame's deps
 * array stays clean.
 */
function buildTrail2D(trackCoords, idx, tipLonLat) {
  if (!trackCoords || trackCoords.length < 2) return null;
  const end = Math.max(2, idx + 1);
  const slice = trackCoords.slice(0, end);
  if (tipLonLat) slice.push([tipLonLat[0], tipLonLat[1]]);
  return featureCollectionFromSegments(splitAtAntimeridian(slice));
}

/**
 * Wrap an array of `[lon, lat]` segments into a GeoJSON
 * FeatureCollection of LineStrings. Returns null when there are
 * no renderable segments so callers can skip the source update.
 */
function featureCollectionFromSegments(segments) {
  if (!segments || segments.length === 0) return null;
  return {
    type: 'FeatureCollection',
    features: segments.map((coords) => ({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: coords },
      properties: {},
    })),
  };
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

function formatNumber(v, digits = 2) {
  if (v == null || !Number.isFinite(v)) return '—';
  if (Math.abs(v) >= 1000) return v.toFixed(0);
  if (Math.abs(v) >= 1)    return v.toFixed(digits);
  return v.toFixed(3);
}

function formatEnergy(j) {
  if (j == null || !Number.isFinite(j)) return '—';
  if (Math.abs(j) >= 1e6) return `${(j / 1e6).toFixed(2)} MJ`;
  if (Math.abs(j) >= 1e3) return `${(j / 1e3).toFixed(2)} kJ`;
  return `${j.toFixed(1)} J`;
}

function formatAltKm(m) {
  if (m == null || !Number.isFinite(m)) return '—';
  if (Math.abs(m) >= 1000) return `${(m / 1000).toFixed(1)} km`;
  return `${m.toFixed(0)} m`;
}

function formatDistance(m) {
  if (m == null || !Number.isFinite(m)) return '—';
  if (Math.abs(m) >= 1000) return `${(m / 1000).toFixed(2)} km`;
  return `${m.toFixed(0)} m`;
}

export default MapView;
