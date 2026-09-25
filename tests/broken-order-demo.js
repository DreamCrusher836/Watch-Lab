// ============================================================
// tests/broken-order-demo.js
//
// A demonstration, not a test. It proves - against your real database
// - what goes wrong when several related writes are NOT wrapped in a
// transaction, and then shows the same crash doing no harm at all once
// they are.
//
// RUN IT WITH:   node tests/broken-order-demo.js
//
// It cleans up after itself, so your shop is left exactly as it was.
// ============================================================

require('dotenv').config({ quiet: true });

const db = require('../db');

// We use two real watches for the demo. Watch 5 (Trailhead Field) has
// plenty of stock, so we are not going to disturb anything scarce.
const FIRST_WATCH_ID = 5;
const FIRST_QUANTITY = 2;
const SECOND_WATCH_ID = 1;
const SECOND_QUANTITY = 1;

// A name we can recognise, so we never delete a real order by mistake.
const DEMO_NAME = 'DEMO crash test';


// ------------------------------------------------------------
// Little helpers so the output reads like a story.
// ------------------------------------------------------------

function heading(text) {
  console.log('\n' + '='.repeat(64));
  console.log(text);
  console.log('='.repeat(64));
}

async function stockOf(watchId) {
  const result = await db.query('select quantity from stock where watch_id = $1', [watchId]);
  return result.rows[0].quantity;
}

async function priceOf(watchId) {
  const result = await db.query('select price_cents from watches where id = $1', [watchId]);
  return result.rows[0].price_cents;
}


// ============================================================
// PART 1 - the way routes/orders.js does it right now.
//
// Five separate statements, each saved the moment it succeeds.
// We interrupt after the third, exactly as a crash would.
// ============================================================
async function partOneWithoutATransaction() {
  heading('PART 1 - five separate statements, then a crash');

  const stockBefore = await stockOf(FIRST_WATCH_ID);
  console.log('Stock of watch ' + FIRST_WATCH_ID + ' before we start: ' + stockBefore);

  // The total the customer is told they owe - for BOTH watches.
  const total =
    (await priceOf(FIRST_WATCH_ID)) * FIRST_QUANTITY +
    (await priceOf(SECOND_WATCH_ID)) * SECOND_QUANTITY;

  // --- statement 1: the order ---
  const orderResult = await db.query(
    `insert into orders (customer_name, customer_email, status, total_cents)
     values ($1, 'demo@example.com', 'pending', $2)
     returning id`,
    [DEMO_NAME, total]
  );

  const orderId = orderResult.rows[0].id;
  console.log('Created order #' + orderId + ' for a total of ' + total + ' cents (two watches).');

  // --- statement 2: the first line ---
  await db.query(
    `insert into order_items (order_id, watch_id, quantity, unit_price_cents)
     values ($1, $2, $3, $4)`,
    [orderId, FIRST_WATCH_ID, FIRST_QUANTITY, await priceOf(FIRST_WATCH_ID)]
  );
  console.log('Wrote line 1.');

  // --- statement 3: hold the stock for the first line ---
  await db.query(
    'update stock set quantity = quantity - $1 where watch_id = $2',
    [FIRST_QUANTITY, FIRST_WATCH_ID]
  );
  console.log('Took ' + FIRST_QUANTITY + ' off the shelf for line 1.');

  // ---------------------------------------------------------
  // >>> THE CRASH <<<
  // The power goes out. The container is restarted. The network
  // drops. Whatever it is, statements 4 and 5 never happen.
  // ---------------------------------------------------------
  console.log('\n*** The server dies here. Line 2 is never written. ***\n');

  return orderId;
}


// ------------------------------------------------------------
// Look at the damage.
// ------------------------------------------------------------
async function reportTheDamage(orderId) {
  const order = await db.query('select total_cents from orders where id = $1', [orderId]);

  const lines = await db.query(
    `select
       count(*) as line_count,
       coalesce(sum(quantity * unit_price_cents), 0) as lines_total
     from order_items
     where order_id = $1`,
    [orderId]
  );

  const charged = order.rows[0].total_cents;
  const actuallyOnTheOrder = Number(lines.rows[0].lines_total);

  console.log('THE DAMAGE');
  console.log('-'.repeat(64));
  console.log('Order #' + orderId + ' still exists, and still says "pending".');
  console.log('It says the customer owes:        ' + charged + ' cents');
  console.log('But its lines only add up to:     ' + actuallyOnTheOrder + ' cents');
  console.log('Lines actually written:            ' + lines.rows[0].line_count + ' (there should be 2)');
  console.log('Stock of watch ' + FIRST_WATCH_ID + ' is now:            ' + (await stockOf(FIRST_WATCH_ID)));
  console.log('');
  console.log('The customer is billed ' + (charged - actuallyOnTheOrder) + ' cents for a watch that is');
  console.log('not on their order. Nothing errored. Nothing looks broken.');
  console.log('No log line anywhere says "this order is wrong".');
  console.log('-'.repeat(64));
}


// ------------------------------------------------------------
// Put the shop back the way it was, by hand.
//
// Note how fiddly this is - we have to know exactly what was done in
// order to undo it. That is the real cost of not having transactions:
// somebody has to write this cleanup, and get it right, forever.
// ------------------------------------------------------------
async function cleanUpTheDamage(orderId) {
  await db.query(
    'update stock set quantity = quantity + $1 where watch_id = $2',
    [FIRST_QUANTITY, FIRST_WATCH_ID]
  );

  // Deleting the order removes its lines too, thanks to "on delete
  // cascade" on order_items.order_id.
  await db.query('delete from orders where id = $1', [orderId]);

  console.log('\n(Tidied up by hand. Stock of watch ' + FIRST_WATCH_ID + ' is back to ' + (await stockOf(FIRST_WATCH_ID)) + '.)');
}


// ============================================================
// PART 2 - the same crash, inside a transaction.
// ============================================================
async function partTwoWithATransaction() {
  heading('PART 2 - the same crash, inside a transaction');

  const stockBefore = await stockOf(FIRST_WATCH_ID);
  const ordersBefore = await db.query('select count(*) as n from orders');

  console.log('Stock of watch ' + FIRST_WATCH_ID + ' before we start: ' + stockBefore);
  console.log('Orders in the table before we start: ' + ordersBefore.rows[0].n);

  // A transaction must run on ONE connection from start to finish.
  // pool.connect() checks a single taxi out of the rank and keeps it.
  const client = await db.pool.connect();

  try {
    // BEGIN opens the transaction. From here on, nothing we write is
    // real to anybody else until we say COMMIT.
    await client.query('begin');

    const total =
      (await priceOf(FIRST_WATCH_ID)) * FIRST_QUANTITY +
      (await priceOf(SECOND_WATCH_ID)) * SECOND_QUANTITY;

    const orderResult = await client.query(
      `insert into orders (customer_name, customer_email, status, total_cents)
       values ($1, 'demo@example.com', 'pending', $2)
       returning id`,
      [DEMO_NAME, total]
    );

    const orderId = orderResult.rows[0].id;
    console.log('Created order #' + orderId + ' ... but only inside the transaction.');

    await client.query(
      `insert into order_items (order_id, watch_id, quantity, unit_price_cents)
       values ($1, $2, $3, $4)`,
      [orderId, FIRST_WATCH_ID, FIRST_QUANTITY, await priceOf(FIRST_WATCH_ID)]
    );
    console.log('Wrote line 1 ... inside the transaction.');

    await client.query(
      'update stock set quantity = quantity - $1 where watch_id = $2',
      [FIRST_QUANTITY, FIRST_WATCH_ID]
    );
    console.log('Took stock ... inside the transaction.');

    // >>> THE SAME CRASH <<<
    console.log('\n*** The server dies here again. ***\n');
    throw new Error('simulated crash');
  } catch (error) {
    // ROLLBACK means: forget everything since BEGIN. Not "undo it
    // step by step" - it was never really written in the first place.
    await client.query('rollback');
    console.log('ROLLBACK ran. Everything since BEGIN was thrown away.\n');
  } finally {
    // Always give the connection back, whatever happened. Forgetting
    // this leaks connections until the pool runs dry and the whole app
    // hangs - a nasty bug, because it only shows up under load.
    client.release();
  }

  const ordersAfter = await db.query('select count(*) as n from orders');

  console.log('THE DAMAGE');
  console.log('-'.repeat(64));
  console.log('Stock of watch ' + FIRST_WATCH_ID + ' is now:            ' + (await stockOf(FIRST_WATCH_ID)) + '   (was ' + stockBefore + ')');
  console.log('Orders in the table:               ' + ordersAfter.rows[0].n + '   (was ' + ordersBefore.rows[0].n + ')');
  console.log('');
  console.log('Nothing happened. No half-order, no missing stock,');
  console.log('no cleanup to write. The crash left no trace at all.');
  console.log('-'.repeat(64));
}


// ============================================================
// Run the two parts one after the other.
// ============================================================
async function main() {
  try {
    const orderId = await partOneWithoutATransaction();
    await reportTheDamage(orderId);
    await cleanUpTheDamage(orderId);

    await partTwoWithATransaction();

    heading('THE POINT');
    console.log('Both parts crashed in exactly the same place.');
    console.log('Without a transaction, the crash left permanent, silent damage');
    console.log('and somebody had to write code to clean it up.');
    console.log('With a transaction, the crash cost nothing.');
    console.log('');
    console.log('A transaction is "all of this, or none of it".');
  } catch (error) {
    console.error('\nThe demo could not run:', error.message);
    console.error('Have you run sql/02_orders_and_order_items.sql in Supabase?');
  } finally {
    // Close the pool so node can exit instead of waiting forever.
    await db.pool.end();
  }
}

main();
