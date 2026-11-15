import * as OTPAuth from 'otpauth';

const PERIOD_SECONDS = 30;

function build(secretBase32: string, issuer: string, account: string): OTPAuth.TOTP {
  return new OTPAuth.TOTP({
    issuer,
    label: account,
    algorithm: 'SHA1', // what authenticator apps universally support
    digits: 6,
    period: PERIOD_SECONDS,
    secret: OTPAuth.Secret.fromBase32(secretBase32),
  });
}

/** 160-bit seed, base32. */
export function newTotpSecret(): string {
  return new OTPAuth.Secret({ size: 20 }).base32;
}

/** The otpauth:// URI encoded in the enrolment QR code. */
export function totpUri(secretBase32: string, issuer: string, account: string): string {
  return build(secretBase32, issuer, account).toString();
}

/**
 * Checks a code, accepting one period of clock drift either way. Returns the
 * time step that matched, or null. A step at or before `lastStep` is refused:
 * every code works exactly once, even inside its validity window.
 */
export function verifyTotp(
  secretBase32: string,
  code: string,
  lastStep: number,
  nowMs: number,
): number | null {
  const delta = build(secretBase32, 'cerebro', 'account').validate({
    token: code,
    timestamp: nowMs,
    window: 1,
  });
  if (delta === null) return null;
  const step = Math.floor(nowMs / 1000 / PERIOD_SECONDS) + delta;
  return step > lastStep ? step : null;
}

/** Test helper and enrolment preview: the code for a given instant. */
export function totpCodeAt(secretBase32: string, nowMs: number): string {
  return build(secretBase32, 'cerebro', 'account').generate({ timestamp: nowMs });
}
