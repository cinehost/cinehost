#!/usr/bin/env node
// Numbered .sql files, applied in order, tracked in schema_migrations.
// Deliberately dumb - a migration framework is more machinery than this needs.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations');

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

await client.query(`
  create table if not exists schema_migrations (
    version text primary key,
    applied_at timestamptz not null default now()
  )
`);

const { rows } = await client.query('select version from schema_migrations');
const applied = new Set(rows.map((r) => r.version));

const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
let ran = 0;

for (const file of files) {
  if (applied.has(file)) continue;
  const sql = readFileSync(join(dir, file), 'utf8');
  process.stdout.write(`applying ${file} ... `);
  try {
    await client.query('begin');
    await client.query(sql);
    await client.query('insert into schema_migrations (version) values ($1)', [file]);
    await client.query('commit');
    console.log('ok');
    ran += 1;
  } catch (err) {
    await client.query('rollback');
    console.log('FAILED');
    console.error(err.message);
    await client.end();
    process.exit(1);
  }
}

console.log(ran === 0 ? 'nothing to apply' : `${ran} migration(s) applied`);
await client.end();
