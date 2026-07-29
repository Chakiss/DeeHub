import { Injectable } from '@nestjs/common';
import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

// Hand-written rather than promisify(): promisify drops the options overload,
// and the options are the whole point — they carry the cost parameters.
function scryptAsync(
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, options, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey);
    });
  });
}

/**
 * Password hashing with scrypt from node:crypto (ADR-0006).
 *
 * Format: `scrypt$N$r$p$saltBase64$hashBase64`. Parameters travel with each
 * hash, so N can be raised later and users are transparently upgraded on their
 * next successful login — no migration, no forced resets.
 */

const ALGORITHM = 'scrypt';
/** 2^15 = 32 MB per hash. See ADR-0006 for why not 2^17. */
const COST = 32_768;
const BLOCK_SIZE = 8;
const PARALLELIZATION = 1;
const SALT_BYTES = 16;
const KEY_BYTES = 64;
// scrypt needs maxmem >= 128 * N * r; Node's default (32 MB) is too low for N=2^15.
const MAX_MEMORY = 256 * COST * BLOCK_SIZE;

export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(password: string, stored: string): Promise<boolean>;
  /** True when the stored hash used weaker parameters than we now require. */
  needsRehash(stored: string): boolean;
}

export const PASSWORD_HASHER = Symbol('PASSWORD_HASHER');

@Injectable()
export class ScryptPasswordHasher implements PasswordHasher {
  async hash(password: string): Promise<string> {
    const salt = randomBytes(SALT_BYTES);
    const derived = await scryptAsync(password.normalize('NFKC'), salt, KEY_BYTES, {
      N: COST,
      r: BLOCK_SIZE,
      p: PARALLELIZATION,
      maxmem: MAX_MEMORY,
    });

    return [
      ALGORITHM,
      COST,
      BLOCK_SIZE,
      PARALLELIZATION,
      salt.toString('base64'),
      derived.toString('base64'),
    ].join('$');
  }

  async verify(password: string, stored: string): Promise<boolean> {
    const parsed = this.parse(stored);
    if (!parsed) return false;

    let derived: Buffer;
    try {
      derived = await scryptAsync(password.normalize('NFKC'), parsed.salt, parsed.hash.length, {
        N: parsed.cost,
        r: parsed.blockSize,
        p: parsed.parallelization,
        maxmem: Math.max(MAX_MEMORY, 256 * parsed.cost * parsed.blockSize),
      });
    } catch {
      // Malformed parameters in the stored value; treat as a failed login
      // rather than a 500, so a corrupt row cannot be probed for information.
      return false;
    }

    // Constant-time: a length check plus byte comparison that does not exit
    // early, so response timing does not leak how much of the hash matched.
    if (derived.length !== parsed.hash.length) return false;
    return timingSafeEqual(derived, parsed.hash);
  }

  needsRehash(stored: string): boolean {
    const parsed = this.parse(stored);
    if (!parsed) return true;
    return (
      parsed.cost < COST ||
      parsed.blockSize < BLOCK_SIZE ||
      parsed.parallelization < PARALLELIZATION
    );
  }

  private parse(stored: string): {
    cost: number;
    blockSize: number;
    parallelization: number;
    salt: Buffer;
    hash: Buffer;
  } | null {
    const parts = stored.split('$');
    if (parts.length !== 6) return null;
    const [algorithm, cost, blockSize, parallelization, salt, hash] = parts;
    if (algorithm !== ALGORITHM) return null;

    const parsedCost = Number(cost);
    const parsedBlockSize = Number(blockSize);
    const parsedParallelization = Number(parallelization);
    if (
      !Number.isInteger(parsedCost) ||
      !Number.isInteger(parsedBlockSize) ||
      !Number.isInteger(parsedParallelization) ||
      parsedCost < 2 ||
      // Guard against a hostile stored value demanding absurd memory.
      parsedCost > 1_048_576
    ) {
      return null;
    }

    return {
      cost: parsedCost,
      blockSize: parsedBlockSize,
      parallelization: parsedParallelization,
      salt: Buffer.from(salt ?? '', 'base64'),
      hash: Buffer.from(hash ?? '', 'base64'),
    };
  }
}
