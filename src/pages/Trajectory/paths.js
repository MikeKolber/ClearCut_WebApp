/**
 * Single source of truth for the on-disk paths each Trajectory-module
 * button reads from or writes to, plus pre-baked tooltip strings.
 *
 * Tooltips follow a uniform two-line shape:
 *
 *     Line 1 — short action description ("Loads a CSV", "Saves a preset", …)
 *     Line 2 — `Source:` or `Destination:` followed by the on-disk path
 *
 * Path strings are repo-relative (no leading slash) so users can
 * paste them straight into Finder via *⌘⇧G* or `cd` from the
 * workspace root in a terminal.
 *
 * Newlines in the strings are honoured by the custom <Tooltip>
 * component (each `\n` becomes a separate line in the bubble).
 */

export const PATHS = {
  // Where saved-preset JSON files live (Trajectory page → Save Preset).
  presetsDir:
    'physics_engines/core/Trajectory Simulation/json_files/presets/',

  // The single canonical trajectory output file.
  trajOutputCsv:
    'physics_engines/core/Trajectory Simulation/output/simulation_output.csv',

  // Reference dataset that the Compare page overlays against the
  // current run.
  preloadedDir:
    'physics_engines/core/Trajectory Simulation/Pre-loaded Trajectories/',

  // 3-D rocket model JSON, regenerated each trajectory run.
  rocketSketch:
    'physics_engines/core/Trajectory Simulation/output/sketch/rocket_data.json',

  // Each debris run lives in its own subfolder named by id.
  debrisOutputDir:
    'physics_engines/core/Debris Analysis/output/',
};

/**
 * Pre-baked tooltip strings for the *external-data* buttons only:
 * Load Simulation, Load Debris, Compare, Save Preset, and the
 * per-row pickers. Buttons that read or write the *current* sim
 * intentionally don't get tooltips — the path is always the same
 * (`output/simulation_output.csv`), so spelling it out on every
 * Plot/Map/Raw card just adds noise.
 */
export const TIPS = {
  /* ── mission actions (header strip) ─────────────────────── */
  loadSimulation:
    'Loads a CSV / XLSX from your computer\n' +
    'Source: a file you pick from your disk',

  loadDebris:
    'Loads an existing debris run\n' +
    `Source: ${PATHS.debrisOutputDir}`,

  compare:
    'Overlays multiple simulations\n' +
    `Source: ${PATHS.preloadedDir}`,

  /* ── preset picker / save ───────────────────────────────── */
  savePreset:
    'Saves the current parameters as a preset\n' +
    `Destination: ${PATHS.presetsDir}`,

  presetItem: (name) =>
    'Loads this preset\n' +
    `Source: ${PATHS.presetsDir}${name}.json`,

  /* ── compare page sidebar rows ──────────────────────────── */
  compareCurrent:
    'Current simulation\n' +
    `Source: ${PATHS.trajOutputCsv}`,

  comparePreloaded: (filename) =>
    'Reference simulation\n' +
    `Source: ${PATHS.preloadedDir}${filename}`,

  /* ── load debris modal rows ─────────────────────────────── */
  loadDebrisRow: (runId) =>
    'Loads this debris run\n' +
    `Source: ${PATHS.debrisOutputDir}${runId}/`,
};
