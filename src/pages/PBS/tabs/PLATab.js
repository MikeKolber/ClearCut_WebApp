import React from 'react';
import { Section, ParamEntry, ParamCheckbox } from '../../../components/Form/Form';

function PLATab({ value, onChange }) {
  const set = (key) => (v) => onChange({ ...value, [key]: v });
  return (
    <>
      <Section title="Payload Adapter" />
      <ParamCheckbox label="Enable payload adapter for this stage"
        checked={value.enabled} onChange={set('enabled')} />
      <ParamEntry label="Payload Mass" unit="kg"
        value={value.payload_mass} onChange={set('payload_mass')} />
    </>
  );
}

export default PLATab;
