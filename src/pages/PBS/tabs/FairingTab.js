import React from 'react';
import { Section, ParamEntry, ParamCheckbox } from '../../../components/Form/Form';

const FIELDS = [
  ['r_cyl',     'Cylindrical Radius',         'm'],
  ['L_cyl',     'Cylindrical Length',         'm'],
  ['r_base',    'Frustum Base Radius',        'm'],
  ['L_base',    'Frustum Height',             'm'],
  ['t',         'Wall Thickness',             'm'],
  ['rho_cyl',   'Cylindrical Density',        'kg/m³'],
  ['rho_frust', 'Frustum Density',            'kg/m³'],
  ['rho_nose',  'Nose Density',               'kg/m³'],
  ['k_nose',    'Nose Mass Margin Factor',    ''],
  ['L_nose',    'Nose Length',                'm'],
  ['n_nose',    'Nose Exponent',              ''],
  ['delta',     'Nose Tip Cutoff',            'm'],
];

function FairingTab({ value, onChange }) {
  const set = (key) => (v) => onChange({ ...value, [key]: v });
  return (
    <>
      <Section title="Fairing" />
      <ParamCheckbox label="Enable fairing for this stage"
        checked={value.enabled} onChange={set('enabled')} />

      <Section title="Geometry" accent="var(--steel)" />
      {FIELDS.map(([key, label, unit]) => (
        <ParamEntry key={key} label={label} unit={unit}
          value={value[key]} onChange={set(key)} />
      ))}
    </>
  );
}

export default FairingTab;
