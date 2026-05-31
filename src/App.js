import React, { useEffect, useRef, useState } from 'react';
import {
  Routes,
  Route,
  Navigate,
  useLocation,
  useNavigate,
} from 'react-router-dom';

import Landing from './pages/Landing/Landing';
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

function App() {
  const location = useLocation();
  const navigate = useNavigate();
  const restoredRef = useRef(false);

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

  // 2. Persist current path (+ search) on every navigation.
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, location.pathname + location.search);
    } catch {
      /* ignore */
    }
  }, [location.pathname, location.search]);

  // 3. Reset scroll on page change.
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [location.pathname]);

  // 4. Esc → back to landing (mirrors the desktop `<Escape>` binding).
  //    `?` (Shift+/) opens the keyboard-shortcut overlay from anywhere.
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  useEffect(() => {
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
  }, [location.pathname, navigate, shortcutsOpen]);

  return (
    <div className="App">
      <div className="App-page" key={location.pathname}>
        <Routes>
          <Route path="/" element={<Landing />} />
          <Route path="/trajectory" element={<Trajectory />} />
          <Route path="/trajectory/plot" element={<TrajectoryPlot />} />
          <Route path="/trajectory/map" element={<MapView />} />
          <Route path="/trajectory/raw" element={<RawData />} />
          <Route path="/trajectory/compare" element={<ComparePage />} />
          {/* Legacy alias — older debris card pointed here. Now everyone
              lands on the unified map view. */}
          <Route path="/trajectory/debris" element={<Navigate to="/trajectory/map" replace />} />
          <Route path="/pbs" element={<PBS />} />
          <Route path="/engine-test" element={<EngineTest />} />
          <Route path="/engine-test/data" element={<TdmsAnalyzer />} />
          <Route path="/engine-test/video" element={<VideoReview />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </div>

      {shortcutsOpen && (
        <ShortcutsOverlay onClose={() => setShortcutsOpen(false)} />
      )}
    </div>
  );
}

export default App;
