import type { FastifyReply, FastifyRequest } from 'fastify';

/*
 * Every cookie uses the `__Host-` prefix: browsers only accept it when it is
 * Secure, has Path=/ and has NO Domain attribute. That pins the cookie to this
 * exact host, so other applications on sibling subdomains of the same domain
 * can neither read it nor overwrite it.
 */
export const SESSION_COOKIE = '__Host-cerebro_session';
export const DEVICE_COOKIE = '__Host-cerebro_device';
export const CHALLENGE_COOKIE = '__Host-cerebro_challenge';

const BASE = { path: '/', httpOnly: true, secure: true, sameSite: 'strict' } as const;

export function setCookie(
  reply: FastifyReply,
  name: string,
  value: string,
  maxAgeSeconds: number,
): void {
  void reply.setCookie(name, value, { ...BASE, maxAge: maxAgeSeconds });
}

export function clearCookie(reply: FastifyReply, name: string): void {
  void reply.clearCookie(name, BASE);
}

const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

/** Returns the cookie only if it looks like one of our tokens. */
export function readToken(request: FastifyRequest, name: string): string | undefined {
  const value = request.cookies[name];
  return value !== undefined && TOKEN_SHAPE.test(value) ? value : undefined;
}
