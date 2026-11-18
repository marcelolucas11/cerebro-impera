import { describe, expect, it } from 'vitest';
import { gather, nothingPending, touches } from '../src/live.js';

describe('what a live event makes the page read again', () => {
  it('gathers lists and items, and ignores anything else', () => {
    let pending = nothingPending();
    pending = gather(pending, { list: 'tarefas', item: 'item-1' });
    pending = gather(pending, { list: 'tarefas' });
    pending = gather(pending, 'nada');
    pending = gather(pending, { title: 'não esperado' });
    expect([...pending.ids].sort()).toEqual(['item-1', 'tarefas']);
    expect(pending.notifications).toBe(false);
  });

  it('touches what is about a changed list or item, and nothing else', () => {
    const pending = gather(nothingPending(), { list: 'tarefas', item: 'item-1' });
    expect(touches(['items', 'tarefas'], pending)).toBe(true);
    expect(touches(['checklist', 'item-1'], pending)).toBe(true);
    expect(touches(['items', 'outra'], pending)).toBe(false);
    expect(touches(['notifications'], pending)).toBe(false);
  });

  it('reads notifications again when told, and everything when access changed', () => {
    const notices = gather(nothingPending(), { notifications: true });
    expect(touches(['notifications-unread'], notices)).toBe(true);
    expect(touches(['items', 'tarefas'], notices)).toBe(false);
    const access = gather(nothingPending(), { access: true });
    expect(touches(['tree'], access)).toBe(true);
    expect(touches(['items', 'tarefas'], access)).toBe(true);
  });
});
