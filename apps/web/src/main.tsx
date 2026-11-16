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

// Nothing is kept on disk: data lives in memory and is fetched again on every visit.
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

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
