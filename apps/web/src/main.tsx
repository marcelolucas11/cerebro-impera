// First: no schema may try to write code at run time (see the shared jitless module).
import '@cerebro/shared/jitless';
import '@fontsource-variable/atkinson-hyperlegible-next';
import '@fontsource-variable/atkinson-hyperlegible-mono';
import './styles.css';
import { QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ApiError } from './api.js';
import { App } from './App.js';
import { sweep } from './offline/store.js';
import { workerAddress } from './trusted.js';
import { announceSignedOut } from './session.js';

const root = document.getElementById('app');
if (!root) throw new Error('missing #app');

// Answers live in memory and are fetched again on every visit. For reading offline, only
// what offline/policy.ts allows is also kept on the device, sealed (offline/store.ts).
const queryClient = new QueryClient({
  queryCache: new QueryCache({
    onError: (error) => {
      if (error instanceof ApiError && error.code === 'unauthorized') announceSignedOut();
    },
  }),
  defaultOptions: {
    queries: {
      // Who has access to what changes under other people's hands: every time a
      // screen opens it asks again, and never trusts what it showed before.
      staleTime: 0,
      refetchOnWindowFocus: true,
      // A refusal is an answer, not a glitch: only retry when the server could not be reached.
      retry: (failures, error) => failures < 2 && error instanceof ApiError && error.status === 0,
    },
  },
});

// What this device kept for offline reading does not outlive its days away from the
// server (or the device's choice to keep nothing), even if nothing is ever read from it.
void sweep();

// Installed or not, the page itself is kept by the browser so it opens offline. The
// worker keeps only the page and its files, never an answer from the API.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  try {
    navigator.serviceWorker
      .register(workerAddress(), { scope: '/', updateViaCache: 'none' })
      .catch(() => {
        // Without it the app works as before, online only.
      });
  } catch {
    // The browser refused the address policy (another CSP in front, say): online only, too.
  }
}

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
