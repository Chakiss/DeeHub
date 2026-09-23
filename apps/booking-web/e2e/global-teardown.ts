import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { teardown, testDataPath, type TestData } from './fixtures';

export default async function globalTeardown(): Promise<void> {
  const path = testDataPath();
  if (!existsSync(path)) return;
  const data = JSON.parse(readFileSync(path, 'utf8')) as TestData;
  await teardown(data);
  unlinkSync(path);
  process.stdout.write(`e2e: removed organization ${data.organizationSlug}\n`);
}
