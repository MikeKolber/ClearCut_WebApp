import React, { useEffect, useRef, useState } from 'react';
import './PromptDialog.css';

/**
 * App-styled replacement for `window.prompt` / `window.confirm`.
 *
 * Driven by a single `dialog` state object owned by the caller:
 *
 *   { mode: 'input',   title, label?, initialValue?, submitLabel?,
 *     onSubmit(value) }
 *   { mode: 'confirm', title, message, submitLabel?, onConfirm() }
 *
 * Pass `null` to hide. `onClose` fires on Cancel / Esc / backdrop
 * click — the caller clears its state there.
 *
 * Keyboard: Enter submits, Esc cancels; the input autofocuses with
 * its text selected so typing immediately replaces the suggestion.
 */
function PromptDialog({ dialog, onClose }) {
  const [value, setValue] = useState('');
  const inputRef = useRef(null);

  const isInput = dialog?.mode === 'input';

  useEffect(() => {
    if (!dialog) return;
    if (isInput) {
      setValue(dialog.initialValue || '');
      // Focus after paint so the select() isn't clobbered by mount.
      const id = requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
      return () => cancelAnimationFrame(id);
    }
    return undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dialog]);

  useEffect(() => {
    if (!dialog) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose?.();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [dialog, onClose]);

  if (!dialog) return null;

  const submit = () => {
    if (isInput) {
      const trimmed = value.trim();
      if (!trimmed) return;
      dialog.onSubmit?.(trimmed);
    } else {
      dialog.onConfirm?.();
    }
  };

  return (
    <div
      className="PD-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose?.();
      }}
    >
      <div
        className="PD-card"
        role="dialog"
        aria-modal="true"
        aria-label={dialog.title}
      >
        <header className="PD-head">
          <span className="PD-title eyebrow">{dialog.title}</span>
        </header>

        {isInput ? (
          <form
            className="PD-body"
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            {dialog.label && (
              <label className="PD-label mono" htmlFor="PD-input">
                {dialog.label}
              </label>
            )}
            <input
              id="PD-input"
              ref={inputRef}
              className="PD-input mono"
              type="text"
              value={value}
              spellCheck={false}
              autoComplete="off"
              onChange={(e) => setValue(e.target.value)}
            />
          </form>
        ) : (
          <div className="PD-body">
            <p className="PD-message">{dialog.message}</p>
          </div>
        )}

        <footer className="PD-actions">
          <button type="button" className="PD-btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="PD-btn PD-btn--primary"
            onClick={submit}
            disabled={isInput && !value.trim()}
          >
            {dialog.submitLabel || (isInput ? 'Save' : 'Confirm')}
          </button>
        </footer>
      </div>
    </div>
  );
}

export default PromptDialog;
