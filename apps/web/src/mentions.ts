/*
 * Mentions in a comment, as written: "@Ana Souza". The ids sent are those of
 * the people picked whose "@name" is still in the text; the text is shown
 * with each mention set apart.
 */

export interface Named {
  id: string;
  name: string;
}

/** The people picked whose "@name" is still in the text. */
export function mentionsIn(body: string, picked: readonly Named[]): string[] {
  const ids = picked
    .filter((person) => body.includes(`@${person.name}`))
    .map((person) => person.id);
  return [...new Set(ids)];
}

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The text cut into plain parts and mentions, in order. Longer names are matched first. */
export function splitMentions(
  body: string,
  names: readonly string[],
): { text: string; mention: boolean }[] {
  const tags = [...new Set(names.filter((name) => name !== ''))]
    .sort((a, b) => b.length - a.length)
    .map((name) => `@${name}`);
  if (tags.length === 0) return [{ text: body, mention: false }];
  const known = new Set(tags);
  const pattern = new RegExp(`(${tags.map(escape).join('|')})`);
  return body
    .split(pattern)
    .filter((part) => part !== '')
    .map((part) => ({ text: part, mention: known.has(part) }));
}
