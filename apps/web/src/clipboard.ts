/*
 * Copying something that opens a door (a secret field, an invite link): it does
 * not stay in the clipboard. After 30 seconds the clipboard is emptied; if the
 * page is not in front then (the browser only lets the page write while it is),
 * it is emptied as soon as the person comes back to it.
 */

export const CLEAR_AFTER_MS = 30_000;

let pending: ReturnType<typeof setTimeout> | null = null;

function clear(): void {
  navigator.clipboard.writeText('').catch(() => {
    // Not in front: try again the next time the page is.
    window.addEventListener(
      'focus',
      () => {
        void navigator.clipboard.writeText('').catch(() => undefined);
      },
      { once: true },
    );
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
