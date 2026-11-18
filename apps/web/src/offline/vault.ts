/*
 * The lock on what a device keeps for offline reading: AES-GCM with a 256-bit
 * key made on the device and marked not exportable, so the page can use it but
 * never read it. Each record carries its own random nonce and is bound to its
 * slot, so a record moved to another slot does not open.
 */

export interface Sealed {
  iv: Uint8Array<ArrayBuffer>;
  data: ArrayBuffer;
}

const text = new TextEncoder();
const words = new TextDecoder();

export function newKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export async function seal(key: CryptoKey, slot: string, value: unknown): Promise<Sealed> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: text.encode(slot) },
    key,
    text.encode(JSON.stringify(value)),
  );
  return { iv, data };
}

/** The value, or undefined when it does not open with this key in this slot. */
export async function unseal(key: CryptoKey, slot: string, sealed: Sealed): Promise<unknown> {
  try {
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: sealed.iv, additionalData: text.encode(slot) },
      key,
      sealed.data,
    );
    return JSON.parse(words.decode(plain)) as unknown;
  } catch {
    return undefined;
  }
}
