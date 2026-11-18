import { useCallback, useSyncExternalStore, type MouseEvent, type ReactNode } from 'react';

/*
 * The few screens inside the app are flat addresses, so this is all the
 * routing they need: the browser's own history, read as React state.
 */

const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  window.addEventListener('popstate', listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('popstate', listener);
  };
}

export function navigate(path: string): void {
  if (window.location.pathname === path) return;
  window.history.pushState(null, '', path);
  for (const listener of listeners) listener();
}

export function usePath(): string {
  return useSyncExternalStore(subscribe, () => window.location.pathname);
}

const ID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const LIST_PATH = new RegExp(`^/listas/(${ID})(/quadro)?$`);

/** The list an address points at, when it is the address of a list. */
export function listIdFrom(path: string): string | undefined {
  return LIST_PATH.exec(path)?.[1];
}

export type ListView = 'list' | 'board';

/** How a list is shown: as a list, or at /quadro as a board. */
export function listViewFrom(path: string): ListView {
  return LIST_PATH.exec(path)?.[2] === undefined ? 'list' : 'board';
}

export function Link({
  to,
  current,
  children,
}: {
  to: string;
  current: boolean;
  children: ReactNode;
}): ReactNode {
  const open = useCallback(
    (event: MouseEvent) => {
      // Let the browser handle "open in a new tab" and similar.
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
        return;
      event.preventDefault();
      navigate(to);
    },
    [to],
  );
  return (
    <a href={to} onClick={open} aria-current={current ? 'page' : undefined}>
      {children}
    </a>
  );
}
