import { useState, type ReactNode } from 'react';
import { Button, CopyButton, Exact } from './kit.js';

/** Shown exactly once. The person cannot continue before saying they kept the codes. */
export function RecoveryCodes({
  codes,
  onDone,
}: {
  codes: readonly string[];
  onDone: () => void;
}): ReactNode {
  const [kept, setKept] = useState(false);
  return (
    <>
      <p className="lead">
        Se você perder o celular, cada código abaixo entra no lugar do autenticador uma única vez.
        Eles não serão mostrados de novo.
      </p>
      <ul className="recovery-codes">
        {codes.map((code) => (
          <li key={code}>
            <Exact>{code}</Exact>
          </li>
        ))}
      </ul>
      <CopyButton text={codes.join('\n')} label="Copiar os 10 códigos" sensitive />
      <p className="field-note">
        Guarde em um gerenciador de senhas ou impresso em lugar seguro. Não deixe em anotações do
        celular nem em conversas.
      </p>
      <label className="check">
        <input
          type="checkbox"
          checked={kept}
          onChange={(event) => {
            setKept(event.target.checked);
          }}
        />
        Guardei os códigos em lugar seguro
      </label>
      <Button onClick={onDone} disabled={!kept}>
        Continuar
      </Button>
    </>
  );
}
