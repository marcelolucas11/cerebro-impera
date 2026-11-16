import type { FieldValue } from '@cerebro/shared';
import { useId, type ReactNode } from 'react';
import type { CustomField } from '../api.js';
import { linkOf, optionsOf, showValue, type FieldDraft } from '../fieldvalues.js';
import { Field } from '../ui/kit.js';

const INPUT: Partial<
  Record<
    CustomField['kind'],
    { type: string; inputMode?: 'decimal' | 'tel' | 'email' | 'url'; maxLength?: number }
  >
> = {
  text: { type: 'text', maxLength: 500 },
  number: { type: 'text', inputMode: 'decimal', maxLength: 30 },
  money: { type: 'text', inputMode: 'decimal', maxLength: 30 },
  date: { type: 'date' },
  datetime: { type: 'datetime-local' },
  url: { type: 'url', inputMode: 'url', maxLength: 2000 },
  email: { type: 'email', inputMode: 'email', maxLength: 320 },
  phone: { type: 'tel', inputMode: 'tel', maxLength: 40 },
};

/** The right control for one custom field, whatever its kind. */
export function FieldInput({
  field,
  draft,
  previous,
  error,
  onChange,
}: {
  field: CustomField;
  draft: FieldDraft;
  /** What the item has now: an archived option stays available only where it already is. */
  previous: FieldValue | undefined;
  error: string | null;
  onChange: (draft: FieldDraft) => void;
}): ReactNode {
  const id = useId();
  const noteId = `${id}-note`;
  const note = error ? (
    <p className="field-note field-note-error" id={noteId}>
      {error}
    </p>
  ) : null;
  const had = new Set(optionsOf(field, previous).map((option) => option.id));
  const choices = (field.config.options ?? []).filter(
    (option) => option.archived !== true || had.has(option.id),
  );

  if (field.kind === 'checkbox') {
    return (
      <div className="field">
        <label className="tick">
          <input
            type="checkbox"
            checked={draft === true}
            onChange={(event) => {
              onChange(event.target.checked);
            }}
          />
          {field.name}
        </label>
        {note}
      </div>
    );
  }

  if (field.kind === 'labels') {
    const chosen = Array.isArray(draft) ? draft : [];
    return (
      <fieldset className="field ticks" aria-describedby={error ? noteId : undefined}>
        <legend>{field.name}</legend>
        {choices.length === 0 ? (
          <p className="field-note">Este campo ainda não tem opções.</p>
        ) : null}
        {choices.map((option) => (
          <label key={option.id} className="tick">
            <input
              type="checkbox"
              checked={chosen.includes(option.id)}
              onChange={(event) => {
                onChange(
                  event.target.checked
                    ? [...chosen, option.id]
                    : chosen.filter((other) => other !== option.id),
                );
              }}
            />
            <span className="stage-mark" style={{ background: option.color }} aria-hidden="true" />
            {option.name}
            {option.archived === true ? <span className="tag">arquivada</span> : null}
          </label>
        ))}
        {note}
      </fieldset>
    );
  }

  if (field.kind === 'select' || field.kind === 'rating') {
    const options =
      field.kind === 'select'
        ? choices.map((option) => ({
            value: option.id,
            label: option.archived === true ? `${option.name} (arquivada)` : option.name,
          }))
        : Array.from({ length: field.config.max ?? 5 }, (_, index) => ({
            value: String(index + 1),
            label: `${index + 1} de ${field.config.max ?? 5}`,
          }));
    return (
      <div className="field">
        <label htmlFor={id}>{field.name}</label>
        <select
          id={id}
          value={typeof draft === 'string' ? draft : ''}
          aria-describedby={error ? noteId : undefined}
          aria-invalid={error ? true : undefined}
          onChange={(event) => {
            onChange(event.target.value);
          }}
        >
          <option value="">Sem valor</option>
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        {note}
      </div>
    );
  }

  if (field.kind === 'long_text') {
    return (
      <div className="field">
        <label htmlFor={id}>{field.name}</label>
        <textarea
          id={id}
          rows={3}
          value={typeof draft === 'string' ? draft : ''}
          maxLength={20_000}
          aria-describedby={error ? noteId : undefined}
          aria-invalid={error ? true : undefined}
          onChange={(event) => {
            onChange(event.target.value);
          }}
        />
        {note}
      </div>
    );
  }

  const input = INPUT[field.kind] ?? { type: 'text' };
  return (
    <Field
      label={
        field.kind === 'money' ? `${field.name} (${field.config.currency ?? 'BRL'})` : field.name
      }
      {...input}
      value={typeof draft === 'string' ? draft : ''}
      error={error}
      onChange={(event) => {
        onChange(event.target.value);
      }}
    />
  );
}

/** A stored value, read-only: plain text, a link that is safe to follow, or colored options. */
export function FieldValueView({
  field,
  value,
}: {
  field: CustomField;
  value: FieldValue | undefined;
}): ReactNode {
  if (field.kind === 'select' || field.kind === 'labels') {
    const options = optionsOf(field, value);
    if (options.length === 0) return null;
    return (
      <span className="chosen">
        {options.map((option) => (
          <span key={option.id} className="chosen-option">
            <span className="stage-mark" style={{ background: option.color }} aria-hidden="true" />
            {option.name}
          </span>
        ))}
      </span>
    );
  }
  const text = showValue(field, value);
  if (text === '') return null;
  const link = linkOf(field, value);
  if (link !== null) {
    return (
      <a
        href={link}
        {...(field.kind === 'url' ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
      >
        {text}
      </a>
    );
  }
  return <>{text}</>;
}
