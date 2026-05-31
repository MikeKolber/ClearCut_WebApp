/**
 * Shared session-state helpers for the Trajectory module.
 *
 * The trajectory results endpoints (Plot, Map View, Raw Data, etc.)
 * read from a single CSV that lives on disk between sessions. That
 * means a previous run's data is still there when the user opens
 * the app fresh, or when they hit the × reset on the success page.
 * To make the UI honest, the result pages need a way to know
 * whether a simulation has actually been run/loaded *in the current
 * UI session*, so they can show "Run a simulation to see data"
 * instead of stale numbers from yesterday.
 *
 * The Trajectory page already persists an enriched run-state
 * snapshot to sessionStorage (`RUN_STATE_STORAGE_KEY`); these
 * helpers just read that snapshot and answer two questions:
 *   - Is there a finished trajectory simulation visible to the UI?
 *   - Is there a finished debris analysis visible to the UI?
 *
 * Both helpers are SSR-safe (return `false` when sessionStorage is
 * unavailable) and are pure reads — they never mutate.
 */

export const RUN_STATE_STORAGE_KEY = 'clearcut.trajectory.runState';

function readSnapshot() {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(RUN_STATE_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Has a trajectory simulation been completed (or loaded) in this
 * session? Returns true once the user has either:
 *   - Run a trajectory simulation that finished successfully, OR
 *   - Loaded a `simulation_output.csv` via the "Load Simulation" flow, OR
 *   - Loaded an existing debris run (which implicitly carries its
 *     parent trajectory).
 *
 * Returns false on a fresh page load with no prior session state,
 * after the user clicks the × reset on the success page, or while
 * a trajectory run is still in flight.
 */
export function isTrajectoryFreshInSession() {
  const s = readSnapshot();
  if (!s) return false;
  /* `phase === 'success'` means *something* finished. The trajectory
     view is fresh whenever:
       - the most recent run was a trajectory run, OR
       - debris is done (debris always implies its parent trajectory
         was either freshly run or loaded alongside it). */
  if (s.phase !== 'success') return false;
  return s.runKind === 'trajectory' || s.debrisDone === true;
}

/**
 * Has a debris analysis been completed (or loaded) in this session?
 * Used by Map View to decide whether to render the impact-points
 * layer. Returns false during a still-running debris job and after
 * the user resets via the × button.
 */
export function isDebrisFreshInSession() {
  const s = readSnapshot();
  if (!s) return false;
  return s.phase === 'success' && s.debrisDone === true;
}

/**
 * The display name of the currently-loaded simulation (preset name
 * or file basename, whichever was used to populate the run). Used
 * by the result pages (Plot / Map / Raw) to show a "LIVE · <name>"
 * badge in the TopBar so the user always knows which sim they're
 * inspecting. Returns null when nothing is loaded.
 */
export function currentSimName() {
  const s = readSnapshot();
  if (!s) return null;
  if (s.phase !== 'success') return null;
  const name = s.presetName;
  if (!name || typeof name !== 'string') return null;
  return name;
}
