import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import TopBar from '../../components/TopBar/TopBar';
import { listEngineTests, getEngineTest } from '../../services/api';
import ErrorToast, { StuckRocket } from '../../components/ErrorToast/ErrorToast';
import './EngineTest.css';
import { formatSize } from '../../utils/format';

/**
 * Mirror of et_pages/page.py — pick a test folder, then a tool.
 *   left  : test list                       (from Engine Tests/data/)
 *   right : header + 2 nav cards (Data / Video) + file browser
 */
function EngineTest() {
  const navigate = useNavigate();

  const [tests, setTests] = useState([]);
  const [selected, setSelected] = useState(null);
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState(null);
  const [loadingList, setLoadingList] = useState(true);
  const [loadingDetail, setLoadingDetail] = useState(false);

  // Load test folders on mount, auto-select the first.
  useEffect(() => {
    let cancelled = false;
    setLoadingList(true);
    listEngineTests()
      .then((data) => {
        if (cancelled) return;
        const list = data?.tests || [];
        setTests(list);
        if (list.length > 0) setSelected(list[0].name);
      })
      .catch((e) => {
        if (cancelled) return;
        setError({
          kind: 'runtime',
          title: 'Could not load engine tests',
          details: [e.message || String(e)],
        });
      })
      .finally(() => !cancelled && setLoadingList(false));
    return () => {
      cancelled = true;
    };
  }, []);

  // Whenever the selected test changes, load its file detail.
  useEffect(() => {
    if (!selected) {
      setDetail(null);
      return undefined;
    }
    let cancelled = false;
    setLoadingDetail(true);
    setError(null);
    getEngineTest(selected)
      .then((data) => !cancelled && setDetail(data))
      .catch((e) => {
        if (cancelled) return;
        setError({
          kind: 'runtime',
          title: `Could not load test "${selected}"`,
          details: [e.message || String(e)],
        });
      })
      .finally(() => !cancelled && setLoadingDetail(false));
    return () => {
      cancelled = true;
    };
  }, [selected]);

  return (
    <>
      <TopBar
        title="Engine Test"
        onBack={() => navigate('/')}
        backLabel="EXIT"
        backPosition="right"
      />

      <div className="ET-main">
        {/* Sidebar: test list */}
        <aside className="ET-sidebar">
          <header className="ET-sidebar-head">
            <span className="eyebrow">Tests</span>
            {tests.length > 0 && (
              <span className="ET-sidebar-count mono">
                {String(tests.length).padStart(2, '0')}
              </span>
            )}
          </header>

          <div className="ET-sidebar-list">
            {loadingList ? (
              <ListMessage text="Loading…" />
            ) : tests.length === 0 ? (
              <ListMessage text="// no test folders found in Engine Tests/data/" />
            ) : (
              tests.map((t) => (
                <button
                  key={t.name}
                  type="button"
                  className={`ET-listItem${t.name === selected ? ' ET-listItem--active' : ''}`}
                  aria-current={t.name === selected ? 'true' : undefined}
                  onClick={() => setSelected(t.name)}
                  title={t.name}
                >
                  <span className="ET-listItem-name">{t.name}</span>
                  <span className="ET-listItem-counts mono">
                    {t.tdms_count}D · {t.video_count}V
                  </span>
                </button>
              ))
            )}
          </div>
        </aside>

        {/* Right pane: details + nav cards + file lists */}
        <section className="ET-detail">
          {!selected ? (
            <NoSelectionPlaceholder />
          ) : loadingDetail ? (
            <Placeholder text="Loading test files…" />
          ) : detail ? (
            <DetailView
              detail={detail}
              onOpenData={() =>
                navigate(`/engine-test/data?test=${encodeURIComponent(selected)}`)
              }
              onOpenVideo={() =>
                navigate(`/engine-test/video?test=${encodeURIComponent(selected)}`)
              }
            />
          ) : (
            /* Fetch failed — the toast explains why; this keeps the
               pane from being silently blank with no recovery hint. */
            <Placeholder text="Could not load this test — pick it again to retry." />
          )}
        </section>
      </div>

      {error && (
        <ErrorToast error={error} onDismiss={() => setError(null)} />
      )}
    </>
  );
}

/* ─── Detail view (right side) ─────────────────────────────────── */

function DetailView({ detail, onOpenData, onOpenVideo }) {
  const tdmsFiles = detail.tdms_files || [];
  const videoFiles = detail.video_files || [];

  return (
    <>
      <header className="ET-detail-head">
        <span className="eyebrow">Test Folder</span>
        <h2 className="ET-detail-title" title={detail.name}>{detail.name}</h2>
        <p className="ET-detail-stats mono">
          {tdmsFiles.length} TDMS · {videoFiles.length} VIDEO
        </p>
      </header>

      <div className="ET-cards">
        <ToolCard
          glyph="≡"
          title="Data Analysis"
          subtitle={`${tdmsFiles.length} TDMS · plot, hover, zoom`}
          onClick={onOpenData}
          disabled={tdmsFiles.length === 0}
        />
        <ToolCard
          glyph="▶"
          title="Video Review"
          subtitle={`${videoFiles.length} video · frame-accurate`}
          onClick={onOpenVideo}
          disabled={videoFiles.length === 0}
        />
      </div>

      <div className="ET-files">
        <FileList label="TDMS Files" files={tdmsFiles} emptyHint="No .tdms files" />
        <FileList label="Videos"     files={videoFiles} emptyHint="No video files" />
      </div>
    </>
  );
}

function ToolCard({ glyph, title, subtitle, onClick, disabled }) {
  return (
    <button
      type="button"
      className={`ET-card${disabled ? ' ET-card--disabled' : ''}`}
      onClick={onClick}
      disabled={disabled}
    >
      <span className="ET-card-glyph" aria-hidden="true">{glyph}</span>
      <span className="ET-card-body">
        <span className="ET-card-title">{title}</span>
        <span className="ET-card-subtitle mono">{subtitle}</span>
      </span>
      <span className="ET-card-arrow" aria-hidden="true">→</span>
    </button>
  );
}

function FileList({ label, files, emptyHint }) {
  return (
    <div className="ET-files-col">
      <header className="ET-files-head">
        <span className="eyebrow">{label}</span>
        <span className="ET-files-count mono">
          {String(files.length).padStart(2, '0')}
        </span>
      </header>
      <div className="ET-files-list">
        {files.length === 0 ? (
          <div className="ET-files-empty mono">{emptyHint}</div>
        ) : (
          files.map((f) => (
            <div key={f.name} className="ET-files-item">
              <span className="ET-files-name mono" title={f.name}>{f.name}</span>
              <span className="ET-files-size mono">{formatSize(f.size_bytes)}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

/* ─── helpers ──────────────────────────────────────────────────── */

// formatSize moved to src/utils/format.js (shared).

function ListMessage({ text }) {
  return <div className="ET-listMessage mono">{text}</div>;
}

function Placeholder({ text }) {
  return <div className="ET-placeholder">{text}</div>;
}

/* "No test selected" empty state — same animated rocket as the
   trajectory result pages and the top-screen ErrorToast, so the
   "you need to pick / run something first" visual cue is
   identical everywhere it appears. */
function NoSelectionPlaceholder() {
  return (
    <div className="ET-empty">
      <div className="ET-empty-card">
        <div className="ET-empty-glyph" aria-hidden="true">
          <StuckRocket />
        </div>
        <h3 className="ET-empty-title">No test selected</h3>
        <p className="ET-empty-body">
          Pick a test folder from the list on the left to see its
          data and video files.
        </p>
      </div>
    </div>
  );
}

export default EngineTest;
