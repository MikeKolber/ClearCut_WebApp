import React, {
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  forwardRef,
} from 'react';
import { Deck, MapView, _GlobeView as GlobeView } from '@deck.gl/core';
import { TileLayer } from '@deck.gl/geo-layers';
import {
  BitmapLayer,
  PathLayer,
  ScatterplotLayer,
  SolidPolygonLayer,
} from '@deck.gl/layers';

/* ═══ Map3D — unified deck.gl map (Globe + Mercator) ════════════════
 *
 * Renders both the Globe (3D _GlobeView) and Flat (2D Mercator MapView)
 * views from a single deck.gl instance. Originally the Flat view was
 * MapLibre, but MapLibre 5.x had cryptic minified worker errors on
 * Render's static-site CDN ("o is not defined" from evented.ts:153)
 * that we couldn't fix without sinking serious time. deck.gl was
 * already known-working for Globe so we let it cover both modes.
 *
 * Data props
 *   trajectory3D     [[lon, lat, height_m], …]   the rocket's true path.
 *                                                 In mercator the z is
 *                                                 ignored visually
 *                                                 (pitch is locked to 0
 *                                                 so it always reads as
 *                                                 a flat ground track).
 *   debrisFeatures   { origins, impacts, ellipses } GeoJSON FCs
 *   launchSite       [lon, lat] of the first valid trajectory sample
 *   selectedRow      number | null — drives dim-others / highlight-this
 *   projection       'globe' (default) | 'mercator'
 *
 * Interaction
 *   onSelectRow(rowNum, kind)  fires when the user clicks a debris dot
 *                              or an origin pin (`kind` ∈ 'impact'/'origin')
 *
 * Imperative ref API
 *   .fitToBounds(bounds, { maxZoom })   frame [[minLon,minLat],[maxLon,maxLat]]
 *   .flyTo({ longitude, latitude, zoom, pitch, bearing })
 *   .reset()                            reset to the global default view
 *   .setPlaybackView(...)               see playback section below
 *   .setPlaybackOverlay(...)
 *   .clearPlayback()
 */

// Globe basemap — EOX Sentinel-2 cloudless 2020. Photographic
// satellite imagery (cloud-removed Sentinel-2 mosaic) with a fast
// Cloudflare CDN, free for non-commercial use, attribution required.
// We darken / warm-tint via `BitmapLayer.tintColor` so the planet
// sits comfortably in the dark UI without a per-frame CSS filter.
const TILE_URL_BASE =
  'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2020_3857/default/g';
const TILE_URL_EXT = '.jpg';
const TILE_URL_GLOBE = `${TILE_URL_BASE}/{z}/{y}/{x}${TILE_URL_EXT}`;

// Mercator basemap — CARTO Dark Matter (raster).
// Why a different source for 2D? A flat top-down map is the natural
// place to read country borders, city labels, ocean names, etc.
// CARTO's Dark Matter is a dark cartographic style with all those
// labels baked in, dark enough to match the rest of the app.
// Free for non-commercial use; attribution required.
const TILE_URL_MERCATOR =
  'https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png';

// 10 is plenty for orbit-scale globe work; mercator can go further
// (zoom 14 ≈ city block) since flat maps are also useful for
// inspecting impact dispersion at the regional scale.
const TILE_MAX_ZOOM_GLOBE = 10;
const TILE_MAX_ZOOM_MERCATOR = 14;
const TILE_MAX_REQUESTS = 12;
const TILE_MAX_CACHE = 512;
// Slight warm darkening multiplied into every Sentinel-2 tile.
// CARTO Dark Matter is already dark + flat-toned, so we don't tint
// it — applying TILE_TINT to those tiles washes the labels out.
const TILE_TINT = [216, 210, 200];
const TILE_ATTRIBUTION_GLOBE = 'Sentinel-2 cloudless · EOX IT Services GmbH';
const TILE_ATTRIBUTION_MERCATOR = '© CARTO · © OpenStreetMap contributors';

/**
 * Split a 3D path `[[lon, lat, alt], …]` into multiple sub-paths
 * wherever adjacent vertices jump by more than 180° in longitude.
 *
 * Why: deck.gl's PathLayer in GlobeView linearly interpolates in
 * lon/lat space between consecutive vertices and only then projects
 * to the sphere. A normal antimeridian crossing — say [179, 24] →
 * [-179, 24] — therefore renders as a 358°-long path that loops
 * the equator at lat≈24. Splitting at the boundary hands the layer
 * N short well-behaved segments instead. Vertex *values* are
 * untouched; we're only deciding where one renderable path ends
 * and the next begins.
 */
function splitPathAtAntimeridian(coords) {
  if (!coords || coords.length < 2) return [];
  const segments = [];
  let current = [coords[0]];
  for (let i = 1; i < coords.length; i++) {
    const prevLon = coords[i - 1][0];
    const currLon = coords[i][0];
    if (Math.abs(currLon - prevLon) > 180) {
      if (current.length >= 2) segments.push(current);
      current = [coords[i]];
    } else {
      current.push(coords[i]);
    }
  }
  if (current.length >= 2) segments.push(current);
  return segments;
}

const DEFAULT_VIEW = Object.freeze({
  longitude: 0,
  latitude: 20,
  zoom: 1,
  pitch: 0,
  bearing: 0,
});

const Map3D = forwardRef(function Map3D(
  {
    trajectory3D = null,
    debrisFeatures = { origins: null, impacts: null, ellipses: null },
    launchSite = null,
    selectedRow = null,
    showAltitude = true,
    showOrigins = true,
    showImpacts = true,
    showEllipses = true,
    onSelectRow,
    // When false, we hide via CSS but keep the deck.gl instance + tile
    // cache alive. The first toggle to Globe pays the ~1s WebGL/init
    // cost; every toggle after that is instantaneous.
    visible = true,
    // 'globe'    → 3D _GlobeView
    // 'mercator' → 2D MapView (top-down)
    projection = 'globe',
  },
  ref
) {
  const isMercator = projection === 'mercator';
  const containerRef = useRef(null);
  const canvasRef = useRef(null);
  const deckRef = useRef(null);
  const viewStateRef = useRef({ ...DEFAULT_VIEW });
  const autoFittedRef = useRef(false);

  // Stash callback in a ref so layer rebuilds don't churn the closure
  // captured in deck.gl picking handlers.
  const onSelectRef = useRef(onSelectRow);
  useEffect(() => { onSelectRef.current = onSelectRow; }, [onSelectRow]);

  // Static layers (built from props in the useMemo below) and the
  // playback overlay layers (pushed imperatively from the parent each
  // animation frame) live in refs so the imperative play methods can
  // merge them without React re-renders.
  const staticLayersRef = useRef([]);
  const playbackLayersRef = useRef([]);
  const pushLayers = () => {
    if (!deckRef.current) return;
    deckRef.current.setProps({
      layers: [...staticLayersRef.current, ...playbackLayersRef.current],
    });
  };

  /* ── view-state mutators ──────────────────────────────────── */
  const applyViewState = (next, animated = true) => {
    const merged = { ...viewStateRef.current, ...next };
    if (animated) merged.transitionDuration = 900;
    viewStateRef.current = { ...merged, transitionDuration: 0 };
    if (deckRef.current) {
      deckRef.current.setProps({ initialViewState: merged });
    }
  };

  /* ── Idle auto-spin ──────────────────────────────────────────
   * When the user lands on Map View *without* a trajectory loaded
   * (and isn't interacting with the globe), we let it slowly rotate
   * around its yaw axis. Picks up immediately when the page mounts,
   * pauses the moment any of:
   *   - trajectory data arrives (interactive content takes priority)
   *   - the user manually pans / zooms (`lastInteractionRef`)
   *   - the page isn't visible (saves CPU in background tabs).
   *
   * Implemented via a single rAF loop that nudges the longitude by
   * a small delta each frame. No state churn — we mutate the same
   * viewState ref deck.gl already uses. */
  const lastInteractionRef = useRef(0);
  const idleSpinRafRef     = useRef(null);
  useEffect(() => {
    // Auto-spin is a globe-only flourish; in mercator it would just
    // pan the world to the side, which feels broken.
    if (isMercator) return undefined;
    // Don't auto-spin if a trajectory is loaded — the user is here
    // to look at *that*, not at a rotating planet.
    if (trajectory3D && trajectory3D.length > 1) {
      if (idleSpinRafRef.current) {
        cancelAnimationFrame(idleSpinRafRef.current);
        idleSpinRafRef.current = null;
      }
      return undefined;
    }
    // Don't spin when this component is hidden — wasted GPU on an
    // off-screen canvas.
    if (!visible) return undefined;

    const SPIN_DEG_PER_SEC = 2;      // gentle, ~3 mins/revolution
    const PAUSE_AFTER_INTERACTION_MS = 4000;

    let lastTs = performance.now();

    const tick = (ts) => {
      const dt = ts - lastTs;
      lastTs = ts;
      const idleFor = ts - lastInteractionRef.current;
      // Spin only after the user's been still long enough that an
      // auto-rotation can't be confused with a hand-off in their
      // own gesture.
      if (idleFor > PAUSE_AFTER_INTERACTION_MS && document.visibilityState === 'visible') {
        const cur = viewStateRef.current;
        const nextLon = ((cur.longitude || 0) + (SPIN_DEG_PER_SEC * dt) / 1000 + 540) % 360 - 180;
        const merged = { ...cur, longitude: nextLon, transitionDuration: 0 };
        viewStateRef.current = merged;
        if (deckRef.current) {
          deckRef.current.setProps({ initialViewState: merged });
        }
      }
      idleSpinRafRef.current = requestAnimationFrame(tick);
    };
    idleSpinRafRef.current = requestAnimationFrame(tick);

    return () => {
      if (idleSpinRafRef.current) {
        cancelAnimationFrame(idleSpinRafRef.current);
        idleSpinRafRef.current = null;
      }
    };
  }, [trajectory3D, visible, isMercator]);

  /* ── imperative API for the parent ────────────────────────── */
  useImperativeHandle(ref, () => ({
    fitToBounds: (bounds, { maxZoom = 7 } = {}) => {
      if (!bounds || !deckRef.current) return;
      const [[minLon, minLat], [maxLon, maxLat]] = bounds;
      const lon = (minLon + maxLon) / 2;
      const lat = (minLat + maxLat) / 2;
      const span = Math.max(
        Math.abs(maxLon - minLon),
        Math.abs(maxLat - minLat),
        0.5
      );
      // Heuristic zoom — both GlobeView and MapView use the same
      // log-scale zoom convention (zoom 0 = world, +1 = half the span).
      // Subtract 0.5 to leave padding. Subtract 1 in mercator because
      // MapView covers more pixels per zoom unit than GlobeView.
      const padding = isMercator ? 1.5 : 0.5;
      const zoom = Math.max(0, Math.min(maxZoom, Math.log2(360 / span) - padding));
      applyViewState({ longitude: lon, latitude: lat, zoom });
    },
    flyTo: ({ longitude, latitude, zoom = 9, pitch = 0, bearing = 0 }) => {
      applyViewState({ longitude, latitude, zoom, pitch, bearing });
    },
    reset: () => {
      applyViewState({ ...DEFAULT_VIEW });
    },

    /* ── playback API ────────────────────────────────────────
     * Used by the rocket follow-cam animation in MapView. Both
     * setPlaybackView and setPlaybackOverlay bypass React entirely
     * — they push directly into the deck instance — because at
     * 60Hz a state-driven update would thrash reconciliation.
     *
     * setPlaybackView    snaps the camera (transitionDuration: 0
     *                    so it doesn't fight the rAF tween).
     * setPlaybackOverlay rebuilds the trail + rocket marker layers
     *                    from a tiny intent object so the parent
     *                    doesn't need its own deck.gl imports.
     * clearPlayback      drops both layers (called on pause/stop).
     */
    setPlaybackView: (next) => {
      if (!deckRef.current) return;
      const merged = {
        ...viewStateRef.current,
        ...next,
        transitionDuration: 0,
      };
      viewStateRef.current = merged;
      deckRef.current.setProps({ initialViewState: merged });
    },
    setPlaybackOverlay: ({ trail, rocketPos, pulse = 1 } = {}) => {
      const next = [];

      // In mercator, flatten the trail + rocket marker onto the
      // surface (z=0) so they don't visually hover over their
      // ground track. In globe, keep the altitudes so the rocket
      // climbs naturally.
      const flattenIfMercator = isMercator
        ? (p) => [p[0], p[1], 0]
        : (p) => p;

      // ── Trail (3 stacked PathLayers → comet-tail look) ──────
      // Wide diffuse glow underneath, a punchy mid body, and a
      // thin nearly-white core line to sell "freshly drawn". The
      // trail is split at antimeridian crossings (one data entry
      // per piece) so deck.gl can't lerp a fake equator-hugging
      // arc through lon=0 between a 179° and -179° vertex.
      if (Array.isArray(trail) && trail.length >= 2) {
        const flattenedTrail = trail.map(flattenIfMercator);
        const trailData = splitPathAtAntimeridian(flattenedTrail)
          .map((path) => ({ path }));
        next.push(new PathLayer({
          id: 'playback-trail-glow',
          data: trailData,
          getPath: (d) => d.path,
          getColor: [255, 190, 90, 70],
          getWidth: 18,
          widthUnits: 'pixels',
          widthMinPixels: 8,
          jointRounded: true,
          capRounded: true,
        }));
        next.push(new PathLayer({
          id: 'playback-trail-mid',
          data: trailData,
          getPath: (d) => d.path,
          getColor: [255, 215, 130, 200],
          getWidth: 7,
          widthUnits: 'pixels',
          widthMinPixels: 3,
          jointRounded: true,
          capRounded: true,
        }));
        next.push(new PathLayer({
          id: 'playback-trail-core',
          data: trailData,
          getPath: (d) => d.path,
          getColor: [255, 250, 220, 250],
          getWidth: 2.4,
          widthUnits: 'pixels',
          widthMinPixels: 1.4,
          jointRounded: true,
          capRounded: true,
        }));
      }

      // ── Rocket marker (4 stacked ScatterplotLayers) ─────────
      // outer halo (pulses) → mid halo (pulses gently) → ring →
      // bright core. The pulse multiplier comes from the parent
      // animation loop (sin-driven) so the marker breathes in
      // sync with the trace, like an active beacon.
      if (
        Array.isArray(rocketPos) &&
        rocketPos.length >= 2 &&
        Number.isFinite(rocketPos[0]) &&
        Number.isFinite(rocketPos[1])
      ) {
        const drawnPos = flattenIfMercator(
          rocketPos.length >= 3 ? rocketPos : [rocketPos[0], rocketPos[1], 0]
        );
        next.push(new ScatterplotLayer({
          id: 'playback-rocket-halo3',
          data: [{ position: drawnPos }],
          getPosition: (d) => d.position,
          getFillColor: [255, 195, 95, 38],
          getRadius: 30 * pulse,
          radiusUnits: 'pixels',
        }));
        next.push(new ScatterplotLayer({
          id: 'playback-rocket-halo2',
          data: [{ position: drawnPos }],
          getPosition: (d) => d.position,
          getFillColor: [255, 215, 130, 80],
          getRadius: 19 * pulse,
          radiusUnits: 'pixels',
        }));
        next.push(new ScatterplotLayer({
          id: 'playback-rocket-halo1',
          data: [{ position: drawnPos }],
          getPosition: (d) => d.position,
          getFillColor: [255, 240, 180, 130],
          getRadius: 11,
          radiusUnits: 'pixels',
        }));
        next.push(new ScatterplotLayer({
          id: 'playback-rocket-core',
          data: [{ position: drawnPos }],
          getPosition: (d) => d.position,
          getFillColor: [255, 255, 240, 255],
          getLineColor: [255, 200, 100, 255],
          stroked: true,
          filled: true,
          lineWidthMinPixels: 1.6,
          radiusUnits: 'pixels',
          getRadius: 5,
        }));
      }
      playbackLayersRef.current = next;
      pushLayers();
    },
    clearPlayback: () => {
      playbackLayersRef.current = [];
      pushLayers();
    },
  }), [isMercator]);

  /* ── deck.gl layer stack (memoized) ───────────────────────── */
  const layers = useMemo(() => {
    const out = [
      // Satellite raster basemap on the sphere — true-color imagery
      // gives the planet a photographic, "view from orbit" look.
      // Tuned for a fast first paint: more parallel requests, a big
      // in-memory cache so toggling Globe ⇄ Flat doesn't refetch,
      // and `best-available` so blurry low-res tiles show first while
      // their sharper neighbors are still on the wire (instead of a
      // blank planet for two seconds).
      new TileLayer({
        // `id` includes the projection so deck.gl invalidates and
        // re-fetches the basemap when the user toggles Globe ⇄ Flat
        // (different tile URL → different cache space).
        id: isMercator ? 'basemap-mercator' : 'basemap-globe',
        data: isMercator ? TILE_URL_MERCATOR : TILE_URL_GLOBE,
        maxZoom: isMercator ? TILE_MAX_ZOOM_MERCATOR : TILE_MAX_ZOOM_GLOBE,
        minZoom: 0,
        tileSize: 256,
        maxRequests: TILE_MAX_REQUESTS,
        maxCacheSize: TILE_MAX_CACHE,
        refinementStrategy: 'best-available',
        renderSubLayers: ({ tile, data }) => {
          if (!data) return null;
          const { boundingBox } = tile;
          const [[w, s], [e, n]] = boundingBox;
          return new BitmapLayer({
            id: `${tile.id}-bmp`,
            image: data,
            bounds: [w, s, e, n],
            // Shader-side tint replaces the old CSS filter on the
            // canvas — same look, but evaluated once per tile vertex
            // instead of every frame for the whole viewport. Skip the
            // tint in mercator so country/city labels stay readable.
            tintColor: isMercator ? [255, 255, 255] : TILE_TINT,
          });
        },
      }),
    ];

    // 3D trajectory — soft glow underneath + crisp top line. Z values
    // come from `height_m` straight out of the simulation; GlobeView
    // interprets them as meters above the surface. The path is split
    // at antimeridian crossings (one data entry per piece) so deck.gl
    // doesn't draw a fake equator-hugging arc bridging 179° → -179°.
    //
    // In mercator mode, strip the z so the path renders as a flat
    // ground track. Otherwise MapView would render the elevation as
    // a tall vertical streak whenever pitch != 0 (we lock pitch=0,
    // but the layer tessellation still considers altitude — better to
    // just zero it out and have a clean ground track).
    if (showAltitude && trajectory3D) {
      const sourcePath = isMercator
        ? trajectory3D.map(([lon, lat]) => [lon, lat, 0])
        : trajectory3D;
      const trajectoryData = splitPathAtAntimeridian(sourcePath)
        .map((path) => ({ path }));
      out.push(new PathLayer({
        id: 'trajectory-3d-glow',
        data: trajectoryData,
        getPath: (d) => d.path,
        getColor: [128, 200, 240, 60],
        getWidth: 14,
        widthUnits: 'pixels',
        widthMinPixels: 6,
        jointRounded: true,
        capRounded: true,
      }));
      out.push(new PathLayer({
        id: 'trajectory-3d',
        data: trajectoryData,
        getPath: (d) => d.path,
        getColor: [149, 213, 255, 240],
        getWidth: 4,
        widthUnits: 'pixels',
        widthMinPixels: 2,
        jointRounded: true,
        capRounded: true,
      }));
    }

    // Debris 3-σ ellipses (filled + outline). Drawn first so the dots
    // sit on top.
    if (showEllipses && debrisFeatures.ellipses?.features) {
      out.push(new SolidPolygonLayer({
        id: 'debris-ellipses-fill',
        data: debrisFeatures.ellipses.features,
        getPolygon: (f) => f.geometry.coordinates[0],
        getFillColor: (f) => {
          const harmful = (f.properties.harmful || 0) > 0;
          const dim = selectedRow != null && f.properties.row !== selectedRow;
          const a = dim ? 8 : 26;
          return harmful ? [239, 68, 68, a] : [245, 158, 11, a];
        },
        stroked: true,
        filled: true,
        getLineColor: (f) => {
          const harmful = (f.properties.harmful || 0) > 0;
          const dim = selectedRow != null && f.properties.row !== selectedRow;
          const a = dim ? 50 : 165;
          return harmful ? [239, 68, 68, a] : [245, 158, 11, a];
        },
        getLineWidth: 1.5,
        lineWidthUnits: 'pixels',
        updateTriggers: {
          getFillColor: [selectedRow],
          getLineColor: [selectedRow],
        },
      }));
    }

    // Per-fragment impact dots — purple if unharmed, red if harmful.
    if (showImpacts && debrisFeatures.impacts?.features) {
      out.push(new ScatterplotLayer({
        id: 'debris-impacts',
        data: debrisFeatures.impacts.features,
        getPosition: (f) => f.geometry.coordinates,
        getFillColor: (f) => {
          const harmful = f.properties.status === 'harmful';
          const dim = selectedRow != null && f.properties.row !== selectedRow;
          const a = dim ? 50 : 200;
          return harmful ? [239, 68, 68, a] : [167, 139, 250, a];
        },
        getLineColor: [11, 17, 24, 200],
        lineWidthMinPixels: 0.4,
        stroked: true,
        filled: true,
        radiusUnits: 'pixels',
        getRadius: (f) => {
          const dim = selectedRow != null && f.properties.row !== selectedRow;
          return dim ? 1.6 : 3.2;
        },
        pickable: true,
        onClick: (info) => {
          const row = info?.object?.properties?.row;
          if (row != null) onSelectRef.current?.(row, 'impact');
        },
        updateTriggers: {
          getFillColor: [selectedRow],
          getRadius: [selectedRow],
        },
      }));
    }

    // Origin pins last — drawn on top, with a translucent halo ring.
    if (showOrigins && debrisFeatures.origins?.features) {
      out.push(new ScatterplotLayer({
        id: 'debris-origins-ring',
        data: debrisFeatures.origins.features,
        getPosition: (f) => f.geometry.coordinates,
        getFillColor: (f) => {
          const harmful = (f.properties.harmful || 0) > 0;
          return harmful ? [239, 68, 68, 46] : [245, 158, 11, 51];
        },
        getLineColor: (f) => {
          const harmful = (f.properties.harmful || 0) > 0;
          return harmful ? [239, 68, 68, 165] : [245, 158, 11, 165];
        },
        lineWidthMinPixels: 1,
        getLineWidth: 1,
        stroked: true,
        filled: true,
        radiusUnits: 'pixels',
        getRadius: (f) => {
          const sel = selectedRow != null && f.properties.row === selectedRow;
          return sel ? 16 : 11;
        },
        updateTriggers: { getRadius: [selectedRow] },
      }));
      out.push(new ScatterplotLayer({
        id: 'debris-origins-dot',
        data: debrisFeatures.origins.features,
        getPosition: (f) => f.geometry.coordinates,
        getFillColor: (f) => {
          const harmful = (f.properties.harmful || 0) > 0;
          return harmful ? [239, 68, 68, 255] : [245, 158, 11, 255];
        },
        getLineColor: [11, 17, 24, 200],
        lineWidthMinPixels: 1.5,
        stroked: true,
        filled: true,
        radiusUnits: 'pixels',
        getRadius: (f) => {
          const sel = selectedRow != null && f.properties.row === selectedRow;
          return sel ? 7 : 5;
        },
        pickable: true,
        onClick: (info) => {
          const row = info?.object?.properties?.row;
          if (row != null) onSelectRef.current?.(row, 'origin');
        },
        updateTriggers: { getRadius: [selectedRow] },
      }));
    }

    return out;
  }, [
    trajectory3D,
    debrisFeatures,
    showAltitude,
    showOrigins,
    showImpacts,
    showEllipses,
    selectedRow,
    isMercator,
  ]);

  /* ── hover tooltip (matches MapLibre popup look-and-feel) ─── */
  const getTooltip = ({ object, layer }) => {
    if (!object) return null;
    const p = object.properties || {};
    const baseStyle = {
      backgroundColor: 'rgba(14, 22, 32, 0.96)',
      color: '#e8eef7',
      border: '1px solid #1c2530',
      borderRadius: '8px',
      padding: '8px 10px',
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: '11px',
      lineHeight: 1.45,
      maxWidth: '260px',
      boxShadow: '0 8px 24px rgba(0,0,0,0.45)',
      zIndex: 10,
    };
    if (layer.id === 'debris-impacts') {
      const harmful = p.status === 'harmful';
      return {
        html: `
          <div>
            <div style="display:flex;justify-content:space-between;gap:10px;margin-bottom:6px;align-items:center;">
              <span style="background:${harmful ? '#ef4444' : '#a78bfa'};color:#0b1118;font-weight:700;padding:2px 6px;border-radius:4px;font-size:10px;letter-spacing:0.5px;">
                ${harmful ? 'HARMFUL' : 'UNHARMED'}
              </span>
              <span style="color:#9aa6b3;font-size:11px;">Row ${p.row}</span>
            </div>
            <div style="display:grid;grid-template-columns:auto 1fr;gap:3px 12px;">
              <span style="color:#9aa6b3;">Speed</span><span>${formatNumber(p.speed_mps)} m/s</span>
              <span style="color:#9aa6b3;">Mass</span><span>${formatNumber(p.mass_kg, 3)} kg</span>
              <span style="color:#9aa6b3;">KE</span><span>${formatEnergy(p.ke_j)}</span>
            </div>
          </div>
        `,
        style: baseStyle,
      };
    }
    if (layer.id === 'debris-origins-dot' || layer.id === 'debris-origins-ring') {
      return {
        html: `
          <div>
            <div style="display:flex;justify-content:space-between;gap:10px;margin-bottom:6px;align-items:center;">
              <span style="background:#f59e0b;color:#0b1118;font-weight:700;padding:2px 6px;border-radius:4px;font-size:10px;letter-spacing:0.5px;">
                FAILURE PT
              </span>
              <span style="color:#9aa6b3;font-size:11px;">Row ${p.row}</span>
            </div>
            <div style="display:grid;grid-template-columns:auto 1fr;gap:3px 12px;">
              <span style="color:#9aa6b3;">Time</span><span>${formatNumber(p.time_s)} s</span>
              <span style="color:#9aa6b3;">Altitude</span><span>${formatAltKm(p.altitude_m)}</span>
              <span style="color:#9aa6b3;">Impacts</span><span>${p.impact_count ?? '—'}</span>
              <span style="color:#9aa6b3;">Harmful</span><span style="color:${(p.harmful || 0) > 0 ? '#ef4444' : '#e8eef7'};">${p.harmful ?? 0}</span>
            </div>
          </div>
        `,
        style: baseStyle,
      };
    }
    return null;
  };

  /* ── pre-warm the basemap HTTP cache ──────────────────────── */
  // Fire image fetches for the lowest-zoom tiles the moment Map3D
  // mounts (which is now on MapView mount, not on Globe-toggle —
  // see the always-mounted JSX in MapView). By the time deck.gl's
  // WebGL context finishes initializing and TileLayer asks for the
  // same URLs, the browser's HTTP cache returns them instantly,
  // eliminating most of the "blank planet" startup wait.
  //
  //   z=0 → 1 tile  (whole world, blurry)
  //   z=1 → 4 tiles (each hemisphere)
  //   z=2 → 16 tiles (continent-scale; matches our auto-fit zoom 4
  //                   well enough that the first paint looks crisp)
  useEffect(() => {
    const urls = [`${TILE_URL_BASE}/0/0/0${TILE_URL_EXT}`];
    for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) {
      urls.push(`${TILE_URL_BASE}/1/${y}/${x}${TILE_URL_EXT}`);
    }
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
      urls.push(`${TILE_URL_BASE}/2/${y}/${x}${TILE_URL_EXT}`);
    }
    const imgs = urls.map((u) => {
      const i = new Image();
      // crossOrigin set explicitly so the cache entry matches the
      // CORS-enabled fetch deck.gl issues a moment later.
      i.crossOrigin = 'anonymous';
      i.referrerPolicy = 'no-referrer';
      i.src = u;
      return i;
    });
    return () => { imgs.forEach((i) => { i.src = ''; }); };
  }, []);

  /* ── deck.gl instance lifecycle ───────────────────────────── */
  // Re-keyed on `isMercator` so the deck instance is fully recreated
  // when the user toggles Globe ⇄ Flat. Cheaper than trying to mutate
  // the view in place, and the basemap tiles are HTTP-cached so the
  // visible re-init delay is ~100-200ms (not the full 1s cold-start).
  useEffect(() => {
    const host = containerRef.current;
    if (!host) return undefined;

    const canvas = document.createElement('canvas');
    canvas.style.cssText =
      'position:absolute;inset:0;width:100%;height:100%;display:block;' +
      'cursor:grab;outline:none;background:transparent;';
    host.appendChild(canvas);
    canvasRef.current = canvas;

    // Per-projection view + controller. Mercator clamps differ
    // (latitude can go to ~85, beyond which the projection blows up;
    // zoom can go higher because there's no spherical singularity to
    // worry about).
    const view = isMercator
      ? new MapView({ id: 'mercator', repeat: false })
      : new GlobeView({ id: 'globe', resolution: 12 });

    const controller = isMercator
      ? {
          // Top-down 2D map. Pitch is locked to 0 so trajectory
          // altitudes don't visually float above the surface — we want
          // a flat ground track in this mode. Bearing also locked.
          scrollZoom: { speed: 0.015, smooth: true },
          minZoom: 0,
          maxZoom: 14,
          minPitch: 0,
          maxPitch: 0,
          dragRotate: false,
        }
      : {
          // Custom controller config for GlobeView. Tight bounds on
          // every axis the user can move along — _GlobeView's
          // projection matrix gets singular near zoom 0, near pitch
          // 90, and exactly at lat ±90, and any one of those three
          // makes the planet vanish. We also disable drag-rotate
          // (the bearing change gesture) entirely, because non-zero
          // bearing combined with high latitude pushes the camera
          // into a configuration where it ends up looking at the
          // back side of the globe.
          scrollZoom: { speed: 0.015, smooth: true },
          minZoom: 0.5,
          maxZoom: 10,
          minPitch: 0,
          maxPitch: 60,
          dragRotate: false,
        };

    const deck = new Deck({
      canvas,
      views: view,
      initialViewState: viewStateRef.current,
      controller,
      // Render at 1 device pixel per CSS pixel instead of the
      // default `window.devicePixelRatio`. On a retina display
      // that's a 4× cut in pixel-shader work for every layer
      // (basemap tiles, paths, scatter halos) every frame —
      // by far the biggest perf knob for a deck.gl scene at
      // common laptop resolutions. The basemap tiles are already
      // raster and our trajectory lines are pixel-thick anyway,
      // so the visual cost is a barely-perceptible softness on
      // edges.
      useDevicePixels: 1,
      // Transparent clear color so the starfield + space gradient
      // behind the canvas show through where the planet doesn't cover.
      // Each frame: gl.clear paints (0,0,0,0), giving a real "Earth in
      // space" composite once the tile imagery covers the sphere.
      parameters: { clearColor: [0, 0, 0, 0] },
      onViewStateChange: ({ viewState, interactionState }) => {
        // If this view-state change came from a real user gesture
        // (drag/pinch/scroll), bump the idle-interaction timestamp so
        // the auto-spin pauses for a few seconds. Programmatic
        // updates (flyTo, fitToBounds) don't carry these flags and
        // won't disturb the spin.
        if (interactionState && (
          interactionState.isDragging ||
          interactionState.isPanning  ||
          interactionState.isZooming  ||
          interactionState.isRotating
        )) {
          lastInteractionRef.current = performance.now();
        }
        // Three-axis clamp on every user-driven view state update.
        // deck.gl's controller doesn't expose minLatitude / maxLatitude
        // and even pitch / zoom can sneak past their controller bounds
        // at the edges, so we enforce the safe envelope manually.
        //
        //   lat  ∈ [-65, 65]  — well clear of the pole singularity.
        //                       Plenty of margin to view polar regions.
        //   pitch ∈ [0, 60]   — past 60° the camera tilt is steep
        //                       enough that the look-at point can sit
        //                       behind the visible hemisphere.
        //   bearing forced 0  — north-up only. Coupled with high lat,
        //                       any non-zero bearing puts the camera
        //                       on the wrong side of the globe.
        const lat = Number.isFinite(viewState.latitude) ? viewState.latitude : 0;
        const pitch = Number.isFinite(viewState.pitch) ? viewState.pitch : 0;
        const clamped = isMercator
          ? {
              ...viewState,
              // Mercator can't render the poles (math goes singular at
              // ±90). 85° on each side is the standard browser-map cap.
              latitude: Math.max(-85, Math.min(85, lat)),
              pitch: 0,
              bearing: 0,
            }
          : {
              ...viewState,
              latitude: Math.max(-65, Math.min(65, lat)),
              pitch: Math.max(0, Math.min(60, pitch)),
              bearing: 0,
            };
        viewStateRef.current = clamped;
        deck.setProps({ initialViewState: clamped });
      },
      onClick: ({ object, layer }) => {
        // Only forward picks from layers that explicitly set onClick;
        // background clicks (basemap, ellipses) are intentional no-ops.
        if (!object || !layer) return;
      },
      getTooltip,
      layers: [],
    });
    deckRef.current = deck;

    // Push the current static layer set into the new deck instance.
    // Without this, after a projection toggle the new deck starts
    // empty until something else triggers the layer-rebuild effect.
    if (staticLayersRef.current.length || playbackLayersRef.current.length) {
      deck.setProps({
        layers: [...staticLayersRef.current, ...playbackLayersRef.current],
      });
    }

    return () => {
      try { deck.finalize(); } catch { /* ignore */ }
      try { canvas.remove(); } catch { /* ignore */ }
      deckRef.current = null;
      canvasRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isMercator]);

  /* ── push layers + tooltip when they change ──────────────── */
  // Static layers come from the useMemo above (basemap, trajectory,
  // debris); the playback overlay layers are stashed in a ref by
  // the imperative `setPlaybackLayers` so the animation loop can
  // update them at 60Hz without a React re-render.
  useEffect(() => {
    if (!deckRef.current) return;
    staticLayersRef.current = layers;
    deckRef.current.setProps({
      layers: [...staticLayersRef.current, ...playbackLayersRef.current],
      getTooltip,
    });
  }, [layers]);

  /* ── auto-fit to launch site on first data load ──────────── */
  useEffect(() => {
    if (autoFittedRef.current || !launchSite || !deckRef.current) return;
    if (!Number.isFinite(launchSite[0]) || !Number.isFinite(launchSite[1])) return;
    // Frame the launch site at a continent-scale zoom so you can see
    // both the rocket and a recognizable chunk of the planet. We do
    // this even while `visible === false` so the basemap tiles for
    // the launch area are warming in the background — by the time
    // the user toggles to Globe, they're already cached.
    applyViewState({
      longitude: launchSite[0],
      latitude: launchSite[1],
      zoom: 4,
      pitch: 0,
    });
    autoFittedRef.current = true;
  }, [launchSite]);

  /* ── force a redraw when becoming visible after a hide ────── */
  // deck.gl draws on demand, so a hidden canvas may show a stale
  // frame for an instant after un-hiding. A single redraw on the
  // visibility transition guarantees a fresh paint.
  useEffect(() => {
    if (!visible || !deckRef.current) return;
    try { deckRef.current.redraw(true); } catch { /* ignore */ }
  }, [visible]);

  return (
    <div
      className="MV-canvas MV-canvas--3d"
      style={{
        visibility: visible ? 'visible' : 'hidden',
        pointerEvents: visible ? 'auto' : 'none',
      }}
      aria-hidden={!visible}
    >
      <Starfield />
      {/* deck.gl mounts its canvas inside this child div. We keep it
          separate from the React-managed siblings (stars, attribution)
          so React's reconciler never tries to remove the canvas. */}
      <div ref={containerRef} className="MV-canvas-3d-mount" />
      <span className="MV-attrib mono" aria-hidden>
        {isMercator ? TILE_ATTRIBUTION_MERCATOR : TILE_ATTRIBUTION_GLOBE}
      </span>
    </div>
  );
});

/* ─── Starfield ────────────────────────────────────────────────
 * 240 deterministic stars rendered as an SVG sprite behind the
 * (transparent) deck.gl canvas. Most are tiny white dots; a few
 * are larger, brighter "anchor" stars and a handful carry a
 * slight blue or amber tint — the kind of variety you actually
 * see in night-sky photography. Memoized so they don't jitter on
 * every render.
 */
function Starfield() {
  const stars = useMemo(() => {
    const out = [];
    // Hash-based PRNG for stable layouts across mount/unmount.
    const rand = (n) => {
      const x = Math.sin(n * 12.9898) * 43758.5453;
      return x - Math.floor(x);
    };
    for (let i = 0; i < 240; i++) {
      const big = i < 8;
      const tinted = !big && i < 28;
      out.push({
        x: rand(i * 7 + 1) * 1000,
        y: rand(i * 7 + 2) * 1000,
        r: big ? 1.6 + rand(i + 99) * 0.9 : 0.25 + rand(i + 33) * 0.7,
        o: big ? 0.85 + rand(i + 17) * 0.15 : 0.22 + rand(i + 5) * 0.55,
        c: tinted ? (i % 2 === 0 ? '#cfe0ff' : '#ffe9c8') : '#ffffff',
      });
    }
    return out;
  }, []);
  return (
    <svg
      className="MV-stars"
      viewBox="0 0 1000 1000"
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
    >
      {stars.map((s, i) => (
        <circle key={i} cx={s.x} cy={s.y} r={s.r} fill={s.c} opacity={s.o} />
      ))}
    </svg>
  );
}

export default Map3D;

/* ─── helpers (mirror of MapView's so popups format identically) ── */

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
