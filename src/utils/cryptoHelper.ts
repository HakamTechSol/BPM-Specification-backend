import crypto from 'crypto';

const ALGORITHM = 'aes-256-cbc';
const IV_LENGTH = 16;
const KEY_ENCODING: BufferEncoding = 'utf8';
const OUTPUT_ENCODING: BufferEncoding = 'hex';
const DELIMITER = '-';
const LEGACY_DELIMITER = ':';

function getKey(): Buffer {
  const key = process.env.ENCRYPTION_KEY;
  if (!key) {
    throw new Error('ENCRYPTION_KEY environment variable is not set');
  }
  if (key.length !== 32) {
    throw new Error('ENCRYPTION_KEY must be exactly 32 characters long (AES-256)');
  }
  return Buffer.from(key, KEY_ENCODING);
}

export function encryptPitchId(pltsnr: number): string {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);

  const encrypted = Buffer.concat([
    cipher.update(String(pltsnr), KEY_ENCODING),
    cipher.final(),
  ]);

  return iv.toString(OUTPUT_ENCODING) + DELIMITER + encrypted.toString(OUTPUT_ENCODING);
}

export function decryptPitchId(token: string): number {
  // Try new delimiter first, fall back to legacy ":" for old QR codes
  let parts = token.split(DELIMITER);
  if (parts.length !== 2) {
    parts = token.split(LEGACY_DELIMITER);
  }
  if (parts.length !== 2) {
    throw new Error('Invalid token format');
  }

  const iv = Buffer.from(parts[0], OUTPUT_ENCODING);
  const encrypted = Buffer.from(parts[1], OUTPUT_ENCODING);

  const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), iv);

  const decrypted = Buffer.concat([
    decipher.update(encrypted),
    decipher.final(),
  ]);

  const pitchId = parseInt(decrypted.toString(KEY_ENCODING), 10);
  if (isNaN(pitchId)) {
    throw new Error('Decrypted value is not a valid pitch number');
  }

  return pitchId;
}
