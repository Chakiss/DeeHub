import { writeFileSync } from 'node:fs';
import { seed, testDataPath } from './fixtures';

export default async function globalSetup(): Promise<void> {
  const data = await seed();
  writeFileSync(testDataPath(), JSON.stringify(data, null, 2));
  process.stdout.write(`\ne2e: seeded organization ${data.organizationSlug}\n`);
}
