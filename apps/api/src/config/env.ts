import { z } from 'zod';

/**
 * Environment contract.
 *
 * The application refuses to start on invalid configuration (architecture.md
 * §10). A service that boots with a missing secret and fails later, in
 * production, under load, is far worse than one that refuses to boot at all.
 */

const nonEmpty = (label: string) => z.string().min(1, `${label} must not be empty`);

const connectionUrl = (label: string, protocols: readonly string[]) =>
  nonEmpty(label).refine(
    (value) => protocols.some((protocol) => value.startsWith(`${protocol}://`)),
    `${label} must start with ${protocols.map((p) => `${p}://`).join(' or ')}`,
  );

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().max(65535).default(3001),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  DATABASE_URL: connectionUrl('DATABASE_URL', ['postgresql', 'postgres']),
  /**
   * Optional. Absent means channel sync is DISABLED: the API and the outbox
   * relay still work, but anything that would enqueue a job fails loudly
   * rather than silently dropping it. Required before connecting any OTA.
   */
  REDIS_URL: connectionUrl('REDIS_URL', ['redis', 'rediss']).optional(),

  // 32 chars minimum: a short signing secret makes JWTs brute-forceable.
  JWT_ACCESS_SECRET: nonEmpty('JWT_ACCESS_SECRET').min(32),
  JWT_REFRESH_SECRET: nonEmpty('JWT_REFRESH_SECRET').min(32),
  JWT_ACCESS_TTL: z.coerce.number().int().positive().default(900),
  JWT_REFRESH_TTL: z.coerce.number().int().positive().default(2_592_000),

  // AES-256 key for channel credentials at rest. openssl rand -base64 32
  CREDENTIALS_KEY: nonEmpty('CREDENTIALS_KEY').default(
    // Development default only; production rejects it below.
    'ZGV2LW9ubHkta2V5LW5vdC1mb3ItcHJvZHVjdGlvbiE=',
  ),

  STORAGE_ENDPOINT: z.string().optional(),
  STORAGE_REGION: z.string().default('ap-southeast-1'),
  STORAGE_BUCKET: z.string().default('deehub-local'),
  STORAGE_ACCESS_KEY: z.string().optional(),
  STORAGE_SECRET_KEY: z.string().optional(),

  CORS_ORIGINS: z
    .string()
    .default('http://localhost:3000')
    .transform((value) =>
      value
        .split(',')
        .map((origin) => origin.trim())
        .filter((origin) => origin.length > 0),
    ),

  SENTRY_DSN: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = envSchema.safeParse(source);

  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${problems}`);
  }

  const env = result.data;

  if (env.NODE_ENV === 'production') {
    // Dev defaults must never reach production. Fail loudly at boot.
    const weakSecrets = (
      [
        ['JWT_ACCESS_SECRET', env.JWT_ACCESS_SECRET],
        ['JWT_REFRESH_SECRET', env.JWT_REFRESH_SECRET],
        // Base64 of a string containing 'dev-only'; decode before checking.
        ['CREDENTIALS_KEY', Buffer.from(env.CREDENTIALS_KEY, 'base64').toString('utf8')],
      ] as const
    ).filter(([, value]) => value.includes('dev-only'));

    if (weakSecrets.length > 0) {
      throw new Error(
        `Refusing to start: development secrets detected in production for ` +
          weakSecrets.map(([name]) => name).join(', '),
      );
    }
  }

  return env;
}

export const ENV = Symbol('ENV');
