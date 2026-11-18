import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { api, ApiError, type SignInResult } from './api.js';
import { describeError } from './messages.js';
import { DevicePending } from './screens/DevicePending.js';
import { Enroll, Invite } from './screens/Enroll.js';
import { Setup } from './screens/Setup.js';
import { Shell } from './screens/Shell.js';
import { SecondFactor, SignIn } from './screens/SignIn.js';
import { Button, Notice } from './ui/kit.js';

type Stage =
  | { name: 'loading' }
  | { name: 'unreachable'; message: string; offline: boolean }
  | { name: 'setup' }
  | { name: 'invite'; token: string }
  | { name: 'sign-in'; notice?: string | undefined }
  | { name: 'second-factor' }
  | { name: 'enroll' }
  | { name: 'device-pending' }
  | { name: 'app' };

const INVITE_PATH = '/convite';

/*
 * Invite links carry their token after the "#". Browsers never send that part
 * to a server, so the token stays out of access logs and proxies.
 */
function inviteTokenFromAddress(): string | undefined {
  if (window.location.pathname !== INVITE_PATH) return undefined;
  const token = window.location.hash.slice(1);
  return /^[A-Za-z0-9_-]{20,200}$/.test(token) ? token : undefined;
}

async function whereToStart(): Promise<{ stage: Stage; instanceName: string }> {
  const { needsSetup, instanceName } = await api.setupStatus();
  if (needsSetup) return { stage: { name: 'setup' }, instanceName };

  const token = inviteTokenFromAddress();
  if (token !== undefined) return { stage: { name: 'invite', token }, instanceName };

  try {
    await api.me();
    return { stage: { name: 'app' }, instanceName };
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 401) throw error;
  }
  const device = await api.deviceStatus();
  return {
    stage: device.status === 'pending' ? { name: 'device-pending' } : { name: 'sign-in' },
    instanceName,
  };
}

export function App(): ReactNode {
  const [stage, setStage] = useState<Stage>({ name: 'loading' });
  const [instanceName, setInstanceName] = useState('');

  const attempt = useCallback(() => {
    whereToStart().then(
      (result) => {
        setInstanceName(result.instanceName);
        setStage(result.stage);
      },
      (error: unknown) => {
        setStage({
          name: 'unreachable',
          message: describeError(error),
          offline: error instanceof ApiError && error.code === 'network',
        });
      },
    );
  }, []);
  const start = useCallback(() => {
    setStage({ name: 'loading' });
    attempt();
  }, [attempt]);
  useEffect(start, [start]);

  // Opened without a connection (the page itself is kept by the browser), it tries again
  // by itself: when the browser says the connection is back, and every few seconds.
  const waiting = stage.name === 'unreachable' && stage.offline;
  useEffect(() => {
    if (!waiting) return undefined;
    const timer = setInterval(attempt, 5_000);
    window.addEventListener('online', attempt);
    return () => {
      clearInterval(timer);
      window.removeEventListener('online', attempt);
    };
  }, [waiting, attempt]);

  const toSignIn = useCallback((notice?: string) => {
    if (window.location.pathname !== '/' || window.location.hash !== '') {
      window.history.replaceState(null, '', '/');
    }
    setStage({ name: 'sign-in', notice });
  }, []);
  const afterFactors = useCallback((result: SignInResult) => {
    setStage(result.status === 'authenticated' ? { name: 'app' } : { name: 'device-pending' });
  }, []);
  const afterPassword = useCallback((next: 'totp' | 'enroll_totp') => {
    setStage(next === 'totp' ? { name: 'second-factor' } : { name: 'enroll' });
  }, []);
  const afterInvite = useCallback(() => {
    window.history.replaceState(null, '', '/');
    setStage({ name: 'enroll' });
  }, []);

  switch (stage.name) {
    case 'loading':
      return <p className="boot">Abrindo…</p>;
    case 'unreachable':
      return stage.offline ? (
        <div className="boot">
          <Notice tone="info">
            Sem conexão com o servidor. O aplicativo abre sozinho assim que ela voltar.
          </Notice>
          <Button variant="quiet" onClick={start}>
            Tentar agora
          </Button>
        </div>
      ) : (
        <div className="boot">
          <Notice tone="error">{stage.message}</Notice>
          <Button onClick={start}>Tentar de novo</Button>
        </div>
      );
    case 'setup':
      return <Setup onDone={start} />;
    case 'invite':
      return <Invite instanceName={instanceName} token={stage.token} onAccepted={afterInvite} />;
    case 'sign-in':
      return (
        <SignIn instanceName={instanceName} notice={stage.notice} onPassword={afterPassword} />
      );
    case 'second-factor':
      return (
        <SecondFactor instanceName={instanceName} onResult={afterFactors} onRestart={toSignIn} />
      );
    case 'enroll':
      return <Enroll instanceName={instanceName} onResult={afterFactors} onRestart={toSignIn} />;
    case 'device-pending':
      return <DevicePending instanceName={instanceName} onSignIn={toSignIn} />;
    case 'app':
      return <Shell onSignedOut={toSignIn} />;
  }
}
