/** Shared display formatters. */

const KB = 1024;
const MB = 1024 * KB;
const GB = 1024 * MB;

/** Human-readable file size: 1.2 GB · 512.0 MB · 87 KB · 12 B. */
export function formatSize(b) {
  if (typeof b !== 'number' || !Number.isFinite(b)) return '—';
  if (b >= GB) return `${(b / GB).toFixed(1)} GB`;
  if (b >= MB) return `${(b / MB).toFixed(1)} MB`;
  if (b >= KB) return `${(b / KB).toFixed(0)} KB`;
  return `${b} B`;
}
