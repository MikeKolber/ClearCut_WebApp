import React from 'react';
import { Section, ParamEntry, ParamDropdown } from '../../../components/Form/Form';
import {
  PROP_METHODS,
  PROPELLANT_LABELS, PROPELLANT_RHO,
  TANK_MATERIAL_LABELS, TANK_MATERIAL_RHO,
  STD_SHAPES, CAST_SHAPES, CAST_SM, CAST_FEED, CB_HEAD_TYPES,
} from '../state';

function PropellantTab({ value, onChange }) {
  const set = (key) => (v) => onChange({ ...value, [key]: v });
  const setTank = (role) => (next) => onChange({ ...value, [role]: next });

  return (
    <>
      <Section title="Propellant System" />
      <ParamEntry label="Total Propellant Mass" unit="kg"
        value={value.propellant_mass} onChange={set('propellant_mass')} />
      <ParamEntry label="O/F Ratio"
        value={value.OF_ratio} onChange={set('OF_ratio')} />
      <ParamDropdown label="Calculation Method" value={value.method}
        options={PROP_METHODS} onChange={set('method')} />

      {value.method === 'Castellini' && (
        <CastellliniGlobal
          value={value.castellini_global || {}}
          onChange={(next) => onChange({ ...value, castellini_global: next })}
        />
      )}

      <Section title="Oxidizer Tank" />
      <TankSection role="Oxidizer" method={value.method}
        value={value.oxidizer} onChange={setTank('oxidizer')} />

      <Section title="Fuel Tank" />
      <TankSection role="Fuel" method={value.method}
        value={value.fuel} onChange={setTank('fuel')} />
    </>
  );
}

/* ─── Castellini shared parameters ───────────────────────────── */

function CastellliniGlobal({ value, onChange }) {
  const set = (key) => (v) => onChange({ ...value, [key]: v });
  return (
    <>
      <Section title="Castellini Shared Parameters" accent="var(--steel)" />
      <ParamEntry label="Max Axial Acceleration"     value={value.n_ax_max}    onChange={set('n_ax_max')} />
      <ParamEntry label="PL Max Axial Acceleration"  value={value.n_ax_max_pl} onChange={set('n_ax_max_pl')} />
      <ParamEntry label="Max Dynamic Pressure" unit="Pa"
        value={value.max_q} onChange={set('max_q')} />
      <ParamEntry label="Max G-Force"                value={value.max_g}       onChange={set('max_g')} />
      <ParamEntry label="Chamber Pressure" unit="Pa"
        value={value.p_cc} onChange={set('p_cc')} />
      <ParamEntry label="Safety Margin (SSM)"        value={value.ssm}         onChange={set('ssm')} />
      <ParamEntry label="Overall Rocket Diameter" unit="m"
        value={value.rocket_diam} onChange={set('rocket_diam')} />
      <ParamEntry label="Overall Rocket Length" unit="m"
        value={value.rocket_len} onChange={set('rocket_len')} />
      <ParamDropdown label="Feed Type" value={value.feed_type}
        options={CAST_FEED} onChange={set('feed_type')} />
    </>
  );
}

/* ─── Per-tank section (Ox or Fuel) ───────────────────────────── */

function TankSection({ role, method, value, onChange }) {
  const set = (key) => (v) => onChange({ ...value, [key]: v });
  const isCustomProp = PROPELLANT_RHO[value.propellant] == null;
  const isCustomMat = TANK_MATERIAL_RHO[value.material] == null;

  return (
    <>
      <ParamDropdown label={`${role} Propellant`} value={value.propellant}
        options={PROPELLANT_LABELS} onChange={set('propellant')} />
      {isCustomProp && (
        <ParamEntry label="Propellant Density" unit="kg/m³"
          value={value.prop_density_custom} onChange={set('prop_density_custom')} />
      )}

      {method !== 'Castellini' && (
        <>
          <ParamDropdown label="Tank Material" value={value.material}
            options={TANK_MATERIAL_LABELS} onChange={set('material')} />
          {isCustomMat && (
            <ParamEntry label="Material Density" unit="kg/m³"
              value={value.mat_density_custom} onChange={set('mat_density_custom')} />
          )}
        </>
      )}

      <ParamEntry label="Ullage (0–1)"
        value={value.ullage} onChange={set('ullage')} />

      {method !== 'Castellini' && (
        <ParamEntry label="Design Pressure" unit="Pa"
          value={value.pressure} onChange={set('pressure')} />
      )}

      {method === 'Standard' && (
        <StandardTankFields value={value} set={set} />
      )}

      {method === 'Castellini' && (
        <CastelliniTankFields value={value} set={set} />
      )}

      {method === 'Pablo Rachov' && (
        <PabloTankFields value={value} set={set} />
      )}
    </>
  );
}

/* ─── Standard shape sub-frames ───────────────────────────────── */

function StandardTankFields({ value, set }) {
  const shape = value.shape;
  return (
    <>
      <ParamEntry label="Allowable Stress" unit="Pa"
        value={value.stress} onChange={set('stress')} />
      <ParamEntry label="Joint Efficiency (0–1)"
        value={value.efficiency} onChange={set('efficiency')} />
      <ParamDropdown label="Tank Shape" value={shape}
        options={STD_SHAPES} onChange={set('shape')} />

      {shape === 'Sphero-cylinder' && (
        <>
          <ParamEntry label="Internal Radius" unit="m"
            value={value.sc_radius} onChange={set('sc_radius')} />
          <ParamEntry label="Cylinder Length (auto)" unit="m"
            value={value.sc_cyl_len} onChange={set('sc_cyl_len')} />
        </>
      )}

      {shape === 'Ellipsoidal' && (
        <>
          <ParamEntry label="Internal Radius" unit="m"
            value={value.el_radius} onChange={set('el_radius')} />
          <ParamEntry label="Cylinder Length (auto)" unit="m"
            value={value.el_cyl_len} onChange={set('el_cyl_len')} />
          <ParamEntry label="Head Height" unit="m"
            value={value.el_head_h} onChange={set('el_head_h')} />
        </>
      )}

      {shape === 'Torispherical' && (
        <>
          <ParamEntry label="Internal Radius" unit="m"
            value={value.ts_radius} onChange={set('ts_radius')} />
          <ParamEntry label="Cylinder Length (auto)" unit="m"
            value={value.ts_cyl_len} onChange={set('ts_cyl_len')} />
          <ParamEntry label="Crown Radius" unit="m"
            value={value.ts_crown} onChange={set('ts_crown')} />
          <ParamEntry label="Knuckle Radius" unit="m"
            value={value.ts_knuckle} onChange={set('ts_knuckle')} />
        </>
      )}

      {shape === 'Common Bulkhead' && (
        <>
          <ParamEntry label="Internal Radius" unit="m"
            value={value.cb_radius} onChange={set('cb_radius')} />
          <ParamDropdown label="Head Type" value={value.cb_head_type}
            options={CB_HEAD_TYPES} onChange={set('cb_head_type')} />
          <ParamEntry label="Bulkhead Fraction (0–1)"
            value={value.cb_fraction} onChange={set('cb_fraction')} />
          <ParamEntry label="Cylinder Length (auto)" unit="m"
            value={value.cb_cyl_len} onChange={set('cb_cyl_len')} />
          {value.cb_head_type === 'Ellipsoidal' && (
            <ParamEntry label="Head Height" unit="m"
              value={value.cb_head_h} onChange={set('cb_head_h')} />
          )}
          {value.cb_head_type === 'Torispherical' && (
            <>
              <ParamEntry label="Crown Radius" unit="m"
                value={value.cb_crown} onChange={set('cb_crown')} />
              <ParamEntry label="Knuckle Radius" unit="m"
                value={value.cb_knuckle} onChange={set('cb_knuckle')} />
            </>
          )}
        </>
      )}
    </>
  );
}

function CastelliniTankFields({ value, set }) {
  return (
    <>
      <ParamDropdown label="Structural Material (SM)" value={value.cast_SM}
        options={CAST_SM} onChange={set('cast_SM')} />
      <ParamDropdown label="Tank Shape" value={value.cast_shape}
        options={CAST_SHAPES} onChange={set('cast_shape')} />
      {value.cast_shape !== 'Manual' ? (
        <>
          <ParamEntry label="Radius R" unit="m"
            value={value.cast_R} onChange={set('cast_R')} />
          <ParamEntry label="Crown Radius" unit="m"
            value={value.cast_crown} onChange={set('cast_crown')} />
          <ParamEntry label="Cylinder Length L (auto)" unit="m"
            value={value.cast_L} onChange={set('cast_L')} />
        </>
      ) : (
        <ParamEntry label="Manual Volume" unit="m³"
          value={value.cast_manual_vol} onChange={set('cast_manual_vol')} />
      )}
    </>
  );
}

function PabloTankFields({ value, set }) {
  return (
    <>
      <ParamEntry label="Propellant Mass (auto)" unit="kg"
        value={value.pablo_mass} onChange={set('pablo_mass')} />
      <ParamEntry label="Material UTS" unit="Pa"
        value={value.pablo_uts} onChange={set('pablo_uts')} />
      <ParamEntry label="Cylinder Safety Factor"
        value={value.pablo_SF_cyl} onChange={set('pablo_SF_cyl')} />
      <ParamEntry label="Spherical Safety Factor"
        value={value.pablo_SF_sph} onChange={set('pablo_SF_sph')} />
      <ParamEntry label="Cylinder Volume" unit="m³"
        value={value.pablo_cyl_vol} onChange={set('pablo_cyl_vol')} />
      <ParamEntry label="Spherical Volume" unit="m³"
        value={value.pablo_sph_vol} onChange={set('pablo_sph_vol')} />
    </>
  );
}

export default PropellantTab;
