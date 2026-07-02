/**
 * Unit tests for the trajectory form logic — pins the validate/collect
 * contract the simulator depends on, including the optional launch
 * azimuth behaviour added alongside the simulator-side fix.
 */
import {
  emptyTrajectoryParams,
  isParamsEmpty,
  validateAndCollect,
  validateDebrisParams,
} from './trajectoryForm';
import { TRAJECTORY_PARAMS, STAGE_PARAMS_PER_STAGE } from './params';

function filledParams() {
  const p = emptyTrajectoryParams();
  for (const fields of Object.values(TRAJECTORY_PARAMS)) {
    for (const [key, meta] of Object.entries(fields)) {
      p[key] = meta.type === 'str' ? 'x' : '10';
    }
  }
  for (const stageKey of ['Stage1', 'Stage2', 'Stage3']) {
    for (const [key, meta] of Object.entries(STAGE_PARAMS_PER_STAGE)) {
      p[stageKey][key] = meta.type === 'str' ? 'Jet-A(L)' : '5';
    }
  }
  return p;
}

describe('validateAndCollect', () => {
  test('fully-filled form produces no errors', () => {
    const { errors } = validateAndCollect(filledParams());
    expect(errors).toEqual([]);
  });

  test('empty required field becomes a labelled error', () => {
    const p = filledParams();
    p.lat_launch = '';
    const { errors } = validateAndCollect(p);
    expect(errors.some((e) => e.includes('Launch Latitude'))).toBe(true);
  });

  test('optional launch azimuth left empty is sent as explicit null', () => {
    const p = filledParams();
    p.initial_launch_azimuth_with_rotation = '';
    const { errors, config } = validateAndCollect(p);
    expect(errors).toEqual([]);
    expect(config.initial_launch_azimuth_with_rotation).toBeNull();
  });

  test('explicit launch azimuth is passed through as a number', () => {
    const p = filledParams();
    p.initial_launch_azimuth_with_rotation = '-55.5';
    const { config } = validateAndCollect(p);
    expect(config.initial_launch_azimuth_with_rotation).toBe(-55.5);
  });

  test('non-numeric input is flagged, not silently coerced', () => {
    const p = filledParams();
    p.initial_speed = 'abc';
    const { errors } = validateAndCollect(p);
    expect(errors.some((e) => e.includes('invalid number'))).toBe(true);
  });

  test('fairing release conditions block is always attached', () => {
    const { config } = validateAndCollect(filledParams());
    expect(config.fairing_release_conditions).toEqual({ min_altitude: 120000 });
  });
});

describe('validateDebrisParams', () => {
  test('custom mode skips the interval but requires a valid point', () => {
    const { errors } = validateDebrisParams({}, 'custom', ['']);
    expect(errors.some((e) => e.includes('Failure Points'))).toBe(true);
    expect(errors.some((e) => e.includes('Failure Interval'))).toBe(false);
  });
});

describe('isParamsEmpty', () => {
  test('true for the pristine empty form (structure defaults ignored)', () => {
    expect(isParamsEmpty(emptyTrajectoryParams())).toBe(true);
  });

  test('false once any field is touched', () => {
    const p = emptyTrajectoryParams();
    p.lat_launch = '35';
    expect(isParamsEmpty(p)).toBe(false);
  });
});
