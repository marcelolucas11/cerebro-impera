import { useState, type ReactNode } from 'react';
import type { Enrollment } from '../api.js';
import { Button, CopyButton, Exact, Field, Form, Notice } from './kit.js';
import { Qr } from './Qr.js';

const groups = (secret: string): string => secret.replace(/(.{4})/g, '$1 ').trim();

/** Linking an authenticator app: scan (or type) the key, then prove it works with one code. */
export function Authenticator({
  enrollment,
  onConfirm,
  busy,
  error,
}: {
  enrollment: Enrollment;
  onConfirm: (code: string) => void;
  busy: boolean;
  error: string | null;
}): ReactNode {
  const [code, setCode] = useState('');
  return (
    <>
      <p className="lead">
        Abra seu aplicativo autenticador (Google Authenticator, Microsoft Authenticator, 1Password
        ou outro) e leia o código abaixo com a câmera.
      </p>
      <div className="authenticator">
        <Qr value={enrollment.otpauthUri} label="Código QR para o aplicativo autenticador" />
        <div>
          <p className="field-note">Sem câmera? Digite esta chave no aplicativo:</p>
          <Exact>{groups(enrollment.secret)}</Exact>
          <CopyButton text={enrollment.secret} label="Copiar chave" sensitive />
        </div>
      </div>
      <Form
        onSubmit={() => {
          onConfirm(code);
        }}
      >
        <CodeField
          value={code}
          onChange={setCode}
          label="Código de 6 dígitos que o aplicativo mostra"
        />
        {error ? <Notice tone="error">{error}</Notice> : null}
        <Button type="submit" busy={busy} disabled={code.length !== 6}>
          Confirmar código
        </Button>
      </Form>
    </>
  );
}

export function CodeField({
  value,
  onChange,
  label,
  autoFocus = true,
}: {
  value: string;
  onChange: (value: string) => void;
  label: string;
  autoFocus?: boolean;
}): ReactNode {
  return (
    <Field
      label={label}
      className="code-input"
      value={value}
      onChange={(event) => {
        onChange(event.target.value.replace(/\D/g, '').slice(0, 6));
      }}
      inputMode="numeric"
      autoComplete="one-time-code"
      pattern="[0-9]{6}"
      maxLength={6}
      autoFocus={autoFocus}
      required
    />
  );
}
