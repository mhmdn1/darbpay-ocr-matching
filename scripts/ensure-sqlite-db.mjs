import 'dotenv/config';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

const databaseUrl = process.env.DATABASE_URL?.trim() || 'file:./dev.db';

// Prisma migrate handles non-SQLite databases itself. This helper only works
// around Prisma 7's SQLite behavior where migrate deploy expects the file to
// exist before applying the initial migration.
if (!databaseUrl.startsWith('file:')) {
  console.log('Database is not SQLite; no local file initialization needed.');
  process.exit(0);
}

const configuredPath = decodeURIComponent(databaseUrl.slice('file:'.length).split('?')[0]);
if (!configuredPath) throw new Error('DATABASE_URL must include a SQLite file path');

const databasePath = isAbsolute(configuredPath)
  ? configuredPath
  : resolve(process.cwd(), configuredPath);

mkdirSync(dirname(databasePath), { recursive: true });
closeSync(openSync(databasePath, 'a'));
console.log(`SQLite database ready: ${databasePath}`);
