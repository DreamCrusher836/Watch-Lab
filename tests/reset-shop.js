// ============================================================
// tests/reset-shop.js
//
// Puts the shop back to its opening-day state: six watches with
// their seeded stock, and no orders or payments at all.
//
// RUN IT WITH:   npm run reset
//
// Use it whenever your test data has drifted and you want a clean
// shop to demonstrate or explore with. It does NOT need the server
// to be running - it talks to the database directly.
//
// ⚠️  IT DELETES EVERY ORDER. That is the point, and it is fine here
// because this is a practice shop. You would never put a script like
// this anywhere near a real one.
// ============================================================

require('dotenv').config({ quiet: true });

const db = require('../db');

// The seeded quantities from sql/01_watches_and_stock.sql, kept in
// one place so this script and that file cannot disagree.
//
// Skyline Pilot is 1 on purpose - it is the watch the race test in
// step 9 fights over. Pulse Smart is 0 on purpose, so the shop always
// has one sold-out card to show.
const SEED_STOCK = [
  { name: 'Harbour Diver', quantity: 8 },
  { name: 'Meridian Dress', quantity: 5 },
  { name: 'Apex Chrono', quantity: 3 },
  { name: 'Skyline Pilot', quantity: 1 },
  { name: 'Trailhead Field', quantity: 10 },
  { name: 'Pulse Smart', quantity: 0 },
];


async function main() {
  // Everything happens in one transaction. If anything goes wrong
  // half way through, we do not want a shop with no orders but the
  // old stock numbers - that would be worse than leaving it alone.
  const client = await db.pool.connect();

  try {
    await client.query('begin');

    // Deleting the orders removes their order_items and payments rows
    // too, because both of those foreign keys were declared with
    // "on delete cascade" (see sql/02 and sql/03).
    const deleted = await client.query('delete from orders returning id');

    for (const seed of SEED_STOCK) {
      // We look the watch up by NAME rather than hard-coding id
      // numbers, so this still works if you ever re-run sql/01 and
      // Postgres hands out different ids.
      const result = await client.query(
        `update stock
            set quantity = $1,
                updated_at = now()
          where watch_id = (select id from watches where name = $2)
        returning quantity`,
        [seed.quantity, seed.name]
      );

      if (result.rowCount === 0) {
        // Better to stop loudly than to half-reset and say nothing.
        throw new Error('No watch called "' + seed.name + '". Have you run sql/01?');
      }
    }

    await client.query('commit');

    console.log('Shop reset.');
    console.log('  Deleted ' + deleted.rowCount + ' order(s), with their items and payment records.');
    console.log('  Stock back to:');

    for (const seed of SEED_STOCK) {
      console.log('    ' + seed.name.padEnd(18) + seed.quantity);
    }

    console.log('\nThe Skyline Pilot is at 1 on purpose - it is the watch the');
    console.log('race test fights over. The Pulse Smart is at 0 so the shop');
    console.log('always has a sold-out card to show.');
  } catch (error) {
    try {
      await client.query('rollback');
    } catch (rollbackError) {
      console.error('Rollback itself failed:', rollbackError.message);
    }

    console.error('\nCould not reset the shop:', error.message);
  } finally {
    client.release();
    await db.pool.end();
  }
}

main();
