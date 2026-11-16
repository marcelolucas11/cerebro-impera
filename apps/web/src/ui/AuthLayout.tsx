import type { ReactNode } from 'react';
import { Gates, type Gate } from './Gates.js';

/** The page every "not inside yet" screen shares: what to do on the left, where you are on the right. */
export function AuthLayout({
  instanceName,
  title,
  gates,
  current,
  children,
}: {
  instanceName: string;
  title: string;
  gates?: readonly Gate[];
  current?: number;
  children: ReactNode;
}): ReactNode {
  return (
    <div className="door">
      <header className="door-brand">{instanceName || 'Cérebro'}</header>
      <main className="door-main">
        <h1>{title}</h1>
        {children}
      </main>
      {gates ? (
        <aside className="door-aside">
          <Gates gates={gates} current={current ?? 0} />
        </aside>
      ) : null}
    </div>
  );
}

export const SIGN_IN_GATES: readonly Gate[] = [
  { label: 'Senha', detail: 'O que só você sabe.' },
  { label: 'Código do autenticador', detail: 'O que só o seu celular gera.' },
  { label: 'Dispositivo aprovado', detail: 'Um aparelho que a empresa reconhece.' },
];
