/*
 * Copying something that opens a door (a secret field, an invite link, the key of
 * an authenticator, recovery codes): the page tries not to leave it in the
 * clipboard. After 30 seconds it empties the clipboard. A browser may refuse that
 * (the page is not in front, or, in some browsers, there was no click or key in it
 * just before): then it tries again at the next return to the page, click or key.
 * It cannot reach a copy the system keeps in a clipboard history, and a tab closed
 * before then empties nothing; the screen says so.
 */

export const CLEAR_AFTER_MS = 30_000;

const RETRY_ON = ['focus', 'pointerdown', 'keydown'] as const;

let pending: ReturnType<typeof setTimeout> | null = null;

function clear(): void {
  navigator.clipboard.writeText('').catch(() => {
    const retry = (): void => {
      for (const kind of RETRY_ON) window.removeEventListener(kind, retry, { capture: true });
      void navigator.clipboard.writeText('').catch(() => undefined);
    };
    for (const kind of RETRY_ON) window.addEventListener(kind, retry, { capture: true });
  });
}

export async function copySensitive(text: string): Promise<void> {
  await navigator.clipboard.writeText(text);
  if (pending !== null) clearTimeout(pending);
  pending = setTimeout(() => {
    pending = null;
    clear();
  }, CLEAR_AFTER_MS);
}
