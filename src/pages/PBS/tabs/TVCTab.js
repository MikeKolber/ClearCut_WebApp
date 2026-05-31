import React from 'react';
import { Section, ParamEntry, ParamDropdown } from '../../../components/Form/Form';
import { TVC_MODELS, TVC_ACTUATORS } from '../state';

function TVCTab({ value, onChange }) {
  const set = (key) => (v) => onChange({ ...value, [key]: v });

  return (
    <>
      <Section title="TVC System" />
      <ParamDropdown label="TVC Calculation Model" value={value.model}
        options={TVC_MODELS} onChange={set('model')} />

      {value.model === 'Castellini' && (
        <>
          <ParamEntry label="Total Thrust" unit="kN"
            value={value.thrust_kN} onChange={set('thrust_kN')} />
          <Section title="Castellini Specifics" accent="var(--steel)" />
          <ParamDropdown label="Actuator Type" value={value.actuator}
            options={TVC_ACTUATORS} onChange={set('actuator')} />
          <ParamEntry label="Max Deflection" unit="deg"
            value={value.delta} onChange={set('delta')} />
        </>
      )}

      {value.model === 'Rohrschneider' && (
        <>
          <ParamEntry label="Total Thrust" unit="kN"
            value={value.thrust_kN} onChange={set('thrust_kN')} />
          <ParamEntry label="Number of Engines"
            value={value.N_eng} onChange={set('N_eng')} />
        </>
      )}

      {value.model === 'Akin' && (
        <>
          <ParamEntry label="Total Thrust" unit="kN"
            value={value.thrust_kN} onChange={set('thrust_kN')} />
          <ParamEntry label="Number of Engines"
            value={value.N_eng} onChange={set('N_eng')} />
          <ParamEntry label="Chamber Pressure Pc" unit="Pa"
            value={value.Pc_Pa} onChange={set('Pc_Pa')} />
        </>
      )}
    </>
  );
}

export default TVCTab;
