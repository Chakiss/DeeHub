import { Inject, Injectable } from '@nestjs/common';
import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';
import { DomainError } from '@deehub/shared';
import { ENV, type Env } from '../../config/env';

/**
 * Symmetric encryption for channel credentials (docs/database.md §14).
 *
 * AES-256-GCM: authenticated encryption, so a tampered ciphertext fails to
 * decrypt rather than silently yielding garbage that we would then send to an
 * OTA as an API key.
 *
 * Stored as `v1:iv:authTag:ciphertext`, all base64. The version prefix exists
 * so a future move to Cloud KMS envelope encryption can decrypt old values
 * during rollout instead of requiring every hotel to re-enter credentials.
 */

const VERSION = 'v1';
const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12; // GCM standard; a 96-bit IV is what the mode is designed for
const KEY_BYTES = 32;

export const CREDENTIAL_CIPHER = Symbol('CREDENTIAL_CIPHER');

export interface CredentialCipher {
  encrypt(plaintext: Record<string, string>): Buffer;
  decrypt(ciphertext: Buffer): Record<string, string>;
}

@Injectable()
export class AesCredentialCipher implements CredentialCipher {
  private readonly key: Buffer;

  constructor(@Inject(ENV) env: Env) {
    const key = Buffer.from(env.CREDENTIALS_KEY, 'base64');
    if (key.length !== KEY_BYTES) {
      throw new Error(
        `CREDENTIALS_KEY must decode to ${String(KEY_BYTES)} bytes, got ${String(key.length)}. ` +
          'Generate one with: openssl rand -base64 32',
      );
    }
    this.key = key;
  }

  encrypt(plaintext: Record<string, string>): Buffer {
    // A fresh IV per encryption is mandatory for GCM: reusing one with the same
    // key breaks confidentiality outright.
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.key, iv);
    const encrypted = Buffer.concat([
      cipher.update(JSON.stringify(plaintext), 'utf8'),
      cipher.final(),
    ]);

    return Buffer.from(
      [
        VERSION,
        iv.toString('base64'),
        cipher.getAuthTag().toString('base64'),
        encrypted.toString('base64'),
      ].join(':'),
      'utf8',
    );
  }

  decrypt(ciphertext: Buffer): Record<string, string> {
    const parts = ciphertext.toString('utf8').split(':');
    if (parts.length !== 4) {
      throw new DomainError('INTERNAL_ERROR', 'Stored credentials are malformed');
    }

    const [version, iv, authTag, payload] = parts;
    const expected = Buffer.from(VERSION);
    const actual = Buffer.from(version ?? '');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      throw new DomainError('INTERNAL_ERROR', `Unsupported credential format: ${String(version)}`);
    }

    try {
      const decipher = createDecipheriv(ALGORITHM, this.key, Buffer.from(iv ?? '', 'base64'));
      decipher.setAuthTag(Buffer.from(authTag ?? '', 'base64'));
      const decrypted = Buffer.concat([
        decipher.update(Buffer.from(payload ?? '', 'base64')),
        decipher.final(),
      ]);
      return JSON.parse(decrypted.toString('utf8')) as Record<string, string>;
    } catch {
      // Covers a wrong key, a tampered payload and a failed auth tag alike.
      // The message deliberately says nothing about which.
      throw new DomainError('INTERNAL_ERROR', 'Unable to decrypt channel credentials');
    }
  }
}
