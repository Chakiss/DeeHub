import { readFileSync, rmSync } from 'node:fs';
import { teardown, testDataPath, type TestData } from './fixtures';

export default async function globalTeardown(): Promise<void> {
  const path = testDataPath();

  let data: TestData;
  try {
    data = JSON.parse(readFileSync(path, 'utf8')) as TestData;
  } catch {
    // Setup failed before writing the file. Nothing was created, nothing to clean.
    return;
  }

  /*
   * A failed delete is reported, never swallowed.
   *
   * The original bare `catch {}` covered both "no file" and "the delete blew
   * up", so when the channel tables were missing from the delete list every
   * run silently stranded an organization — and said "removed" was never
   * printed, which nobody reads when the tests passed.
   */
  try {
    await teardown(data);
  } catch (error) {
    process.stderr.write(
      `\ne2e: FAILED to remove organization ${data.organizationSlug} — ` +
        `it is still in the database.\n${String(error)}\n`,
    );
    throw error;
  }

  rmSync(path, { force: true });
  process.stdout.write(`\ne2e: removed organization ${data.organizationSlug}\n`);
}
