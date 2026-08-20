import { existsSync, readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require('better-sqlite3');

/**
 * Prepare a fresh test.db before any test worker starts.
 *
 * Build test.db from committed migrations. Tests no longer depend on a
 * developer's mutable dev.db and therefore exercise fresh-install behavior.
 */
export default async function globalSetup(): Promise<void> {
  const cwd = process.cwd();
  const testDb = join(cwd, 'test.db');

  if (existsSync(testDb)) unlinkSync(testDb);
  if (existsSync(`${testDb}-journal`)) unlinkSync(`${testDb}-journal`);

  const db = new Database(testDb);
  const migrationsDir = join(cwd, 'prisma', 'migrations');
  for (const directory of readdirSync(migrationsDir).sort()) {
    const migration = join(migrationsDir, directory, 'migration.sql');
    if (existsSync(migration)) db.exec(readFileSync(migration, 'utf8'));
  }
  db.close();
}
