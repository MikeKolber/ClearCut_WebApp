/**
 * Tiny API client for the Flask backend.
 *
 * In development the CRA dev server proxies unknown routes to
 * http://localhost:5001 (see "proxy" in package.json), so relative paths work.
 */

export const API_BASE = process.env.REACT_APP_API_BASE || '';

/* Paths the auth gate should NOT trigger a redirect for. A 401 from
   /api/auth/whoami is the *expected* "not logged in" signal during the
   initial gate check, not a session-expired event. */
const AUTH_NOOP_PATHS = new Set([
  '/api/auth/whoami',
  '/api/auth/login',
  '/api/auth/logout',
]);

/* Dispatched whenever the backend says 401 on any /api/* call other than
   the auth endpoints themselves. App.js listens for this and bounces the
   user to /login. Using a CustomEvent keeps services/api.js free of any
   react-router coupling. */
function notifyAuthExpired() {
  try {
    window.dispatchEvent(new CustomEvent('cc:auth-expired'));
  } catch {
    /* SSR / test envs without window — no-op */
  }
}

export async function request(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    /* `include` so the signed-session cookie travels even when
       REACT_APP_API_BASE points at a different origin. In the standard
       same-origin / CRA-proxy setup this is a no-op. */
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });

  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    let body = null;
    try {
      body = await res.json();
      if (body?.error) msg = body.error;
    } catch {
      try {
        msg = (await res.text()) || msg;
      } catch {
        /* ignore */
      }
    }
    if (res.status === 401 && !AUTH_NOOP_PATHS.has(path)) {
      notifyAuthExpired();
    }
    // Attach the parsed body and HTTP status to the Error so callers
    // can distinguish e.g. a 409 conflict (preset already exists)
    // from a real server failure without re-stringifying.
    const err = new Error(msg);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return res.json();
}

export function ping() {
  return request('/api/ping');
}

/* ─── Auth ────────────────────────────────────────────────────────── */

export function login(username, password) {
  return request('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  });
}

export function logout() {
  return request('/api/auth/logout', { method: 'POST' });
}

export function whoami() {
  return request('/api/auth/whoami');
}

/* ─── PBS ─────────────────────────────────────────────────────────── */

export function getPbsDefaults() {
  return request('/api/pbs/defaults');
}

export function calculatePbs({ num_stages, stage_data }) {
  return request('/api/pbs/calculate', {
    method: 'POST',
    body: JSON.stringify({ num_stages, stage_data }),
  });
}

/* ─── Engine Tests ─────────────────────────────────────────────── */

export function listEngineTests() {
  return request('/api/engine/tests');
}

export function getEngineTest(name) {
  return request(`/api/engine/tests/${encodeURIComponent(name)}`);
}

export function loadEngineTdms(testName, fileName) {
  return request(
    `/api/engine/tests/${encodeURIComponent(testName)}` +
      `/tdms/${encodeURIComponent(fileName)}`
  );
}

export function engineVideoUrl(testName, fileName) {
  return (
    `${API_BASE}/api/engine/tests/${encodeURIComponent(testName)}` +
    `/video/${encodeURIComponent(fileName)}`
  );
}

/* ─── Trajectory ──────────────────────────────────────────────── */

/** Read decimated `output/simulation_output.csv` for the plot page.
 *  Returns `{ exists, columns, default_x, row_count, ... }` — exists=false
 *  when the simulation hasn't produced any output yet. */
export function loadTrajectoryOutput() {
  return request('/api/trajectory/output');
}

/** Paginated raw rows of `simulation_output.csv` (no decimation).
 *  Returns `{ exists, total_rows, offset, limit, returned, columns,
 *  columns_meta, rows }`. */
export function loadTrajectoryRaw({ offset = 0, limit = 5000 } = {}) {
  const qs = new URLSearchParams({ offset: String(offset), limit: String(limit) });
  return request(`/api/trajectory/output/raw?${qs.toString()}`);
}

/** Fetch the *full* simulation output as one binary Float64Array (no
 *  decimation, no pagination). Used by the canvas Raw Data viewer.
 *
 *  Returns:
 *    `{ exists: true, total_rows, cols_count, columns, columns_meta, data }`
 *    where `data` is a `Float64Array` of length total_rows × cols_count
 *    in row-major order. NaN means the underlying value was null/Inf.
 *
 *  Or `{ exists: false, message }` if no simulation output exists yet.
 */
export async function loadTrajectoryRawAll() {
  const res = await fetch(`${API_BASE}/api/trajectory/output/raw/all`, {
    credentials: 'include',
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const data = await res.json();
      if (data?.error) msg = data.error;
    } catch { /* ignore */ }
    if (res.status === 401) notifyAuthExpired();
    throw new Error(msg);
  }
  const ct = res.headers.get('content-type') || '';
  // Server returns JSON when there's no simulation output yet.
  if (ct.includes('application/json')) {
    return res.json();
  }
  // Binary path.
  const colsHdr = res.headers.get('X-Cc-Columns');
  if (!colsHdr) throw new Error('Missing X-Cc-Columns header');
  const { names, meta } = JSON.parse(colsHdr);
  const totalRows = parseInt(res.headers.get('X-Cc-Rows'), 10);
  const totalCols = parseInt(res.headers.get('X-Cc-Cols'), 10);
  const buf = await res.arrayBuffer();
  return {
    exists:       true,
    total_rows:   totalRows,
    cols_count:   totalCols,
    columns:      names,
    columns_meta: meta,
    data:         new Float64Array(buf),
  };
}

/** URL for a CSV / XLSX download of the full simulation output. Use
 *  with `downloadFromBackend()` rather than a plain `<a href download>`,
 *  because CRA's dev proxy returns the SPA's index.html for any GET
 *  whose `Accept` header includes `text/html` (which is exactly what
 *  the browser sends for an anchor-driven download). `fetch()` sends
 *  `Accept: *​/​*`, which the proxy DOES forward to the Flask backend. */
export function trajectoryDownloadUrl(format = 'csv') {
  return `${API_BASE}/api/trajectory/output/download?format=${encodeURIComponent(format)}`;
}

/** Trigger a file download from a backend URL via fetch + blob, sidestepping
 *  the CRA dev-proxy's HTML-fallback behavior on `<a href download>` clicks.
 *
 *  Why not just use `<a href={url} download>`?
 *    Because CRA's "proxy" config in package.json only forwards GETs whose
 *    `Accept` header is NOT `text/html`. Browsers send `Accept: text/html,...`
 *    for anchor navigations, so the proxy returns the SPA's index.html
 *    instead of the file — the browser then can't save HTML as a `.csv`
 *    and shows "file wasn't available on site". `fetch()` defaults to
 *    `Accept: *​/​*`, which the proxy forwards correctly.
 *
 *  Usage:
 *    onClick={() => downloadFromBackend(trajectoryDownloadUrl('csv'),
 *                                       'simulation_output.csv')}
 */
export async function downloadFromBackend(url, suggestedFilename) {
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) {
    let msg = `download failed: HTTP ${res.status}`;
    try {
      const body = await res.json();
      if (body?.error) msg = body.error;
    } catch { /* not JSON — keep generic message */ }
    if (res.status === 401) notifyAuthExpired();
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  /* Prefer the server's Content-Disposition filename when the caller
     didn't supply one, so debris files keep their original names. */
  let filename = suggestedFilename;
  if (!filename) {
    const cd = res.headers.get('content-disposition') || '';
    const m = /filename\*?=(?:UTF-8'')?["']?([^"';]+)["']?/i.exec(cd);
    if (m) filename = decodeURIComponent(m[1]);
  }
  const blob = await res.blob();
  const blobUrl = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = blobUrl;
    if (filename) a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    /* Defer revoke so Safari has time to start the download — it
       sometimes drops the request if the blob URL disappears too
       quickly after click(). */
    setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
  }
}

/** List every preset JSON in `json_files/presets/`. Returns
 *  `{ presets: [{ name, data }] }` where `data` is the parsed preset
 *  body (trajectory keys + Stage1/2/3 sub-objects). Used by the
 *  trajectory page to merge user-saved presets into the picker. */
export function listTrajectoryPresets() {
  return request('/api/trajectory/presets');
}

/** Save the current params snapshot as a new preset on disk. The
 *  server sanitizes the name (whitelist: alnum, `- _ . space`) and
 *  returns `{ saved_name }`. On a name conflict the server returns
 *  409 with `body: { error, exists: true, name }` so the caller can
 *  prompt for overwrite confirmation and retry with `overwrite: true`. */
export function saveTrajectoryPreset(name, payload, overwrite = false) {
  return request('/api/trajectory/presets', {
    method: 'POST',
    body: JSON.stringify({ name, payload, overwrite }),
  });
}

/** Delete a saved trajectory preset by name (file stem, no `.json`).
 *  Returns `{ deleted: name }` on success, 404 if not on disk. */
export function deleteTrajectoryPreset(name) {
  return request(
    `/api/trajectory/presets/${encodeURIComponent(name)}`,
    { method: 'DELETE' }
  );
}

/** Upload an external CSV/XLSX as the new `simulation_output.csv`.
 *  `file` is a browser `File` object from a `<input type="file">`.
 *  Returns `{ rows, name }` on success.
 *
 *  Note: this bypasses the JSON `request` helper above because we're
 *  sending multipart/form-data — the `Content-Type` must be set by
 *  the browser so it can include the boundary string. */
export async function loadSimulationFile(file) {
  const fd = new FormData();
  fd.append('file', file);
  const res = await fetch(`${API_BASE}/api/trajectory/load`, {
    method: 'POST',
    credentials: 'include',
    body: fd,
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    let body = null;
    try {
      body = await res.json();
      if (body?.error) msg = body.error;
    } catch { /* ignore */ }
    if (res.status === 401) notifyAuthExpired();
    const err = new Error(msg);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return res.json();
}

/** Save the current `simulation_output.csv` into Pre-loaded Trajectories
 *  under the given user-supplied name (sanitised server-side). The
 *  saved file becomes available to both the "Load Simulation" picker
 *  and the Compare page's reference set.
 *
 *  Returns `{ saved_name, filename }` on success.
 *  On a name collision *without* `overwrite`, throws an Error with
 *  `err.status === 409` and `err.body.exists === true` so the caller
 *  can prompt the user before retrying. */
export function saveCurrentSimulation(name, overwrite = false, params = null) {
  return request('/api/trajectory/save-current', {
    method: 'POST',
    body: JSON.stringify({ name, overwrite, params }),
  });
}

/** Load a previously-saved simulation file (by basename) from
 *  Pre-loaded Trajectories/ as the new active simulation.
 *  This is the "click an entry in the saved list" path, complementing
 *  the file-upload variant above.
 *
 *  Returns `{ rows, name }` on success. */
export function loadSavedSimulation(filename) {
  return request('/api/trajectory/load-saved', {
    method: 'POST',
    body: JSON.stringify({ filename }),
  });
}

/** Delete a saved simulation from Pre-loaded Trajectories/. Removes
 *  the XLSX, its `.json` config sidecar (if any), and any cached
 *  artefacts. Returns `{ deleted: filename }` on success. */
export function deleteSavedSimulation(filename) {
  return request(
    `/api/trajectory/saved/${encodeURIComponent(filename)}`,
    { method: 'DELETE' }
  );
}

/** List `.csv` / `.xlsx` files in the `Pre-loaded Trajectories/`
 *  folder, plus a synthetic "Current run" entry pointing at the
 *  most recent simulation output. Returns
 *  `{ files: [{ name, filename, kind }] }`. */
export function compareFilesList() {
  return request('/api/trajectory/compare/files');
}

/** Fetch decimated per-file data for the Compare page. `filename`
 *  is what `compareFilesList()` returned (or `__current__` for the
 *  live sim output). Same response shape as `loadTrajectoryOutput()`. */
export function compareFileData(filename) {
  return request(
    `/api/trajectory/compare/data?file=${encodeURIComponent(filename)}`
  );
}

/** Fetch the rocket geometry payload (`src/sketch/rocket_data.json`)
 *  that drives the 3D viewer. Returns
 *  `{ exists: true, data: { payload_length, fairing_radius, stage1_*, … } }`
 *  on success, or 404 (caught by `request()` as an Error with
 *  `err.status === 404`) before any sim has run. */
export function loadRocketStructure() {
  return request('/api/trajectory/rocket-structure');
}

/** Spawn a trajectory simulation. `config` is the merged params dict
 *  (same shape as `json_files/presets/*.json` — trajectory keys plus
 *  Stage1/2/3 sub-objects). Returns `{ run_id, status: 'running' }`. */
export function startTrajectoryRun(config) {
  return request('/api/trajectory/run', {
    method: 'POST',
    body: JSON.stringify(config),
  });
}

/** Poll the current state of a running simulation.
 *  Returns `{ run_id, status, progress, phase, elapsed_s, error_msg, recent_log }`.
 *  `status` is one of: `running`, `success`, `failed`, `cancelled`. */
export function getTrajectoryRunStatus(runId) {
  return request(`/api/trajectory/run/${encodeURIComponent(runId)}`);
}

/** Cancel a running simulation. */
export function cancelTrajectoryRun(runId) {
  return request(`/api/trajectory/run/${encodeURIComponent(runId)}/cancel`, {
    method: 'POST',
  });
}

/* ─── Debris ──────────────────────────────────────────────────── */

/** List every preset JSON in `json_files/debris_presets/`. Returns
 *  `{ presets: [{ name, data }] }` — same shape as the trajectory
 *  preset list, so the picker on the debris tab can ingest it
 *  without branching. */
export function listDebrisPresets() {
  return request('/api/debris/presets');
}

/** Save the current debris params snapshot as a new preset on disk.
 *  Sanitisation + 409-on-conflict behaviour mirror `saveTrajectoryPreset`. */
export function saveDebrisPreset(name, payload, overwrite = false) {
  return request('/api/debris/presets', {
    method: 'POST',
    body: JSON.stringify({ name, payload, overwrite }),
  });
}

/** Delete a saved debris preset by name. Mirrors `deleteTrajectoryPreset`. */
export function deleteDebrisPreset(name) {
  return request(
    `/api/debris/presets/${encodeURIComponent(name)}`,
    { method: 'DELETE' }
  );
}

/** Spawn a debris-analysis run. `body = { mode, interval_s?, custom_times?, params }`.
 *  Returns `{ run_id, status: 'running', n_rows }`. */
export function startDebrisRun(body) {
  return request('/api/debris/run', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

/** Poll debris run status. Same shape as trajectory + `parent_folder`. */
export function getDebrisRunStatus(runId) {
  return request(`/api/debris/run/${encodeURIComponent(runId)}`);
}

/** Cancel a running debris analysis. */
export function cancelDebrisRun(runId) {
  return request(`/api/debris/run/${encodeURIComponent(runId)}/cancel`, {
    method: 'POST',
  });
}

/** List available debris runs (newest first). */
export function listDebrisRuns() {
  return request('/api/debris/output');
}

/** Fetch one debris run's full results — index entries + impact dots. */
export function loadDebrisRun(runId) {
  return request(`/api/debris/output/${encodeURIComponent(runId)}`);
}

/** Fetch the file-tree listing for one debris run (top-level files +
 *  per-row file groups with row metadata). */
export function loadDebrisTree(runId) {
  return request(`/api/debris/output/${encodeURIComponent(runId)}/tree`);
}

/** Build a URL pointing at a single file inside a debris run. HTML files
 *  open inline (text/html); everything else downloads as attachment. */
export function debrisFileUrl(runId, path) {
  const encId = encodeURIComponent(runId);
  const encPath = encodeURIComponent(path);
  return `${API_BASE}/api/debris/output/${encId}/file?path=${encPath}`;
}

/** Build a URL that streams the whole run folder as a ZIP. */
export function debrisZipUrl(runId) {
  return `${API_BASE}/api/debris/output/${encodeURIComponent(runId)}/zip`;
}
