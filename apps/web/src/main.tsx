import '@fontsource-variable/atkinson-hyperlegible-next';
import '@fontsource-variable/atkinson-hyperlegible-mono';
import './styles.css';
import { QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ApiError } from './api.js';
import { App } from './App.js';
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

// Installed or not, the page itself is kept by the browser so it opens offline. The
// worker keeps only the page and its files, never an answer from the API.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' }).catch(() => {
    // Without it the app works as before, online only.
  });
}

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
