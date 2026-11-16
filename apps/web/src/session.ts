/*
 * Any screen can find out the session ended (expired, revoked, account
 * suspended). They all report it the same way and one listener takes the
 * person back to the entrance.
 */
const SIGNED_OUT = 'cerebro:signed-out';

export function announceSignedOut(): void {
  window.dispatchEvent(new Event(SIGNED_OUT));
}

export function onSignedOut(listener: () => void): () => void {
  window.addEventListener(SIGNED_OUT, listener);
  return () => {
    window.removeEventListener(SIGNED_OUT, listener);
  };
}
