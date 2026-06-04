/**
 * Mirror of `gui/config.py` parameter definitions for the trajectory page.
 *
 * Field shape matches the desktop:
 *   { label, unit, type, tip?, default? }
 *
 * The web frontend doesn't run the physics — it just shapes the form and
 * the JSON payload that gets sent to `_current.json` via the backend.
 * Keeping field keys + types identical to the Python config means the
 * existing `src/simulation.py` and the existing presets keep working
 * untouched.
 */

export const TRAJECTORY_PARAMS = {
  Simulation: {
    simulation_time: {
      label: 'Simulation Time', unit: 's', type: 'float',
      tip: 'Total duration of the simulation run',
    },
  },
  'Launch Parameters': {
    lat_launch: {
      label: 'Launch Latitude', unit: 'deg', type: 'float',
      tip: 'WGS-84 latitude; must be ≤ desired inclination',
    },
    lon_launch: {
      label: 'Launch Longitude', unit: 'deg', type: 'float',
      tip: 'WGS-84 longitude of the launch site',
    },
    height_launch: {
      label: 'Launch Height', unit: 'm', type: 'float',
      tip: 'Altitude above the WGS-84 ellipsoid',
    },
    initial_launch_azimuth_with_rotation: {
      label: 'Launch Azimuth', unit: 'deg', type: 'float',
      tip: 'Recalculated from inclination & latitude at runtime',
    },
    initial_role: {
      label: 'Initial Roll', unit: 'deg', type: 'float',
      tip: 'Roll angle at launch (usually 0)',
    },
  },
  'Initial Conditions': {
    initial_speed: {
      label: 'Initial Speed', unit: 'm/s', type: 'float',
      tip: 'Velocity magnitude along body x-axis at t = 0',
    },
    initial_path_angle: {
      label: 'Initial Path Angle', unit: 'deg', type: 'float',
      tip: 'Flight path angle (gamma) at launch',
    },
  },
  'Orbit Parameters': {
    desired_inclination: {
      label: 'Desired Inclination', unit: 'deg', type: 'float',
      tip: 'Target orbital inclination; must be ≥ launch latitude',
    },
    desired_orbit_height: {
      label: 'Desired Orbit Height', unit: 'km', type: 'float',
      tip: 'Target altitude above Earth surface',
    },
  },
  'Timing Parameters': {
    free_fall_timing: {
      label: 'Free Fall Time', unit: 's', type: 'float',
      tip: 'Free-fall duration before Stage 1 ignition',
    },
    pull_up_time: {
      label: 'Pull-Up Time', unit: 's', type: 'float',
      tip: 'Pitch-up maneuver during S1 (+15° if M ≤ 3, +10° if M > 3)',
    },
    pitch_command_delay_time: {
      label: 'Pitch Cmd Delay', unit: 's', type: 'float',
      tip: 'Delay constant for pitch command response',
    },
    coasting_s1_s2: {
      label: 'Coast S1 → S2', unit: 's', type: 'float',
      tip: 'Coast between Stage 1 burnout and Stage 2 ignition',
    },
    stage_2_timing: {
      label: 'Stage 2 Burn Time', unit: 's', type: 'float',
      tip: 'Stage 2 powered-flight duration',
    },
    coasting_s2_s3: {
      label: 'Coast S2 → S3', unit: 's', type: 'float',
      tip: 'Coast between Stage 2 burnout and Stage 3 ignition',
    },
    stage_3_timing_total_burn: {
      label: 'S3 Total Burn', unit: 's', type: 'float',
      tip: 'Total Stage 3 burn time (burn 1 + burn 2)',
    },
    stage_3_timing_burn_1: {
      label: 'S3 Burn 1', unit: 's', type: 'float',
      tip: 'Duration of the first Stage 3 burn segment',
    },
    stage_3_timing_coast: {
      label: 'S3 Coast', unit: 's', type: 'float',
      tip: 'Coast between Stage 3 burn 1 and burn 2',
    },
  },
  'Payload & Fairing': {
    no_of_stages: {
      label: 'Number of Stages', unit: '', type: 'int',
      tip: 'Total number of rocket stages (1–4)',
    },
    final_payload_mass: {
      label: 'Payload Mass', unit: 'kg', type: 'float',
      tip: 'Mass delivered to orbit',
    },
    fairing_mass: {
      label: 'Fairing Mass', unit: 'kg', type: 'float',
      tip: 'Jettisoned above 120 km altitude',
    },
    rocket_diameter_cd: {
      label: 'Diameter (Cd ref)', unit: 'm', type: 'float',
      tip: 'Reference diameter for drag (S_ref = πd²/4)',
    },
    rocket_diameter_cl: {
      label: 'Diameter (Cl ref)', unit: 'm', type: 'float',
      tip: 'Reference diameter for lift coefficient',
    },
  },
};

export const STAGE_PARAMS_PER_STAGE = {
  propellant_mass: {
    label: 'Propellant Mass', unit: 'kg', type: 'float',
    tip: 'Total propellant loaded in this stage',
  },
  structural_coefficient: {
    label: 'Structural Coeff.', unit: '', type: 'float',
    tip: 'ε; struct = prop / (1/ε − 1). Typical: 0.05–0.15',
  },
  number_of_engines: {
    label: 'Number of Engines', unit: '', type: 'int',
  },
  stage_burn_time: {
    label: 'Burn Time', unit: 's', type: 'float',
    tip: 'Powered-flight duration for this stage',
  },
  fuel_type: {
    label: 'Fuel Type', unit: '', type: 'str',
    tip: 'CEA fuel identifier (e.g. Jet-A(L), RP-1, CH4(L))',
  },
  oxidizer_type: {
    label: 'Oxidizer Type', unit: '', type: 'str',
    tip: 'CEA oxidizer identifier (e.g. HTP90, LOX)',
  },
  desired_operating_pressure: {
    label: 'Chamber Pressure', unit: 'bar', type: 'float',
    tip: 'Combustion chamber pressure',
  },
  area_ratio: {
    label: 'Area Ratio (Ae/At)', unit: '', type: 'float',
    tip: 'Nozzle expansion ratio: exit area / throat area',
  },
  efficiency: {
    label: 'Efficiency', unit: '', type: 'float',
    tip: 'Overall engine efficiency factor (0–1)',
  },
  unburned_propellant_fraction: {
    label: 'Unburned Frac.', unit: '', type: 'float',
    tip: 'Fraction of propellant remaining at burnout (e.g. 0.01 = 1%)',
  },
};

/**
 * ─── Structure tab ─────────────────────────────────────────────────
 *
 * Geometric and structural parameters that drive the Center-of-Mass /
 * Moment-of-Inertia subsystem (`StaticMomentOfInertia` in the Python
 * engine). These used to live in `rocket_structure.yaml`; migrating
 * them into the form gives the user a single source of truth for
 * every quantity the simulation reads.
 *
 * Five fields appear here as *locked mirrors* of fields the user
 * already edits in the Simulation tab (per-stage `propellant_mass`,
 * per-stage `number_of_engines`, `final_payload_mass`, `fairing_mass`).
 * Those mirrors render as disabled inputs that pull the live value
 * from the Simulation state — the rendering layer in `Trajectory.js`
 * picks them up by key from `LOCKED_MIRRORS` below.
 *
 * Every field has a `default` matching the YAML's original values so
 * the form is usable out-of-the-box. Missing fields fall back to the
 * same defaults on the Python side (`STRUCTURE_DEFAULTS` in
 * `static_moment_of_inertia_class.py`), so old presets without a
 * `structure` block still load cleanly.
 */
export const STRUCTURE_PARAMS = {
  'Stage 1 Structure': {
    Stage1_propellant_order: {
      label: 'Propellant Order', unit: '', type: 'enum',
      options: ['fuel_first', 'ox_first'], default: 'fuel_first',
      tip: 'Which propellant sits at the bottom of the tank stack',
    },
    Stage1_of_ratio: {
      label: 'O/F Ratio', unit: '', type: 'float', default: 7,
      tip: 'Oxidiser-to-fuel mass ratio (used to split propellant_mass into fuel/ox masses)',
    },
    Stage1_fuel_density: {
      label: 'Fuel Density', unit: 'kg/m³', type: 'float', default: 800,
    },
    Stage1_ox_density: {
      label: 'Ox Density', unit: 'kg/m³', type: 'float', default: 1400,
    },
    Stage1_stage_max_diameter_m: {
      label: 'Stage Diameter', unit: 'm', type: 'float', default: 1.2,
    },
    Stage1_tank_head_length_m: {
      label: 'Tank Head Length', unit: 'm', type: 'float', default: 0.6,
    },
    Stage1_engine_mass_kg: {
      label: 'Engine Mass (each)', unit: 'kg', type: 'float', default: 135,
    },
    Stage1_engine_length_m: {
      label: 'Engine Length', unit: 'm', type: 'float', default: 0.8,
    },
  },
  'Stage 2 Structure': {
    Stage2_propellant_order: {
      label: 'Propellant Order', unit: '', type: 'enum',
      options: ['fuel_first', 'ox_first'], default: 'fuel_first',
    },
    Stage2_of_ratio: {
      label: 'O/F Ratio', unit: '', type: 'float', default: 7,
    },
    Stage2_fuel_density: {
      label: 'Fuel Density', unit: 'kg/m³', type: 'float', default: 800,
    },
    Stage2_ox_density: {
      label: 'Ox Density', unit: 'kg/m³', type: 'float', default: 1400,
    },
    Stage2_stage_max_diameter_m: {
      label: 'Stage Diameter', unit: 'm', type: 'float', default: 1.2,
    },
    Stage2_tank_head_length_m: {
      label: 'Tank Head Length', unit: 'm', type: 'float', default: 0.6,
    },
    Stage2_engine_mass_kg: {
      label: 'Engine Mass (each)', unit: 'kg', type: 'float', default: 135,
    },
    Stage2_engine_length_m: {
      label: 'Engine Length', unit: 'm', type: 'float', default: 0.8,
    },
  },
  'Stage 3 Structure': {
    Stage3_propellant_order: {
      label: 'Propellant Order', unit: '', type: 'enum',
      options: ['fuel_first', 'ox_first'], default: 'fuel_first',
    },
    Stage3_of_ratio: {
      label: 'O/F Ratio', unit: '', type: 'float', default: 6.9,
    },
    Stage3_fuel_density: {
      label: 'Fuel Density', unit: 'kg/m³', type: 'float', default: 800,
    },
    Stage3_ox_density: {
      label: 'Ox Density', unit: 'kg/m³', type: 'float', default: 1400,
    },
    Stage3_stage_max_diameter_m: {
      label: 'Stage Diameter', unit: 'm', type: 'float', default: 1.2,
    },
    Stage3_tank_head_length_m: {
      label: 'Tank Head Length', unit: 'm', type: 'float', default: 0.6,
    },
    Stage3_engine_mass_kg: {
      label: 'Engine Mass (each)', unit: 'kg', type: 'float', default: 60,
    },
    Stage3_engine_length_m: {
      label: 'Engine Length', unit: 'm', type: 'float', default: 0.8,
    },
  },
  'Engines (Global)': {
    engine_inner_radius_m: {
      label: 'Engine Inner Radius', unit: 'm', type: 'float', default: 0.18,
      tip: 'Inner radius of the hollow-cylinder engine model',
    },
    engine_outer_radius_m: {
      label: 'Engine Outer Radius', unit: 'm', type: 'float', default: 0.2,
      tip: 'Must be greater than the inner radius',
    },
    default_engine_length_m: {
      label: 'Fallback Engine Length', unit: 'm', type: 'float', default: 0.5,
      tip: 'Used when a per-stage engine length is missing or invalid',
    },
  },
  'Tanks (Global)': {
    fuel_tank_mass_ratio: {
      label: 'Fuel Tank Mass Ratio', unit: '', type: 'float', default: 0.12,
      tip: 'Tank mass = fuel mass × this ratio',
    },
    oxidizer_tank_mass_ratio: {
      label: 'Ox Tank Mass Ratio', unit: '', type: 'float', default: 0.12,
    },
    fuel_tank_head_mass: {
      label: 'Tank Head Mass', unit: 'kg', type: 'float', default: 30,
      tip: 'Mass of each end-cap on the propellant tanks',
    },
    tank_thickness_m: {
      label: 'Tank Wall Thickness', unit: 'm', type: 'float', default: 0.01,
    },
  },
  'Interstages': {
    stage12_interstage_mass_kg: {
      label: 'S1-S2 Mass', unit: 'kg', type: 'float', default: 25,
    },
    stage12_interstage_length_m: {
      label: 'S1-S2 Length', unit: 'm', type: 'float', default: 0.6,
    },
    stage23_interstage_mass_kg: {
      label: 'S2-S3 Mass', unit: 'kg', type: 'float', default: 25,
    },
    stage23_interstage_length_m: {
      label: 'S2-S3 Length', unit: 'm', type: 'float', default: 0.6,
    },
  },
  'Fairing Geometry': {
    fairing_radius_m: {
      label: 'Fairing Radius', unit: 'm', type: 'float', default: 0.75,
    },
    fairing_length_m: {
      label: 'Fairing Length', unit: 'm', type: 'float', default: 5,
    },
  },
  'Payload Geometry': {
    payload_radius_m: {
      label: 'Payload Radius', unit: 'm', type: 'float', default: 0.6,
    },
    payload_length_m: {
      label: 'Payload Length', unit: 'm', type: 'float', default: 1,
    },
  },
};

/**
 * Locked-mirror metadata for the Structure tab. Each entry maps a
 * Structure-tab section name to a list of fields that should render
 * as disabled inputs reading from the Simulation tab's state. The
 * Structure tab's renderer puts these at the top of the matching
 * section with a small "set in Simulation tab" caption + arrow link.
 *
 *   `from`: dot-path into `params` (e.g. 'Stage1.propellant_mass')
 *   `label`: what to show as the field label
 *   `unit`: optional unit suffix
 */
export const LOCKED_MIRRORS = {
  'Stage 1 Structure': [
    { from: 'Stage1.propellant_mass',    label: 'Propellant Mass',    unit: 'kg' },
    { from: 'Stage1.number_of_engines',  label: 'Number of Engines',  unit: ''   },
  ],
  'Stage 2 Structure': [
    { from: 'Stage2.propellant_mass',    label: 'Propellant Mass',    unit: 'kg' },
    { from: 'Stage2.number_of_engines',  label: 'Number of Engines',  unit: ''   },
  ],
  'Stage 3 Structure': [
    { from: 'Stage3.propellant_mass',    label: 'Propellant Mass',    unit: 'kg' },
    { from: 'Stage3.number_of_engines',  label: 'Number of Engines',  unit: ''   },
  ],
  'Fairing Geometry': [
    { from: 'fairing_mass',              label: 'Fairing Mass',       unit: 'kg' },
  ],
  'Payload Geometry': [
    { from: 'final_payload_mass',        label: 'Payload Mass',       unit: 'kg' },
  ],
};

export const DEBRIS_PARAMS = {
  General: {
    failure_interval_s: {
      label: 'Failure Point Interval', unit: 's', type: 'float', default: 50.0,
      tip: 'Time spacing between simulated failure points',
    },
    number_of_debris: {
      label: 'Debris per Point', unit: '', type: 'int', default: 10,
      tip: 'Number of debris fragments per failure point',
    },
    epoch_tt: {
      label: 'Epoch (TT ISO)', unit: '', type: 'str',
      default: '2025-01-01T12:00:00.000',
      tip: 'Reference epoch in Terrestrial Time (ISO 8601)',
    },
  },
  'Explosion Model': {
    dv_alpha: {
      label: 'Alpha', unit: '', type: 'float', default: 1.6,
      tip: 'Explosion energy scaling exponent for ΔV distribution',
    },
    dv_min: {
      label: 'Min Delta-V', unit: 'm/s', type: 'float', default: 1.0,
      tip: 'Minimum ΔV imparted to debris fragments',
    },
    dv_max: {
      label: 'Max Delta-V', unit: 'm/s', type: 'float', default: 4000.0,
      tip: 'Maximum ΔV imparted to debris fragments',
    },
    dv_sigma: {
      label: 'Log10 DV Sigma', unit: '', type: 'float', default: 0.4,
      tip: 'Standard deviation of the log10(ΔV) distribution',
    },
  },
  'Mass Distribution': {
    min_mass_kg: {
      label: 'Min Mass', unit: 'kg', type: 'float', default: 0.001,
      tip: 'Smallest debris fragment mass to simulate',
    },
    mass_sigma: {
      label: 'Log-Normal Sigma', unit: '', type: 'float', default: 1.0,
      tip: 'Width of the log-normal debris mass distribution',
    },
  },
  'Physics & Integration': {
    atmosphere_cutoff: {
      label: 'Atmosphere Cutoff', unit: 'm', type: 'float', default: 100000.0,
      tip: 'Altitude above which atmospheric drag is ignored',
    },
    dt: {
      label: 'Integration Step', unit: 's', type: 'float', default: 0.1,
      tip: 'RK4 time step for debris propagation',
    },
    t_max: {
      label: 'Max Sim Time', unit: 's', type: 'float', default: 20000.0,
      tip: 'Maximum propagation time per fragment',
    },
  },
};

/**
 * Bundled presets — mirrors the JSON files in
 * `physics_engines/core/Trajectory Simulation/json_files/presets/`. Used in the
 * scaffold so the picker actually loads values into the form. In stage 2
 * this gets swapped for `GET /api/trajectory/presets/<name>`.
 */
export const PRESETS = {
  '140-500': {
    name: '140-500',
    simulation_time: 300,
    lat_launch: 35,
    lon_launch: -10,
    height_launch: 9500,
    initial_launch_azimuth_with_rotation: -70.6,
    initial_role: 0,
    initial_speed: 210,
    initial_path_angle: 15,
    desired_inclination: 140,
    desired_orbit_height: 500,
    free_fall_timing: 5,
    pull_up_time: 34,
    pitch_command_delay_time: 0,
    coasting_s1_s2: 3,
    stage_2_timing: 65,
    coasting_s2_s3: 40,
    stage_3_timing_total_burn: 200,
    stage_3_timing_burn_1: 195.3,
    stage_3_timing_coast: 3015,
    no_of_stages: 3,
    final_payload_mass: 300,
    fairing_mass: 150,
    rocket_diameter_cd: 1.5,
    rocket_diameter_cl: 1.2,
    Stage1: {
      propellant_mass: 8100, structural_coefficient: 0.15, number_of_engines: 9,
      stage_burn_time: 70, fuel_type: 'Jet-A(L)', oxidizer_type: 'HTP90',
      desired_operating_pressure: 80, area_ratio: 20, efficiency: 0.97,
      unburned_propellant_fraction: 0.01,
    },
    Stage2: {
      propellant_mass: 3315, structural_coefficient: 0.14, number_of_engines: 3,
      stage_burn_time: 65, fuel_type: 'Jet-A(L)', oxidizer_type: 'HTP90',
      desired_operating_pressure: 80, area_ratio: 40, efficiency: 0.97,
      unburned_propellant_fraction: 0.01,
    },
    Stage3: {
      propellant_mass: 1135, structural_coefficient: 0.1, number_of_engines: 1,
      stage_burn_time: 200, fuel_type: 'Jet-A(L)', oxidizer_type: 'HTP90',
      desired_operating_pressure: 50, area_ratio: 60, efficiency: 0.97,
      unburned_propellant_fraction: 0.0117,
    },
  },
  '105-700': {
    name: '105-700',
    simulation_time: 300,
    lat_launch: 35,
    lon_launch: -10,
    height_launch: 9500,
    initial_launch_azimuth_with_rotation: -21.5,
    initial_role: 0,
    initial_speed: 210,
    initial_path_angle: 15,
    desired_inclination: 105,
    desired_orbit_height: 700,
    free_fall_timing: 5,
    pull_up_time: 33.3,
    pitch_command_delay_time: 0,
    coasting_s1_s2: 3,
    stage_2_timing: 65,
    coasting_s2_s3: 40,
    stage_3_timing_total_burn: 200,
    stage_3_timing_burn_1: 194.1,
    stage_3_timing_coast: 2915,
    no_of_stages: 3,
    final_payload_mass: 325,
    fairing_mass: 150,
    rocket_diameter_cd: 1.5,
    rocket_diameter_cl: 1.2,
    Stage1: {
      propellant_mass: 8100, structural_coefficient: 0.15, number_of_engines: 9,
      stage_burn_time: 70, fuel_type: 'Jet-A(L)', oxidizer_type: 'HTP90',
      desired_operating_pressure: 80, area_ratio: 20, efficiency: 0.97,
      unburned_propellant_fraction: 0.01,
    },
    Stage2: {
      propellant_mass: 3315, structural_coefficient: 0.14, number_of_engines: 3,
      stage_burn_time: 65, fuel_type: 'Jet-A(L)', oxidizer_type: 'HTP90',
      desired_operating_pressure: 80, area_ratio: 40, efficiency: 0.97,
      unburned_propellant_fraction: 0.01,
    },
    Stage3: {
      propellant_mass: 1135, structural_coefficient: 0.1, number_of_engines: 1,
      stage_burn_time: 200, fuel_type: 'Jet-A(L)', oxidizer_type: 'HTP90',
      desired_operating_pressure: 50, area_ratio: 60, efficiency: 0.97,
      unburned_propellant_fraction: 0.01,
    },
  },
  '140-700': {
    name: '140-700',
    simulation_time: 300,
    lat_launch: 35,
    lon_launch: -10,
    height_launch: 9500,
    initial_launch_azimuth_with_rotation: -70.6,
    initial_role: 0,
    initial_speed: 210,
    initial_path_angle: 15,
    desired_inclination: 140,
    desired_orbit_height: 700,
    free_fall_timing: 5,
    pull_up_time: 33.7,
    pitch_command_delay_time: 0,
    coasting_s1_s2: 3,
    stage_2_timing: 65,
    coasting_s2_s3: 40,
    stage_3_timing_total_burn: 200,
    stage_3_timing_burn_1: 194.2,
    stage_3_timing_coast: 2980,
    no_of_stages: 3,
    final_payload_mass: 285,
    fairing_mass: 150,
    rocket_diameter_cd: 1.5,
    rocket_diameter_cl: 1.2,
    Stage1: {
      propellant_mass: 8100, structural_coefficient: 0.15, number_of_engines: 9,
      stage_burn_time: 70, fuel_type: 'Jet-A(L)', oxidizer_type: 'HTP90',
      desired_operating_pressure: 80, area_ratio: 20, efficiency: 0.97,
      unburned_propellant_fraction: 0.01,
    },
    Stage2: {
      propellant_mass: 3315, structural_coefficient: 0.14, number_of_engines: 3,
      stage_burn_time: 65, fuel_type: 'Jet-A(L)', oxidizer_type: 'HTP90',
      desired_operating_pressure: 80, area_ratio: 40, efficiency: 0.97,
      unburned_propellant_fraction: 0.01,
    },
    Stage3: {
      propellant_mass: 1135, structural_coefficient: 0.1, number_of_engines: 1,
      stage_burn_time: 200, fuel_type: 'Jet-A(L)', oxidizer_type: 'HTP90',
      desired_operating_pressure: 50, area_ratio: 60, efficiency: 0.97,
      unburned_propellant_fraction: 0.011,
    },
  },
  'negev-140-500': {
    name: 'negev-140-500',
    simulation_time: 3000,
    lat_launch: 30.5,
    lon_launch: 34.8,
    height_launch: 9500,
    initial_launch_azimuth_with_rotation: -70.6,
    initial_role: 0,
    initial_speed: 210,
    initial_path_angle: 15,
    desired_inclination: 140,
    desired_orbit_height: 500,
    free_fall_timing: 5,
    pull_up_time: 34,
    pitch_command_delay_time: 0,
    coasting_s1_s2: 3,
    stage_2_timing: 65,
    coasting_s2_s3: 40,
    stage_3_timing_total_burn: 200,
    stage_3_timing_burn_1: 195.3,
    stage_3_timing_coast: 3015,
    no_of_stages: 3,
    final_payload_mass: 300,
    fairing_mass: 150,
    rocket_diameter_cd: 1.5,
    rocket_diameter_cl: 1.2,
    Stage1: {
      propellant_mass: 8100, structural_coefficient: 0.15, number_of_engines: 9,
      stage_burn_time: 70, fuel_type: 'Jet-A(L)', oxidizer_type: 'HTP90',
      desired_operating_pressure: 80, area_ratio: 20, efficiency: 0.97,
      unburned_propellant_fraction: 0.01,
    },
    Stage2: {
      propellant_mass: 3315, structural_coefficient: 0.14, number_of_engines: 3,
      stage_burn_time: 65, fuel_type: 'Jet-A(L)', oxidizer_type: 'HTP90',
      desired_operating_pressure: 80, area_ratio: 40, efficiency: 0.97,
      unburned_propellant_fraction: 0.01,
    },
    Stage3: {
      propellant_mass: 1135, structural_coefficient: 0.1, number_of_engines: 1,
      stage_burn_time: 200, fuel_type: 'Jet-A(L)', oxidizer_type: 'HTP90',
      desired_operating_pressure: 50, area_ratio: 60, efficiency: 0.97,
      unburned_propellant_fraction: 0.0117,
    },
  },
};

/** 140-500 preset is the initial form state so the page has real numbers
 *  to display before the user picks a preset of their own. */
export const DEFAULT_PRESET = PRESETS['140-500'];

export const STAGE_ACCENTS = {
  1: { color: 'var(--accent)',         soft: 'rgba(77, 168, 218, 0.10)' },
  2: { color: 'var(--warning)',        soft: 'rgba(245, 158, 11, 0.10)' },
  3: { color: '#ef4444',               soft: 'rgba(239, 68, 68, 0.10)'  },
};
