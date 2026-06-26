/**
 * Browser-side download helpers.
 *
 * Triggers the browser's standard "save file" flow. Where the file
 * ends up is governed by the user's browser settings:
 *   - Chrome / Safari / Firefox default to ~/Downloads/.
 *   - Setting "Always ask where to save files" pops the OS save-as
 *     dialog so the user can pick a folder per file.
 *
 * We don't try to use the experimental File System Access API
 * (`showSaveFilePicker`) here — it's Chrome-only and unsupported on
 * Safari/Firefox, so we'd silently lose the picker on those browsers.
 * The standard download flow works everywhere.
 */

/**
 * Slug a free-form name into something safe for a filename.
 *   "My run #1" → "my-run-1"
 */
export function slugifyFilename(s, fallback = 'untitled') {
  if (typeof s !== 'string') return fallback;
  const out = s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return out || fallback;
}

/**
 * Trigger a browser download of a Blob with the given filename. The
 * blob URL is revoked after a beat so Safari has time to start the
 * download before we tear it down.
 */
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

/**
 * Serialize `data` as pretty-printed JSON and download it with the
 * given filename. Use this for trajectory / debris presets so the
 * user can keep a local copy alongside the one on the team server.
 */
export function downloadJson(filename, data) {
  const text = JSON.stringify(data, null, 2);
  downloadBlob(
    new Blob([text], { type: 'application/json' }),
    filename.endsWith('.json') ? filename : `${filename}.json`
  );
}
