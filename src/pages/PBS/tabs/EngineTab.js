import React from 'react';
import { Section, ParamEntry, ParamDropdown, ParamCheckbox } from '../../../components/Form/Form';
import {
  ENGINE_MODELS, CEA_RUN_TYPES, FUEL_TYPES, OXIDIZER_TYPES,
} from '../state';

function EngineTab({ value, onChange }) {
  const set = (key) => (v) => onChange({ ...value, [key]: v });
  const cea = value.cea_enabled;
  const isSingle = String(value.run_type).startsWith('Single');
  const isHTP = value.oxidizer_type === 'HTP_Specific';

  return (
    <>
      <Section title="Engine Mass" />
      <ParamDropdown label="Engine Mass Model" value={value.model}
        options={ENGINE_MODELS} onChange={set('model')} />
      <ParamEntry label="Thrust (Vac.) per Engine" unit="kN"
        value={value.thrust_kN} onChange={set('thrust_kN')} />

      <Section title="Engine Performance" />
      <ParamCheckbox
        label="Enable Engine Performance (Chamber + Nozzle)"
        checked={cea} onChange={set('cea_enabled')}
      />

      {cea && (
        <>
          <Section title="Combustion Chamber" accent="var(--steel)" />
          <ParamDropdown label="Run Type" value={value.run_type}
            options={CEA_RUN_TYPES} onChange={set('run_type')} />
          <ParamEntry label="Chamber Pressure (P_c)" unit="bar"
            value={value.P_c} onChange={set('P_c')} />
          <ParamDropdown label="Fuel Type" value={value.fuel_type}
            options={FUEL_TYPES} onChange={set('fuel_type')} />
          <ParamEntry label="Fuel Initial Temp" unit="K"
            value={value.Tinit_Fuel} onChange={set('Tinit_Fuel')} />
          <ParamDropdown label="Oxidizer Type" value={value.oxidizer_type}
            options={OXIDIZER_TYPES} onChange={set('oxidizer_type')} />
          {isHTP && (
            <ParamEntry label="HTP Concentration" unit="%"
              value={value.HTP_concentration} onChange={set('HTP_concentration')} />
          )}
          <ParamEntry label="Oxidizer Initial Temp" unit="K"
            value={value.Tinit_Oxidizer} onChange={set('Tinit_Oxidizer')} />
          <ParamEntry label="Mass Flow Rate (m_dot)" unit="kg/s"
            value={value.m_dot} onChange={set('m_dot')} />
          <ParamEntry label="Design Chamber Efficiency" unit="%"
            value={value.design_efficiency} onChange={set('design_efficiency')} />
          <ParamEntry label="Actual Chamber Efficiency" unit="%"
            value={value.actual_efficiency} onChange={set('actual_efficiency')} />
          <ParamEntry label="Nozzle Efficiency" unit="%"
            value={value.nozzle_efficiency} onChange={set('nozzle_efficiency')} />
          {isSingle && (
            <ParamEntry label="Custom O/F Ratio"
              value={value.OF_ratio} onChange={set('OF_ratio')} />
          )}

          <Section title="Nozzle Geometry" accent="var(--steel)" />
          <ParamEntry label="Expansion Ratio (Ae/At)"
            value={value.Ae_At} onChange={set('Ae_At')} />
          <ParamEntry label="Nozzle Length %" unit="%"
            value={value.l_percent} onChange={set('l_percent')} />
          <ParamEntry label="Characteristic Length (L*)" unit="m"
            value={value.char_length} onChange={set('char_length')} />
          <ParamEntry label="Chamber Contraction Ratio"
            value={value.epsilon_c} onChange={set('epsilon_c')} />
          <ParamEntry label="Convergence Angle" unit="deg"
            value={value.alpha_angle} onChange={set('alpha_angle')} />
        </>
      )}

      <Section title="Stage Parameters" />
      <ParamEntry label="Number of Engines in Stage"
        value={value.num_engines} onChange={set('num_engines')} />
      <ParamEntry label="Rocket Outer Diameter" unit="m"
        value={value.outer_diameter} onChange={set('outer_diameter')} />
    </>
  );
}

export default EngineTab;
