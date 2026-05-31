import React from 'react';
import { Section, ParamEntry } from '../../../components/Form/Form';
import { interstageSectionDefaults } from '../state';

function InterstagesTab({ numStages, value, onChange }) {
  if (numStages < 2) {
    return (
      <div className="Interstages-empty">
        Interstage sections appear here when the vehicle has 2 or more stages.
      </div>
    );
  }

  // Make sure a section exists for every gap (1..numStages-1).
  const sections = { ...(value?.interstages || {}) };
  for (let i = 1; i < numStages; i++) {
    if (!sections[i]) sections[i] = interstageSectionDefaults();
  }

  const setField = (idx, key, v) => {
    const next = {
      ...sections,
      [idx]: { ...sections[idx], [key]: v },
    };
    onChange({ num_stages: numStages, interstages: next });
  };

  const indices = Array.from({ length: numStages - 1 }, (_, i) => i + 1);

  return (
    <>
      {indices.map((idx) => (
        <React.Fragment key={idx}>
          <Section title={`Interstage ${idx}–${idx + 1}`} />
          <ParamEntry label="Rocket Radius" unit="m"
            value={sections[idx].radius_m}
            onChange={(v) => setField(idx, 'radius_m', v)} />
          <ParamEntry label="Stage Length" unit="m"
            value={sections[idx].stage_length_m}
            onChange={(v) => setField(idx, 'stage_length_m', v)} />
          <ParamEntry label="Interstage % of Stage" unit="%"
            value={sections[idx].interstage_frac}
            onChange={(v) => setField(idx, 'interstage_frac', v)} />
          <ParamEntry label="Area Density (M_unpressurized)" unit="kg/m²"
            value={sections[idx].area_density}
            onChange={(v) => setField(idx, 'area_density', v)} />
          <ParamEntry label="Stage Mass Portion"
            value={sections[idx].stage_mass_port}
            onChange={(v) => setField(idx, 'stage_mass_port', v)} />
        </React.Fragment>
      ))}
    </>
  );
}

export default InterstagesTab;
