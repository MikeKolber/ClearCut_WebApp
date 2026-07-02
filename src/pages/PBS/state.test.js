/**
 * Unit tests for the PBS payload builder — pins the interstage-pruning
 * behaviour: gaps that no longer exist for the current stage count
 * must never reach the calculator (they'd silently add mass).
 */
import {
  buildPayload,
  makeStageDefaults,
  makeInterstagesDefaults,
  interstageSectionDefaults,
} from './state';

function stagesFor(n) {
  const out = {};
  for (let i = 1; i <= n; i++) out[i] = makeStageDefaults({});
  return out;
}

describe('buildPayload interstage pruning', () => {
  test('N stages send exactly N-1 interstage gaps', () => {
    const interstages = makeInterstagesDefaults(4);
    const payload = buildPayload({
      numStages: 4,
      stages: stagesFor(4),
      interstages,
    });
    expect(Object.keys(payload.stage_data.interstages.interstages))
      .toEqual(['1', '2', '3']);
  });

  test('gaps left over from a higher stage count are dropped', () => {
    // Simulate a config that was edited down from 4 stages to 2 but
    // whose interstage dict still carries gaps 2 and 3.
    const staleInterstages = {
      num_stages: 2,
      interstages: {
        1: { ...interstageSectionDefaults(), stage_mass_port: '100' },
        2: { ...interstageSectionDefaults(), stage_mass_port: '999' },
        3: { ...interstageSectionDefaults(), stage_mass_port: '999' },
      },
    };
    const payload = buildPayload({
      numStages: 2,
      stages: stagesFor(2),
      interstages: staleInterstages,
    });
    const sent = payload.stage_data.interstages.interstages;
    expect(Object.keys(sent)).toEqual(['1']);
    expect(sent[1].stage_mass_port).toBe('100');
  });

  test('single stage sends no interstages', () => {
    const payload = buildPayload({
      numStages: 1,
      stages: stagesFor(1),
      interstages: makeInterstagesDefaults(1),
    });
    expect(payload.stage_data.interstages.interstages).toEqual({});
    expect(payload.num_stages).toBe(1);
  });

  test('string-keyed interstage sections are accepted', () => {
    const payload = buildPayload({
      numStages: 3,
      stages: stagesFor(3),
      interstages: {
        num_stages: 3,
        interstages: {
          '1': interstageSectionDefaults(),
          '2': interstageSectionDefaults(),
        },
      },
    });
    expect(Object.keys(payload.stage_data.interstages.interstages))
      .toEqual(['1', '2']);
  });
});

describe('buildPayload stage data', () => {
  test('includes exactly numStages stage entries plus interstages', () => {
    const payload = buildPayload({
      numStages: 2,
      stages: stagesFor(4), // extra stage slots must not leak through
      interstages: makeInterstagesDefaults(2),
    });
    const keys = Object.keys(payload.stage_data);
    expect(keys.sort()).toEqual(['1', '2', 'interstages']);
  });

  test('resolves engine model label to its calculator key', () => {
    const payload = buildPayload({
      numStages: 1,
      stages: stagesFor(1),
      interstages: makeInterstagesDefaults(1),
    });
    expect(payload.stage_data[1].engine.model_key).toBe('our_thrust');
  });
});
