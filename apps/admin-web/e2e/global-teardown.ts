import { readFileSync, rmSync } from 'node:fs';
import { teardown, testDataPath, type TestData } from './fixtures';

export default async function globalTeardown(): Promise<void> {
  const path = testDataPath();
  try {
    const data = JSON.parse(readFileSync(path, 'utf8')) as TestData;
    await teardown(data);
    rmSync(path, { force: true });
    process.stdout.write(`\ne2e: removed organization ${data.organizationSlug}\n`);
  } catch {
    // Setup may have failed before writing the file; nothing to clean.
  }
}
