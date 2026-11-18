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
  workers,
  nameOf,
  files,
}: {
  field: CustomField;
  draft: FieldDraft;
  /** What the item has now: an archived option stays available only where it already is. */
  previous: FieldValue | undefined;
  error: string | null;
  onChange: (draft: FieldDraft) => void;
  /** Who can be named here; null for someone who does not hand out work in this list. */
  workers: { id: string; name: string }[] | null;
  nameOf: (userId: string | null) => string;
  /** The item's attachments that a files field can name. */
  files: { id: string; name: string }[];
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

  if (field.kind === 'people') {
    const chosen = Array.isArray(draft) ? draft : [];
    if (workers === null) {
      // Not someone who hands out work here: the field is read, not chosen.
      return (
        <div className="field">
          <span className="field-label">{field.name}</span>
          <p className="fixed-value">
            {chosen.length === 0 ? 'Ninguém' : chosen.map((id) => nameOf(id)).join(', ')}
          </p>
        </div>
      );
    }
    const offered = [
      ...workers,
      ...chosen
        .filter((id) => !workers.some((worker) => worker.id === id))
        .map((id) => ({ id, name: nameOf(id) })),
    ];
    return (
      <fieldset className="field ticks" aria-describedby={error ? noteId : undefined}>
        <legend>{field.name}</legend>
        {offered.map((person) => (
          <label key={person.id} className="tick">
            <input
              type="checkbox"
              checked={chosen.includes(person.id)}
              onChange={(event) => {
                onChange(
                  event.target.checked
                    ? [...chosen, person.id]
                    : chosen.filter((other) => other !== person.id),
                );
              }}
            />
            {person.name}
          </label>
        ))}
        {note}
      </fieldset>
    );
  }

  if (field.kind === 'files') {
    const chosen = Array.isArray(draft) ? draft : [];
    // Something named before and since removed from the item can still be unticked.
    const offered = [
      ...files,
      ...chosen
        .filter((fileId) => !files.some((file) => file.id === fileId))
        .map((fileId) => ({ id: fileId, name: 'Arquivo que saiu do item' })),
    ];
    return (
      <fieldset className="field ticks" aria-describedby={error ? noteId : undefined}>
        <legend>{field.name}</legend>
        {offered.length === 0 ? (
          <p className="field-note">Anexe arquivos ao item, em Anexos, para escolher aqui.</p>
        ) : null}
        {offered.map((file) => (
          <label key={file.id} className="tick">
            <input
              type="checkbox"
              checked={chosen.includes(file.id)}
              onChange={(event) => {
                onChange(
                  event.target.checked
                    ? [...chosen, file.id]
                    : chosen.filter((other) => other !== file.id),
                );
              }}
            />
            {file.name}
          </label>
        ))}
        {note}
      </fieldset>
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
  nameOf,
}: {
  field: CustomField;
  value: FieldValue | undefined;
  nameOf: (userId: string | null) => string;
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
  const text = showValue(field, value, nameOf);
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
