import { isIP } from 'node:net';
import type { FastifyRequest } from 'fastify';
import type { z } from 'zod';
import { badRequest } from './errors.js';

/** The caller's address, or null when it is not a well-formed IP. */
export function clientIp(request: FastifyRequest): string | null {
  return isIP(request.ip) === 0 ? null : request.ip;
}

export function userAgent(request: FastifyRequest): string {
  const value = request.headers['user-agent'];
  return typeof value === 'string' ? value.slice(0, 400) : '';
}

/** Validates untrusted input against a schema; anything else is a 400. */
export function parse<S extends z.ZodType>(schema: S, input: unknown): z.infer<S> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw badRequest('invalid_input', {
      issues: result.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    });
  }
  return result.data;
}
