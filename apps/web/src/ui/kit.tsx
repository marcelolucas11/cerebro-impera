import {
  useCallback,
  useId,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SyntheticEvent,
} from 'react';
import { ApiError } from '../api.js';
import { describeError } from '../messages.js';
import { announceSignedOut } from '../session.js';
import { Cancelled } from '../cancelled.js';
import { copySensitive } from '../clipboard.js';

interface FieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'id'> {
  label: string;
  hint?: ReactNode;
  error?: string | null;
}

interface SelectProps<V extends string> {
  label: string;
  value: V;
  options: readonly { value: V; label: string }[];
  onChange: (value: V) => void;
  disabled?: boolean;
}

export function Select<V extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
}: SelectProps<V>): ReactNode {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <select
        id={id}
        value={value}
        disabled={disabled}
        onChange={(event) => {
          const chosen = options.find((option) => option.value === event.target.value);
          if (chosen) onChange(chosen.value);
        }}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}

export function Field({ label, hint, error, ...input }: FieldProps): ReactNode {
  const id = useId();
  const noteId = `${id}-note`;
  const hasNote = Boolean(error) || hint !== undefined;
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        aria-describedby={hasNote ? noteId : undefined}
        aria-invalid={error ? true : undefined}
        {...input}
      />
      {error ? (
        <p className="field-note field-note-error" id={noteId}>
          {error}
        </p>
      ) : hint !== undefined ? (
        <p className="field-note" id={noteId}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'quiet';
  busy?: boolean;
}

export function Button({
  variant = 'primary',
  busy = false,
  children,
  ...rest
}: ButtonProps): ReactNode {
  return (
    <button
      type="button"
      className={`button button-${variant}`}
      aria-busy={busy || undefined}
      {...rest}
      disabled={busy || rest.disabled}
    >
      {children}
    </button>
  );
}

/** A message the person must not miss. Errors are announced by screen readers at once. */
export function Notice({
  tone,
  children,
}: {
  tone: 'error' | 'info' | 'ok';
  children: ReactNode;
}): ReactNode {
  return (
    <p className={`notice notice-${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      {children}
    </p>
  );
}

export function Form({
  onSubmit,
  children,
}: {
  onSubmit: () => void;
  children: ReactNode;
}): ReactNode {
  const handle = (event: SyntheticEvent): void => {
    event.preventDefault();
    onSubmit();
  };
  return (
    <form className="form" onSubmit={handle} noValidate>
      {children}
    </form>
  );
}

/** Runs one request at a time and turns a failure into a sentence to show. */
export function useAction<A extends unknown[]>(
  action: (...args: A) => Promise<void>,
): { run: (...args: A) => void; busy: boolean; error: string | null } {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(
    (...args: A): void => {
      if (busy) return;
      setBusy(true);
      setError(null);
      action(...args)
        .catch((failure: unknown) => {
          // Backing out of a confirmation is a choice, not a failure.
          if (failure instanceof Cancelled) return;
          if (failure instanceof ApiError && failure.code === 'unauthorized') announceSignedOut();
          setError(describeError(failure));
        })
        .finally(() => {
          setBusy(false);
        });
    },
    [action, busy],
  );
  return { run, busy, error };
}

/** Text that must be read or typed exactly: shown in the monospaced face, selectable in one tap. */
export function Exact({ children }: { children: string }): ReactNode {
  return <code className="exact">{children}</code>;
}

/**
 * Copies text in one tap. `sensitive` for what opens a door (an invite link): the
 * clipboard is emptied 30 seconds later.
 */
export function CopyButton({
  text,
  label,
  sensitive = false,
}: {
  text: string;
  label: string;
  sensitive?: boolean;
}): ReactNode {
  const [copied, setCopied] = useState(false);
  const copy = (): void => {
    (sensitive ? copySensitive(text) : navigator.clipboard.writeText(text)).then(
      () => {
        setCopied(true);
        window.setTimeout(() => {
          setCopied(false);
        }, 2500);
      },
      () => {
        setCopied(false);
      },
    );
  };
  return (
    <Button variant="quiet" onClick={copy}>
      {copied ? 'Copiado' : label}
    </Button>
  );
}
