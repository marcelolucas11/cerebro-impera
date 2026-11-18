import { describe, expect, it } from 'vitest';
import { dueState, dueText, formatDay, priorityLabel } from '../src/due.js';

describe('due dates as people read them', () => {
  const today = '2026-11-18';

  it('says where a due date stands, and a finished item is never late', () => {
    expect(dueState(null, today, false)).toBeNull();
    expect(dueState('2026-11-17', today, false)).toBe('overdue');
    expect(dueState('2026-11-17', today, true)).toBe('finished');
    expect(dueState('2026-11-18', today, false)).toBe('today');
    expect(dueState('2026-11-24', today, false)).toBe('soon');
    expect(dueState('2026-11-25', today, false)).toBe('later');
  });

  it('writes the day as here, the year only when it is another', () => {
    expect(formatDay('2026-11-20', today)).toBe('20/11');
    expect(formatDay('2027-01-05', today)).toBe('05/01/2027');
    expect(dueText('2026-11-18', today, 'today')).toBe('Vence hoje');
    expect(dueText('2026-11-19', today, 'soon')).toBe('Vence amanhã');
    expect(dueText('2026-11-10', today, 'overdue')).toBe('Atrasado desde 10/11');
    expect(dueText('2026-12-01', today, 'later')).toBe('Prazo 01/12');
    expect(dueText('2026-11-10', today, 'finished')).toBe('Prazo 10/11');
  });

  it('names priorities with their number', () => {
    expect(priorityLabel(1)).toBe('1 · Urgente');
    expect(priorityLabel(4)).toBe('4 · Baixa');
    expect(priorityLabel(null)).toBeNull();
    expect(priorityLabel(7)).toBeNull();
  });
});
