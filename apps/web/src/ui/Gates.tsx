import type { ReactNode } from 'react';

export interface Gate {
  label: string;
  detail: string;
}

/*
 * Signing in here takes more steps than people are used to. This shows the
 * doors in order, which ones are already behind them and which one they are
 * standing at, so the extra steps read as protection instead of friction.
 */
export function Gates({ gates, current }: { gates: readonly Gate[]; current: number }): ReactNode {
  return (
    <ol className="gates" aria-label="Etapas">
      {gates.map((gate, index) => {
        const state = index < current ? 'done' : index === current ? 'current' : 'ahead';
        return (
          <li
            key={gate.label}
            className={`gate gate-${state}`}
            aria-current={state === 'current' ? 'step' : undefined}
          >
            <Lock open={state === 'done'} />
            <div>
              <p className="gate-label">
                {gate.label}
                {state === 'done' ? <span className="visually-hidden"> (concluída)</span> : null}
              </p>
              <p className="gate-detail">{gate.detail}</p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function Lock({ open }: { open: boolean }): ReactNode {
  return (
    <svg className="gate-lock" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="5" y="11" width="14" height="10" rx="2.5" />
      <path d={open ? 'M8 11V7.5a4 4 0 0 1 7.6-1.7' : 'M8 11V7.5a4 4 0 0 1 8 0V11'} />
    </svg>
  );
}
