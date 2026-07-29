/**
 * Loads the repo-root .env for local development.
 *
 * Import this FIRST, before anything that reads process.env.
 *
 * The path is resolved relative to this file rather than process.cwd(): in a
 * monorepo the working directory is the app, not the repo root, so a bare
 * `dotenv/config` silently finds nothing and the app fails validation with
 * "DATABASE_URL is required" while a perfectly good .env sits two levels up.
 *
 * In production (Cloud Run) there is no .env file and real environment
 * variables are used; dotenv is a no-op when the file is absent.
 */
import { config } from 'dotenv';
import { resolve } from 'node:path';

// dist/ and src/ sit at the same depth, so one path works for both the
// compiled build and ts-node/tsx development.
config({ path: resolve(__dirname, '../../../../.env'), quiet: true });
