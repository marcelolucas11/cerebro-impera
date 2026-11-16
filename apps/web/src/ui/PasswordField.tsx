import { checkPassword } from '@cerebro/shared';
import type { ReactNode } from 'react';
import { PASSWORD_PROBLEMS } from '../messages.js';
import { Field } from './kit.js';

/** A new password, checked as it is typed against the same rules the server applies. */
export function PasswordField({
  value,
  onChange,
  identity,
}: {
  value: string;
  onChange: (value: string) => void;
  identity: { email?: string; name?: string };
}): ReactNode {
  const problem = value === '' ? undefined : checkPassword(value, identity)[0];
  return (
    <Field
      label="Crie uma senha"
      type="password"
      autoComplete="new-password"
      value={value}
      onChange={(event) => {
        onChange(event.target.value);
      }}
      error={problem ? PASSWORD_PROBLEMS[problem] : null}
      hint={
        value === ''
          ? 'Pelo menos 12 caracteres. Uma frase com várias palavras é forte e fácil de lembrar.'
          : 'Senha aceita.'
      }
      required
    />
  );
}

export function passwordIsAcceptable(
  value: string,
  identity: { email?: string; name?: string },
): boolean {
  return value !== '' && checkPassword(value, identity).length === 0;
}
