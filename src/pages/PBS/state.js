/**
 * Default values + tab metadata for the PBS page.
 * Every key here is consumed by `physics_engines/core/PBS/calculator.py` —
 * keep the spelling identical to the Python side.
 */

export const TAB_ORDER = [
  { key: 'engine',      label: 'Engine' },
  { key: 'tvc',         label: 'TVC' },
  { key: 'propellant',  label: 'Prop. Tanks' },
  { key: 'pressurant',  label: 'Pressurant' },
  { key: 'thrust',      label: 'Thrust Struct.' },
  { key: 'interstages', label: 'Interstages' },
  { key: 'fairing',     label: 'Fairing' },
  { key: 'pla',         label: 'PLA' },
];

/* ─── Engine ─────────────────────────────────────────────────────── */

export const ENGINE_MODELS = [
  'Our Model (Thrust)',
  'Our Model (Mass Flow)',
  'Zandbergen Low',
  'Zandbergen High',
  'Humble',
  'McHugh',
  'Castellini: Storables Med',
  'Castellini: CryoStorables Low',
  'Castellini: Staged Combustion Mid',
  'Castellini: GG Cycle Full',
  'Castellini: Storables Conserv.',
];

export const ENGINE_MODEL_KEYS = {
  'Our Model (Thrust)':                 'our_thrust',
  'Our Model (Mass Flow)':              'our_flow',
  'Zandbergen Low':                     'zandbergen_lo',
  'Zandbergen High':                    'zandbergen_hi',
  'Humble':                             'humble',
  'McHugh':                             'mchugh',
  'Castellini: Storables Med':          'castellini_storables_med',
  'Castellini: CryoStorables Low':      'castellini_cryostorables_low',
  'Castellini: Staged Combustion Mid':  'castellini_staged_combustion_mid',
  'Castellini: GG Cycle Full':          'castellini_gg_cycle_full',
  'Castellini: Storables Conserv.':     'castellini_storables_conserv',
};

export const CEA_RUN_TYPES = ['Full (Optimal O/F)', 'Single (Custom O/F)'];
export const FUEL_TYPES = ['Jet-A(L)', 'Paraffin'];
export const OXIDIZER_TYPES = ['Air', 'LOX', 'HTP90', 'HTP_Specific'];

export const engineDefaults = (defs = {}) => {
  const e = defs.Engine || {};
  return {
    model: 'Our Model (Thrust)',
    thrust_kN: String(e.thrust_kN ?? 200),
    cea_enabled: false,
    run_type: CEA_RUN_TYPES[0],
    P_c: '80.0',
    fuel_type: 'Jet-A(L)',
    Tinit_Fuel: '298.0',
    oxidizer_type: 'HTP90',
    HTP_concentration: '94.0',
    Tinit_Oxidizer: '298.0',
    m_dot: String(e.mass_flow_rate ?? 17),
    design_efficiency: '100.0',
    actual_efficiency: '97.0',
    nozzle_efficiency: '98.7',
    OF_ratio: '4.0',
    Ae_At: '20.0',
    l_percent: '80.0',
    char_length: '1.0',
    epsilon_c: '2.0',
    alpha_angle: '45.0',
    num_engines: String(e.num_engines ?? 1),
    outer_diameter: '1.25',
  };
};

/* ─── TVC ────────────────────────────────────────────────────────── */

export const TVC_MODELS = ['Castellini', 'Rohrschneider', 'Akin'];
export const TVC_ACTUATORS = ['1 - Hydraulic', '2 - Electro-mechanical'];

export const tvcDefaults = (defs = {}) => {
  const t = defs.TVC || {};
  const idx = Math.min(t.type_idx ?? 1, TVC_ACTUATORS.length - 1);
  return {
    model: t.model || 'Castellini',
    thrust_kN: String(t.thrust_kN ?? 200),
    actuator: TVC_ACTUATORS[idx],
    delta: String(t.delta ?? 6),
    N_eng: String(t.N_eng ?? 1),
    Pc_Pa: '3000000',
  };
};

/* ─── Thrust Structure ───────────────────────────────────────────── */

export const THRUST_METHODS = [
  'Linear Fit (SI)',
  'Castellini (US empirical)',
  'Rohrschneider (US empirical)',
];

export const THRUST_METHOD_KEYS = {
  'Linear Fit (SI)':                   'linear_fit',
  'Castellini (US empirical)':         'castellini',
  'Rohrschneider (US empirical)':      'rohrschneider',
};

export const thrustDefaults = (defs = {}) => {
  const ts = defs.Thrust_Structure || {};
  return {
    method: 'Linear Fit (SI)',
    T_total_N: String(ts.thrust_N ?? 200000),
    N_eng: '1',
    T_per_engine_N: '200000',
    m_eng_kg: '500',
    SSM: '1.0',
    n_ax: '1.0',
    g0: '9.80665',
    k_sm: '1.0',
    k_thrust: '0.0',
  };
};

/* ─── Pressurant ─────────────────────────────────────────────────── */

export const PRES_MODELS = ['Isothermal', 'Energy', 'Adiabatic'];

export const PRES_GASES = [
  ['Helium (He)',                     2077.1],
  ['Nitrogen (N₂)',                    296.8],
  ['Argon (Ar)',                       208.1],
  ['Gaseous Hydrogen (GH₂)',          4124.0],
  ['Gaseous Oxygen (GO₂)',             259.8],
  ['Custom Gas...',                    null],
];
export const PRES_GAS_LABELS = PRES_GASES.map(([name, r]) =>
  r != null ? `${name} (${r} J/kg·K)` : name
);
export const PRES_GAS_R = Object.fromEntries(
  PRES_GAS_LABELS.map((label, i) => [label, PRES_GASES[i][1]])
);

export const PRES_MATERIALS = [
  ['Al 6061-T6',              2700],
  ['Al 7075-T6',              2810],
  ['Al 2195 (Al-Li)',         2710],
  ['Al 2219-T87',             2840],
  ['Ti 6Al-4V (Grade 5)',     4430],
  ['Stainless Steel 301',     7930],
  ['CFRP (Pressure Vessel)',  1700],
  ['Inconel 718',             8190],
  ['Custom Material...',      null],
];
export const PRES_MATERIAL_LABELS = PRES_MATERIALS.map(([n, d]) =>
  d != null ? `${n} (${d} kg/m³)` : n
);
export const PRES_MATERIAL_RHO = Object.fromEntries(
  PRES_MATERIAL_LABELS.map((label, i) => [label, PRES_MATERIALS[i][1]])
);

export const PRES_UTS = ['Ti-6Al-4V (950 MPa)', 'Custom Value...'];
export const PRES_DIM_METHODS = ['Spherical', 'Toroidal'];

export const pressurantDefaults = (defs = {}) => {
  const p = defs.Pressurant || {};
  return {
    model: p.model || 'Adiabatic',
    V_ox: String(p.V_ox ?? 0.12),
    V_fu: String(p.V_fu ?? 0.115),
    P_tank: String(p.P_tank ?? 3.0e6),
    P0: String(p.P0 ?? 2.86e8),
    T0: String(p.T0 ?? 293.0),
    gas: PRES_GAS_LABELS[0],
    R_custom: String(p.R_gas ?? 2077.0),
    gamma: String(p.gamma ?? 1.667),
    material: PRES_MATERIAL_LABELS[4],
    rho_custom: String(p.rho_mat ?? 4429),
    UTS: PRES_UTS[0],
    UTS_custom: '950e6',
    SF: String(p.SF ?? 3.5),
    sigma_y: String(p.sigma_y ?? 880e6),
    dim_method: 'Spherical',
    torus_r: '0.05',
    rocket_diameter: '1.2',
  };
};

/* ─── Propellant Tanks ───────────────────────────────────────────── */

export const PROP_METHODS = ['Standard', 'Castellini', 'Pablo Rachov'];

export const PROPELLANTS = [
  ['Liquid Oxygen (LOX)',        1140],
  ['RP-1 (Kerosene)',             800],
  ['Liquid Hydrogen (LH₂)',        71],
  ['Nitrogen Tetroxide (NTO)',   1450],
  ['Monomethylhydrazine (MMH)',   880],
  ['UDMH',                        800],
  ['Hydrazine (N₂H₄)',           1010],
  ['Hydrogen Peroxide 90%',      1420],
  ['Aerozine 50',                 870],
  ['Custom Propellant…',         null],
];
export const PROPELLANT_LABELS = PROPELLANTS.map(([n, d]) =>
  d != null ? `${n} (${d} kg/m³)` : n
);
export const PROPELLANT_RHO = Object.fromEntries(
  PROPELLANT_LABELS.map((l, i) => [l, PROPELLANTS[i][1]])
);

export const TANK_MATERIALS = [
  ['Al 6061-T6',          2700],
  ['Al 7075',             2810],
  ['Al 2195 (Al-Li)',     2710],
  ['Al 2219 (Al-Cu)',     2840],
  ['Ti 6Al-4V',           4430],
  ['Stainless Steel 301', 7930],
  ['CFRP (Carbon Fiber)', 1700],
  ['Inconel 718',         8190],
  ['Custom Material…',    null],
];
export const TANK_MATERIAL_LABELS = TANK_MATERIALS.map(([n, d]) =>
  d != null ? `${n} (${d} kg/m³)` : n
);
export const TANK_MATERIAL_RHO = Object.fromEntries(
  TANK_MATERIAL_LABELS.map((l, i) => [l, TANK_MATERIALS[i][1]])
);

export const STD_SHAPES = [
  'Sphero-cylinder',
  'Ellipsoidal',
  'Torispherical',
  'Common Bulkhead',
  'Spherical (Separated)',
];
export const CAST_SHAPES = ['Ellipsoidal', 'Sphero-cylinder', 'Torispherical', 'Manual'];
export const CAST_SM = [
  'Aluminum Alloy', 'Al-Li Alloy', 'Composite Wings',
  'Composite Tanks', 'Composite Interstage',
];
export const CAST_FEED = [
  'Pressure-fed', 'Gas generator', 'Expander cycle', 'Staged combustion',
];
export const CB_HEAD_TYPES = ['Spherical', 'Ellipsoidal', 'Torispherical'];

const tankSectionDefaults = (role, defs = {}) => {
  const isOx = role === 'Oxidizer';
  return {
    propellant: PROPELLANT_LABELS[isOx ? 0 : 1],
    prop_density_custom: '1000',
    material: TANK_MATERIAL_LABELS[0],
    mat_density_custom: '2700',
    ullage: '0.05',
    pressure: isOx ? '3000000' : '2000000',

    stress: isOx ? '250e6' : '200e6',
    efficiency: isOx ? '0.9' : '0.85',
    shape: isOx ? 'Ellipsoidal' : 'Sphero-cylinder',

    sc_radius: '0.4',
    sc_cyl_len: '',

    el_radius: '0.4',
    el_cyl_len: '',
    el_head_h: '0.2',

    ts_radius: '0.4',
    ts_cyl_len: '',
    ts_crown: '0.7',
    ts_knuckle: '0.08',

    cb_radius: '0.4',
    cb_head_type: 'Spherical',
    cb_fraction: '0.5',
    cb_cyl_len: '',
    cb_head_h: '0.2',
    cb_crown: '0.7',
    cb_knuckle: '0.08',

    cast_SM: 'Composite Tanks',
    cast_shape: 'Ellipsoidal',
    cast_R: isOx ? '0.4' : '0.35',
    cast_crown: isOx ? '0.4' : '0.35',
    cast_L: '',
    cast_manual_vol: isOx ? '1.0' : '0.8',

    pablo_mass: '',
    pablo_uts: '500e6',
    pablo_SF_cyl: '2.0',
    pablo_SF_sph: '2.0',
    pablo_cyl_vol: isOx ? '1.0' : '2.0',
    pablo_sph_vol: isOx ? '0.25' : '0.35',
  };
};

export const propellantDefaults = (defs = {}) => {
  const tc = defs.Tank_Common || {};
  const cast = defs.Tank_Castellini || {};
  return {
    propellant_mass: '10000',
    OF_ratio: '2.5',
    method: tc.method || 'Standard',
    castellini_global: {
      n_ax_max:    String(cast.n_ax_max ?? 7),
      n_ax_max_pl: String(cast.n_ax_max_pl ?? 7),
      max_q:       String(cast.max_q ?? 40000),
      max_g:       String(cast.max_g ?? 7),
      p_cc:        String(cast.p_cc ?? 1e6),
      ssm:         String(cast.ssm ?? 1.5),
      rocket_diam: String(cast.rocket_diameter ?? '1.2'),
      rocket_len:  String(cast.rocket_length ?? '15'),
      feed_type:   cast.feed_type || 'Pressure-fed',
    },
    oxidizer: tankSectionDefaults('Oxidizer', defs),
    fuel:     tankSectionDefaults('Fuel', defs),
  };
};

/* ─── Fairing ────────────────────────────────────────────────────── */

export const fairingDefaults = () => ({
  enabled: false,
  r_cyl: '0.6',
  L_cyl: '5.0',
  r_base: '0.8',
  L_base: '3.0',
  t: '0.005',
  rho_cyl: '1600.0',
  rho_frust: '1600.0',
  rho_nose: '1600.0',
  k_nose: '1.1',
  L_nose: '2.0',
  n_nose: '2.0',
  delta: '0.0',
});

/* ─── PLA ────────────────────────────────────────────────────────── */

export const plaDefaults = () => ({
  enabled: false,
  payload_mass: '0.0',
});

/* ─── Stage / interstages ────────────────────────────────────────── */

export const makeStageDefaults = (defs = {}) => ({
  engine:     engineDefaults(defs),
  tvc:        tvcDefaults(defs),
  thrust:     thrustDefaults(defs),
  propellant: propellantDefaults(defs),
  pressurant: pressurantDefaults(defs),
  fairing:    fairingDefaults(),
  pla:        plaDefaults(),
});

export const interstageSectionDefaults = () => ({
  radius_m: '',
  stage_length_m: '',
  interstage_frac: '',
  area_density: '',
  stage_mass_port: '',
});

export const makeInterstagesDefaults = (n = 1) => ({
  num_stages: n,
  interstages: Object.fromEntries(
    Array.from({ length: Math.max(0, n - 1) }, (_, i) => [
      i + 1,
      interstageSectionDefaults(),
    ])
  ),
});

/* ─── Build the payload the calculator expects ───────────────────── */

export function buildPayload({ numStages, stages, interstages }) {
  // Each stage tab returns the same shape its Python `get_data()` returned —
  // we resolve a few "this dropdown OR custom value" pairs here, mirroring
  // the customtkinter tabs.
  const out = {};

  for (let i = 1; i <= numStages; i++) {
    const s = stages[i] || {};
    out[i] = {
      engine: resolveEngine(s.engine),
      tvc: resolveTvc(s.tvc),
      thrust: resolveThrust(s.thrust),
      propellant: resolvePropellant(s.propellant),
      pressurant: resolvePressurant(s.pressurant),
      fairing: { ...s.fairing },
      pla: { ...s.pla },
    };
  }

  out.interstages = {
    num_stages: numStages,
    interstages: interstages?.interstages || {},
  };

  return { num_stages: numStages, stage_data: out };
}

function resolveEngine(d) {
  if (!d) return {};
  return {
    ...d,
    model_key: ENGINE_MODEL_KEYS[d.model] || d.model,
  };
}

function resolveTvc(d) {
  if (!d) return {};
  return { ...d };
}

function resolveThrust(d) {
  if (!d) return {};
  return {
    ...d,
    method: THRUST_METHOD_KEYS[d.method] || d.method,
  };
}

function resolvePressurant(d) {
  if (!d) return {};
  const r = PRES_GAS_R[d.gas];
  const rho = PRES_MATERIAL_RHO[d.material];
  return {
    ...d,
    R_gas: r != null ? r : d.R_custom,
    rho_mat: rho != null ? rho : d.rho_custom,
  };
}

function resolvePropellant(d) {
  if (!d) return {};
  return {
    ...d,
    oxidizer: resolveTank(d.oxidizer),
    fuel: resolveTank(d.fuel),
  };
}

function resolveTank(t) {
  if (!t) return {};
  const propRho = PROPELLANT_RHO[t.propellant];
  const matRho = TANK_MATERIAL_RHO[t.material];
  return {
    ...t,
    prop_density_resolved: propRho != null ? propRho : t.prop_density_custom,
    mat_density_resolved: matRho != null ? matRho : t.mat_density_custom,
  };
}
