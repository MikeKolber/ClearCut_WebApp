import React, { useEffect, useRef, useState } from 'react';
import {
  Routes,
  Route,
  Navigate,
  useLocation,
  useNavigate,
} from 'react-router-dom';

import Landing from './pages/Landing/Landing';
import Login from './pages/Login/Login';
import Trajectory from './pages/Trajectory/Trajectory';
import TrajectoryPlot from './pages/Trajectory/TrajectoryPlot';
import MapView from './pages/Trajectory/MapView';
import RawData from './pages/Trajectory/RawData';
import ComparePage from './pages/Trajectory/ComparePage';
import PBS from './pages/PBS/PBS';
import EngineTest from './pages/EngineTest/EngineTest';
import TdmsAnalyzer from './pages/EngineTest/TdmsAnalyzer';
import VideoReview from './pages/EngineTest/VideoReview';
import ShortcutsOverlay from './components/ShortcutsOverlay/ShortcutsOverlay';
import { whoami } from './services/api';
import './styles/App.css';

const STORAGE_KEY = 'clearcut.lastPath';
const VALID_PATH_PREFIXES = [
  '/',
  '/trajectory',
  '/trajectory/plot',
  '/trajectory/map',
  '/trajectory/raw',
  '/trajectory/compare',
  '/pbs',
  '/engine-test',
];
const isValidSavedPath = (p) =>
  typeof p === 'string' &&
  VALID_PATH_PREFIXES.some((root) => p === root || p.startsWith(`${root}/`) || p.startsWith(`${root}?`));

/* ─────────────────────────────────────────────────────────────────
   ProtectedRoute — verifies the session via /api/auth/whoami. The
   verified flag is cached at module scope so navigating between
   pages doesn't refire the check on every mount — any later 401
   dispatches `cc:auth-expired`, which resets the flag and bounces
   to /login. On slow checks (cold backend) a quiet branded splash
   appears after 300 ms instead of an unexplained black screen.
   ───────────────────────────────────────────────────────────────── */
let _authVerified = false;
if (typeof window !== 'undefined') {
  window.addEventListener('cc:auth-expired', () => { _authVerified = false; });
}

function ProtectedRoute({ children }) {
  const navigate = useNavigate();
  // 'checking' | 'authed' | 'unauthed'
  const [state, setState] = useState(_authVerified ? 'authed' : 'checking');
  const [showSplash, setShowSplash] = useState(false);

  useEffect(() => {
    if (_authVerified) return undefined;
    let cancelled = false;
    whoami()
      .then(() => {
        _authVerified = true;
        if (!cancelled) setState('authed');
      })
      .catch(() => { if (!cancelled) setState('unauthed'); });
    return () => { cancelled = true; };
  }, []);

  // Only surface the splash when the check is genuinely slow — a
  // sub-300ms check stays a plain black frame, no flash of UI.
  useEffect(() => {
    if (state !== 'checking') return undefined;
    const t = setTimeout(() => setShowSplash(true), 300);
    return () => clearTimeout(t);
  }, [state]);

  useEffect(() => {
    if (state !== 'unauthed') return;
    navigate('/login', { replace: true });
  }, [state, navigate]);

  if (state !== 'authed') {
    return (
      <div className="App-authGate">
        {showSplash && state === 'checking' && (
          <span className="App-authGate-text mono">
            Verifying session…
          </span>
        )}
      </div>
    );
  }
  return children;
}

function App() {
  const location = useLocation();
  const navigate = useNavigate();
  const restoredRef = useRef(false);
  const onLoginPage = location.pathname === '/login';

  // 1. On first mount only: if we landed on `/` but localStorage has a saved
  //    deep path, restore it. Subsequent visits to `/` show the landing page
  //    as expected.
  useEffect(() => {
    if (restoredRef.current) return;
    restoredRef.current = true;
    if (location.pathname !== '/') return;
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved && saved !== '/' && isValidSavedPath(saved)) {
        navigate(saved, { replace: true });
      }
    } catch {
      /* localStorage disabled — ignore */
    }
  }, [location.pathname, navigate]);

  // 2. Persist current path (+ search) on every navigation. The /login
  //    route is excluded so a user who got bounced there mid-session
  //    doesn't land back on /login after their next visit.
  useEffect(() => {
    if (onLoginPage) return;
    try {
      localStorage.setItem(STORAGE_KEY, location.pathname + location.search);
    } catch {
      /* ignore */
    }
  }, [location.pathname, location.search, onLoginPage]);

  // 3. Reset scroll on page change.
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [location.pathname]);

  // 4. Esc → back to landing (mirrors the desktop `<Escape>` binding).
  //    `?` (Shift+/) opens the keyboard-shortcut overlay from anywhere.
  //    Both shortcuts are no-ops on /login so they don't leak the app's
  //    structure to a user who hasn't authenticated yet.
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  useEffect(() => {
    if (onLoginPage) return undefined;
    const onKey = (e) => {
      // Ignore shortcuts while typing into form fields.
      const t = e.target;
      const isTyping =
        t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);

      if (e.key === 'Escape') {
        if (shortcutsOpen) {
          setShortcutsOpen(false);
          return;
        }
        if (location.pathname !== '/') navigate('/');
        return;
      }
      if (!isTyping && (e.key === '?' || (e.shiftKey && e.key === '/'))) {
        e.preventDefault();
        setShortcutsOpen((s) => !s);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [location.pathname, navigate, shortcutsOpen, onLoginPage]);

  // 5. Listen for `cc:auth-expired` (dispatched by services/api.js when any
  //    /api/* request comes back 401) and bounce to /login. Login always
  //    routes the user to the Landing page after a successful re-auth.
  useEffect(() => {
    const onExpired = () => {
      if (location.pathname === '/login') return;
      navigate('/login', { replace: true });
    };
    window.addEventListener('cc:auth-expired', onExpired);
    return () => window.removeEventListener('cc:auth-expired', onExpired);
  }, [location.pathname, navigate]);

  return (
    <div className="App">
      <div className="App-page" key={location.pathname}>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route
            path="/"
            element={<ProtectedRoute><Landing /></ProtectedRoute>}
          />
          <Route
            path="/trajectory"
            element={<ProtectedRoute><Trajectory /></ProtectedRoute>}
          />
          <Route
            path="/trajectory/plot"
            element={<ProtectedRoute><TrajectoryPlot /></ProtectedRoute>}
          />
          <Route
            path="/trajectory/map"
            element={<ProtectedRoute><MapView /></ProtectedRoute>}
          />
          <Route
            path="/trajectory/raw"
            element={<ProtectedRoute><RawData /></ProtectedRoute>}
          />
          <Route
            path="/trajectory/compare"
            element={<ProtectedRoute><ComparePage /></ProtectedRoute>}
          />
          {/* Legacy alias — older debris card pointed here. Now everyone
              lands on the unified map view. */}
          <Route path="/trajectory/debris" element={<Navigate to="/trajectory/map" replace />} />
          <Route
            path="/pbs"
            element={<ProtectedRoute><PBS /></ProtectedRoute>}
          />
          <Route
            path="/engine-test"
            element={<ProtectedRoute><EngineTest /></ProtectedRoute>}
          />
          <Route
            path="/engine-test/data"
            element={<ProtectedRoute><TdmsAnalyzer /></ProtectedRoute>}
          />
          <Route
            path="/engine-test/video"
            element={<ProtectedRoute><VideoReview /></ProtectedRoute>}
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </div>

      {shortcutsOpen && !onLoginPage && (
        <ShortcutsOverlay onClose={() => setShortcutsOpen(false)} />
      )}
    </div>
  );
}

export default App;
