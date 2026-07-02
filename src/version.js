/**
 * Single in-app source for the displayed version string.
 *
 * Keep in sync with `package.json` "version" when cutting a release —
 * CRA's module-scope restriction prevents importing package.json from
 * src/ directly, so this mirror is the pragmatic single point of
 * truth for UI display.
 */
export const APP_VERSION = '1.0.0';
