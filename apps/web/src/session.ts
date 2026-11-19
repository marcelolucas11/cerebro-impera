import { forget } from './offline/store.js';
/*
 * Any screen can find out the session ended (expired, revoked, account
 * suspended). They all report it the same way and one listener takes the
 * person back to the entrance. The other open tabs of the app share the same
 * session: they are told too, and drop what they hold in memory.
 */

const SIGNED_OUT = 'cerebro:signed-out';

const tabs: BroadcastChannel | null =
  typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('cerebro-session');
if (tabs !== null) {
  tabs.onmessage = (event: MessageEvent) => {
    // Told by another tab: handled here, never sent on.
    if (event.data === 'signed-out') window.dispatchEvent(new Event(SIGNED_OUT));
  };
}

/** The session is over: what this device kept for offline reading goes with it. */
export function announceSignedOut(): void {
  void forget();
  tellOtherTabs();
  window.dispatchEvent(new Event(SIGNED_OUT));
}

/**
 * Someone signed out or in, in this tab: what the other tabs show is from the
 * session before, so they go back to the entrance.
 */
export function tellOtherTabs(): void {
  tabs?.postMessage('signed-out');
}

export function onSignedOut(listener: () => void): () => void {
  window.addEventListener(SIGNED_OUT, listener);
  return () => {
    window.removeEventListener(SIGNED_OUT, listener);
  };
}
