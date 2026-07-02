import React from 'react';
import './Form.css';

/* ──────────────────────────────────────────────────────────────────
   Section header — port of widgets.add_section
   ────────────────────────────────────────────────────────────────── */

export function Section({ title, accent = 'var(--accent)' }) {
  return (
    <div className="Section">
      <span className="Section-mark" style={{ background: accent }} />
      <span className="Section-text">{title.toUpperCase()}</span>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────
   ParamEntry — horizontal: label on the left, input on the right
   with the unit as an inline suffix.
   ────────────────────────────────────────────────────────────────── */

export function ParamEntry({
  label,
  value = '',
  onChange,
  unit = '',
  tip = '',
  placeholder = '',
  type = 'text',
  // Nearly every ParamEntry is a number — 'decimal' brings up the
  // numeric keyboard on touch devices while keeping free-form string
  // state (unlike type="number"). Pass inputMode="text" for the rare
  // genuinely-textual field.
  inputMode = 'decimal',
  error = false,
  disabled = false,
}) {
  return (
    <label className="Param" title={tip || undefined}>
      <span className="Param-label">{label}</span>
      <span className="Param-input-wrap">
        <input
          className={[
            'Param-input',
            unit ? 'Param-input--with-unit' : '',
            error ? 'Param-input--error' : '',
          ].filter(Boolean).join(' ')}
          type={type}
          inputMode={inputMode}
          value={value ?? ''}
          placeholder={placeholder}
          disabled={disabled}
          onChange={(e) => onChange?.(e.target.value)}
          spellCheck={false}
        />
        {unit && <span className="Param-unit">{unit}</span>}
      </span>
    </label>
  );
}

/* ──────────────────────────────────────────────────────────────────
   ParamDropdown — same horizontal grid as ParamEntry
   ────────────────────────────────────────────────────────────────── */

export function ParamDropdown({
  label,
  value,
  onChange,
  options,
  disabled = false,
}) {
  return (
    <label className="Param">
      <span className="Param-label">{label}</span>
      <span className="Param-select-wrap">
        <select
          className="Param-select"
          value={value ?? ''}
          disabled={disabled}
          onChange={(e) => onChange?.(e.target.value)}
        >
          {options.map((opt) => {
            const o = typeof opt === 'string' ? { value: opt, label: opt } : opt;
            return (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            );
          })}
        </select>
        <span className="Param-select-arrow" aria-hidden="true">▾</span>
      </span>
    </label>
  );
}

/* ──────────────────────────────────────────────────────────────────
   ParamCheckbox — full-row, no grid alignment
   ────────────────────────────────────────────────────────────────── */

export function ParamCheckbox({ label, checked = false, onChange, disabled = false }) {
  return (
    <label className={`Check${disabled ? ' Check--disabled' : ''}`}>
      <input
        type="checkbox"
        className="Check-input"
        checked={!!checked}
        disabled={disabled}
        onChange={(e) => onChange?.(e.target.checked)}
      />
      <span className="Check-box" aria-hidden="true" />
      <span className="Check-label">{label}</span>
    </label>
  );
}
