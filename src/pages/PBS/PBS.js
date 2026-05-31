import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import TopBar from '../../components/TopBar/TopBar';

import {
  TAB_ORDER,
  makeStageDefaults,
  makeInterstagesDefaults,
  buildPayload,
} from './state';

import EngineTab from './tabs/EngineTab';
import TVCTab from './tabs/TVCTab';
import ThrustTab from './tabs/ThrustTab';
import PropellantTab from './tabs/PropellantTab';
import PressurantTab from './tabs/PressurantTab';
import FairingTab from './tabs/FairingTab';
import PLATab from './tabs/PLATab';
import InterstagesTab from './tabs/InterstagesTab';

import Results from './Results';
import { resultsToText, resultsToCsv, downloadFile } from './exporters';
import { calculatePbs, getPbsDefaults } from '../../services/api';
import ErrorToast from '../../components/ErrorToast/ErrorToast';
import Tooltip from '../../components/Tooltip/Tooltip';

import './PBS.css';

const STAGE_COUNTS = [1, 2, 3, 4];

function PBS() {
  const navigate = useNavigate();

  const [defaults, setDefaults] = useState(null);
  const [numStages, setNumStages] = useState(1);
  const [activeStage, setActiveStage] = useState(1);
  const [activeTab, setActiveTab] = useState('engine');

  const [stages, setStages] = useState({});
  const [interstages, setInterstages] = useState(makeInterstagesDefaults(1));

  const [results, setResults] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const fileInputRef = useRef(null);

  // ── load defaults from backend, seed stage 1 ──────────────────────
  useEffect(() => {
    let cancelled = false;
    getPbsDefaults()
      .then((d) => {
        if (cancelled) return;
        setDefaults(d || {});
        setStages({ 1: makeStageDefaults(d || {}) });
      })
      .catch(() => {
        if (cancelled) return;
        setDefaults({});
        setStages({ 1: makeStageDefaults({}) });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Make sure each active stage has a data slot.
  useEffect(() => {
    if (!defaults) return;
    setStages((prev) => {
      const next = { ...prev };
      for (let i = 1; i <= numStages; i++) {
        if (!next[i]) next[i] = makeStageDefaults(defaults);
      }
      return next;
    });
  }, [numStages, defaults]);

  // Keep interstages.num_stages in sync with stage count.
  useEffect(() => {
    setInterstages((prev) => ({ ...prev, num_stages: numStages }));
  }, [numStages]);

  const stageData = stages[activeStage] || null;

  const updateActiveStageTab = (tabKey, nextValue) => {
    setStages((prev) => ({
      ...prev,
      [activeStage]: {
        ...(prev[activeStage] || {}),
        [tabKey]: nextValue,
      },
    }));
  };

  // ── calculate ────────────────────────────────────────────────────
  const onCalculate = async () => {
    setBusy(true);
    setError(null);
    try {
      const payload = buildPayload({ numStages, stages, interstages });
      const res = await calculatePbs(payload);
      setResults(res);
    } catch (e) {
      setError({
        kind: 'runtime',
        title: 'PBS calculation failed',
        details: [e.message || 'Calculation failed'],
      });
      setResults(null);
    } finally {
      setBusy(false);
    }
  };

  // ── save / load JSON config ──────────────────────────────────────
  const onSave = () => {
    const bundle = {
      num_stages: numStages,
      stages: Object.fromEntries(
        Object.entries(stages).map(([k, v]) => [String(k), v])
      ),
      interstages,
    };
    downloadFile('pbs-config.json',
      JSON.stringify(bundle, null, 2), 'application/json');
  };

  const onLoadClick = () => fileInputRef.current?.click();

  const onLoadFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const text = await file.text();
      const bundle = JSON.parse(text);
      const n = Math.max(1, Math.min(4, Number(bundle.num_stages) || 1));
      const loaded = bundle.stages || {};
      const next = {};
      for (let i = 1; i <= 4; i++) {
        const key = String(i);
        if (loaded[key]) next[i] = loaded[key];
        else if (loaded[i]) next[i] = loaded[i];
      }
      setNumStages(n);
      setActiveStage(1);
      setStages((prev) => ({ ...prev, ...next }));
      if (bundle.interstages) setInterstages(bundle.interstages);
    } catch (err) {
      setError({
        kind: 'runtime',
        title: 'Could not load config',
        details: [err.message || String(err)],
      });
    }
  };

  // ── exports ──────────────────────────────────────────────────────
  const onExportTxt = () => {
    if (!results) return;
    downloadFile('pbs-results.txt', resultsToText(results, numStages));
  };

  const onExportCsv = () => {
    if (!results) return;
    downloadFile('pbs-results.csv', resultsToCsv(results),
      'text/csv;charset=utf-8');
  };

  // ── content ──────────────────────────────────────────────────────
  const tabContent = useMemo(() => {
    if (!stageData) return null;
    if (activeTab === 'interstages') {
      return (
        <InterstagesTab
          numStages={numStages}
          value={interstages}
          onChange={setInterstages}
        />
      );
    }
    const props = {
      value: stageData[activeTab],
      onChange: (v) => updateActiveStageTab(activeTab, v),
    };
    switch (activeTab) {
      case 'engine':     return <EngineTab {...props} />;
      case 'tvc':        return <TVCTab {...props} />;
      case 'thrust':     return <ThrustTab {...props} />;
      case 'propellant': return <PropellantTab {...props} />;
      case 'pressurant': return <PressurantTab {...props} />;
      case 'fairing':    return <FairingTab {...props} />;
      case 'pla':        return <PLATab {...props} />;
      default:           return null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, stageData, numStages, interstages]);

  return (
    <>
      <TopBar
        title="Product Breakdown Structure"
        onBack={() => navigate('/')}
        backLabel="EXIT"
        backPosition="right"
        right={
          <>
            <Tooltip text={'Load a saved PBS config\nfrom a JSON file on your disk'} placement="bottom">
              <button type="button" className="PBS-topBtn" onClick={onLoadClick}>
                Load
              </button>
            </Tooltip>
            <Tooltip text={'Save the current PBS config\nas a JSON file you can re-load later'} placement="bottom">
              <button type="button" className="PBS-topBtn" onClick={onSave}>
                Save
              </button>
            </Tooltip>
            <input
              ref={fileInputRef}
              type="file"
              accept="application/json,.json"
              hidden
              onChange={onLoadFile}
            />
          </>
        }
      />

      {/* Stage bar */}
      <div className="StageBar">
        <div className="StageBar-group">
          <span className="StageBar-label">STAGES</span>
          <div className="StageBar-counts">
            {STAGE_COUNTS.map((n) => (
              <button
                key={n}
                type="button"
                className={`StageBar-count${n === numStages ? ' StageBar-count--active' : ''}`}
                onClick={() => setNumStages(n)}
              >
                {n}
              </button>
            ))}
          </div>
        </div>

        <div className="StageBar-divider" />

        <div className="StageBar-group">
          <span className="StageBar-label">ACTIVE</span>
          <div className="StageBar-pills">
            {Array.from({ length: numStages }, (_, i) => i + 1).map((i) => (
              <button
                key={i}
                type="button"
                className={`StageBar-pill${i === activeStage ? ' StageBar-pill--active' : ''}`}
                onClick={() => setActiveStage(i)}
              >
                <span className="StageBar-pill-num mono">{String(i).padStart(2, '0')}</span>
                <span className="StageBar-pill-text">Stage</span>
              </button>
            ))}
          </div>
        </div>

        <div className="StageBar-spacer" />

        <div className="StageBar-meta mono">
          {numStages} STAGE{numStages > 1 ? 'S' : ''} · ACTIVE {String(activeStage).padStart(2, '0')}
        </div>
      </div>

      {/* Main grid */}
      <div className="PBS-main">
        {/* Sidebar */}
        <aside className="PBS-sidebar">
          <div className="PBS-sidebar-tabs">
            {TAB_ORDER.map(({ key, label }) => (
              <button
                key={key}
                type="button"
                className={`PBS-tabBtn${activeTab === key ? ' PBS-tabBtn--active' : ''}`}
                onClick={() => setActiveTab(key)}
              >
                {label}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="PBS-calcBtn"
            disabled={busy || !stageData}
            onClick={onCalculate}
          >
            {busy ? 'Calculating…' : 'Calculate Mass'}
          </button>
        </aside>

        {/* Tab content */}
        <section className="PBS-content">
          <header className="PBS-content-head">
            <span className="eyebrow">
              {activeTab === 'interstages'
                ? 'CONFIG · INTERSTAGES'
                : `STAGE ${String(activeStage).padStart(2, '0')} · ${
                    (TAB_ORDER.find((t) => t.key === activeTab) || {}).label
                  }`}
            </span>
          </header>
          <div className="PBS-content-scroll">
            {tabContent}
          </div>
        </section>

        {/* Results */}
        <aside className="PBS-results">
          <header className="PBS-results-head">
            <div className="PBS-results-head-left">
              <span className="eyebrow">Telemetry · Results</span>
              {results && (
                <span className="PBS-results-status mono">
                  <span className="PBS-results-status-dot" /> READY
                </span>
              )}
            </div>
            <div className="PBS-results-actions">
              <Tooltip text="Export the current results as CSV" placement="bottom">
                <button
                  type="button"
                  className="PBS-topBtn"
                  onClick={onExportCsv}
                  disabled={!results}
                >
                  CSV
                </button>
              </Tooltip>
              <Tooltip text="Export the current results as plain text" placement="bottom">
                <button
                  type="button"
                  className="PBS-topBtn"
                  onClick={onExportTxt}
                  disabled={!results}
                >
                  TXT
                </button>
              </Tooltip>
            </div>
          </header>
          <div className="PBS-results-scroll">
            <Results results={results} />
          </div>
        </aside>
      </div>

      {error && (
        <ErrorToast error={error} onDismiss={() => setError(null)} />
      )}

      {busy && (
        <div className="PBS-busy">
          <span>Calculating…</span>
        </div>
      )}
    </>
  );
}

export default PBS;
