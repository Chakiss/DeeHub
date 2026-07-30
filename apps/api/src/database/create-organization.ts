/**
 * Creates a real organization, its first property, and an owner account.
 *
 * There is no self-service signup yet (roadmap Phase 3), so onboarding a
 * property is this script. Unlike `db:seed` it creates NO demo data and is safe
 * to run against production — the password is generated, shown once, and never
 * stored anywhere but the hash.
 *
 *   pnpm --filter @deehub/api db:create-org -- \
 *     --name "Baan Suan Resort" --slug baan-suan \
 *     --owner somchai@baansuan.co.th --property "Baan Suan Resort Krabi"
 */
import '../config/load-dotenv';
import { randomBytes } from 'node:crypto';
import { drizzle } from 'drizzle-orm/node-postgres';
import { and, eq } from 'drizzle-orm';
import { Pool } from 'pg';
import { v7 as uuidv7 } from 'uuid';
import { ScryptPasswordHasher } from '../modules/auth/domain/password-hasher';
import * as schema from './schema';

interface Options {
  name: string;
  slug: string;
  owner: string;
  property: string;
  timezone: string;
  currency: string;
  countryCode: string;
}

/**
 * Environment fallback for each flag.
 *
 * Command-line flags are the nicer interface and win when present, but they are
 * not usable everywhere this has to run. A Cloud Run job takes its arguments as
 * a single delimited list that rejects a repeated value — so an organization and
 * its property cannot share a name — and every candidate delimiter collides with
 * the `@` in an owner's email address. Environment variables have neither
 * problem, and the database itself is only reachable from inside the VPC, so a
 * job is how this runs against production.
 */
const ENV_FALLBACK: Record<string, string> = {
  name: 'DEEHUB_ORG_NAME',
  slug: 'DEEHUB_ORG_SLUG',
  owner: 'DEEHUB_OWNER_EMAIL',
  property: 'DEEHUB_PROPERTY_NAME',
  timezone: 'DEEHUB_TIMEZONE',
  currency: 'DEEHUB_CURRENCY',
  country: 'DEEHUB_COUNTRY',
};

function parseArgs(argv: string[]): Options {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key?.startsWith('--')) {
      const value = argv[i + 1];
      if (value && !value.startsWith('--')) {
        flags.set(key.slice(2), value);
        i += 1;
      }
    }
  }

  for (const [flag, variable] of Object.entries(ENV_FALLBACK)) {
    const value = process.env[variable];
    if (!flags.has(flag) && value) flags.set(flag, value);
  }

  const required = ['name', 'slug', 'owner', 'property'] as const;
  const missing = required.filter((key) => !flags.get(key));
  if (missing.length > 0) {
    throw new Error(
      `Missing required option(s): ${missing.map((key) => `--${key}`).join(', ')}\n` +
        'Usage: --name "Hotel Group" --slug hotel-group --owner owner@example.com ' +
        '--property "Hotel Name" [--timezone Asia/Bangkok] [--currency THB] [--country TH]\n' +
        `Or set: ${missing.map((key) => ENV_FALLBACK[key]).join(', ')}`,
    );
  }

  const slug = flags.get('slug')!;
  // The slug is typed at every login, so keep it unambiguous.
  if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(slug)) {
    throw new Error(`Invalid slug "${slug}": use lowercase letters, digits and hyphens`);
  }

  return {
    name: flags.get('name')!,
    slug,
    owner: flags.get('owner')!,
    property: flags.get('property')!,
    timezone: flags.get('timezone') ?? 'Asia/Bangkok',
    currency: (flags.get('currency') ?? 'THB').toUpperCase(),
    countryCode: (flags.get('country') ?? 'TH').toUpperCase(),
  };
}

/**
 * Readable rather than maximally dense: it gets typed once from a screen, and a
 * password nobody can transcribe gets written on a sticky note instead.
 */
function generatePassword(): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const bytes = randomBytes(20);
  const chars = [...bytes].map((byte) => alphabet[byte % alphabet.length]);
  return [chars.slice(0, 5), chars.slice(5, 10), chars.slice(10, 15), chars.slice(15, 20)]
    .map((group) => group.join(''))
    .join('-');
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const connectionString = process.env['DATABASE_URL'];
  if (!connectionString) throw new Error('DATABASE_URL is required');

  const pool = new Pool({ connectionString, max: 2 });
  const db = drizzle(pool, { schema });

  try {
    const existing = await db
      .select({ id: schema.organizations.id })
      .from(schema.organizations)
      .where(eq(schema.organizations.slug, options.slug))
      .limit(1);
    if (existing.length > 0) {
      throw new Error(`An organization with slug "${options.slug}" already exists`);
    }

    const password = generatePassword();
    const passwordHash = await new ScryptPasswordHasher().hash(password);

    const organizationId = uuidv7();
    const propertyId = uuidv7();
    const userId = uuidv7();

    await db.transaction(async (tx) => {
      await tx.insert(schema.organizations).values({
        id: organizationId,
        name: options.name,
        slug: options.slug,
        plan: 'TRIAL',
      });

      await tx.insert(schema.properties).values({
        id: propertyId,
        organizationId,
        code: 'MAIN',
        name: options.property,
        timezone: options.timezone,
        currency: options.currency,
        country: options.countryCode,
      });

      await tx.insert(schema.users).values({
        id: userId,
        organizationId,
        email: options.owner,
        passwordHash,
        fullName: options.owner,
      });

      // Organization-wide OWNER: propertyId null, so they keep full access as
      // more properties are added.
      await tx.insert(schema.memberships).values({
        id: uuidv7(),
        organizationId,
        userId,
        propertyId: null,
        role: 'OWNER',
      });

      await tx.insert(schema.auditLogs).values({
        id: uuidv7(),
        organizationId,
        propertyId,
        actorType: 'SYSTEM',
        actorLabel: 'create-organization',
        action: 'organization.created',
        entityType: 'organization',
        entityId: organizationId,
        after: { name: options.name, slug: options.slug, owner: options.owner },
      });
    });

    // Printed once, deliberately. Nothing stores it but the hash, so if this
    // scrolls past it cannot be recovered — only reset.
    process.stdout.write(
      [
        '',
        `Created "${options.name}"`,
        '',
        `  Organization slug : ${options.slug}`,
        `  Property          : ${options.property} (${propertyId})`,
        `  Timezone/currency : ${options.timezone} / ${options.currency}`,
        '',
        '  Owner sign-in — give these to the hotel, then delete your copy:',
        `    organization : ${options.slug}`,
        `    email        : ${options.owner}`,
        `    password     : ${password}`,
        '',
        '  Shown once. There is no self-service reset yet, so losing it before',
        '  signing in means re-running this against a new email.',
        '',
        '  FIRST THING: sign in and change it at /account. This password was',
        '  generated on a server and may have passed through a log on its way',
        '  to you; changing it also signs out every other session.',
        '',
        '  Then: add room types, rate plans and inventory.',
        '',
      ].join('\n'),
    );
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`\n${error instanceof Error ? error.message : String(error)}\n\n`);
  process.exitCode = 1;
});
