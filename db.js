// ============================================================
// db.js - the one and only connection to our PostgreSQL database.
//
// Every route file will require() this file. That is deliberate:
// we want ONE shared connection pool for the whole application,
// not a new connection per request.
// ============================================================

// dotenv reads the secret values out of the .env file and puts them
// into process.env, so we can read them below. We keep secrets in a
// file that is never committed to git, instead of typing them into
// our code where anyone reading the code could see them.
// ("quiet: true" just stops dotenv printing a note every time it loads.)
require('dotenv').config({ quiet: true });

// "Pool" comes from the "pg" library (pg = PostGres).
const { Pool } = require('pg');

// A friendly early warning. Without this, a missing DATABASE_URL shows up
// later as a confusing, almost empty error. It is worth spending three
// lines to turn a mystery into a clear instruction.
if (!process.env.DATABASE_URL) {
  console.warn('WARNING: DATABASE_URL is empty. Open the .env file and paste your Supabase connection string.');
}

// ------------------------------------------------------------
// WHAT IS A POOL? (new concept)
//
// Opening a connection to a database is slow - it involves a network
// handshake and a login. If we opened a fresh one for every visitor,
// the site would crawl.
//
// A pool is a small set of connections that stay open and get reused.
// Think of a taxi rank: instead of building a new taxi each time
// someone needs a ride, a handful of taxis wait at the rank, take a
// passenger, drop them off, and return to the rank for the next one.
//
// We ask the pool for a connection, use it, and give it straight back.
// ------------------------------------------------------------
const pool = new Pool({
  // The full address of our Supabase database, including the password.
  // It lives in .env because it is a secret.
  connectionString: process.env.DATABASE_URL,

  // Supabase requires an encrypted (SSL) connection.
  // "rejectUnauthorized: false" tells node not to fuss about the exact
  // certificate authority. This is normal and fine for connecting to
  // Supabase from a local practice project.
  ssl: { rejectUnauthorized: false },
});

// ------------------------------------------------------------
// A tiny helper so our route files can run a query in one line.
//
// "text" is the SQL, e.g. 'select * from watches where id = $1'
// "params" is an array of the values, e.g. [7]
//
// IMPORTANT RULE - PARAMETERISED QUERIES:
// We always pass values separately as $1, $2, $3 and never glue them
// into the SQL string. Glueing lets a visitor type SQL into a form
// field and have our database run it - that attack is called SQL
// injection. With $1, Postgres treats the value as DATA only, never
// as instructions. It is the difference between handing someone a
// sealed envelope and reading their letter out loud as commands.
// ------------------------------------------------------------
async function query(text, params) {
  const result = await pool.query(text, params);
  return result;
}

// We export BOTH:
//  - query: for ordinary one-off queries (most of the app)
//  - pool:  for step 5 onwards, when a transaction needs to grab one
//           single connection and keep it for several statements
module.exports = { query, pool };
