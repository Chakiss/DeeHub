/**
 * Changes the address a user signs in with.
 *
 * Written because onboarding a property put a placeholder into production: the
 * command to create an organization was run with `<อีเมลเจ้าของโรงแรม>` still in
 * it, and `create-organization` accepted the string without looking at it. The
 * result is an account nobody can reach — the sign-in form is `type="email"`,
 * so the browser refuses to submit it, and there is no screen that edits a user
 * who cannot be signed in as.
 *
 * The obvious alternatives are worse. Creating a second owner needs somebody
 * signed in to invite them. Deleting the organization means unpicking every
 * table that references it with RESTRICT, and the moment it holds one real
 * booking that stops being an option at all.
 *
 *   DEEHUB_ORG_SLUG=lets-chill \
 *   DEEHUB_CURRENT_EMAIL='<placeholder>' \
 *   DEEHUB_NEW_EMAIL=owner@hotel.co.th \
 *     pnpm --filter @deehub/api db:set-user-email
 *
 * Every live session and refresh token for that user is revoked, because an
 * address change is either a correction or a handover, and both mean the person
 * holding the old session may not be the person who should hold the new one.
 */
import '../config/load-dotenv';
import { drizzle } from 'drizzle-orm/node-postgres';
import { and, eq } from 'drizzle-orm';
import { Pool } from 'pg';
import { normaliseEmailAddress } from '../common/validation/email-address';
import * as schema from './schema';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function main(): Promise<void> {
  const slug = required('DEEHUB_ORG_SLUG');
  const currentEmail = required('DEEHUB_CURRENT_EMAIL');
  const newEmail = normaliseEmailAddress(required('DEEHUB_NEW_EMAIL'), 'new email');

  const connectionString = process.env['DATABASE_URL'];
  if (!connectionString) throw new Error('DATABASE_URL is required');

  const pool = new Pool({ connectionString, max: 2 });
  const db = drizzle(pool, { schema });

  try {
    const [organization] = await db
      .select({ id: schema.organizations.id, name: schema.organizations.name })
      .from(schema.organizations)
      .where(eq(schema.organizations.slug, slug))
      .limit(1);
    if (!organization) throw new Error(`No organization with slug "${slug}"`);

    const [user] = await db
      .select({ id: schema.users.id, email: schema.users.email })
      .from(schema.users)
      .where(
        and(eq(schema.users.organizationId, organization.id), eq(schema.users.email, currentEmail)),
      )
      .limit(1);
    if (!user) {
      throw new Error(`No user "${currentEmail}" in ${slug}. Nothing changed.`);
    }

    const [clash] = await db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(
        and(eq(schema.users.organizationId, organization.id), eq(schema.users.email, newEmail)),
      )
      .limit(1);
    if (clash) {
      throw new Error(`"${newEmail}" already signs in to ${slug}. Nothing changed.`);
    }

    await db.transaction(async (tx) => {
      await tx
        .update(schema.users)
        .set({ email: newEmail, updatedAt: new Date() })
        .where(eq(schema.users.id, user.id));

      // Whoever was signed in as the old address does not automatically get to
      // stay signed in as the new one.
      await tx.delete(schema.refreshTokens).where(eq(schema.refreshTokens.userId, user.id));
    });

    console.log(`${organization.name}: ${user.email} → ${newEmail}`);
    console.log('Sessions revoked. The password is unchanged — sign in with it, then change it.');
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
