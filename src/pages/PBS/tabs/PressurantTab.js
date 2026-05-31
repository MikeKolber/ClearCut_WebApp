import React from 'react';
import { Section, ParamEntry, ParamDropdown } from '../../../components/Form/Form';
import {
  PRES_MODELS, PRES_GAS_LABELS, PRES_GAS_R,
  PRES_MATERIAL_LABELS, PRES_MATERIAL_RHO,
  PRES_UTS, PRES_DIM_METHODS,
} from '../state';

function PressurantTab({ value, onChange }) {
  const set = (key) => (v) => onChange({ ...value, [key]: v });
  const isCustomGas = PRES_GAS_R[value.gas] == null;
  const isCustomMat = PRES_MATERIAL_RHO[value.material] == null;
  const isCustomUTS = String(value.UTS).startsWith('Custom');
  const isToroidal = value.dim_method === 'Toroidal';

  return (
    <>
      <Section title="Pressurant System" />
      <ParamDropdown label="Model" value={value.model}
        options={PRES_MODELS} onChange={set('model')} />
      <ParamEntry label="Oxidizer Tank Volume" unit="m³"
        value={value.V_ox} onChange={set('V_ox')} />
      <ParamEntry label="Fuel Tank Volume" unit="m³"
        value={value.V_fu} onChange={set('V_fu')} />
      <ParamEntry label="Tank Pressure" unit="Pa"
        value={value.P_tank} onChange={set('P_tank')} />
      <ParamEntry label="Tank Pressure at Launch" unit="Pa"
        value={value.P0} onChange={set('P0')} />
      <ParamEntry label="Tank Temperature at Launch" unit="K"
        value={value.T0} onChange={set('T0')} />

      <Section title="Gas Properties" accent="var(--steel)" />
      <ParamDropdown label="Pressurant Gas" value={value.gas}
        options={PRES_GAS_LABELS} onChange={set('gas')} />
      {isCustomGas && (
        <ParamEntry label="Custom Gas Constant R" unit="J/(kg·K)"
          value={value.R_custom} onChange={set('R_custom')} />
      )}
      <ParamEntry label="Gamma (specific-heat ratio)"
        value={value.gamma} onChange={set('gamma')} />

      <Section title="Tank Material" accent="var(--steel)" />
      <ParamDropdown label="Tank Material" value={value.material}
        options={PRES_MATERIAL_LABELS} onChange={set('material')} />
      {isCustomMat && (
        <ParamEntry label="Custom Material Density" unit="kg/m³"
          value={value.rho_custom} onChange={set('rho_custom')} />
      )}
      <ParamDropdown label="Ultimate Tensile Strength" value={value.UTS}
        options={PRES_UTS} onChange={set('UTS')} />
      {isCustomUTS && (
        <ParamEntry label="Custom UTS" unit="Pa"
          value={value.UTS_custom} onChange={set('UTS_custom')} />
      )}
      <ParamEntry label="Safety Factor UTS"
        value={value.SF} onChange={set('SF')} />

      <Section title="Tank Dimensions" accent="var(--steel)" />
      <ParamDropdown label="Dimension Method" value={value.dim_method}
        options={PRES_DIM_METHODS} onChange={set('dim_method')} />
      {isToroidal && (
        <>
          <ParamEntry label="Toroidal Tube Radius" unit="m"
            value={value.torus_r} onChange={set('torus_r')} />
          <ParamEntry label="Rocket Diameter" unit="m"
            value={value.rocket_diameter} onChange={set('rocket_diameter')} />
        </>
      )}
    </>
  );
}

export default PressurantTab;
