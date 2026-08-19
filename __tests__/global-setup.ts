import { copyFileSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require('better-sqlite3');

/**
 * Prepare a fresh test.db before any test worker starts.
 *
 * We clone dev.db (which the developer produced with `npm run db:push`) and
 * truncate every table. This keeps test startup fast while ensuring tests
 * never mutate the developer's demo data.
 * If dev.db doesn't exist, we bail out with a clear message.
 */
export default async function globalSetup(): Promise<void> {
  const cwd = process.cwd();
  const devDb = join(cwd, 'dev.db');
  const testDb = join(cwd, 'test.db');

  if (!existsSync(devDb)) {
    throw new Error(
      'test setup: dev.db not found — run `npm run db:push` once so the tests have a schema to clone.',
    );
  }

  if (existsSync(testDb)) unlinkSync(testDb);
  if (existsSync(`${testDb}-journal`)) unlinkSync(`${testDb}-journal`);

  copyFileSync(devDb, testDb);

  // Truncate any pre-existing rows carried over from dev.db.
  const db = new Database(testDb);
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name != '_prisma_migrations'")
    .all() as Array<{ name: string }>;
  db.exec('PRAGMA foreign_keys=OFF');
  for (const { name } of tables) db.exec(`DELETE FROM "${name}"`);
  db.exec('PRAGMA foreign_keys=ON');
  // Prisma's schema DSL cannot express a partial unique index. Mirror the
  // production migration so integration tests exercise the real invariant.
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS "one_confirmed_document_per_transaction"
    ON "DocumentMatch"("transactionId")
    WHERE "status" IN ('CONFIRMED', 'AUTO_CONFIRMED')
  `);
  db.close();
}
