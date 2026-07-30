import { describe, expect, it } from 'vitest';
import { loadEnv } from './env';
import { channelSyncEnabled } from '../queue/queue.module';

/**
 * The environment contract is the first thing that runs in production and the
 * only thing that can stop a bad configuration from reaching guests. These
 * cover the cases that have actually broken a deployment.
 */

const valid = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgresql://user:pass@10.0.0.3:5432/deehub',
  JWT_ACCESS_SECRET: 'a'.repeat(48),
  JWT_REFRESH_SECRET: 'b'.repeat(48),
  CREDENTIALS_KEY: Buffer.from('c'.repeat(32)).toString('base64'),
} satisfies NodeJS.ProcessEnv;

describe('loadEnv', () => {
  describe('REDIS_URL', () => {
    it('accepts a real Redis URL', () => {
      const env = loadEnv({ ...valid, REDIS_URL: 'redis://10.0.0.4:6379' });
      expect(env.REDIS_URL).toBe('redis://10.0.0.4:6379');
      expect(channelSyncEnabled(env)).toBe(true);
    });

    it('treats an unset REDIS_URL as channel sync disabled', () => {
      const env = loadEnv(valid);
      expect(env.REDIS_URL).toBeUndefined();
      expect(channelSyncEnabled(env)).toBe(false);
    });

    /**
     * This one cost a failed production deploy. A deployment with no Redis has
     * to express that somehow, and Terraform conditionals, Cloud Run env vars
     * and `.env` lines all express it as an empty string rather than an unset
     * variable. Rejecting empty meant the no-Redis configuration — the cheap
     * one, the one the first property runs — could not boot at all.
     */
    it('treats an empty REDIS_URL as absent, not as invalid', () => {
      const env = loadEnv({ ...valid, REDIS_URL: '' });
      expect(env.REDIS_URL).toBeUndefined();
      expect(channelSyncEnabled(env)).toBe(false);
    });

    it('treats a whitespace-only REDIS_URL as absent', () => {
      expect(loadEnv({ ...valid, REDIS_URL: '   ' }).REDIS_URL).toBeUndefined();
    });

    // Leniency stops at empty. A URL that is present but wrong is a typo, and a
    // typo that silently disables channel sync would sell rooms twice.
    it('still rejects a non-empty REDIS_URL with the wrong protocol', () => {
      expect(() => loadEnv({ ...valid, REDIS_URL: 'http://10.0.0.4:6379' })).toThrow(/REDIS_URL/);
    });
  });

  describe('production secrets', () => {
    it('refuses to start when the development CREDENTIALS_KEY reaches production', () => {
      const { CREDENTIALS_KEY: _omitted, ...withoutKey } = valid;
      expect(() => loadEnv(withoutKey)).toThrow(/development secrets/i);
    });

    it('refuses to start on a development signing secret', () => {
      expect(() => loadEnv({ ...valid, JWT_ACCESS_SECRET: `dev-only-${'x'.repeat(40)}` })).toThrow(
        /development secrets/i,
      );
    });

    it('allows the development default outside production', () => {
      const { CREDENTIALS_KEY: _omitted, ...withoutKey } = valid;
      expect(() => loadEnv({ ...withoutKey, NODE_ENV: 'development' })).not.toThrow();
    });
  });

  describe('DATABASE_URL', () => {
    it('is required — there is no useful default', () => {
      const { DATABASE_URL: _omitted, ...withoutDb } = valid;
      expect(() => loadEnv(withoutDb)).toThrow(/DATABASE_URL/);
    });

    it('rejects an empty value rather than treating it as absent', () => {
      expect(() => loadEnv({ ...valid, DATABASE_URL: '' })).toThrow(/DATABASE_URL/);
    });
  });
});
