import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { api, ApiError } from './api.js';
import { Cancelled } from './cancelled.js';
import { describeError } from './messages.js';
import { CodeField } from './ui/Authenticator.js';
import { Button, Form, Notice } from './ui/kit.js';

type Guard = <T>(action: () => Promise<T>) => Promise<T>;

const GuardContext = createContext<Guard | null>(null);

/**
 * Wraps a critical action. When the server answers that the second factor
 * must be confirmed again, this asks for the code and then repeats the action,
 * so no screen has to deal with that case on its own.
 */
export function useGuard(): Guard {
  const guard = useContext(GuardContext);
  if (!guard) throw new Error('useGuard outside StepUpProvider');
  return guard;
}

interface Pending {
  resolve: () => void;
  reject: (reason: Error) => void;
}

export function StepUpProvider({ children }: { children: ReactNode }): ReactNode {
  const [pending, setPending] = useState<Pending | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (pending && !element.open) element.showModal();
    if (!pending && element.open) element.close();
  }, [pending]);

  const confirmed = useCallback(
    () =>
      new Promise<void>((resolve, reject) => {
        setCode('');
        setError(null);
        setPending({ resolve, reject });
      }),
    [],
  );

  const guard = useMemo<Guard>(
    () => async (action) => {
      try {
        return await action();
      } catch (failure) {
        if (!(failure instanceof ApiError) || failure.code !== 'step_up_required') throw failure;
      }
      await confirmed();
      return action();
    },
    [confirmed],
  );

  const submit = (): void => {
    if (!pending || busy) return;
    setBusy(true);
    setError(null);
    api
      .stepUp(code)
      .then(
        () => {
          setPending(null);
          pending.resolve();
        },
        (failure: unknown) => {
          setCode('');
          setError(describeError(failure));
        },
      )
      .finally(() => {
        setBusy(false);
      });
  };
  const cancel = (): void => {
    if (!pending) return;
    setPending(null);
    pending.reject(new Cancelled());
  };

  return (
    <GuardContext.Provider value={guard}>
      {children}
      <dialog ref={dialog} className="dialog" onCancel={cancel} aria-labelledby="step-up-title">
        {pending ? (
          <>
            <h2 id="step-up-title">Confirme que é você</h2>
            <p className="lead">
              Esta ação muda quem tem acesso a quê. Digite o código do seu aplicativo autenticador
              para continuar.
            </p>
            <Form onSubmit={submit}>
              <CodeField value={code} onChange={setCode} label="Código de 6 dígitos" />
              {error ? <Notice tone="error">{error}</Notice> : null}
              <div className="actions">
                <Button type="submit" busy={busy} disabled={code.length !== 6}>
                  Confirmar
                </Button>
                <Button variant="quiet" onClick={cancel}>
                  Cancelar
                </Button>
              </div>
            </Form>
          </>
        ) : null}
      </dialog>
    </GuardContext.Provider>
  );
}
