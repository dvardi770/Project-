/**
 * Encryption for the secrets stored in the database (storefront access tokens,
 * webhook secrets). AES-256-GCM with a random nonce per value.
 *
 * Layout: 0x01 | 12-byte nonce | 16-byte auth tag | ciphertext
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const VERSION = 1;

/** Accepts a 32-byte key as 64 hex characters or base64. */
export function parseEncryptionKey(value: string): Buffer {
  const trimmed = value.trim();
  const key = /^[0-9a-fA-F]{64}$/.test(trimmed) ? Buffer.from(trimmed, 'hex') : Buffer.from(trimmed, 'base64');
  if (key.length !== 32) throw new Error('encryption key must be 32 bytes (64 hex characters or base64)');
  return key;
}

export function encryptSecret(plaintext: string, key: Buffer): Uint8Array<ArrayBuffer> {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  // A plain Uint8Array is what Prisma's Bytes columns take.
  return new Uint8Array(Buffer.concat([Buffer.from([VERSION]), nonce, cipher.getAuthTag(), ciphertext]));
}

/** Throws if the value was tampered with or the key is wrong. */
export function decryptSecret(box: Uint8Array, key: Buffer): string {
  const buf = Buffer.from(box);
  if (buf.length < 29 || buf[0] !== VERSION) throw new Error('unrecognised secret format');
  const decipher = createDecipheriv('aes-256-gcm', key, buf.subarray(1, 13));
  decipher.setAuthTag(buf.subarray(13, 29));
  return Buffer.concat([decipher.update(buf.subarray(29)), decipher.final()]).toString('utf8');
}

export const encryptJson = (value: unknown, key: Buffer) => encryptSecret(JSON.stringify(value), key);
export const decryptJson = <T>(box: Uint8Array, key: Buffer) => JSON.parse(decryptSecret(box, key)) as T;
