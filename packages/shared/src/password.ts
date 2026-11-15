export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

export type PasswordProblem =
  'too_short' | 'too_long' | 'low_variety' | 'too_common' | 'contains_identity';

/**
 * Passwords that are long enough to pass the length rule but still show up at
 * the top of breach lists. Compared after lowercasing. This is a floor, not a
 * guarantee. A check against breached-password lists is planned (see docs/DECISIONS.md).
 */
const COMMON = new Set([
  '123456789012',
  '1234567890123',
  '12345678910111',
  '123123123123',
  '111111111111',
  '000000000000',
  'aaaaaaaaaaaa',
  'abcdefghijkl',
  'abcdefghijklm',
  'abcd12345678',
  'abc123abc123',
  'password1234',
  'password12345',
  'passwordpassword',
  'password123456',
  'qwertyuiop12',
  'qwertyuiop123',
  'qwertyuiopas',
  'qwerty123456',
  '1q2w3e4r5t6y',
  '1qaz2wsx3edc',
  'asdfghjklqwe',
  'zaq12wsxcde3',
  'iloveyou1234',
  'administrator',
  'administrador',
  'admin1234567',
  'adminadminadmin',
  'senha1234567',
  'senha12345678',
  'senhasenhasenha',
  'mudar1234567',
  'trocar123456',
  'welcome12345',
  'letmein12345',
  'changeme1234',
  'changemeplease',
  'brasil123456',
  'correcthorsebatterystaple',
]);

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Returns every rule the password breaks; an empty array means it is accepted.
 * Length counts Unicode code points so that passphrases with accents and emoji
 * are not penalised.
 */
export function checkPassword(
  password: string,
  identity: { email?: string; name?: string } = {},
): PasswordProblem[] {
  const problems: PasswordProblem[] = [];
  const length = Array.from(password).length;
  if (length < PASSWORD_MIN_LENGTH) problems.push('too_short');
  if (length > PASSWORD_MAX_LENGTH) problems.push('too_long');
  if (new Set(password.toLowerCase()).size < 6) problems.push('low_variety');

  const lowered = password.toLowerCase();
  if (COMMON.has(lowered) || COMMON.has(normalize(password))) problems.push('too_common');

  const compact = normalize(password);
  const pieces = [identity.email?.split('@')[0], ...(identity.name?.split(/\s+/) ?? [])]
    .filter((piece): piece is string => typeof piece === 'string')
    .map(normalize)
    .filter((piece) => piece.length >= 4);
  if (pieces.some((piece) => compact.includes(piece))) problems.push('contains_identity');

  return problems;
}
