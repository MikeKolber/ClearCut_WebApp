import React from 'react';
import { Section, ParamEntry, ParamDropdown } from '../../../components/Form/Form';
import { THRUST_METHODS } from '../state';

function ThrustTab({ value, onChange }) {
  const set = (key) => (v) => onChange({ ...value, [key]: v });
  const m = value.method;

  return (
    <>
      <Section title="Thrust Structure" />
      <ParamDropdown label="Method" value={m}
        options={THRUST_METHODS} onChange={set('method')} />

      {m === 'Linear Fit (SI)' && (
        <ParamEntry label="Total Thrust" unit="N"
          value={value.T_total_N} onChange={set('T_total_N')} />
      )}

      {m === 'Castellini (US empirical)' && (
        <>
          <ParamEntry label="Number of Engines"
            value={value.N_eng} onChange={set('N_eng')} />
          <ParamEntry label="Thrust Per Engine" unit="N"
            value={value.T_per_engine_N} onChange={set('T_per_engine_N')} />
          <ParamEntry label="Single Engine Mass" unit="kg"
            value={value.m_eng_kg} onChange={set('m_eng_kg')} />
          <ParamEntry label="SSM"
            value={value.SSM} onChange={set('SSM')} />
          <ParamEntry label="n_ax" unit="m/s²"
            value={value.n_ax} onChange={set('n_ax')} />
          <ParamEntry label="g0" unit="m/s²"
            value={value.g0} onChange={set('g0')} />
          <ParamEntry label="k_SM (structural coeff)"
            value={value.k_sm} onChange={set('k_sm')} />
        </>
      )}

      {m === 'Rohrschneider (US empirical)' && (
        <>
          <ParamEntry label="Total Thrust" unit="N"
            value={value.T_total_N} onChange={set('T_total_N')} />
          <ParamEntry label="K Thrust"
            value={value.k_thrust} onChange={set('k_thrust')} />
        </>
      )}
    </>
  );
}

export default ThrustTab;
