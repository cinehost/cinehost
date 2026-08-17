import pg from 'pg';
import { env } from './env.js';

// smallint[] comes back as strings by default; parse to numbers.
pg.types.setTypeParser(1005, (val) =>
  val === '{}' ? [] : val.slice(1, -1).split(',').map(Number),
);

export const pool = new pg.Pool({
  connectionString: env.databaseUrl,
  max: Number(process.env.PG_POOL_MAX || 10),
});

export const query = (text, params) => pool.query(text, params);

export async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
}
