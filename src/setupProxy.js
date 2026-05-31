/**
 * Custom dev-server proxy.
 *
 * Why this file exists:
 *   The simple `"proxy": "http://localhost:5001"` line in package.json
 *   uses CRA's built-in lenient proxy, which has one well-known footgun:
 *   it ONLY forwards GET requests whose `Accept` header is NOT
 *   `text/html`. Any anchor click (download links, in-app HTML viewer
 *   tabs) sends `Accept: text/html, ...`, so the proxy short-circuits
 *   to the SPA's index.html instead of hitting Flask. Symptom: the
 *   user clicks "Download CSV" and the browser shows
 *   "file wasn't available on site" — because what came back was a
 *   block of HTML labelled `text/html` instead of the CSV they asked for.
 *
 *   `setupProxy.js` (a CRA-recognised hook) lets us replace that
 *   behaviour with an explicit, always-forward rule for `/api/*`.
 *   Same effect for end users; works for fetch, anchor downloads,
 *   target=_blank tabs, every method.
 *
 *   This file is dev-only — production deploys serve the React build
 *   from the same origin as Flask (or behind a real reverse proxy)
 *   so this concern doesn't apply there.
 */

const { createProxyMiddleware } = require('http-proxy-middleware');

const API_TARGET = process.env.REACT_APP_API_PROXY_TARGET || 'http://localhost:5001';

module.exports = function (app) {
  app.use(
    '/api',
    createProxyMiddleware({
      target: API_TARGET,
      changeOrigin: true,
      /* Pass the original Accept header through unchanged so the Flask
         endpoints can content-negotiate if they ever start doing so. */
      xfwd: true,
    })
  );
};
