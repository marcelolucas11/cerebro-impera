import { describe, expect, it } from 'vitest';
import { noticeSentence } from '../src/notices.js';

describe('a notification as a sentence', () => {
  const base = { itemTitle: 'Postar no feed', actorName: 'Olívia Dona', dueOn: null };

  it('says who did what to which item', () => {
    expect(noticeSentence({ ...base, kind: 'mentioned' })).toBe(
      'Olívia Dona mencionou você em “Postar no feed”',
    );
    expect(noticeSentence({ ...base, kind: 'assigned' })).toBe(
      'Olívia Dona passou “Postar no feed” para você',
    );
    expect(noticeSentence({ ...base, kind: 'commented', actorName: null })).toBe(
      'Alguém comentou em “Postar no feed”',
    );
  });

  it('says when something is due today or late', () => {
    expect(noticeSentence({ ...base, kind: 'due_today', actorName: null })).toBe(
      '“Postar no feed” vence hoje',
    );
    expect(noticeSentence({ ...base, kind: 'overdue', dueOn: '2026-11-15' })).toBe(
      '“Postar no feed” está atrasado desde 15/11/2026',
    );
  });
});
