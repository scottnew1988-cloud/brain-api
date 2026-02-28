// ──────────────────────────────────────────────────────────────────────
// DATABASE
// Postgres connection pool via node-postgres (pg).
//
// Required env var:
//   DATABASE_URL  — Postgres connection string
//                   e.g. postgres://user:pass@host:5432/dbname
//                   Set ?sslmode=require for Supabase / Render Postgres.
// ──────────────────────────────────────────────────────────────────────

import pg from "pg";

const { Pool } = pg;

// ── CONNECTION POOL ────────────────────────────────────────────────────

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Render Postgres and Supabase both require SSL
  ssl: process.env.DATABASE_URL && !process.env.DATABASE_URL.includes("localhost")
    ? { rejectUnauthorized: false }
    : false,
  // Conservative pool settings — tune for your Render plan
  max:             10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

pool.on("error", (err) => {
  console.error("[DB] Unexpected pool error:", err.message);
});

// ── HELPERS ────────────────────────────────────────────────────────────

/**
 * Execute a single parameterised query.
 * Returns the pg QueryResult object.
 *
 * @param {string}   sql
 * @param {any[]}    [params]
 * @returns {Promise<pg.QueryResult>}
 */
export async function query(sql, params) {
  try {
    return await pool.query(sql, params);
  } catch (err) {
    console.error("[DB] Query error:", err.message, "\nSQL:", sql.slice(0, 200));
    throw err;
  }
}

/**
 * Run a function inside a BEGIN / COMMIT transaction.
 * If the function throws, the transaction is rolled back.
 *
 * The pg client is passed to the callback so all queries in the
 * function share the same connection (required for advisory locks,
 * SELECT … FOR UPDATE, etc.).
 *
 * @param {(client: pg.PoolClient) => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Acquire a session-level advisory lock for the duration of a transaction.
 *
 * pg_advisory_xact_lock blocks until it obtains the lock.
 * The lock is automatically released when the transaction ends.
 *
 * @param {pg.PoolClient} client  — must be inside a transaction
 * @param {number}        lockKey — application-defined integer
 */
export async function acquireAdvisoryLock(client, lockKey) {
  await client.query("SELECT pg_advisory_xact_lock($1)", [lockKey]);
}

// ── STARTUP CHECK ──────────────────────────────────────────────────────

/**
 * Verify the DB connection and ensure the sweep_state singleton row
 * exists (safe to run every startup).
 */
export async function initDb() {
  try {
    await pool.query("SELECT 1");
    // Ensure sweep_state singleton exists (schema.sql does this too,
    // but this guards against partial migrations)
    await pool.query(
      `INSERT INTO sweep_state (id, run_count) VALUES (1, 0)
       ON CONFLICT (id) DO NOTHING`
    );
    console.log("[DB] Connected and ready");
  } catch (err) {
    console.error("[DB] Startup check failed:", err.message);
    console.error("[DB] Ensure DATABASE_URL is set and schema.sql has been applied");
    // Do not crash the process — allow health-check endpoint to respond
  }
}
