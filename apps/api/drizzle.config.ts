import './src/config/load-dotenv';
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/database/schema/index.ts',
  out: './src/database/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgresql://deehub:deehub@localhost:15432/deehub',
  },
  // Generated SQL is reviewed and committed; drizzle-kit never touches a
  // deployed database directly (docs/database.md §12).
  strict: true,
  verbose: true,
});
