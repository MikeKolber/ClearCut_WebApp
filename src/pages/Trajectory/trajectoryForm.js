/**
 * Pure form logic for the Trajectory page — empty-state builders and
 * the validate/collect passes that turn form state into the JSON the
 * simulator consumes. No React in here: everything is a pure function
 * of (schema, values), which keeps it unit-testable and lets the page
 * component focus on orchestration.
 */

import {
  TRAJECTORY_PARAMS,
  STAGE_PARAMS_PER_STAGE,
  STRUCTURE_PARAMS,
  DEBRIS_PARAMS,
} from './params';

/* Build an empty parameter dict from a schema — every field is set to
   '' so the inputs render blank on first paint. Presets fill the form
   in one click; manual entry is fully explicit. */
export function collectEmpty(schema) {
  const out = {};
  for (const fields of Object.values(schema)) {
    for (const key of Object.keys(fields)) {
      out[key] = '';
    }
  }
  return out;
}

/* Default values for the Structure tab — pulled from each field's
   `default` in STRUCTURE_PARAMS. Starting point for both
   `emptyTrajectoryParams()` and the "Reset to defaults" button. */
export function defaultStructureParams() {
  const out = {};
  for (const fields of Object.values(STRUCTURE_PARAMS)) {
    for (const [key, meta] of Object.entries(fields)) {
      out[key] = meta.default ?? '';
    }
  }
  return out;
}

/* Empty state for the whole trajectory form: flat trajectory fields
   PLUS Stage1..3 sub-objects PLUS a `structure` sub-object. Structure
   fields start at their defaults (the YAML used to provide them for
   free — nobody should type 30 numbers to run a default rocket). */
export function emptyTrajectoryParams() {
  return {
    ...collectEmpty(TRAJECTORY_PARAMS),
    Stage1: collectEmpty(STAGE_PARAMS_PER_STAGE),
    Stage2: collectEmpty(STAGE_PARAMS_PER_STAGE),
    Stage3: collectEmpty(STAGE_PARAMS_PER_STAGE),
    structure: defaultStructureParams(),
  };
}

/**
 * "Has the user actually entered anything in the trajectory form?"
 * True iff every flat field is empty AND every stage's nested fields
 * are empty. Drives the first-time "pick a preset" hint.
 */
export function isParamsEmpty(params) {
  if (!params) return true;
  for (const fields of Object.values(TRAJECTORY_PARAMS)) {
    for (const key of Object.keys(fields)) {
      const v = params[key];
      if (v !== '' && v !== null && v !== undefined) return false;
    }
  }
  for (const stageKey of ['Stage1', 'Stage2', 'Stage3']) {
    const stage = params[stageKey] || {};
    for (const key of Object.keys(STAGE_PARAMS_PER_STAGE)) {
      const v = stage[key];
      if (v !== '' && v !== null && v !== undefined) return false;
    }
  }
  return true;
}

/**
 * Walk the trajectory + stage schemas, coerce each value to the right type,
 * and assemble the JSON the simulator wants. Mirrors the desktop's
 * `_validate_and_collect()` + `_write_current_config()` flow:
 *   - Required fields with empty / non-numeric values become validation errors.
 *   - Optional fields (meta.optional) left empty are sent as explicit null so
 *     the simulator applies its documented fallback (e.g. launch azimuth
 *     auto-computes from the target orbit).
 *   - Numbers get parsed (`int` / `float`); strings pass through.
 *   - The fairing-release-conditions block the desktop tacks on at runtime is
 *     added here so simulation.py can read it from `_current.json`.
 */
export function validateAndCollect(params) {
  const errors = [];
  const config = {};

  const coerce = (raw, type) => {
    if (raw === null || raw === undefined || raw === '') return null;
    if (type === 'int') {
      const v = parseInt(raw, 10);
      return Number.isFinite(v) ? v : NaN;
    }
    if (type === 'float') {
      const v = typeof raw === 'number' ? raw : parseFloat(raw);
      return Number.isFinite(v) ? v : NaN;
    }
    return String(raw);
  };

  // Trajectory params
  for (const [section, fields] of Object.entries(TRAJECTORY_PARAMS)) {
    for (const [key, meta] of Object.entries(fields)) {
      const raw = params[key];
      const value = coerce(raw, meta.type);
      if (value === null) {
        if (meta.optional) {
          config[key] = null;
          continue;
        }
        errors.push(`${section} > ${meta.label} is empty`);
        continue;
      }
      if (typeof value === 'number' && !Number.isFinite(value)) {
        errors.push(`${section} > ${meta.label}: invalid number "${raw}"`);
        continue;
      }
      config[key] = value;
    }
  }

  // Stage params (Stage1, Stage2, Stage3 — always all three, simulator uses
  // no_of_stages to know which ones to actually fire).
  for (const stageKey of ['Stage1', 'Stage2', 'Stage3']) {
    const stage = params[stageKey] || {};
    config[stageKey] = {};
    for (const [key, meta] of Object.entries(STAGE_PARAMS_PER_STAGE)) {
      const raw = stage[key];
      const value = coerce(raw, meta.type);
      if (value === null) {
        errors.push(`${stageKey} > ${meta.label} is empty`);
        continue;
      }
      if (typeof value === 'number' && !Number.isFinite(value)) {
        errors.push(`${stageKey} > ${meta.label}: invalid number "${raw}"`);
        continue;
      }
      config[stageKey][key] = value;
    }
  }

  // Structure params (CoM / MoI inputs that used to live in
  // rocket_structure.yaml). Empty fields silently fall back to the
  // Python side's STRUCTURE_DEFAULTS — they're decorative defaults,
  // not hard requirements — so empty isn't an error. Invalid numbers
  // (NaN) ARE flagged.
  const structure = params.structure || {};
  const structureOut = {};
  for (const [section, fields] of Object.entries(STRUCTURE_PARAMS)) {
    for (const [key, meta] of Object.entries(fields)) {
      const raw = structure[key];
      if (raw === '' || raw === null || raw === undefined) continue;
      if (meta.type === 'enum') {
        if (Array.isArray(meta.options) && !meta.options.includes(raw)) {
          errors.push(`${section} > ${meta.label}: "${raw}" not in ${meta.options.join('/')}`);
          continue;
        }
        structureOut[key] = String(raw);
        continue;
      }
      const value = coerce(raw, meta.type);
      if (typeof value === 'number' && !Number.isFinite(value)) {
        errors.push(`${section} > ${meta.label}: invalid number "${raw}"`);
        continue;
      }
      structureOut[key] = value;
    }
  }

  // Sanity bounds — the Python side trusts the JSON, so we catch
  // physically nonsensical values here before they cause divide-by-
  // zero or negative geometry downstream.
  const num = (k) => {
    const v = structureOut[k];
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  };
  const eir = num('engine_inner_radius_m');
  const eor = num('engine_outer_radius_m');
  if (eir !== null && eor !== null && eor <= eir) {
    errors.push(
      `Engines (Global) > Engine Outer Radius must be greater than Inner Radius `
      + `(${eor} ≤ ${eir})`
    );
  }
  const tt = num('tank_thickness_m');
  if (tt !== null && tt <= 0) {
    errors.push(`Tanks (Global) > Tank Wall Thickness must be > 0`);
  }
  for (const N of [1, 2, 3]) {
    const of = num(`Stage${N}_of_ratio`);
    if (of !== null && of <= 0) {
      errors.push(`Stage ${N} Structure > O/F Ratio must be > 0`);
    }
    const fd = num(`Stage${N}_fuel_density`);
    const od = num(`Stage${N}_ox_density`);
    if (fd !== null && fd <= 0) errors.push(`Stage ${N} Structure > Fuel Density must be > 0`);
    if (od !== null && od <= 0) errors.push(`Stage ${N} Structure > Ox Density must be > 0`);
  }

  // Pivot the flat `Stage{N}_xxx` keys into per-stage sub-objects
  // matching what `_reshape_json_config` on the Python side expects.
  // Globals stay flat at the top of the structure block.
  const structureBlock = {};
  for (const [k, v] of Object.entries(structureOut)) {
    const m = k.match(/^Stage(\d)_(.+)$/);
    if (m) {
      const [, n, field] = m;
      const key = `Stage${n}`;
      if (!structureBlock[key]) structureBlock[key] = {};
      structureBlock[key][field] = v;
    } else {
      structureBlock[k] = v;
    }
  }
  if (Object.keys(structureBlock).length > 0) {
    config.structure = structureBlock;
  }

  // Magic block the desktop GUI also adds before writing _current.json.
  config.fairing_release_conditions = { min_altitude: 120000 };

  return { errors, config };
}

/**
 * Walk DEBRIS_PARAMS and check that every required field has a finite
 * value. Mirrors validateAndCollect for the trajectory form. Skips
 * `failure_interval_s` when the user picked Custom mode (they're
 * providing explicit time points instead) and requires at least one
 * valid custom point in that mode.
 */
export function validateDebrisParams(params, mode, customPoints) {
  const errors = [];
  const config = {};

  for (const [section, fields] of Object.entries(DEBRIS_PARAMS)) {
    for (const [key, meta] of Object.entries(fields)) {
      // In Custom mode the interval is unused — don't require it.
      if (key === 'failure_interval_s' && mode === 'custom') continue;

      const raw = params[key];
      if (raw === '' || raw === null || raw === undefined) {
        errors.push(`${section} > ${meta.label} is empty`);
        continue;
      }

      if (meta.type === 'float' || meta.type === 'int') {
        const v = meta.type === 'int' ? parseInt(raw, 10) : parseFloat(raw);
        if (!Number.isFinite(v)) {
          errors.push(`${section} > ${meta.label}: invalid number "${raw}"`);
          continue;
        }
        config[key] = v;
      } else {
        config[key] = String(raw);
      }
    }
  }

  if (mode === 'custom') {
    const valid = customPoints
      .map((p) => parseFloat(p))
      .filter((v) => Number.isFinite(v));
    if (valid.length === 0) {
      errors.push('Failure Points: provide at least one valid time');
    }
  }

  return { errors, config };
}
