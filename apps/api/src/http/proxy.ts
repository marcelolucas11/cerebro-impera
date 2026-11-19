/**
 * Believes exactly that many reverse proxies, counted from the closest one: the
 * address they saw is the client's. Entries further left in X-Forwarded-For were
 * written by the client itself and are never believed.
 */
export function trustHops(hops: number): false | ((address: string, hop: number) => boolean) {
  return hops === 0 ? false : (_address, hop) => hop < hops;
}

/**
 * The unit an address is counted by. One IPv6 subscriber usually holds a whole /64,
 * so counting each of its addresses apart would let one client look like billions.
 */
export function addressGroup(ip: string | null | undefined): string {
  if (ip === null || ip === undefined || ip === '') return 'unknown';
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (mapped?.[1] !== undefined) return mapped[1];
  if (!ip.includes(':')) return ip;
  const bare = ip.split('%')[0] ?? ip;
  const [head = '', tail] = bare.split('::');
  const start = head === '' ? [] : head.split(':');
  const end = tail === undefined || tail === '' ? [] : tail.split(':');
  const middle =
    tail === undefined ? [] : Array<string>(Math.max(0, 8 - start.length - end.length)).fill('0');
  const groups = [...start, ...middle, ...end];
  return `${groups
    .slice(0, 4)
    .map((group) => group.toLowerCase().replace(/^0+(?=.)/, ''))
    .join(':')}::/64`;
}
