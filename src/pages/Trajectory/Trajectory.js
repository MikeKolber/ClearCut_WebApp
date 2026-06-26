import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import TopBar from '../../components/TopBar/TopBar';
import {
  TRAJECTORY_PARAMS,
  STAGE_PARAMS_PER_STAGE,
  STRUCTURE_PARAMS,
  LOCKED_MIRRORS,
  DEBRIS_PARAMS,
  PRESETS,
  STAGE_ACCENTS,
} from './params';
import {
  startTrajectoryRun,
  getTrajectoryRunStatus,
  cancelTrajectoryRun,
  startDebrisRun,
  getDebrisRunStatus,
  cancelDebrisRun,
  listTrajectoryPresets,
  saveTrajectoryPreset,
  deleteTrajectoryPreset,
  listDebrisPresets,
  saveDebrisPreset,
  deleteDebrisPreset,
  loadSimulationFile,
  loadDebrisRun,
  saveCurrentSimulation,
  trajectoryDownloadUrl,
  downloadFromBackend,
} from '../../services/api';
import { downloadJson, slugifyFilename } from '../../utils/download';
import {
  PlotPreview,
  DebrisPreview,
  ExcelPreview,
  KmlPreview,
  DebrisFolderPreview,
} from './previews';
import { JumpTabs, getJumpTabs } from './JumpTabs';
import DebrisFilesModal from './DebrisFilesModal';
import LoadDebrisModal from './LoadDebrisModal';
import LoadSimulationModal from './LoadSimulationModal';
import RocketViewerModal from './RocketViewerModal';
import { RUN_STATE_STORAGE_KEY } from './runState';
import { TIPS } from './paths';
import Tooltip from '../../components/Tooltip/Tooltip';
import ErrorToast from '../../components/ErrorToast/ErrorToast';
import './Trajectory.css';

/* ─────────────────────────────────────────────────────────────────
 *  Trajectory page — visual scaffold.
 *
 *  Lay-out:
 *   ├── TopBar (overflow menu: Load Sim / Load Debris / Compare)
 *   ├── Top progress strip (hidden when idle)
 *   └── Body (sidebar + content)
 *       ├── Sidebar
 *       │   ├── tab strip [Trajectory] [Debris]
 *       │   └── tab content (collapsible sections, stage chip strip)
 *       └── Content
 *           ├── animated orbit icon
 *           ├── title + subtitle
 *           ├── mission summary card
 *           ├── run block (button + status pill)
 *           └── results grid (hidden until success)
 *
 *  Functions are deliberately stubbed out — the goal here is layout +
 *  interactivity. Buttons are wired to a mock run cycle so all visual
 *  states (idle / running / success) can be inspected before we plumb
 *  the real Flask endpoints.
 * ─────────────────────────────────────────────────────────────── */

// How often we poll the backend for run status. Lower = more samples for
// the progress-bar interpolator, more HTTP chatter. 200 ms feels live
// without putting any meaningful load on the Flask worker.
const POLL_INTERVAL_MS = 200;

// How far behind real time the progress bar plays. Wide enough that we
// (almost) always have a future sample to interpolate toward, narrow
// enough the bar still feels live. Slightly larger than POLL_INTERVAL_MS
// is the right ballpark.
const PROGRESS_LAG_MS = 500;

// Cap the sample buffer so a long-running sim doesn't grow it unbounded.
const PROGRESS_SAMPLE_CAP = 200;

/* Build an empty parameter dict from a schema — every field is set to
   '' so the inputs render blank on first paint. Used to initialise the
   trajectory + debris forms so colleagues land on a clean slate
   instead of a pre-filled "demo" config that might silently roll over
   into a run if they don't notice. Presets fill the form in one click;
   manual entry is fully explicit. */
function collectEmpty(schema) {
  const out = {};
  for (const fields of Object.values(schema)) {
    for (const key of Object.keys(fields)) {
      out[key] = '';
    }
  }
  return out;
}

/* Same idea for the trajectory form, which has flat trajectory fields
   PLUS Stage1 / Stage2 / Stage3 sub-objects (each shaped like
   `STAGE_PARAMS_PER_STAGE`) PLUS a `structure` sub-object carrying the
   ~30 fields that used to live in `rocket_structure.yaml`. Returns a
   value matching the live `params` shape — empty strings for the
   trajectory fields the user must fill in, and *populated defaults*
   for structure fields (since the YAML used to provide those values
   for free and we don't want to force the user to type 30 numbers
   just to run a default rocket). */
function emptyTrajectoryParams() {
  return {
    ...collectEmpty(TRAJECTORY_PARAMS),
    Stage1: collectEmpty(STAGE_PARAMS_PER_STAGE),
    Stage2: collectEmpty(STAGE_PARAMS_PER_STAGE),
    Stage3: collectEmpty(STAGE_PARAMS_PER_STAGE),
    structure: defaultStructureParams(),
  };
}

/* Default values for the Structure tab — pulled from each field's
   `default` in STRUCTURE_PARAMS. Used as the starting point both for
   `emptyTrajectoryParams()` and for the "Reset to defaults" button
   inside the Structure tab. */
function defaultStructureParams() {
  const out = {};
  for (const fields of Object.values(STRUCTURE_PARAMS)) {
    for (const [key, meta] of Object.entries(fields)) {
      out[key] = meta.default ?? '';
    }
  }
  return out;
}

/* sessionStorage key for the run-state snapshot lives in `./runState`
   — see the import block at the top of this file. The same key is
   read by the result pages (Plot / Map / Raw Data) to gate their
   own data displays, so it must be a single source of truth. */

function loadPersistedRunState() {
  try {
    const raw = sessionStorage.getItem(RUN_STATE_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    if (parsed.phase !== 'running' && parsed.phase !== 'success') return null;
    return parsed;
  } catch {
    return null;
  }
}

function persistRunState(snapshot) {
  try {
    if (snapshot == null) {
      sessionStorage.removeItem(RUN_STATE_STORAGE_KEY);
    } else {
      sessionStorage.setItem(RUN_STATE_STORAGE_KEY, JSON.stringify(snapshot));
    }
  } catch {
    /* sessionStorage unavailable / quota exceeded — non-fatal */
  }
}

function Trajectory() {
  const navigate = useNavigate();

  // Snapshot from sessionStorage — populated when the user navigated
  // away (e.g. opened /trajectory/plot) and is now coming back. We seed
  // every relevant piece of state from it so the page picks up exactly
  // where it was. Read once, before any state hooks, so the seed values
  // are constants throughout this render.
  const persistedRef = useRef(null);
  if (persistedRef.current === null) {
    persistedRef.current = loadPersistedRunState() || {};
  }
  const persisted = persistedRef.current;

  /* ── state ───────────────────────────────────────────────── */
  const [tab, setTab] = useState(() => persisted.tab || 'params'); // 'params' | 'debris'
  const [phase, setPhase] = useState(() =>
    persisted.phase === 'success' || persisted.phase === 'running'
      ? persisted.phase
      : 'idle'
  );
  // Which kind of run is currently running / was last successful. Drives
  // the run button label, the progress phase strings, and which result
  // cards we render. 'trajectory' is the default first run; clicking
  // the Debris Analysis result card flips this to 'debris'.
  const [runKind, setRunKind] = useState(() => persisted.runKind || 'trajectory');
  // displayPct = what the progress bar actually renders. We record
  // every backend poll into `progressSamplesRef` with a wall-clock
  // timestamp, then a rAF loop renders the bar at `now() -
  // PROGRESS_LAG_MS`, linearly interpolating between the two samples
  // that bracket that virtual cursor. End result: motion is
  // continuous at the actual simulator rate, paid for with ~500 ms
  // of intentional delay.
  const [displayPct, setDisplayPct] = useState(() =>
    persisted.phase === 'success' ? 100 : 0
  );
  const progressSamplesRef = useRef([]); // [{ t: ms, pct: 0..100 }, ...]
  const [progressLabel, setProgressLabel] = useState(() =>
    persisted.phase === 'success' ? 'Complete' : 'Initializing…'
  );
  const [elapsed, setElapsed] = useState(() => persisted.elapsed || 0);

  const [params, setParams] = useState(() => {
    // Backfill `structure` from defaults when the persisted state
    // pre-dates the Structure tab (so existing tabs in flight don't
    // lose their other fields, but every Structure field is present).
    const base = persisted.params || emptyTrajectoryParams();
    return {
      ...base,
      structure: { ...defaultStructureParams(), ...(base.structure || {}) },
    };
  });
  const [presetName, setPresetName] = useState(
    () => persisted.presetName || 'Custom'
  );
  const [activeStage, setActiveStage] = useState(1);

  // User-saved presets pulled from disk (everything in
  // `json_files/presets/`). Merged with the hardcoded `PRESETS`
  // baseline so user-saved presets show up in the picker
  // immediately after the Save as Preset action.
  const [userPresets, setUserPresets] = useState({});

  const refreshUserPresets = useCallback(async () => {
    try {
      const res = await listTrajectoryPresets();
      const out = {};
      for (const p of res?.presets || []) {
        if (!p?.name || !p?.data) continue;
        out[p.name] = { name: p.name, ...p.data };
      }
      setUserPresets(out);
    } catch {
      // Backend isn't reachable / endpoint missing — fall back to
      // just the hardcoded PRESETS. Don't surface this to the user.
    }
  }, []);

  useEffect(() => { refreshUserPresets(); }, [refreshUserPresets]);

  // Merged map: user-saved presets win over the hardcoded baseline so
  // the user can locally override one of the shipped names.
  const allPresets = useMemo(
    () => ({ ...PRESETS, ...userPresets }),
    [userPresets]
  );

  const [debrisMode, setDebrisMode] = useState('interval');
  const [debrisParams, setDebrisParams] = useState(() => collectEmpty(DEBRIS_PARAMS));
  // Selected debris preset name. 'Custom' = no preset / hand-edited.
  const [debrisPresetName, setDebrisPresetName] = useState('Custom');

  // User-saved debris presets pulled from disk (`json_files/debris_presets/`).
  // Independent of trajectory presets — debris has its own library because
  // a "preset" here is a tuning of explosion / mass-distribution / physics
  // params, not a launch profile. Same name-collision + 409 retry semantics.
  const [userDebrisPresets, setUserDebrisPresets] = useState({});

  const refreshUserDebrisPresets = useCallback(async () => {
    try {
      const res = await listDebrisPresets();
      const out = {};
      for (const p of res?.presets || []) {
        if (!p?.name || !p?.data) continue;
        out[p.name] = { name: p.name, ...p.data };
      }
      setUserDebrisPresets(out);
    } catch {
      // Backend unreachable / endpoint missing — quietly leave the
      // user-presets map empty. The "Custom" entry is always present
      // in the picker so the dropdown is never broken.
    }
  }, []);

  useEffect(() => { refreshUserDebrisPresets(); }, [refreshUserDebrisPresets]);
  const [customPoints, setCustomPoints] = useState(['']);

  // Sidebar starts closed when restoring a finished/in-flight run, since
  // the content area is what the user wants to see.
  const [sidebarOpen, setSidebarOpen] = useState(
    () => !(persisted.phase === 'success' || persisted.phase === 'running')
  );

  // Active backend run + last error message
  const [runId, setRunId] = useState(() =>
    persisted.phase === 'running' ? persisted.runId || null : null
  );
  const [runError, setRunError] = useState(null);

  // Track whether the current `success` view was rehydrated from
  // sessionStorage (so we skip the entrance animation — it already
  // played the first time the user saw it). Cleared whenever the
  // user starts a brand-new run.
  const [restoredSuccess, setRestoredSuccess] = useState(
    () => persisted.phase === 'success'
  );

  // "Has a trajectory been run / loaded in this session yet?" Gates
  // the Run Debris button — clicking it without a fresh trajectory
  // shows a popup instead of running. Initialized from the persisted
  // snapshot so navigating away/back doesn't lose the fact that
  // trajectory has already finished. A stale on-disk CSV from a
  // previous machine session does NOT count — only an explicit
  // success in *this* session unlocks debris.
  //
  // Both flags use state (not refs) so toggling them re-renders the
  // ResultsBlock — that's how trajectory + debris cards can stack
  // after a debris run finishes.
  const [trajectoryDoneInSession, setTrajectoryDoneInSession] = useState(
    () => persisted.phase === 'success' &&
      (persisted.runKind === 'trajectory' || persisted.debrisDone)
  );
  const [debrisDoneInSession, setDebrisDoneInSession] = useState(
    () => persisted.debrisDone === true
  );

  // Mission-lock pulse: a quiet pair of accent rings that expand once
  // from the progress-bar center on every successful trajectory run.
  // Counter-driven so re-running fires the effect again (keyed
  // remount). Subtle enough to repeat without becoming tiresome —
  // closer to a sonar lock than a celebration.
  const [missionLockKey, setMissionLockKey] = useState(0);

  const noOfStages = useMemo(() => {
    const n = parseInt(params.no_of_stages, 10);
    return Number.isFinite(n) ? Math.max(1, Math.min(3, n)) : 1;
  }, [params.no_of_stages]);

  // Snap activeStage if the user lowers no_of_stages.
  useEffect(() => {
    if (activeStage > noOfStages) setActiveStage(noOfStages);
  }, [noOfStages, activeStage]);

  /* ── persist run state across navigation ──────────────────── */
  // Mirror the bits of state we need to bring back (after a hop to
  // /trajectory/plot, say) into sessionStorage. `idle` clears the
  // snapshot — a fresh page load with nothing pending lands on the
  // empty form, as it should.
  useEffect(() => {
    if (phase === 'idle') {
      persistRunState(null);
      return;
    }
    persistRunState({
      phase,
      runId,
      runKind,
      tab,
      params,
      presetName,
      elapsed,
      debrisDone: debrisDoneInSession,
      savedAt: Date.now(),
    });
  }, [phase, runId, runKind, tab, params, presetName, elapsed, debrisDoneInSession]);

  /* ── param mutators ─────────────────────────────────────── */
  const setParam = useCallback((key, value) => {
    setParams((p) => ({ ...p, [key]: value }));
  }, []);

  const setStageParam = useCallback((stageKey, key, value) => {
    setParams((p) => ({
      ...p,
      [stageKey]: { ...p[stageKey], [key]: value },
    }));
  }, []);

  // Structure-tab setter — nests into `params.structure` so the whole
  // form state stays in one object. Preset save/load and validation
  // both walk the same `params` tree so they pick up structure changes
  // for free.
  const setStructureParam = useCallback((key, value) => {
    setParams((p) => ({
      ...p,
      structure: { ...(p.structure || {}), [key]: value },
    }));
  }, []);

  const resetStructureParams = useCallback(() => {
    setParams((p) => ({ ...p, structure: defaultStructureParams() }));
  }, []);

  const setDebrisParam = useCallback((key, value) => {
    setDebrisParams((p) => ({ ...p, [key]: value }));
  }, []);

  const resetDebrisDefaults = useCallback(() => {
    setDebrisParams(collectEmpty(DEBRIS_PARAMS));
    setCustomPoints(['']);
    setDebrisMode('interval');
    setDebrisPresetName('Custom');
  }, []);

  /* ── preset loading ─────────────────────────────────────── */
  const loadPreset = useCallback((name) => {
    if (name === 'Custom') {
      setPresetName('Custom');
      return;
    }
    const preset = allPresets[name];
    if (!preset) return;
    // Backfill the Structure block from defaults if the preset was
    // saved before the Structure tab existed (or if individual fields
    // are missing). User-provided structure values from the preset
    // override the defaults; everything else falls back. Same idea
    // as the Python side's `STRUCTURE_DEFAULTS` resolution order.
    const merged = {
      ...preset,
      structure: {
        ...defaultStructureParams(),
        ...(preset.structure || {}),
      },
    };
    setParams(merged);
    setPresetName(name);
    setActiveStage(1);
  }, [allPresets]);

  // Wipe the trajectory form back to the cold-start empty state. Used by
  // the "Clear" button in the sidebar footer — mirror of the debris
  // tab's clear action so both tabs offer the same Save + Clear combo.
  // Preserves the user's Structure tab edits — those have their own
  // dedicated "Reset to Defaults" button, so clearing the Simulation
  // tab shouldn't silently wipe geometry the user spent time tuning.
  const clearTrajectoryParams = useCallback(() => {
    setParams((p) => ({
      ...emptyTrajectoryParams(),
      structure: p.structure || defaultStructureParams(),
    }));
    setPresetName('Custom');
    setActiveStage(1);
  }, []);

  /* ── Save current params as a new preset on disk ─────────── */
  // Mirrors the desktop `save_parameters()` flow: ask for a name
  // (prefilled with `inclination-orbit_height` when available),
  // POST to the backend, prompt for overwrite on a 409, refresh the
  // dropdown, and select the just-saved preset.
  const handleSavePreset = useCallback(async () => {
    const inc = params?.desired_inclination;
    const orbH = params?.desired_orbit_height;
    const suggested =
      Number.isFinite(inc) && Number.isFinite(orbH)
        ? `${Math.round(inc)}-${Math.round(orbH)}`
        : 'preset';

    const raw = window.prompt('Save preset as:', suggested);
    const name = (raw || '').trim();
    if (!name) return;

    let saved;
    try {
      saved = await saveTrajectoryPreset(name, params, false);
    } catch (err) {
      if (err.status === 409 && err.body?.exists) {
        const proposedName = err.body.name || name;
        const ok = window.confirm(
          `A preset named "${proposedName}" already exists.\n\nOverwrite it?`
        );
        if (!ok) return;
        try {
          saved = await saveTrajectoryPreset(name, params, true);
        } catch (err2) {
          setRunError({
            kind: 'runtime',
            title: 'Could not save preset',
            details: [err2.message || String(err2)],
          });
          return;
        }
      } else {
        setRunError({
          kind: 'runtime',
          title: 'Could not save preset',
          details: [err.message || String(err)],
        });
        return;
      }
    }

    await refreshUserPresets();
    if (saved?.saved_name) setPresetName(saved.saved_name);
  }, [params, refreshUserPresets]);

  /* ── Download a local copy of the trajectory preset JSON ──────
   * Companion to handleSavePreset above. "Save as Preset" puts the
   * file into the shared team library on the server; "Download"
   * gives the user a .json on their own computer (browser handles
   * the save-as dialog / Downloads folder per their OS settings).
   * Same shape, same data — just two destinations.
   */
  const handleDownloadPreset = useCallback(() => {
    const inc = params?.desired_inclination;
    const orbH = params?.desired_orbit_height;
    const suggested =
      Number.isFinite(inc) && Number.isFinite(orbH)
        ? `${Math.round(inc)}-${Math.round(orbH)}`
        : 'trajectory-preset';
    const raw = window.prompt('Download preset as filename:', suggested);
    const name = (raw || '').trim();
    if (!name) return;
    downloadJson(`clearcut-${slugifyFilename(name)}.json`, params);
  }, [params]);

  /* ── Debris preset loading + saving ──────────────────────────── */
  // Same shape as the trajectory preset flow above, but reads/writes
  // from `json_files/debris_presets/` on the backend. 'Custom' means
  // no preset is active — picking it just updates the label without
  // mutating any params.
  const loadDebrisPreset = useCallback((name) => {
    if (name === 'Custom') {
      setDebrisPresetName('Custom');
      return;
    }
    const preset = userDebrisPresets[name];
    if (!preset) return;
    // Strip the `name` key we tack on for picker labelling — only the
    // actual debris param keys should land in `debrisParams`.
    const { name: _name, ...payload } = preset;
    setDebrisParams({ ...collectEmpty(DEBRIS_PARAMS), ...payload });
    setDebrisPresetName(name);
  }, [userDebrisPresets]);

  const handleSaveDebrisPreset = useCallback(async () => {
    // Suggested name uses the same convention as the seed preset:
    //   interval mode → "{debris-per-point}d-{interval}s"   (e.g. 10d-50s)
    //   custom mode   → "{debris-per-point}d-{N}pts"        (e.g. 10d-3pts)
    // Falls back to "debris-preset" when the relevant params aren't set.
    const dbg = parseInt(debrisParams.number_of_debris, 10);
    const intv = parseFloat(debrisParams.failure_interval_s);
    let suggested = 'debris-preset';
    if (Number.isFinite(dbg)) {
      if (debrisMode === 'interval' && Number.isFinite(intv)) {
        suggested = `${dbg}d-${Math.round(intv)}s`;
      } else if (debrisMode === 'custom') {
        const pts = customPoints
          .filter((p) => Number.isFinite(parseFloat(p))).length;
        if (pts > 0) suggested = `${dbg}d-${pts}pts`;
      }
    }

    const raw = window.prompt('Save debris preset as:', suggested);
    const name = (raw || '').trim();
    if (!name) return;

    let saved;
    try {
      saved = await saveDebrisPreset(name, debrisParams, false);
    } catch (err) {
      if (err.status === 409 && err.body?.exists) {
        const proposedName = err.body.name || name;
        const ok = window.confirm(
          `A debris preset named "${proposedName}" already exists.\n\nOverwrite it?`
        );
        if (!ok) return;
        try {
          saved = await saveDebrisPreset(name, debrisParams, true);
        } catch (err2) {
          setRunError({
            kind: 'runtime',
            title: 'Could not save debris preset',
            details: [err2.message || String(err2)],
          });
          return;
        }
      } else {
        setRunError({
          kind: 'runtime',
          title: 'Could not save debris preset',
          details: [err.message || String(err)],
        });
        return;
      }
    }

    await refreshUserDebrisPresets();
    if (saved?.saved_name) setDebrisPresetName(saved.saved_name);
  }, [debrisParams, debrisMode, customPoints, refreshUserDebrisPresets]);

  /* ── Download a local copy of the debris preset JSON ─────────
   * Same idea as handleDownloadPreset above, but for the debris tab.
   */
  const handleDownloadDebrisPreset = useCallback(() => {
    const raw = window.prompt('Download debris preset as filename:', 'debris-preset');
    const name = (raw || '').trim();
    if (!name) return;
    downloadJson(`clearcut-debris-${slugifyFilename(name)}.json`, debrisParams);
  }, [debrisParams]);

  /* ── Preset deletion (trajectory + debris) ─────────────────────────
     PresetPicker enters select-mode and emits the chosen names; we
     issue the DELETE calls in parallel, refresh the list, and reset
     the active preset label if it pointed at one of the removed items. */
  const handleDeleteTrajectoryPresets = useCallback(async (names) => {
    if (!Array.isArray(names) || names.length === 0) return;
    const failures = [];
    await Promise.all(names.map(async (n) => {
      try { await deleteTrajectoryPreset(n); }
      catch (err) { failures.push(`${n}: ${err.message || String(err)}`); }
    }));
    await refreshUserPresets();
    if (names.includes(presetName)) setPresetName('Custom');
    if (failures.length > 0) {
      setRunError({
        kind: 'runtime',
        title: 'Could not delete some presets',
        details: failures,
      });
    }
  }, [presetName, refreshUserPresets]);

  const handleDeleteDebrisPresets = useCallback(async (names) => {
    if (!Array.isArray(names) || names.length === 0) return;
    const failures = [];
    await Promise.all(names.map(async (n) => {
      try { await deleteDebrisPreset(n); }
      catch (err) { failures.push(`${n}: ${err.message || String(err)}`); }
    }));
    await refreshUserDebrisPresets();
    if (names.includes(debrisPresetName)) setDebrisPresetName('Custom');
    if (failures.length > 0) {
      setRunError({
        kind: 'runtime',
        title: 'Could not delete some debris presets',
        details: failures,
      });
    }
  }, [debrisPresetName, refreshUserDebrisPresets]);

  /* ── Mission action handlers (Load Sim / Load Debris / Compare) ── */

  // Modal-mode Load Simulation: shows a list of saved sims (server-side
  // Pre-loaded Trajectories/) plus a "Browse from disk" fallback.
  // Hidden <input type="file"> still lives at page level for the
  // browse-from-disk path; the modal calls back into us to trigger it.
  const loadSimInputRef = useRef(null);
  const [loadSimOpen, setLoadSimOpen] = useState(false);
  const [loadDebrisOpen, setLoadDebrisOpen] = useState(false);

  const handleLoadSim = useCallback(() => {
    setLoadSimOpen(true);
  }, []);

  /* Common state-update path for "we now have a fresh trajectory
     loaded into the UI" — used by both the saved-list pick and the
     browse-from-disk flow. Drops the page into the success state so
     the result cards show up immediately, AND repopulates the form
     params from the loaded sim.
     ─── How `params` is rebuilt ───────────────────────────────────
       1. If the backend returned `fullParams` (the JSON sidecar that
          Save Simulation now writes alongside the XLSX), use it as-is
          — that's the original form state at save time, complete with
          stage sub-objects and orbit target. Best-case round trip.
       2. Otherwise apply `derived` (5 keys the backend pulls straight
          from the output CSV's first/last rows) on top of an empty
          form. Honest about what's recoverable from a flat output.   */
  const finishLoadedSim = useCallback((displayName, derived, fullParams) => {
    setRunError(null);
    setRunId(null);
    setRunKind('trajectory');
    setElapsed(0);
    setRestoredSuccess(false);
    setTrajectoryDoneInSession(true);
    // A loaded sim invalidates any prior debris run — the on-disk
    // debris CSVs no longer match the trajectory we just replaced.
    setDebrisDoneInSession(false);
    setPresetName(displayName.replace(/\.[^.]+$/, ''));
    if (fullParams && typeof fullParams === 'object') {
      // Use the saved form state verbatim — gives us back the orbit
      // target, per-stage burn times, mass fractions, everything.
      setParams(fullParams);
    } else {
      // Best-effort partial repop. Reset other fields to '' so the
      // mission summary shows "—" instead of stale prior values.
      setParams({ ...emptyTrajectoryParams(), ...(derived || {}) });
    }
    setActiveStage(1);
    setPhase('success');
  }, []);

  const onLoadSimFile = useCallback(async (e) => {
    const file = e.target.files?.[0];
    // Reset the input so picking the *same* file again still fires.
    if (e.target) e.target.value = '';
    if (!file) return;

    try {
      const res = await loadSimulationFile(file);
      // Uploaded files never have a sidecar; only `derived` applies.
      finishLoadedSim(file.name, res?.derived, null);
    } catch (err) {
      setRunError({
        kind: 'runtime',
        title: 'Could not load simulation',
        details: [err.message || String(err)],
      });
    }
  }, [finishLoadedSim]);

  /* Saved-list pick from the LoadSimulationModal — server has already
     copied the file into output/simulation_output.csv, we just need
     to roll the UI into the success state. If the saved entry has a
     `.json` sidecar we get the full form state back too. */
  const onSavedSimLoaded = useCallback((res) => {
    finishLoadedSim(
      res?.name || 'saved simulation',
      res?.derived,
      res?.params,
    );
  }, [finishLoadedSim]);

  /* Browse-from-disk fallback inside the modal — close the modal and
     trigger the hidden file input so the existing upload path runs. */
  const onBrowseDiskFromModal = useCallback(() => {
    setLoadSimOpen(false);
    /* tiny delay so the modal's exit doesn't swallow the click event */
    setTimeout(() => loadSimInputRef.current?.click(), 0);
  }, []);

  /* Save Simulation — copy the current `simulation_output.csv` into
     `Pre-loaded Trajectories/<name>.xlsx` so it shows up in the
     Load Simulation modal's saved list AND in the Compare reference
     set. UX flow mirrors Save Preset: prompt for name, retry with
     overwrite=true on 409. */
  const handleSaveSimulation = useCallback(async () => {
    const suggested = (presetName || 'simulation')
      .replace(/[^A-Za-z0-9 ._-]/g, '_')
      .trim() || 'simulation';
    const name = window.prompt(
      'Name this saved simulation:',
      suggested,
    );
    if (name == null) return;
    const trimmed = name.trim();
    if (!trimmed) return;

    try {
      // Pass the live form params so the backend can drop a JSON
      // sidecar next to the XLSX. That sidecar carries the full
      // config — orbit target, per-stage burn times, mass fractions,
      // everything — so loading the saved sim later restores the
      // full form state, not just the 5 fields derivable from the
      // output columns.
      const res = await saveCurrentSimulation(trimmed, false, params);
      setRunError({
        kind: 'success',
        title: 'Simulation saved',
        details: [`Saved as "${res.saved_name}".`],
      });
    } catch (err) {
      if (err.status === 409 && err.body?.exists) {
        const ok = window.confirm(
          `A saved simulation named "${err.body.name}" already exists.\n\n` +
          'Overwrite it?'
        );
        if (!ok) return;
        try {
          const res2 = await saveCurrentSimulation(trimmed, true, params);
          setRunError({
            kind: 'success',
            title: 'Simulation overwritten',
            details: [`Saved as "${res2.saved_name}".`],
          });
        } catch (err2) {
          setRunError({
            kind: 'runtime',
            title: 'Could not save simulation',
            details: [err2.message || String(err2)],
          });
        }
      } else {
        setRunError({
          kind: 'runtime',
          title: 'Could not save simulation',
          details: [err.message || String(err)],
        });
      }
    }
  }, [presetName, params]);

  /* ── Download the current simulation output as a CSV/XLSX ────
   * Sister action to handleSaveSimulation. Save Simulation pushes
   * the current run into the team library on the server; Download
   * Simulation hands the user the same data as a file on their own
   * computer (browser save-as / Downloads folder per OS settings).
   *
   * Uses the existing `/api/trajectory/output/download` endpoint
   * via the api.js helper — same path Raw Data uses for its
   * download button, so format support and filename handling are
   * already battle-tested.
   */
  const handleDownloadSimulation = useCallback(async (format = 'csv') => {
    const fmt = format === 'xlsx' ? 'xlsx' : 'csv';
    try {
      await downloadFromBackend(
        trajectoryDownloadUrl(fmt),
        // Suggested name; the backend's Content-Disposition wins
        // if it sends one. We pass our own to cover the case where
        // it doesn't.
        `simulation_output.${fmt}`,
      );
    } catch (err) {
      setRunError({
        kind: 'runtime',
        title: 'Could not download simulation',
        details: [err.message || String(err)],
      });
    }
  }, []);

  const handleLoadDebris = useCallback(() => {
    setLoadDebrisOpen(true);
  }, []);

  // Picked a run from the LoadDebrisModal — mark debris as fresh
  // for this session, transition to success state, and bounce to
  // the map view so the user immediately sees it. We persist the
  // debris-fresh flag synchronously to sessionStorage *before*
  // navigating, otherwise React's deferred state-flush race could
  // let MapView mount while `isDebrisFreshInSession()` still reads
  // false and the debris layers wouldn't appear on first paint.
  const onPickDebrisRun = useCallback(async (runId) => {
    try {
      await loadDebrisRun(runId);
    } catch (err) {
      setRunError({
        kind: 'runtime',
        title: 'Could not load debris run',
        details: [err.message || String(err)],
      });
      return;
    }

    /* Flip the run state into the same "success + debris-done" shape
       that finishing a debris analysis from scratch produces. After
       this commits, the trajectory page re-renders into the results
       view with both the trajectory result cards (Plot Data, Map,
       Raw Data) AND the debris result cards (Map, Results Folder)
       — i.e. the user stays on this page with every result button
       visible, instead of being yanked to the map. They can then
       click whichever result they actually want to see. */
    setDebrisDoneInSession(true);
    setTrajectoryDoneInSession(true);
    setPhase('success');
    setLoadDebrisOpen(false);

    try {
      const raw = sessionStorage.getItem(RUN_STATE_STORAGE_KEY);
      const cur = raw ? JSON.parse(raw) : {};
      sessionStorage.setItem(
        RUN_STATE_STORAGE_KEY,
        JSON.stringify({ ...cur, phase: 'success', debrisDone: true }),
      );
    } catch { /* ignore */ }
  }, []);

  const handleCompare = useCallback(() => {
    navigate('/trajectory/compare');
  }, [navigate]);

  /* ── buffered-playback display value for the progress bar ─── */
  // Each poll appends a {t, pct} sample to progressSamplesRef. The rAF
  // loop renders at `now - PROGRESS_LAG_MS`, finds the two samples
  // bracketing that virtual cursor, and lerps. Constant-velocity motion
  // between samples means no chase-and-catch-up jitter — the bar moves
  // at the actual simulator rate, ~500 ms behind real time.
  useEffect(() => {
    if (phase === 'idle') {
      setDisplayPct(0);
      return undefined;
    }
    let raf = 0;
    const tick = () => {
      const samples = progressSamplesRef.current;
      const cursor = performance.now() - PROGRESS_LAG_MS;

      let value;
      if (samples.length === 0) {
        value = 0;
      } else if (samples.length === 1 || cursor <= samples[0].t) {
        value = samples[0].pct;
      } else {
        const last = samples[samples.length - 1];
        if (cursor >= last.t) {
          value = last.pct;
        } else {
          // Walk from the end — the cursor is almost always near the tail.
          let i = samples.length - 1;
          while (i > 0 && samples[i - 1].t > cursor) i--;
          const a = samples[i - 1];
          const b = samples[i];
          const span = b.t - a.t;
          const f = span > 0 ? (cursor - a.t) / span : 1;
          value = a.pct + (b.pct - a.pct) * f;
        }
      }
      setDisplayPct(value);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [phase]);

  /* ── poll the backend run while one is active ─────────────── */
  useEffect(() => {
    if (!runId || phase !== 'running') return undefined;

    let cancelled = false;
    let timer = null;

    const pushSample = (pct) => {
      const buf = progressSamplesRef.current;
      const last = buf.length ? buf[buf.length - 1] : null;
      // Skip duplicates: the simulator prints PROGRESS at 1-decimal
      // precision, so two polls 200 ms apart frequently report the
      // same value. Pushing both creates a flat segment between them
      // that the interpolator faithfully renders as "stopped". By
      // dropping the duplicate, the next *different* pct extends the
      // active segment to span the whole flat period — the cursor
      // glides through it instead of stalling.
      if (last && Math.abs(last.pct - pct) < 1e-6) return;
      buf.push({ t: performance.now(), pct });
      if (buf.length > PROGRESS_SAMPLE_CAP) buf.shift();
    };

    const statusFn = runKind === 'debris' ? getDebrisRunStatus : getTrajectoryRunStatus;
    const poll = async () => {
      try {
        const s = await statusFn(runId);
        if (cancelled) return;
        const livePct = (s.progress || 0) * 100;
        pushSample(livePct);
        setElapsed(Math.floor(s.elapsed_s || 0));
        setProgressLabel(`${s.phase || 'Running'}…`);
        if (s.status === 'success') {
          // Pin the buffer at 100 so the playback head finishes there.
          pushSample(100);

          // Mark trajectory or debris as fresh-in-session so we know
          // debris can be run, AND so we can stack debris result cards
          // on top of the trajectory's.
          if (runKind === 'trajectory') {
            setTrajectoryDoneInSession(true);
          } else if (runKind === 'debris') {
            setDebrisDoneInSession(true);
          }

          // Mission-lock pulse — fires once per successful trajectory
          // run. Quiet enough to be welcome every time; we increment a
          // counter so the keyed component remounts and replays.
          if (runKind === 'trajectory') {
            setMissionLockKey((k) => k + 1);
          }

          setPhase('success');
          setRunId(null);
          return;
        }
        if (s.status === 'failed') {
          setRunError({
            kind: 'runtime',
            title: runKind === 'debris'
              ? 'Debris analysis failed'
              : 'Simulation failed',
            details: [s.error_msg || 'Simulation failed'],
          });
          setPhase('idle');
          setRunId(null);
          return;
        }
        if (s.status === 'cancelled') {
          setPhase('idle');
          setRunId(null);
          return;
        }
        timer = setTimeout(poll, POLL_INTERVAL_MS);
      } catch (e) {
        if (cancelled) return;
        const msg = e.message || String(e);
        // "run not found" means we re-attached to a runId the backend
        // forgot (server restart, mostly). That's not really an error
        // from the user's POV — just drop back to idle silently.
        if (!/not found/i.test(msg)) {
          setRunError({
            kind: 'runtime',
            title: 'Lost contact with the backend',
            details: [msg],
          });
        }
        setPhase('idle');
        setRunId(null);
      }
    };

    poll();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [runId, phase, runKind]);

  /**
   * Start a run. `kind` is 'trajectory' or 'debris'; defaults to whatever
   * the active sidebar tab implies ('params' → trajectory, 'debris' →
   * debris). Validates inputs, seeds the buffered-progress state, and
   * dispatches to the right backend endpoint.
   *
   * Debris runs are gated on `trajectoryDoneInSession`: if the user
   * tries to run debris without a fresh trajectory in this session, we
   * show a small popup explaining that a trajectory needs to come first
   * — we don't silently auto-chain a hidden trajectory run, because the
   * result pages (Plot / Map / Raw) would then surface that unsanctioned
   * trajectory data as if the user had asked for it.
   */
  const startRun = useCallback(async (kind) => {
    setRunError(null);
    setElapsed(0);
    setRestoredSuccess(false);
    progressSamplesRef.current = [
      { t: performance.now() - PROGRESS_LAG_MS, pct: 0 },
      { t: performance.now(),                   pct: 0 },
    ];

    if (kind === 'debris') {
      // Debris needs a simulation that ran or was explicitly loaded in
      // *this* session. A stale CSV on disk from a previous machine
      // session doesn't count — refuse with a friendly popup instead of
      // running on top of leftover data the user didn't ask for.
      if (!trajectoryDoneInSession) {
        window.alert(
          'Run or load a trajectory simulation first.\n\n' +
          'Debris analysis samples failure points from a finished ' +
          'trajectory - it can\'t run on its own.'
        );
        return;
      }

      // Validate the debris params the same way the trajectory side
      // validates its own: every numeric field must be a finite number.
      // Empty fields used to silently fall back to backend defaults,
      // but now that the form ships completely empty we surface the
      // requirement up-front instead of running on stale defaults.
      const { errors: debrisErrors } = validateDebrisParams(
        debrisParams, debrisMode, customPoints,
      );
      if (debrisErrors.length > 0) {
        setRunError({
          kind: 'validation',
          title: 'Some debris parameters are missing',
          details: debrisErrors,
        });
        return;
      }

      // Simulation output exists — go straight to debris.
      setRunKind('debris');
      setProgressLabel('Initializing debris…');
      setPhase('running');
      setSidebarOpen(false);
      try {
        const customTimes = debrisMode === 'custom'
          ? customPoints
              .map((s) => parseFloat(s))
              .filter((v) => Number.isFinite(v))
          : null;
        if (debrisMode === 'custom' && (!customTimes || customTimes.length === 0)) {
          throw new Error('Custom mode needs at least one valid time');
        }
        const { run_id } = await startDebrisRun({
          mode: debrisMode,
          custom_times: customTimes,
          params: debrisParams,
        });
        setRunId(run_id);
      } catch (e) {
        setRunError({
          kind: 'runtime',
          title: 'Could not start debris analysis',
          details: [e.message || String(e)],
        });
        setPhase('idle');
        setRunId(null);
      }
      return;
    }

    // Trajectory run — validate + normalize params, then POST.
    const { errors, config } = validateAndCollect(params);
    if (errors.length > 0) {
      setRunError({
        kind: 'validation',
        title: 'Some trajectory parameters are missing',
        details: errors,
      });
      return;
    }

    setRunKind('trajectory');
    setProgressLabel('Initializing…');
    // Fresh trajectory invalidates any prior trajectory + debris success
    // — the on-disk CSV is about to be overwritten, so the result-cards
    // view should reset until the new run completes.
    setTrajectoryDoneInSession(false);
    setDebrisDoneInSession(false);
    setPhase('running');
    setSidebarOpen(false);

    try {
      const { run_id } = await startTrajectoryRun(config);
      setRunId(run_id);
    } catch (e) {
      setRunError({
        kind: 'runtime',
        title: 'Could not start the simulation',
        details: [e.message || String(e)],
      });
      setPhase('idle');
      setRunId(null);
    }
  }, [debrisMode, customPoints, debrisParams, params, trajectoryDoneInSession]);

  const handleRun = useCallback(async () => {
    if (phase === 'idle') {
      // Pick the next runnable action. The debris tab only runs debris
      // when a trajectory has finished in this session — otherwise the
      // button below is labelled "Run Simulation" and runs the
      // trajectory the user clearly needs to set up first.
      const runnable =
        tab === 'debris' && trajectoryDoneInSession ? 'debris' : 'trajectory';
      await startRun(runnable);
      return;
    }

    if (phase === 'running') {
      // Cancel — pick the right cancel endpoint based on what's running.
      if (runId) {
        try {
          if (runKind === 'debris') await cancelDebrisRun(runId);
          else await cancelTrajectoryRun(runId);
        } catch {
          /* swallow — we're tearing down anyway */
        }
      }
      setPhase('idle');
      setRunId(null);
      return;
    }

    /* 'success' → reset the page back to the idle "run trajectory"
       state. The × button on the progress strip is a "close /
       dismiss the results" affordance — it tears down the success
       view (results cards, progress strip) and brings the user
       back to the parameter sidebar + Run button. They then click
       Run themselves when they want to launch the next sim, which
       lets them edit params first if they want to. */
    setPhase('idle');
    setElapsed(0);
    setRunError(null);
  }, [phase, runId, runKind, tab, trajectoryDoneInSession, startRun]);

  /**
   * Click handler for the "Debris Analysis" result card on the trajectory
   * success state. Mirrors the desktop's "click result card → switch
   * sidebar tab to debris → kick off the run" flow:
   *   - Open the sidebar to the debris tab so the user sees what's about
   *     to run (and can edit if needed before clicking Run).
   *   - If the debris params look like the defaults (= "empty"), stop
   *     here so the user reviews them; they hit Run when ready.
   *   - Otherwise (params have been touched) start the debris run
   *     immediately so the click "just works".
   */
  const openDebrisFromCard = useCallback(() => {
    setTab('debris');
    setSidebarOpen(true);
    // "Empty" detection: every debris param is still the cold-start
    // empty string (no preset loaded, no manual edits) AND interval
    // mode with no custom failure points. In that case we don't fire
    // — we open the tab so the user can fill in or load a preset.
    const empty = collectEmpty(DEBRIS_PARAMS);
    const isUntouched =
      Object.keys(empty).every((k) => debrisParams[k] === empty[k]) &&
      debrisMode === 'interval' &&
      customPoints.every((p) => p === '');
    if (isUntouched) {
      // Reset to idle so the Run button is visible (in case we're on
      // the success state right now). The user reviews + clicks Run.
      setPhase('idle');
      setElapsed(0);
      setRunError(null);
      return;
    }
    // Params have been touched — fire the run immediately.
    startRun('debris');
  }, [debrisParams, debrisMode, customPoints, startRun]);

  /* ── render ─────────────────────────────────────────────── */
  return (
    <>
      <TopBar
        onBack={() => navigate('/')}
        backLabel="EXIT"
        backPosition="right"
        leftExtras={
          <JumpTabs
            tabs={getJumpTabs({
              navigate,
              // Trajectory tab is the current page — clicking it is a no-op.
              onTrajectoryClick: () => { /* already here */ },
            })}
            activeKey="trajectory"
          />
        }
      />

      <div className={`TR-main${sidebarOpen ? '' : ' TR-main--collapsed'}`}>
        <aside className={`TR-sidebar${sidebarOpen ? '' : ' TR-sidebar--collapsed'}`}>
          {sidebarOpen ? (
            <>
              <SidebarHeader
                tab={tab}
                onTabChange={setTab}
                onToggle={() => setSidebarOpen(false)}
              />
              <div className="TR-sidebar-body">
                {tab === 'params' ? (
                  <ParamsTab
                    params={params}
                    setParam={setParam}
                    setStageParam={setStageParam}
                    activeStage={activeStage}
                    setActiveStage={setActiveStage}
                    noOfStages={noOfStages}
                    presetName={presetName}
                    onLoadPreset={loadPreset}
                    onSavePreset={handleSavePreset}
                    onDownloadPreset={handleDownloadPreset}
                    onClear={clearTrajectoryParams}
                    presets={allPresets}
                    deletablePresetNames={userPresets}
                    onDeletePresets={handleDeleteTrajectoryPresets}
                  />
                ) : tab === 'debris' ? (
                  <DebrisTab
                    params={debrisParams}
                    setParam={setDebrisParam}
                    mode={debrisMode}
                    setMode={setDebrisMode}
                    trajectoryDone={trajectoryDoneInSession}
                    presetName={debrisPresetName}
                    onLoadPreset={loadDebrisPreset}
                    onSavePreset={handleSaveDebrisPreset}
                    onDownloadPreset={handleDownloadDebrisPreset}
                    presets={userDebrisPresets}
                    customPoints={customPoints}
                    setCustomPoints={setCustomPoints}
                    onClear={resetDebrisDefaults}
                    deletablePresetNames={userDebrisPresets}
                    onDeletePresets={handleDeleteDebrisPresets}
                  />
                ) : (
                  <StructureTab
                    params={params}
                    setStructureParam={setStructureParam}
                    onClear={resetStructureParams}
                    onJumpToSimulation={() => setTab('params')}
                  />
                )}
              </div>
            </>
          ) : (
            <button
              type="button"
              className="TR-sidebar-toggle TR-sidebar-toggle--reopen"
              onClick={() => setSidebarOpen(true)}
              aria-label="Show parameters"
              title="Show parameters"
            >
              »
            </button>
          )}
        </aside>

        <section className="TR-content">
          <div className="TR-hero">
            <OrbitIcon />
            <h1 className="TR-title">Trajectory Simulation</h1>
            <p className="TR-subtitle mono">
              Configure parameters in the sidebar, then launch.
            </p>

            <MissionSummary params={params} preset={presetName} />

            <MissionActions
              onLoadSim={handleLoadSim}
              onLoadDebris={handleLoadDebris}
              onCompare={handleCompare}
            />

            <ProgressTrack
              phase={phase}
              pct={displayPct}
              label={progressLabel}
              elapsed={elapsed}
              onCancel={handleRun}
              onRerun={handleRun}
              kind={runKind}
            />

            {runError && (
              <ErrorToast
                error={runError}
                onDismiss={() => setRunError(null)}
                accent={tab === 'debris' ? 'debris' : 'trajectory'}
                /* Success toasts auto-dismiss after 3.5s; errors stick
                   until the user explicitly closes them. */
                autoDismissMs={runError?.kind === 'success' ? 3500 : null}
              />
            )}

            <RunBlock
              phase={phase}
              onRun={handleRun}
              kind={
                tab === 'debris' && trajectoryDoneInSession
                  ? 'debris'
                  : 'trajectory'
              }
            />
          </div>

          {phase === 'success' && (
            <ResultsBlock
              restored={restoredSuccess}
              runKind={runKind}
              trajectoryDone={trajectoryDoneInSession}
              debrisDone={debrisDoneInSession}
              onOpenDebris={openDebrisFromCard}
              onSaveSimulation={handleSaveSimulation}
              onDownloadSimulation={handleDownloadSimulation}
            />
          )}
        </section>
      </div>

      {/* Hidden file input for the Load Simulation button. Lives at
          the page level (not inside MissionActions) so re-renders of
          the action bar don't churn the input element. */}
      <input
        ref={loadSimInputRef}
        type="file"
        accept=".csv,.xlsx"
        onChange={onLoadSimFile}
        style={{ display: 'none' }}
        aria-hidden="true"
      />

      {loadSimOpen && (
        <LoadSimulationModal
          onClose={() => setLoadSimOpen(false)}
          onLoaded={onSavedSimLoaded}
          onBrowseDisk={onBrowseDiskFromModal}
        />
      )}
      {loadDebrisOpen && (
        <LoadDebrisModal
          onClose={() => setLoadDebrisOpen(false)}
          onSelect={onPickDebrisRun}
        />
      )}

      {missionLockKey > 0 && <MissionLockPulse key={missionLockKey} />}
    </>
  );
}

/* ═══ Sidebar ════════════════════════════════════════════════ */

function SidebarHeader({ tab, onTabChange, onToggle }) {
  const eyebrow = (
    tab === 'params'    ? 'Parameters' :
    tab === 'debris'    ? 'Debris Config' :
    tab === 'structure' ? 'Structure' :
    'Parameters'
  );
  return (
    <header className="TR-sidebar-head">
      <div className="TR-sidebar-eyebrow-row">
        <span className="eyebrow TR-sidebar-eyebrow">
          {eyebrow}
        </span>
        <button
          type="button"
          className="TR-sidebar-toggle"
          onClick={onToggle}
          aria-label="Hide parameters"
          title="Hide parameters"
        >
          «
        </button>
      </div>
      <div className="TR-tabstrip" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'params'}
          className={`TR-tab${tab === 'params' ? ' TR-tab--active' : ''}`}
          onClick={() => onTabChange('params')}
        >
          Trajectory
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'debris'}
          className={`TR-tab${tab === 'debris' ? ' TR-tab--active TR-tab--warning' : ''}`}
          onClick={() => onTabChange('debris')}
        >
          Debris
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'structure'}
          className={`TR-tab${tab === 'structure' ? ' TR-tab--active TR-tab--structure' : ''}`}
          onClick={() => onTabChange('structure')}
          title="Geometric & structural parameters (CoM / MoI)"
        >
          Structure
        </button>
      </div>
    </header>
  );
}

function ParamsTab({
  params, setParam, setStageParam, activeStage, setActiveStage,
  noOfStages, presetName, onLoadPreset, onSavePreset, onDownloadPreset,
  onClear, presets,
  /* `deletablePresetNames` is the map of user-saved presets (keys =
     deletable names). `onDeletePresets(names[])` is the parent action. */
  deletablePresetNames = null, onDeletePresets = null,
}) {
  // Single-open accordion across all sections in this tab. Pre-load with
  // the first trajectory section open. Stage section keys are 'stage-N'.
  const firstSectionKey = Object.keys(TRAJECTORY_PARAMS)[0];
  const [openKey, setOpenKey] = useState(firstSectionKey);

  const toggleSection = useCallback((key) => {
    setOpenKey((cur) => (cur === key ? null : key));
  }, []);

  const handleStageClick = (i) => {
    if (i > noOfStages) return;
    setActiveStage(i);
    setOpenKey(`stage-${i}`);
  };

  return (
    <>
      <PresetPicker
        presetName={presetName}
        onSelect={onLoadPreset}
        presets={presets}
        recentKey="trajectory"
        firstTimeHint={
          presetName === 'Custom' && isParamsEmpty(params)
            ? 'Pick a preset or fill in values below'
            : null
        }
        deletableNames={
          deletablePresetNames
            ? new Set(Object.keys(deletablePresetNames))
            : null
        }
        onDelete={onDeletePresets}
      />

      <div className="TR-divider" />

      <div className="TR-scroll">
        {/* Trajectory sections — single-open accordion */}
        {Object.entries(TRAJECTORY_PARAMS).map(([sectionName, fields]) => (
          <Section
            key={sectionName}
            title={sectionName}
            accent="var(--accent)"
            summary={summarizeSection(fields, params)}
            isOpen={openKey === sectionName}
            onToggle={() => toggleSection(sectionName)}
          >
            {Object.entries(fields).map(([key, meta]) => (
              <Field
                key={key}
                meta={meta}
                value={params[key]}
                onChange={(v) => setParam(key, v)}
              />
            ))}
          </Section>
        ))}

        {/* Stage chip strip + active stage's form */}
        <div className="TR-stages-block">
          <header className="TR-stages-head">
            <span className="eyebrow">Stages</span>
            <span className="TR-stages-count mono">{noOfStages} active</span>
          </header>
          <div className="TR-stages-strip">
            {[1, 2, 3].map((i) => {
              const accent = STAGE_ACCENTS[i].color;
              const active = activeStage === i;
              const enabled = i <= noOfStages;
              return (
                <button
                  key={i}
                  type="button"
                  className={`TR-stage-chip${active ? ' TR-stage-chip--active' : ''}${enabled ? '' : ' TR-stage-chip--disabled'}`}
                  onClick={() => handleStageClick(i)}
                  disabled={!enabled}
                  style={active ? { borderColor: accent, color: accent } : undefined}
                >
                  <span className="TR-stage-chip-dot" style={{ background: accent }} />
                  Stage {i}
                </button>
              );
            })}
          </div>

          <Section
            key={`stage-${activeStage}`}
            title={`Stage ${activeStage} · Engine & Propellant`}
            accent={STAGE_ACCENTS[activeStage].color}
            summary={summarizeSection(STAGE_PARAMS_PER_STAGE, params[`Stage${activeStage}`] || {})}
            isOpen={openKey === `stage-${activeStage}`}
            onToggle={() => toggleSection(`stage-${activeStage}`)}
          >
            {Object.entries(STAGE_PARAMS_PER_STAGE).map(([key, meta]) => (
              <Field
                key={key}
                meta={meta}
                value={params[`Stage${activeStage}`]?.[key]}
                onChange={(v) => setStageParam(`Stage${activeStage}`, key, v)}
              />
            ))}
          </Section>
        </div>
      </div>

      <div className="TR-sidebar-foot TR-sidebar-foot--row">
        <Tooltip text={TIPS.savePreset} placement="top">
          <button
            type="button"
            className="TR-btn-primary"
            onClick={onSavePreset}
          >
            Save as Preset
          </button>
        </Tooltip>
        {/* Download companion — same params as the Save, but saved
            to the user's own computer (browser save-as / Downloads
            folder) instead of the team's shared server library. */}
        <button
          type="button"
          className="TR-btn-clear"
          onClick={onDownloadPreset}
          disabled={!onDownloadPreset}
          title="Download these parameters as a .json file to your computer"
        >
          <span className="TR-btn-clear-icon" aria-hidden="true">↓</span>
          Download
        </button>
        <button
          type="button"
          className="TR-btn-clear"
          onClick={onClear}
          disabled={!onClear}
          title="Clear all trajectory parameters"
        >
          <span className="TR-btn-clear-icon" aria-hidden="true">↺</span>
          Clear
        </button>
      </div>
    </>
  );
}

/* ═══ Preset picker (popover with search) ═══════════════════ */

function PresetPicker({
  presetName, onSelect, presets = PRESETS, variant = 'trajectory', hint,
  firstTimeHint, recentKey = null,
  /* `deletableNames` — Set of preset names that live on disk and can
     therefore be deleted from this picker. Hardcoded presets shipped
     in code aren't in this set, so they stay safe. When the set is
     empty the ⋮ menu button is hidden. */
  deletableNames = null,
  /* `onDelete(names)` — async; parent removes the listed presets and
     refreshes the dropdown. The picker awaits this before clearing
     its own select-mode state so partial failures stay visible. */
  onDelete = null,
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const containerRef = useRef(null);
  const inputRef = useRef(null);
  const [activeIdx, setActiveIdx] = useState(0);

  /* Select-to-delete state. Lives inside the picker so its parent
     doesn't need to think about UI state at all — only the action
     handler. Reset whenever the popover closes. */
  const [selectMode, setSelectMode] = useState(false);
  const [selected,   setSelected]   = useState(() => new Set());
  const [deleting,   setDeleting]   = useState(false);
  /* Pending confirm-toast payload — null when no prompt is showing.
     Replaces the native `window.confirm` for delete confirmations so
     the prompt matches the rest of the app's toast visual language. */
  const [confirmReq, setConfirmReq] = useState(null);

  // Only delete is allowed for entries in this set (provided by parent).
  // Hardcoded presets + the synthetic "Custom" entry don't appear here,
  // so they're never selectable in delete mode.
  const isDeletable = (name) =>
    deletableNames instanceof Set
      ? deletableNames.has(name)
      : false;
  const hasDeletable = deletableNames instanceof Set && deletableNames.size > 0;

  // Recently-used preset names — short list (max 5) kept in
  // localStorage so it survives reloads. Only updated when the user
  // actively picks a named preset (skipping the synthetic "Custom"
  // entry). Per-picker key so trajectory and debris don't share the
  // same history.
  const [recent, setRecent] = useState(() => {
    if (!recentKey) return [];
    try {
      const raw = localStorage.getItem(`clearcut.recent.${recentKey}`);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr.slice(0, 5) : [];
    } catch { return []; }
  });

  // Names list — Custom is always first. Driven by the merged presets
  // map (hardcoded baseline + user-saved disk presets) so newly-saved
  // presets appear here without a page reload.
  const allItems = useMemo(() => {
    const presetNames = Object.keys(presets);
    return [
      { name: 'Custom', meta: 'leave values as edited' },
      ...presetNames.map((name) => {
        const p = presets[name];
        const inc = p?.desired_inclination;
        const orb = p?.desired_orbit_height;
        return {
          name,
          meta:
            Number.isFinite(inc) && Number.isFinite(orb)
              ? `${inc}° · ${orb} km`
              : '',
        };
      }),
    ];
  }, [presets]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return allItems;
    return allItems.filter((it) => it.name.toLowerCase().includes(q));
  }, [allItems, query]);

  // Outside-click + Escape close. In select mode Esc drops the mode
  // first (matches the LoadSimulation modal's two-stage cancel),
  // requiring a second Esc to close the popover itself.
  useEffect(() => {
    if (!open) return undefined;
    setActiveIdx(0);
    const t = setTimeout(() => inputRef.current?.focus(), 0);
    const onClick = (e) => {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        setOpen(false);
      }
    };
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      if (selectMode) {
        setSelectMode(false);
        setSelected(new Set());
        return;
      }
      setOpen(false);
    };
    window.addEventListener('mousedown', onClick);
    window.addEventListener('keydown', onKey);
    return () => {
      clearTimeout(t);
      window.removeEventListener('mousedown', onClick);
      window.removeEventListener('keydown', onKey);
    };
  }, [open, selectMode]);

  // Reset highlighted item when filter changes.
  useEffect(() => {
    setActiveIdx(0);
  }, [query]);

  // When the popover closes, drop any pending select-mode state so
  // the next open starts from a clean slate. The confirm toast is
  // also dismissed — if the popover is gone there's nothing to act on.
  useEffect(() => {
    if (!open) {
      setSelectMode(false);
      setSelected(new Set());
      setConfirmReq(null);
    }
  }, [open]);

  /* Select-mode toggles + delete handler. The parent owns the actual
     API call via `onDelete(names)` — we just collect intent here. */
  const toggleSelected = (name) => {
    if (!isDeletable(name)) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  /* Execute the actual delete. Lives separately from the request so
     the confirm toast can call it after the user commits. */
  const performDelete = async (names) => {
    if (!names || names.length === 0 || !onDelete) return;
    setDeleting(true);
    try {
      await onDelete(names);
      setSelected(new Set());
      setSelectMode(false);
    } finally {
      setDeleting(false);
    }
  };

  /* Show the confirm-style ErrorToast. The toast's primary action
     calls `performDelete`; its Cancel button + × both just dismiss,
     leaving the picker in select mode with the choices intact. */
  const handleDeleteSelected = () => {
    if (selected.size === 0 || !onDelete) return;
    const names = [...selected];
    const title = names.length === 1
      ? `Delete preset “${names[0]}”?`
      : `Delete ${names.length} presets?`;
    setConfirmReq({
      kind: 'confirm',
      title,
      details: ['This cannot be undone.'],
      action: { label: 'Delete', onClick: () => performDelete(names) },
    });
  };

  const handleSelect = (name) => {
    // Track in recents — skip "Custom" since it isn't really a preset.
    if (recentKey && name && name !== 'Custom') {
      setRecent((prev) => {
        const next = [name, ...prev.filter((n) => n !== name)].slice(0, 5);
        try {
          localStorage.setItem(`clearcut.recent.${recentKey}`, JSON.stringify(next));
        } catch { /* ignore */ }
        return next;
      });
    }
    onSelect(name);
    setOpen(false);
    setQuery('');
  };

  // Filter the recents down to entries that still exist in `presets`
  // (in case the user deleted a preset file by hand).
  const validRecent = useMemo(
    () => recent.filter((n) => n in presets).slice(0, 5),
    [recent, presets]
  );

  const onSearchKey = (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIdx((i) => Math.min(i + 1, Math.max(0, filtered.length - 1)));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const it = filtered[activeIdx];
      if (it) handleSelect(it.name);
    }
  };

  return (
    <div
      className={`TR-preset-picker${variant === 'debris' ? ' TR-preset-picker--debris' : ''}`}
      ref={containerRef}
    >
      <span className="eyebrow TR-presets-label">Preset</span>
      {hint && <span className="TR-preset-hint mono">{hint}</span>}
      {firstTimeHint && !open && (
        <span className="TR-preset-firsttime">
          <span className="TR-preset-firsttime-arrow" aria-hidden="true">↓</span>
          {firstTimeHint}
        </span>
      )}
      <button
        type="button"
        className={`TR-preset-trigger${open ? ' TR-preset-trigger--open' : ''}`}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="TR-preset-trigger-name">{presetName}</span>
        <span className="TR-preset-trigger-count mono">
          {Object.keys(presets).length}
        </span>
        <span className="TR-preset-trigger-chev" aria-hidden="true">▾</span>
      </button>

      {open && (
        <div className="TR-preset-popover" role="listbox">
          {selectMode ? (
            <div className="TR-preset-select-head">
              <span className="TR-preset-select-title">
                Select to delete
              </span>
              <span className="TR-preset-select-count mono">
                {selected.size} selected
              </span>
            </div>
          ) : (
            <div className="TR-preset-search-wrap">
              <span className="TR-preset-search-icon" aria-hidden="true">⌕</span>
              <input
                ref={inputRef}
                type="text"
                className="TR-preset-search mono"
                placeholder="Search presets…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={onSearchKey}
                spellCheck={false}
                autoComplete="off"
              />
              {/* ⋮ button — only meaningful when there's at least one
                  user-saved preset on disk to delete. Hardcoded
                  presets ship in code and aren't deletable here. */}
              {hasDeletable && onDelete && (
                <button
                  type="button"
                  className="TR-preset-menu-btn"
                  onClick={() => setSelectMode(true)}
                  aria-label="Select presets to delete"
                  title="Select presets to delete"
                >
                  ⋮
                </button>
              )}
            </div>
          )}
          <div className="TR-preset-list">
            {selectMode ? (
              /* Select mode — only deletable presets appear. Hardcoded
                 + the synthetic "Custom" entry are hidden so the list
                 only shows things the user can actually act on. */
              (() => {
                const deletableItems = filtered.filter(
                  (it) => isDeletable(it.name)
                );
                if (deletableItems.length === 0) {
                  return (
                    <div className="TR-preset-empty mono">
                      No user-saved presets to delete
                    </div>
                  );
                }
                return deletableItems.map((it) => {
                  const isOn = selected.has(it.name);
                  return (
                    <button
                      key={it.name}
                      type="button"
                      role="option"
                      aria-pressed={isOn}
                      className={
                        'TR-preset-item TR-preset-item--select' +
                        (isOn ? ' TR-preset-item--checked' : '')
                      }
                      onClick={() => toggleSelected(it.name)}
                      disabled={deleting}
                    >
                      <span
                        className={`TR-preset-check${isOn ? ' TR-preset-check--on' : ''}`}
                        aria-hidden="true"
                      >
                        {isOn ? '✓' : ''}
                      </span>
                      <span className="TR-preset-item-name">{it.name}</span>
                      <span className="TR-preset-item-meta mono">{it.meta}</span>
                    </button>
                  );
                });
              })()
            ) : (
              <>
                {/* Recent picks — surfaced as a small header section above
                    the full list. Only shown when no search query is
                    active AND there are still-valid recents to display. */}
                {!query.trim() && validRecent.length > 0 && (
                  <>
                    <div className="TR-preset-section-label mono">Recent</div>
                    {validRecent.map((name) => {
                      const p = presets[name] || {};
                      const inc = p.desired_inclination;
                      const orb = p.desired_orbit_height;
                      const meta =
                        Number.isFinite(inc) && Number.isFinite(orb)
                          ? `${inc}° · ${orb} km`
                          : '';
                      const active = name === presetName;
                      return (
                        <button
                          key={`recent-${name}`}
                          type="button"
                          role="option"
                          aria-selected={active}
                          className={'TR-preset-item' + (active ? ' TR-preset-item--active' : '')}
                          onClick={() => handleSelect(name)}
                          title={TIPS.presetItem ? TIPS.presetItem(name) : name}
                        >
                          <span className="TR-preset-item-name">{name}</span>
                          <span className="TR-preset-item-meta mono">{meta}</span>
                        </button>
                      );
                    })}
                    <div className="TR-preset-section-label mono">All presets</div>
                  </>
                )}
                {filtered.length === 0 ? (
                  <div className="TR-preset-empty mono">No matches</div>
                ) : (
                  filtered.map((it, idx) => {
                    const active = it.name === presetName;
                    const highlight = idx === activeIdx;
                    return (
                      <button
                        key={it.name}
                        type="button"
                        role="option"
                        aria-selected={active}
                        className={
                          'TR-preset-item' +
                          (active    ? ' TR-preset-item--active'    : '') +
                          (highlight ? ' TR-preset-item--highlight' : '')
                        }
                        onMouseEnter={() => setActiveIdx(idx)}
                        onClick={() => handleSelect(it.name)}
                        title={it.name === 'Custom' ? 'Custom (no preset)' : TIPS.presetItem(it.name)}
                      >
                        <span className="TR-preset-item-name">{it.name}</span>
                        <span className="TR-preset-item-meta mono">{it.meta}</span>
                      </button>
                    );
                  })
                )}
              </>
            )}
          </div>
          {selectMode && (
            <div className="TR-preset-select-foot">
              <button
                type="button"
                className="TR-preset-select-cancel"
                onClick={() => { setSelectMode(false); setSelected(new Set()); }}
                disabled={deleting}
              >
                Cancel
              </button>
              <button
                type="button"
                className="TR-preset-select-delete"
                onClick={handleDeleteSelected}
                disabled={selected.size === 0 || deleting}
              >
                {deleting
                  ? 'Deleting…'
                  : `Delete${selected.size > 0 ? ` (${selected.size})` : ''}`}
              </button>
            </div>
          )}
        </div>
      )}

      {/* Pretty confirm toast — replaces `window.confirm`. Always
          rose-accented regardless of picker variant, since delete is
          a destructive action and red conveys that intent more
          clearly than the debris-amber theme would. The action
          callback runs the actual delete; dismiss (× or Cancel) just
          clears the request, leaving the user back in select mode. */}
      {confirmReq && (
        <ErrorToast
          error={confirmReq}
          onDismiss={() => setConfirmReq(null)}
          accent="trajectory"
        />
      )}
    </div>
  );
}

function DebrisTab({
  params, setParam, mode, setMode, customPoints, setCustomPoints, onClear,
  trajectoryDone = false,
  presetName = 'Custom', onLoadPreset, onSavePreset, onDownloadPreset,
  presets = {},
  /* All debris presets are user-saved (no hardcoded ones), so the
     deletable set is just the presets map's keys. */
  deletablePresetNames = null, onDeletePresets = null,
}) {
  const [openKey, setOpenKey] = useState('Failure Points');
  const toggleSection = useCallback((key) => {
    setOpenKey((cur) => (cur === key ? null : key));
  }, []);

  const addPoint = () => setCustomPoints((p) => [...p, '']);
  const removePoint = (idx) => setCustomPoints((p) =>
    p.length > 1 ? p.filter((_, i) => i !== idx) : p
  );
  const updatePoint = (idx, value) => setCustomPoints((p) =>
    p.map((v, i) => (i === idx ? value : v))
  );

  return (
    <>
      <PresetPicker
        presetName={presetName}
        onSelect={onLoadPreset || (() => {})}
        presets={presets}
        variant="debris"
        recentKey="debris"
        hint="Named by debris/point and interval — e.g. “10d-50s”"
        deletableNames={
          deletablePresetNames
            ? new Set(Object.keys(deletablePresetNames))
            : new Set(Object.keys(presets))
        }
        onDelete={onDeletePresets}
      />

      {!trajectoryDone && (
        <div
          className="TR-debris-banner"
          role="note"
          aria-label="Trajectory required to run debris analysis"
        >
          <span className="TR-debris-banner-icon" aria-hidden="true">!</span>
          <div className="TR-debris-banner-body">
            <span className="TR-debris-banner-title">Trajectory required</span>
            <span className="TR-debris-banner-text">
              Set debris parameters here. To use them, run a trajectory
              simulation first — they'll be applied automatically when it
              finishes.
            </span>
          </div>
        </div>
      )}
      <div className="TR-divider" />

      <div className="TR-scroll">
        <Section
          title="Failure Points"
          accent="var(--warning)"
          isOpen={openKey === 'Failure Points'}
          onToggle={() => toggleSection('Failure Points')}
        >
          <div className="TR-mode-toggle">
            <button
              type="button"
              className={`TR-mode-btn${mode === 'interval' ? ' TR-mode-btn--active' : ''}`}
              onClick={() => setMode('interval')}
            >
              Interval
            </button>
            <button
              type="button"
              className={`TR-mode-btn${mode === 'custom' ? ' TR-mode-btn--active' : ''}`}
              onClick={() => setMode('custom')}
            >
              Custom
            </button>
          </div>

          {mode === 'interval' ? (
            <Field
              meta={DEBRIS_PARAMS.General.failure_interval_s}
              value={params.failure_interval_s}
              onChange={(v) => setParam('failure_interval_s', v)}
            />
          ) : (
            <div className="TR-custom-points">
              {customPoints.map((value, idx) => (
                <div key={idx} className="TR-custom-row">
                  <span className="TR-custom-idx mono">#{idx + 1}</span>
                  <input
                    type="text"
                    className="TR-input mono"
                    placeholder="Time (s)"
                    value={value}
                    onChange={(e) => updatePoint(idx, e.target.value)}
                  />
                  <button
                    type="button"
                    className="TR-icon-btn TR-icon-btn--danger"
                    onClick={() => removePoint(idx)}
                    aria-label={`Remove point ${idx + 1}`}
                  >
                    −
                  </button>
                </div>
              ))}
              <button
                type="button"
                className="TR-btn-secondary"
                onClick={addPoint}
              >
                + Add Point
              </button>
            </div>
          )}
        </Section>

        {Object.entries(DEBRIS_PARAMS).map(([sectionName, fields]) => (
          <Section
            key={sectionName}
            title={sectionName}
            accent="var(--warning)"
            summary={summarizeSection(fields, params)}
            isOpen={openKey === sectionName}
            onToggle={() => toggleSection(sectionName)}
          >
            {Object.entries(fields).map(([key, meta]) => {
              if (key === 'failure_interval_s') return null;
              return (
                <Field
                  key={key}
                  meta={meta}
                  value={params[key]}
                  onChange={(v) => setParam(key, v)}
                />
              );
            })}
          </Section>
        ))}
      </div>

      <div className="TR-sidebar-foot TR-sidebar-foot--row">
        <button
          type="button"
          className="TR-btn-primary TR-btn-primary--debris"
          onClick={onSavePreset}
          disabled={!onSavePreset}
          title="Save the current debris parameters as a named preset"
        >
          Save as Preset
        </button>
        {/* Download companion — see ParamsTab's footer comment. */}
        <button
          type="button"
          className="TR-btn-clear"
          onClick={onDownloadPreset}
          disabled={!onDownloadPreset}
          title="Download these parameters as a .json file to your computer"
        >
          <span className="TR-btn-clear-icon" aria-hidden="true">↓</span>
          Download
        </button>
        <button
          type="button"
          className="TR-btn-clear"
          onClick={onClear}
          disabled={!onClear}
          title="Clear all debris parameters"
        >
          <span className="TR-btn-clear-icon" aria-hidden="true">↺</span>
          Clear
        </button>
      </div>
    </>
  );
}

/* ═══ Collapsible section (controlled — accordion) ═══════════ */

function Section({ title, accent, summary, children, isOpen, onToggle }) {
  return (
    <div className={`TR-section${isOpen ? ' TR-section--open' : ''}`}>
      <button
        type="button"
        className="TR-section-head"
        onClick={onToggle}
        aria-expanded={isOpen}
      >
        <span className="TR-section-marker" style={{ background: accent }} />
        <span className="TR-section-title" style={{ color: accent }}>{title}</span>
        {summary && !isOpen && (
          <span className="TR-section-summary mono">{summary}</span>
        )}
        <span className="TR-section-chevron" aria-hidden="true">▾</span>
      </button>
      {isOpen && <div className="TR-section-body">{children}</div>}
    </div>
  );
}

/* ═══ Field input ════════════════════════════════════════════ */

function Field({ meta, value, onChange, error }) {
  // Enum fields render as a styled dropdown — used by the Structure
  // tab's `propellant_order` and any future categorical input.
  if (meta.type === 'enum' && Array.isArray(meta.options)) {
    return (
      <label
        className={`TR-field${error ? ' TR-field--error' : ''}`}
        title={meta.tip || ''}
      >
        <span className="TR-field-label">{meta.label}</span>
        <span className="TR-field-input-wrap">
          <select
            className="TR-field-input mono TR-field-input--select"
            value={value ?? ''}
            onChange={(e) => onChange(e.target.value)}
          >
            {meta.options.map((opt) => (
              <option key={opt} value={opt}>{opt}</option>
            ))}
          </select>
        </span>
      </label>
    );
  }
  return (
    <label className={`TR-field${error ? ' TR-field--error' : ''}`} title={meta.tip || ''}>
      <span className="TR-field-label">{meta.label}</span>
      <span className="TR-field-input-wrap">
        <input
          type="text"
          className="TR-field-input mono"
          value={value ?? ''}
          onChange={(e) => onChange(e.target.value)}
          spellCheck={false}
          autoComplete="off"
        />
        {meta.unit && <span className="TR-field-unit mono">{meta.unit}</span>}
      </span>
    </label>
  );
}

/* ═══ Structure tab — CoM / MoI geometry ═══════════════════════════
 *   Companion to the Simulation tab. Owns the ~30 structural fields
 *   that used to live in `rocket_structure.yaml` plus locked-mirror
 *   read-outs of the five overlap fields (propellant_mass per stage,
 *   number_of_engines per stage, payload_mass, fairing_mass).
 *
 *   Locked mirrors are disabled inputs whose value tracks the
 *   Simulation tab's state in real time. Clicking the "Set in
 *   Simulation →" caption jumps the user back over there, since
 *   those values can only be edited at one place — that's how we
 *   guarantee MoI and the trajectory math see the same numbers.
 * ──────────────────────────────────────────────────────────────── */

function StructureTab({
  params, setStructureParam, onClear, onJumpToSimulation,
}) {
  const firstSectionKey = Object.keys(STRUCTURE_PARAMS)[0];
  const [openKey, setOpenKey] = useState(firstSectionKey);
  const toggleSection = useCallback((key) => {
    setOpenKey((cur) => (cur === key ? null : key));
  }, []);

  const structure = params.structure || {};

  // Read a locked-mirror value via dot-path into the full `params`
  // tree (e.g. 'Stage1.propellant_mass', 'fairing_mass').
  const readLocked = useCallback((path) => {
    const parts = path.split('.');
    let v = params;
    for (const p of parts) {
      if (v == null) return '';
      v = v[p];
    }
    return v ?? '';
  }, [params]);

  return (
    <>
      <div className="TR-scroll">
        {Object.entries(STRUCTURE_PARAMS).map(([sectionName, fields]) => {
          const mirrors = LOCKED_MIRRORS[sectionName] || [];
          // Summary in the accordion header shows how many fields
          // have a value (almost always "all" since defaults are
          // pre-populated, but useful if the user deliberately
          // clears one to fall back to the Python default).
          const sectionValues = {};
          for (const k of Object.keys(fields)) sectionValues[k] = structure[k];
          return (
            <Section
              key={sectionName}
              title={sectionName}
              summary={summarizeSection(fields, sectionValues)}
              isOpen={openKey === sectionName}
              onToggle={() => toggleSection(sectionName)}
            >
              {mirrors.length > 0 && (
                <div className="TR-locked-mirrors">
                  {mirrors.map((m) => (
                    <LockedMirror
                      key={m.from}
                      label={m.label}
                      unit={m.unit}
                      value={readLocked(m.from)}
                      onJump={onJumpToSimulation}
                    />
                  ))}
                </div>
              )}
              {Object.entries(fields).map(([key, meta]) => (
                <Field
                  key={key}
                  meta={meta}
                  value={structure[key]}
                  onChange={(v) => setStructureParam(key, v)}
                />
              ))}
            </Section>
          );
        })}
      </div>

      <div className="TR-sidebar-foot TR-sidebar-foot--row">
        <button
          type="button"
          className="TR-btn-clear"
          onClick={onClear}
          title="Reset every structure parameter to its default value"
        >
          <span className="TR-btn-clear-icon" aria-hidden="true">↺</span>
          Reset to Defaults
        </button>
      </div>
    </>
  );
}

/* A read-only mirror of a value owned by another tab. Renders as a
 * disabled Field plus a small "Set in Simulation →" caption that
 * jumps the user back to the source. Used at the top of the Stage,
 * Fairing, and Payload sections of the Structure tab. */
function LockedMirror({ label, unit, value, onJump }) {
  return (
    <div className="TR-field TR-field--locked" title="Set this in the Simulation tab">
      <span className="TR-field-label">{label}</span>
      <span className="TR-field-input-wrap">
        <input
          type="text"
          className="TR-field-input mono"
          value={value === '' || value == null ? '—' : value}
          disabled
          tabIndex={-1}
          aria-readonly="true"
        />
        {unit && <span className="TR-field-unit mono">{unit}</span>}
      </span>
      <button
        type="button"
        className="TR-locked-mirror-jump"
        onClick={onJump}
      >
        Set in Simulation
        <span className="TR-locked-mirror-jump-arrow" aria-hidden="true">→</span>
      </button>
    </div>
  );
}

/* ═══ Hero — animated orbit icon ═════════════════════════════ */

function OrbitIcon() {
  return (
    <div className="TR-orbit-wrap" aria-hidden="true">
      <svg
        className="TR-orbit"
        width="120"
        height="120"
        viewBox="-55 -55 110 110"
      >
        <defs>
          <filter id="TR-orbit-glow" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="1.4" result="b" />
            <feMerge>
              <feMergeNode in="b" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
          <radialGradient id="TR-orbit-planet" cx="35%" cy="30%" r="80%">
            <stop offset="0%"   stopColor="#3a3f47" />
            <stop offset="60%"  stopColor="#1a1d22" />
            <stop offset="100%" stopColor="#0a0c0f" />
          </radialGradient>
        </defs>

        {/* Faint rear orbit (different tilt) */}
        <ellipse
          cx="0" cy="0" rx="42" ry="9"
          fill="none"
          stroke="rgba(255, 255, 255, 0.06)"
          strokeWidth="1"
          transform="rotate(-58)"
        />

        {/* "Past orbits" — three faint trails between the rear orbit
            and the primary, fanning forward as the orbital plane has
            precessed. Tilt + ry + opacity all rise toward the primary
            so they read as historical (dimmer, flatter) → current
            (bright, more open).                                         */}
        <ellipse
          cx="0" cy="0" rx="42" ry="10"
          fill="none"
          stroke="rgba(255, 255, 255, 0.08)"
          strokeWidth="1"
          transform="rotate(-46)"
        />
        <ellipse
          cx="0" cy="0" rx="42" ry="11.5"
          fill="none"
          stroke="rgba(255, 255, 255, 0.11)"
          strokeWidth="1"
          transform="rotate(-37)"
        />
        <ellipse
          cx="0" cy="0" rx="42" ry="13"
          fill="none"
          stroke="rgba(255, 255, 255, 0.15)"
          strokeWidth="1"
          transform="rotate(-29)"
        />

        {/* Primary orbit + animated satellite */}
        <g transform="rotate(-22)">
          <ellipse
            cx="0" cy="0" rx="42" ry="14"
            fill="none"
            stroke="rgba(255, 255, 255, 0.22)"
            strokeWidth="1.2"
          />
          {/* Subtle ascending arc highlight */}
          <path
            d="M 42,0 A 42,14 0 0,0 -42,0"
            fill="none"
            stroke="var(--accent)"
            strokeWidth="1.2"
            strokeLinecap="round"
            opacity="0.55"
          />
          {/* Orbiting ball */}
          <circle r="3" fill="var(--accent-bright)" filter="url(#TR-orbit-glow)">
            <animateMotion
              dur="6s"
              repeatCount="indefinite"
              path="M 42,0 A 42,14 0 1,1 -42,0 A 42,14 0 1,1 42,0"
            />
          </circle>
          {/* Comet trail — 6 staggered shrinking-dimming dots fanning
              out behind the leader. Each one shares the leader's path
              with a 0.1 s offset, smaller radius, and lower opacity.
              Together they read as a particle exhaust streak rather
              than a single ball. */}
          {[0.10, 0.20, 0.30, 0.42, 0.55, 0.70].map((delay, i) => (
            <circle
              key={i}
              r={2.4 - i * 0.32}
              fill="var(--accent)"
              opacity={0.55 - i * 0.08}
            >
              <animateMotion
                dur="6s"
                begin={`${delay}s`}
                repeatCount="indefinite"
                path="M 42,0 A 42,14 0 1,1 -42,0 A 42,14 0 1,1 42,0"
              />
            </circle>
          ))}
        </g>

        {/* Planet core */}
        <circle cx="0" cy="0" r="11" fill="url(#TR-orbit-planet)" />
        <circle cx="0" cy="0" r="11" fill="none"
                stroke="rgba(255, 255, 255, 0.18)" strokeWidth="0.8" />
        {/* Specular highlight */}
        <ellipse cx="-3.2" cy="-4" rx="2.4" ry="1.4"
                 fill="rgba(255, 255, 255, 0.28)" />
      </svg>
    </div>
  );
}

/* ═══ Mission summary card ═══════════════════════════════════ */

function MissionSummary({ params, preset }) {
  const stages = parseInt(params.no_of_stages, 10) || 1;
  const totalBurn = computeTotalBurn(params);

  const lat = fmt(params.lat_launch, 2);
  const lon = fmt(params.lon_launch, 2);
  const incl = fmt(params.desired_inclination, 1);
  const orbit = fmt(params.desired_orbit_height, 0);

  return (
    <div className="TR-mission">
      <header className="TR-mission-head">
        <span className="eyebrow">Mission</span>
        <span className="TR-mission-preset mono">{preset}</span>
      </header>
      <div className="TR-mission-grid">
        <Stat label="Launch Site" value={`${lat}°, ${lon}°`} />
        <Stat label="Target Orbit" value={`${incl}° / ${orbit} km`} />
        <NumberStat label="Stages"     value={stages}                       decimals={0} />
        <NumberStat label="Total Burn" value={totalBurn}                    decimals={0} unit="s" />
        <NumberStat label="Sim Time"   value={parseFloat(params.simulation_time)} decimals={0} unit="s" />
        <NumberStat label="Payload"    value={parseFloat(params.final_payload_mass)} decimals={0} unit="kg" />
      </div>
    </div>
  );
}

function Stat({ label, value }) {
  // Briefly outline-flash the stat in accent blue whenever its rendered
  // value changes — gives the user instant feedback when editing a
  // param that the mission card reflects. We toggle a className for
  // ~600 ms then strip it; the CSS handles the actual animation.
  const [flash, setFlash] = useState(false);
  const prevRef = useRef(value);
  useEffect(() => {
    if (prevRef.current === value) return undefined;
    prevRef.current = value;
    setFlash(true);
    const t = setTimeout(() => setFlash(false), 620);
    return () => clearTimeout(t);
  }, [value]);

  return (
    <div className={`TR-stat${flash ? ' TR-stat--flash' : ''}`}>
      <span className="TR-stat-label">{label}</span>
      <span className="TR-stat-value mono">{value}</span>
    </div>
  );
}

/**
 * Numeric variant of `Stat` — animates the displayed value from its
 * previous to current value over ~500 ms (eased) on every change, like
 * an odometer counting up. Combined with the same flash outline as
 * `Stat`, this turns a preset load into a satisfying "data just
 * arrived" moment instead of an instant text swap.
 *
 *   value     — raw number (NaN / null show as "—").
 *   decimals  — fixed precision for the rendered value.
 *   unit      — optional suffix appended after the number.
 */
function NumberStat({ label, value, decimals = 0, unit = '' }) {
  const [shown, setShown] = useState(Number.isFinite(value) ? value : 0);
  const [flash, setFlash] = useState(false);
  const prevRef = useRef(Number.isFinite(value) ? value : 0);
  const rafRef = useRef(null);
  const flashTimer = useRef(null);

  useEffect(() => {
    const safe = Number.isFinite(value) ? value : 0;
    if (prevRef.current === safe) return undefined;
    const from = prevRef.current;
    const to = safe;
    prevRef.current = safe;

    // Quick flash outline for "just changed" feedback.
    setFlash(true);
    clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlash(false), 620);

    // Interpolate the displayed value over 500 ms using easeOutQuart
    // so the count slows gracefully into the new target.
    const duration = 500;
    const t0 = performance.now();
    const tick = (now) => {
      const t = Math.min(1, (now - t0) / duration);
      const eased = 1 - Math.pow(1 - t, 4);
      setShown(from + (to - from) * eased);
      if (t < 1) rafRef.current = requestAnimationFrame(tick);
    };
    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(rafRef.current);
    };
  }, [value]);

  // Always clean up timers on unmount.
  useEffect(() => () => {
    cancelAnimationFrame(rafRef.current);
    clearTimeout(flashTimer.current);
  }, []);

  const display = Number.isFinite(value)
    ? shown.toFixed(decimals)
    : '—';

  return (
    <div className={`TR-stat${flash ? ' TR-stat--flash' : ''}`}>
      <span className="TR-stat-label">{label}</span>
      <span className="TR-stat-value mono">
        {display}{unit ? ` ${unit}` : ''}
      </span>
    </div>
  );
}

/* ═══ Progress track (full-width, sits under the mission card) ═ */

function ProgressTrack({ phase, pct, label, elapsed, onCancel, onRerun, kind = 'trajectory' }) {
  const isRunning = phase === 'running';
  const isSuccess = phase === 'success';
  if (!isRunning && !isSuccess) return null;

  const shownPct = isSuccess ? 100 : pct;
  const isDebris = kind === 'debris';
  const trackClass =
    'TR-progress-track' +
    (isSuccess ? ' TR-progress-track--success' : '') +
    (isDebris  ? ' TR-progress-track--debris'  : '');

  return (
    <div className={trackClass}>
      <div
        className="TR-progress-track-bar"
        role="progressbar"
        aria-valuenow={Math.round(shownPct)}
        aria-valuemin="0"
        aria-valuemax="100"
      >
        <span className="TR-progress-track-grid" aria-hidden="true" />
        <span
          className="TR-progress-track-fill"
          style={{ width: `${shownPct}%` }}
        />
        {isRunning ? (
          <div className="TR-progress-track-content">
            <span className="TR-progress-track-label mono">{label}</span>
            <div className="TR-progress-track-meta">
              <span className="TR-progress-track-pct mono">{Math.round(pct)}%</span>
              <span className="TR-progress-track-elapsed mono">{elapsed}s</span>
            </div>
          </div>
        ) : (
          <div className="TR-progress-track-content TR-progress-track-content--center">
            <span className="TR-progress-track-pct TR-progress-track-pct--success mono">
              100%
            </span>
            <span className="TR-progress-track-sep">·</span>
            <span className="TR-progress-track-success-label mono">
              {isDebris ? 'Debris Analysis Complete' : 'Simulation Complete'}
            </span>
          </div>
        )}
      </div>
      {isRunning && (
        <button
          type="button"
          className="TR-progress-track-cancel"
          onClick={onCancel}
          aria-label="Cancel simulation"
          title="Cancel simulation"
        >
          ×
        </button>
      )}
      {isSuccess && (
        <button
          type="button"
          className="TR-progress-track-reload"
          onClick={onRerun}
          aria-label="Reset and return to the run page"
          title="Reset · return to the run page"
        >
          <span className="TR-progress-track-reload-icon" aria-hidden="true">
            ×
          </span>
        </button>
      )}
    </div>
  );
}

/* ═══ Run-error popup ════════════════════════════════════════
 *   Moved to src/components/ErrorToast/ErrorToast.js so the same
 *   toast can be reused across PBS, EngineTest, and the trajectory
 *   result pages. Imported at the top of this file as `ErrorToast`. */

/* ═══ Mission-lock pulse ═════════════════════════════════════════
 *   Subtle sonar-style confirmation that fires every time a
 *   trajectory simulation reaches the success state. Two thin
 *   accent-blue rings expand outward from the centre of the page
 *   and fade as they grow — a "lock acquired" visual cue rather
 *   than a celebration. Auto-unmounts via the parent's keyed
 *   remount after ~1.4 s of pure-CSS animation. No state, no
 *   re-renders. */
function MissionLockPulse() {
  return (
    <div className="TR-lockpulse" aria-hidden="true">
      <span className="TR-lockpulse-ring" />
      <span className="TR-lockpulse-ring TR-lockpulse-ring--late" />
    </div>
  );
}
/* ═══ Run block ══════════════════════════════════════════════ */

function RunBlock({ phase, onRun, kind = 'trajectory' }) {
  // The big run button only exists in idle state.
  //   running → progress bar + cancel × box carry the UI.
  //   success → progress bar + reload ↻ box carry the UI.
  const [igniting, setIgniting] = useState(false);

  // When `phase` flips out of idle (i.e. the run actually started),
  // we tear down. Anything mid-ignition just gets cancelled.
  useEffect(() => {
    if (phase !== 'idle' && igniting) setIgniting(false);
  }, [phase, igniting]);

  if (phase !== 'idle') return null;
  const label = kind === 'debris' ? 'Run Debris Analysis' : 'Run Simulation';

  const handleClick = () => {
    if (igniting) return;
    setIgniting(true);
    // The ignition CSS animation takes ~700 ms; fire `onRun` close to
    // its peak so the actual progress-bar / phase change feels like
    // it's *caused* by the ignition — not a separate event.
    setTimeout(() => onRun?.(), 520);
  };

  return (
    <div className="TR-run-wrap">
      <button
        type="button"
        className={
          `TR-run-btn` +
          (kind === 'debris' ? ' TR-run-btn--debris' : '') +
          (igniting ? ' TR-run-btn--igniting' : '')
        }
        onClick={handleClick}
        disabled={igniting}
      >
        <span className="TR-run-btn-icon" aria-hidden="true">▶</span>
        <span className="TR-run-btn-label">{label}</span>
        {/* Ignition particles — three small dots that eject downward
            when `igniting` is true. CSS handles all the timing /
            positioning so the JSX stays static. */}
        <span className="TR-run-btn-particles" aria-hidden="true">
          <span className="TR-run-btn-particle" />
          <span className="TR-run-btn-particle" />
          <span className="TR-run-btn-particle" />
          <span className="TR-run-btn-particle" />
          <span className="TR-run-btn-particle" />
        </span>
      </button>
    </div>
  );
}

/* ═══ Results block — sketch cards + small footer buttons ═══ */

function ResultsBlock({
  restored = false,
  runKind = 'trajectory',
  trajectoryDone = false,
  debrisDone = false,
  onOpenDebris,
  onSaveSimulation,
  onDownloadSimulation,
}) {
  const navigate = useNavigate();
  // The "Results Folder" card opens an in-app file browser modal —
  // web equivalent of the desktop's `_open_debris_folder` action.
  const [filesModalOpen, setFilesModalOpen] = useState(false);
  // The "View Rocket Structure" button opens a 3D viewer that mirrors
  // the desktop's `_view_rocket_structure` action — but inline rather
  // than spawning an external HTML file.
  const [rocketModalOpen, setRocketModalOpen] = useState(false);

  /* Result cards intentionally have no tooltips — they all read the
     same file (`output/simulation_output.csv` and the matching
     debris folder for the current run), so a per-card tooltip
     repeating that path on every card would be noise. The user's
     mental model ("these show me the run I just finished") is
     already clear from the page context. */
  const trajectoryCards = [
    {
      key: 'plot', glyph: '∿',
      title: 'Plot Data', subtitle: 'Interactive charts',
      Preview: PlotPreview,
      onClick: () => navigate('/trajectory/plot'),
    },
    {
      key: 'debris', glyph: '⚛',
      title: 'Debris Analysis', subtitle: 'Monte Carlo sim',
      Preview: DebrisPreview,
      onClick: onOpenDebris || (() => {}),
      variant: 'debris',
    },
    {
      key: 'raw', glyph: '☷',
      title: 'Raw Data', subtitle: 'Spreadsheet · CSV/XLSX',
      Preview: ExcelPreview,
      onClick: () => navigate('/trajectory/raw'),
    },
    {
      key: 'map', glyph: '◉',
      title: 'Map View', subtitle: 'Globe + ground track',
      Preview: KmlPreview,
      onClick: () => navigate('/trajectory/map'),
    },
  ];

  // Just one debris-specific card — Results Folder. The Map View
  // already lives in the trajectory cards (since debris requires a
  // trajectory anyway, those cards are always above this section),
  // so we don't duplicate it here.
  const debrisCards = [
    {
      key: 'debris-folder', glyph: '☷',
      title: 'Results Folder', subtitle: 'CSVs · summaries',
      Preview: DebrisFolderPreview,
      onClick: () => setFilesModalOpen(true),
    },
  ];

  // What to render where: mirrors the desktop's behavior of *adding*
  // the debris cards under the trajectory ones once debris finishes,
  // rather than replacing them. So:
  //   - trajectory finished only            → 4 trajectory cards
  //   - debris  finished only (no traj yet) → 2 debris cards (rare)
  //   - both finished                       → 4 + 2 stacked
  const showTrajectory = trajectoryDone || runKind === 'trajectory';
  const showDebris     = debrisDone     || runKind === 'debris';

  return (
    <div className={`TR-results-mid${restored ? ' TR-results-mid--no-anim' : ''}`}>
      {showTrajectory && (
        <>
          <h2 className="TR-results-title">Results</h2>
          <div className="TR-cards-row">
            {trajectoryCards.map(({ key, glyph, title, subtitle, Preview, onClick, variant }) => (
              <button
                key={key}
                type="button"
                className={`TR-result-card${variant === 'debris' ? ' TR-result-card--debris' : ''}`}
                onClick={onClick}
              >
                <div className="TR-result-card-head">
                  <span className="TR-result-card-glyph" aria-hidden="true">{glyph}</span>
                  <span className="TR-result-card-arrow" aria-hidden="true">→</span>
                </div>
                <Preview />
                <span className="TR-result-card-title">{title}</span>
                <span className="TR-result-card-subtitle mono">{subtitle}</span>
              </button>
            ))}
          </div>
        </>
      )}

      {showDebris && (
        <>
          <h3 className={`TR-results-subtitle${showTrajectory ? '' : ' TR-results-subtitle--solo'}`}>
            Debris Results
          </h3>
          <div className="TR-cards-row TR-cards-row--two">
            {debrisCards.map(({ key, glyph, title, subtitle, Preview, onClick }) => (
              <button
                key={key}
                type="button"
                className="TR-result-card"
                onClick={onClick}
              >
                <div className="TR-result-card-head">
                  <span className="TR-result-card-glyph" aria-hidden="true">{glyph}</span>
                  <span className="TR-result-card-arrow" aria-hidden="true">→</span>
                </div>
                <Preview />
                <span className="TR-result-card-title">{title}</span>
                <span className="TR-result-card-subtitle mono">{subtitle}</span>
              </button>
            ))}
          </div>
        </>
      )}

      <div className="TR-results-foot">
        {/* Compact icon+label buttons sized to sit under the bigger
            result cards without competing with them visually:
              • View 3D Structure  — opens inline rocket viewer
              • Save Simulation    — snapshots the current run into
                                     Pre-loaded Trajectories/ so it
                                     can be re-loaded later or used
                                     as a Compare reference. */}
        <button
          type="button"
          className="TR-rocket-btn"
          onClick={() => setRocketModalOpen(true)}
        >
          <RocketGlyph />
          <span className="TR-rocket-btn-label">View 3D Structure</span>
        </button>
        <Tooltip
          text={
            'Saves this run for later\n' +
            'Destination: Pre-loaded Trajectories/<your-name>.xlsx'
          }
          placement="top"
        >
          <button
            type="button"
            className="TR-save-sim-btn"
            onClick={onSaveSimulation}
          >
            <SaveGlyph />
            <span className="TR-save-sim-btn-label">Save Simulation</span>
          </button>
        </Tooltip>
        {/* Download companion to Save Simulation. Save Simulation
            puts the run into the team library on the server;
            Download saves the same CSV onto the user's own computer
            (browser save-as / Downloads folder per OS settings).
            Uses the same neutral-grey pill styling as Save Simulation
            so the two read as a balanced pair. */}
        <Tooltip
          text={
            'Download this run as a CSV file to your computer.\n' +
            'Browser will offer a save-as dialog or save to your\n' +
            'Downloads folder.'
          }
          placement="top"
        >
          <button
            type="button"
            className="TR-save-sim-btn"
            onClick={() => onDownloadSimulation && onDownloadSimulation('csv')}
            disabled={!onDownloadSimulation}
          >
            <span className="TR-save-sim-btn-label" aria-hidden="true">↓</span>
            <span className="TR-save-sim-btn-label">Download CSV</span>
          </button>
        </Tooltip>
      </div>

      {filesModalOpen && (
        <DebrisFilesModal onClose={() => setFilesModalOpen(false)} />
      )}
      {rocketModalOpen && (
        <RocketViewerModal onClose={() => setRocketModalOpen(false)} />
      )}
    </div>
  );
}

/* ═══ Mission action buttons ═════════════════════════════════ */

function MissionActions({ onLoadSim, onLoadDebris, onCompare }) {
  // Sits between the mission card and the run/progress area —
  // three visible, labeled buttons for the secondary workflows.
  // Tooltips include the on-disk source/destination so the user
  // knows exactly what file each button reads from or writes to.
  const actions = [
    { key: 'load-sim',    glyph: '↑',  label: 'Load Simulation', onClick: onLoadSim,    tip: TIPS.loadSimulation },
    { key: 'load-debris', glyph: '↑',  label: 'Load Debris',     onClick: onLoadDebris, tip: TIPS.loadDebris },
    { key: 'compare',     glyph: '⇄',  label: 'Compare',         onClick: onCompare,    tip: TIPS.compare },
  ];
  return (
    <div className="TR-mission-actions">
      {actions.map(({ key, glyph, label, onClick, tip }) => (
        <Tooltip key={key} text={tip}>
          <button
            type="button"
            className="TR-mission-action"
            onClick={onClick}
          >
            <span className="TR-mission-action-glyph" aria-hidden="true">{glyph}</span>
            <span className="TR-mission-action-label">{label}</span>
          </button>
        </Tooltip>
      ))}
    </div>
  );
}

/* ═══ Inline rocket glyph — used by the View 3D Structure button ═══
 *
 *   Side-view of a stacked-stage rocket. Inline SVG (not an asset
 *   file) so it inherits the page's CSS variables for colors and
 *   stays crisp at any size. Roughly 14×22 viewbox; sized with CSS.
 */

function RocketGlyph(props) {
  return (
    <svg
      className="TR-rocket-glyph"
      viewBox="0 0 14 22"
      width="14"
      height="22"
      aria-hidden="true"
      {...props}
    >
      {/* Nose cone */}
      <path d="M7 0.5 L9.5 4.5 L4.5 4.5 Z" fill="currentColor" opacity="0.92" />
      {/* Fairing band */}
      <rect x="4.5" y="4.5" width="5" height="1.6" fill="currentColor" opacity="0.65" />
      {/* Main body — payload + stages, with subtle gradient via two rects */}
      <rect x="4.5" y="6.1" width="5" height="6"  fill="currentColor" opacity="0.78" />
      <rect x="4.5" y="12.1" width="5" height="4.8" fill="currentColor" opacity="0.70" />
      {/* Ring stage divider */}
      <rect x="4.4" y="11.9" width="5.2" height="0.5" fill="currentColor" opacity="0.45" />
      {/* Engine */}
      <rect x="5.2" y="16.9" width="3.6" height="1.8" fill="currentColor" opacity="0.6" />
      {/* Nozzle bell */}
      <path d="M5 18.7 L4 21.3 L10 21.3 L9 18.7 Z" fill="currentColor" opacity="0.75" />
      {/* Fins */}
      <path d="M4.5 14 L1.5 18 L1.5 16.4 L4.5 13 Z"  fill="currentColor" opacity="0.55" />
      <path d="M9.5 14 L12.5 18 L12.5 16.4 L9.5 13 Z" fill="currentColor" opacity="0.55" />
      {/* Tiny exhaust spark */}
      <circle cx="7" cy="22" r="0.6" fill="currentColor" opacity="0.4" />
    </svg>
  );
}

/* ═══ Save-simulation glyph ═════════════════════════════════════
 *
 *   Stylised "save" / disk icon — a download arrow into a tray.
 *   Reads-as-save more universally than a 3.5″ floppy in 2026,
 *   and pairs visually with the rocket glyph next to it (same
 *   stroke weight, same `currentColor` so the parent button can
 *   tint it). 14×22 viewBox so it slots into TR-rocket-btn /
 *   TR-save-sim-btn at identical render size. */

function SaveGlyph(props) {
  return (
    <svg
      className="TR-save-glyph"
      viewBox="0 0 14 22"
      width="14"
      height="22"
      aria-hidden="true"
      {...props}
    >
      {/* Down-arrow shaft */}
      <rect x="6.2" y="3" width="1.6" height="9" fill="currentColor" opacity="0.92" />
      {/* Down-arrow head */}
      <path d="M3.2 11 L7 15 L10.8 11 Z" fill="currentColor" opacity="0.92" />
      {/* Tray / inbox at the bottom */}
      <path
        d="M2 17 L2 20 L12 20 L12 17"
        stroke="currentColor"
        strokeWidth="1.5"
        fill="none"
        opacity="0.9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* Tray base highlight — tiny accent line */}
      <line x1="2" y1="20" x2="12" y2="20" stroke="currentColor" strokeWidth="1.4" opacity="0.55" />
    </svg>
  );
}

/* ═══ Helpers ════════════════════════════════════════════════ */

/**
 * "Has the user actually entered anything in the trajectory form?"
 * True iff every flat field is empty AND every stage's nested fields
 * are empty. Used to decide whether to show the first-time "pick a
 * preset to get started" hint in the sidebar.
 */
function isParamsEmpty(params) {
  if (!params) return true;
  for (const fields of Object.values(TRAJECTORY_PARAMS)) {
    for (const key of Object.keys(fields)) {
      const v = params[key];
      if (v !== '' && v !== null && v !== undefined) return false;
    }
  }
  for (const stageKey of ['Stage1', 'Stage2', 'Stage3']) {
    const stage = params[stageKey] || {};
    for (const key of Object.keys(STAGE_PARAMS_PER_STAGE)) {
      const v = stage[key];
      if (v !== '' && v !== null && v !== undefined) return false;
    }
  }
  return true;
}

/**
 * Walk the trajectory + stage schemas, coerce each value to the right type,
 * and assemble the JSON the simulator wants. Mirrors the desktop's
 * `_validate_and_collect()` + `_write_current_config()` flow:
 *   - Required fields with empty / non-numeric values become validation errors.
 *   - Numbers get parsed (`int` / `float`); strings pass through.
 *   - The fairing-release-conditions block the desktop tacks on at runtime is
 *     added here so simulation.py can read it from `_current.json`.
 */
function validateAndCollect(params) {
  const errors = [];
  const config = {};

  const coerce = (raw, type) => {
    if (raw === null || raw === undefined || raw === '') return null;
    if (type === 'int') {
      const v = parseInt(raw, 10);
      return Number.isFinite(v) ? v : NaN;
    }
    if (type === 'float') {
      const v = typeof raw === 'number' ? raw : parseFloat(raw);
      return Number.isFinite(v) ? v : NaN;
    }
    return String(raw);
  };

  // Trajectory params
  for (const [section, fields] of Object.entries(TRAJECTORY_PARAMS)) {
    for (const [key, meta] of Object.entries(fields)) {
      const raw = params[key];
      const value = coerce(raw, meta.type);
      if (value === null) {
        errors.push(`${section} > ${meta.label} is empty`);
        continue;
      }
      if (typeof value === 'number' && !Number.isFinite(value)) {
        errors.push(`${section} > ${meta.label}: invalid number "${raw}"`);
        continue;
      }
      config[key] = value;
    }
  }

  // Stage params (Stage1, Stage2, Stage3 — always all three, simulator uses
  // no_of_stages to know which ones to actually fire).
  for (const stageKey of ['Stage1', 'Stage2', 'Stage3']) {
    const stage = params[stageKey] || {};
    config[stageKey] = {};
    for (const [key, meta] of Object.entries(STAGE_PARAMS_PER_STAGE)) {
      const raw = stage[key];
      const value = coerce(raw, meta.type);
      if (value === null) {
        errors.push(`${stageKey} > ${meta.label} is empty`);
        continue;
      }
      if (typeof value === 'number' && !Number.isFinite(value)) {
        errors.push(`${stageKey} > ${meta.label}: invalid number "${raw}"`);
        continue;
      }
      config[stageKey][key] = value;
    }
  }

  // Structure params (CoM / MoI inputs that used to live in
  // rocket_structure.yaml). Empty fields silently fall back to the
  // Python side's STRUCTURE_DEFAULTS — they're decorative defaults,
  // not hard requirements — so empty isn't an error. Invalid numbers
  // (NaN) ARE flagged.
  const structure = params.structure || {};
  const structureOut = {};
  for (const [section, fields] of Object.entries(STRUCTURE_PARAMS)) {
    for (const [key, meta] of Object.entries(fields)) {
      const raw = structure[key];
      if (raw === '' || raw === null || raw === undefined) continue;
      if (meta.type === 'enum') {
        if (Array.isArray(meta.options) && !meta.options.includes(raw)) {
          errors.push(`${section} > ${meta.label}: "${raw}" not in ${meta.options.join('/')}`);
          continue;
        }
        structureOut[key] = String(raw);
        continue;
      }
      const value = coerce(raw, meta.type);
      if (typeof value === 'number' && !Number.isFinite(value)) {
        errors.push(`${section} > ${meta.label}: invalid number "${raw}"`);
        continue;
      }
      structureOut[key] = value;
    }
  }

  // Sanity bounds — the Python side trusts the JSON, so we catch
  // physically nonsensical values here before they cause divide-by-
  // zero or negative geometry downstream.
  const num = (k) => {
    const v = structureOut[k];
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  };
  const eir = num('engine_inner_radius_m');
  const eor = num('engine_outer_radius_m');
  if (eir !== null && eor !== null && eor <= eir) {
    errors.push(
      `Engines (Global) > Engine Outer Radius must be greater than Inner Radius `
      + `(${eor} ≤ ${eir})`
    );
  }
  const tt = num('tank_thickness_m');
  if (tt !== null && tt <= 0) {
    errors.push(`Tanks (Global) > Tank Wall Thickness must be > 0`);
  }
  for (const N of [1, 2, 3]) {
    const of = num(`Stage${N}_of_ratio`);
    if (of !== null && of <= 0) {
      errors.push(`Stage ${N} Structure > O/F Ratio must be > 0`);
    }
    const fd = num(`Stage${N}_fuel_density`);
    const od = num(`Stage${N}_ox_density`);
    if (fd !== null && fd <= 0) errors.push(`Stage ${N} Structure > Fuel Density must be > 0`);
    if (od !== null && od <= 0) errors.push(`Stage ${N} Structure > Ox Density must be > 0`);
  }

  // Pivot the flat `Stage{N}_xxx` keys into per-stage sub-objects
  // matching what `_reshape_json_config` on the Python side expects.
  // Globals stay flat at the top of the structure block.
  const structureBlock = {};
  for (const [k, v] of Object.entries(structureOut)) {
    const m = k.match(/^Stage(\d)_(.+)$/);
    if (m) {
      const [, n, field] = m;
      const key = `Stage${n}`;
      if (!structureBlock[key]) structureBlock[key] = {};
      structureBlock[key][field] = v;
    } else {
      structureBlock[k] = v;
    }
  }
  if (Object.keys(structureBlock).length > 0) {
    config.structure = structureBlock;
  }

  // Magic block the desktop GUI also adds before writing _current.json.
  config.fairing_release_conditions = { min_altitude: 120000 };

  return { errors, config };
}

/**
 * Walk DEBRIS_PARAMS and check that every required field has a finite
 * value. Mirrors validateAndCollect for the trajectory form. Skips
 * `failure_interval_s` when the user picked Custom mode (they're
 * providing explicit time points instead) and requires at least one
 * valid custom point in that mode.
 */
function validateDebrisParams(params, mode, customPoints) {
  const errors = [];
  const config = {};

  for (const [section, fields] of Object.entries(DEBRIS_PARAMS)) {
    for (const [key, meta] of Object.entries(fields)) {
      // In Custom mode the interval is unused — don't require it.
      if (key === 'failure_interval_s' && mode === 'custom') continue;

      const raw = params[key];
      if (raw === '' || raw === null || raw === undefined) {
        errors.push(`${section} > ${meta.label} is empty`);
        continue;
      }

      if (meta.type === 'float' || meta.type === 'int') {
        const v = meta.type === 'int' ? parseInt(raw, 10) : parseFloat(raw);
        if (!Number.isFinite(v)) {
          errors.push(`${section} > ${meta.label}: invalid number "${raw}"`);
          continue;
        }
        config[key] = v;
      } else {
        config[key] = String(raw);
      }
    }
  }

  if (mode === 'custom') {
    const valid = customPoints
      .map((p) => parseFloat(p))
      .filter((v) => Number.isFinite(v));
    if (valid.length === 0) {
      errors.push('Failure Points: provide at least one valid time');
    }
  }

  return { errors, config };
}

function summarizeSection(fields, values) {
  // Compact one-line summary when the section is collapsed.
  const keys = Object.keys(fields).slice(0, 2);
  const parts = keys
    .map((k) => {
      const v = values?.[k];
      const meta = fields[k];
      if (v === undefined || v === '' || v === null) return null;
      const unit = meta.unit ? ` ${meta.unit}` : '';
      return `${v}${unit}`.trim();
    })
    .filter(Boolean);
  return parts.join(' · ');
}

function fmt(value, decimals = 1) {
  if (value === undefined || value === null || value === '') return '—';
  const n = typeof value === 'number' ? value : parseFloat(value);
  if (!Number.isFinite(n)) return String(value);
  if (decimals === 0) return String(Math.round(n));
  return n.toFixed(decimals);
}

function computeTotalBurn(p) {
  const s1 = parseFloat(p?.Stage1?.stage_burn_time);
  const s2 = parseFloat(p?.stage_2_timing);
  const s3 = parseFloat(p?.stage_3_timing_total_burn);
  const stages = parseInt(p?.no_of_stages, 10) || 1;
  let total = 0;
  if (stages >= 1 && Number.isFinite(s1)) total += s1;
  if (stages >= 2 && Number.isFinite(s2)) total += s2;
  if (stages >= 3 && Number.isFinite(s3)) total += s3;
  return total;
}

export default Trajectory;
