/**
 * Unit tests for the session-freshness helpers — pins the contract the
 * result pages (Plot / Map / Raw) rely on: freshness comes only from
 * the sessionStorage snapshot the Trajectory page writes.
 */
import {
  RUN_STATE_STORAGE_KEY,
  isTrajectoryFreshInSession,
  isDebrisFreshInSession,
  currentSimName,
} from './runState';

function setSnapshot(obj) {
  window.sessionStorage.setItem(RUN_STATE_STORAGE_KEY, JSON.stringify(obj));
}

afterEach(() => {
  window.sessionStorage.clear();
});

describe('isTrajectoryFreshInSession', () => {
  test('false with no snapshot (fresh page load / after dismiss)', () => {
    expect(isTrajectoryFreshInSession()).toBe(false);
  });

  test('true after a successful trajectory run', () => {
    setSnapshot({ phase: 'success', runKind: 'trajectory' });
    expect(isTrajectoryFreshInSession()).toBe(true);
  });

  test('true when debris is done (implies a parent trajectory)', () => {
    setSnapshot({ phase: 'success', runKind: 'debris', debrisDone: true });
    expect(isTrajectoryFreshInSession()).toBe(true);
  });

  test('false while a run is still in flight', () => {
    setSnapshot({ phase: 'running', runKind: 'trajectory' });
    expect(isTrajectoryFreshInSession()).toBe(false);
  });

  test('false on corrupt snapshot JSON', () => {
    window.sessionStorage.setItem(RUN_STATE_STORAGE_KEY, '{not json');
    expect(isTrajectoryFreshInSession()).toBe(false);
  });
});

describe('isDebrisFreshInSession', () => {
  test('false when only the trajectory finished', () => {
    setSnapshot({ phase: 'success', runKind: 'trajectory' });
    expect(isDebrisFreshInSession()).toBe(false);
  });

  test('true when a debris run finished', () => {
    setSnapshot({ phase: 'success', runKind: 'debris', debrisDone: true });
    expect(isDebrisFreshInSession()).toBe(true);
  });
});

describe('currentSimName', () => {
  test('returns the preset name on success', () => {
    setSnapshot({ phase: 'success', runKind: 'trajectory', presetName: '140-500' });
    expect(currentSimName()).toBe('140-500');
  });

  test('null when nothing finished', () => {
    setSnapshot({ phase: 'running', presetName: '140-500' });
    expect(currentSimName()).toBe(null);
  });
});
