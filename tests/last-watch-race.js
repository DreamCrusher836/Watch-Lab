// ============================================================
// tests/last-watch-race.js
//
// Two people click "Place order" for the LAST Skyline Pilot at the
// same instant. Proves exactly one of them gets it.
//
// RUN IT LIKE THIS:
//   1. In one terminal:   npm start
//   2. In another:        node tests/last-watch-race.js
//
// It cleans up after itself, so your shop is left as it was.
//
// ------------------------------------------------------------
// WHAT IS A RACE CONDITION?
//
// A bug where the result depends on the exact timing of two things
// happening at once - so it works perfectly every time you try it by
// hand, and then goes wrong on a busy Friday.
//
// The classic shape is CHECK, then ACT:
//
//     if (there is enough stock) {      <- check
//         take the stock                <- act
//     }
//
// Between the check and the act there is a gap. Another customer can
// slip into that gap, pass the same check, and act too. Both were
// honestly told "yes". The last watch is sold twice.
//
// It is two people reaching for the last item on a shelf. Whether it
// goes wrong depends entirely on whose hand arrives first, measured
// in milliseconds - which is why you cannot find these bugs by
// clicking around, and why this file exists.
// ============================================================

require('dotenv').config({ quiet: true });

const db = require('../db');

const BASE_URL = 'http://localhost:' + (process.env.PORT || 3000);

// The Skyline Pilot - seeded with a stock of 1 for exactly this test.
const WATCH_ID = 4;

// A distinctive email so cleanup can only delete orders this test made.
const TEST_EMAIL = 'race-test@lab.local';


// ------------------------------------------------------------
// The same tiny test helpers as tests/duplicate-webhook.js.
// ------------------------------------------------------------
let passed = 0;
let failed = 0;

function check(description, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);

  if (ok) {
    passed++;
    console.log('  PASS  ' + description);
  } else {
    failed++;
    console.log('  FAIL  ' + description);
    console.log('        expected: ' + JSON.stringify(expected));
    console.log('        actually: ' + JSON.stringify(actual));
  }
}

function heading(text) {
  console.log('\n' + '='.repeat(66));
  console.log(text);
  console.log('='.repeat(66));
}


async function stockOf(watchId) {
  const result = await db.query('select quantity from stock where watch_id = $1', [watchId]);
  return result.rows[0].quantity;
}

async function setStock(watchId, quantity) {
  await db.query(
    'update stock set quantity = $1, updated_at = now() where watch_id = $2',
    [quantity, watchId]
  );
}


// Place an order through the real API, exactly as the cart page does.
// Returns the status code and body rather than throwing, because here
// a refusal is a RESULT we want to measure, not an error.
async function tryToOrder(buyerName, quantity) {
  const response = await fetch(BASE_URL + '/api/orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      customerName: buyerName,
      customerEmail: TEST_EMAIL,
      items: [{ watchId: WATCH_ID, quantity: quantity }],
    }),
  });

  return { status: response.status, body: await response.json() };
}


// ============================================================
// PART 1 - two buyers, one watch, at the same instant.
// ============================================================
async function partOneTwoBuyersOneWatch() {
  heading('PART 1 - two buyers, one Skyline Pilot, same instant');

  await setStock(WATCH_ID, 1);
  console.log('Skyline Pilot stock: 1  (the last one)');
  console.log('Anna and Ben both click "Place order" at the same moment...\n');

  // Promise.all starts BOTH requests without waiting for the first to
  // finish, so they are genuinely in flight together. Two separate
  // awaits would run one after the other and test nothing.
  const [anna, ben] = await Promise.all([
    tryToOrder('Anna', 1),
    tryToOrder('Ben', 1),
  ]);

  console.log('Anna -> ' + anna.status + ' ' + JSON.stringify(anna.body.error || ('order #' + anna.body.orderId)));
  console.log('Ben  -> ' + ben.status + ' ' + JSON.stringify(ben.body.error || ('order #' + ben.body.orderId)));
  console.log('');

  // We do not know or care WHICH of them wins - that is genuinely
  // down to microseconds. We care that exactly one did.
  // Sorting turns "one 201 and one 409, in either order" into a
  // single value we can compare against.
  const statuses = [anna.status, ben.status].sort();

  check('one was created and one was refused', statuses, [201, 409]);
  check('the shelf is now empty', await stockOf(WATCH_ID), 0);
  check('stock never went negative', (await stockOf(WATCH_ID)) >= 0, true);

  const orderCount = await db.query(
    'select count(*) as n from orders where customer_email = $1',
    [TEST_EMAIL]
  );

  check('exactly one order was created', Number(orderCount.rows[0].n), 1);

  // The loser must get a clear, human explanation - not a crash.
  const loser = anna.status === 409 ? anna : ben;
  check('the loser was told why, in plain English',
    typeof loser.body.error === 'string' && loser.body.error.includes('Not enough stock'),
    true);

  console.log('\n  The loser saw: "' + loser.body.error + '"');
}


// ============================================================
// PART 2 - the same thing, but with a crowd.
//
// Ten people, three watches. Exactly three must win. This catches
// bugs that a two-way race is too small to reveal.
// ============================================================
async function partTwoACrowd() {
  heading('PART 2 - ten buyers, three watches');

  // Clear out part 1's order so the count starts fresh.
  await db.query('delete from orders where customer_email = $1', [TEST_EMAIL]);
  await setStock(WATCH_ID, 3);

  console.log('Skyline Pilot stock: 3');
  console.log('Ten people click "Place order" at once...\n');

  // Build ten attempts and start them all together.
  const attempts = [];

  for (let buyerNumber = 1; buyerNumber <= 10; buyerNumber++) {
    attempts.push(tryToOrder('Buyer ' + buyerNumber, 1));
  }

  const results = await Promise.all(attempts);

  // filter() keeps only the entries that pass the test, so .length
  // counts them.
  const created = results.filter(function (r) { return r.status === 201; });
  const refused = results.filter(function (r) { return r.status === 409; });
  const other = results.filter(function (r) { return r.status !== 201 && r.status !== 409; });

  console.log('  created (201): ' + created.length);
  console.log('  refused (409): ' + refused.length);
  console.log('  anything else: ' + other.length);
  console.log('');

  check('exactly three buyers got a watch', created.length, 3);
  check('the other seven were refused', refused.length, 7);

  // This one matters as much as the others. Nobody should get a
  // 500, a deadlock error, or a timeout. Losing politely is part of
  // working correctly.
  check('nobody got an unexpected error', other.length, 0);
  check('the shelf is empty, not negative', await stockOf(WATCH_ID), 0);

  const orderCount = await db.query(
    'select count(*) as n from orders where customer_email = $1',
    [TEST_EMAIL]
  );

  check('exactly three orders exist', Number(orderCount.rows[0].n), 3);
}


// ============================================================
// PART 3 - what the OLD code did, for comparison.
//
// This does not go through our route. It runs the naive
// "check, then act" sequence by hand on two connections, so you can
// watch both customers be told "yes" for the same single watch.
// ============================================================
async function partThreeTheOldWay() {
  heading('PART 3 - the naive way, so you can see it lose');

  await db.query('delete from orders where customer_email = $1', [TEST_EMAIL]);
  await setStock(WATCH_ID, 1);

  console.log('Skyline Pilot stock: 1  (the last one, again)');
  console.log('This time using the step-4 logic: SELECT first, then UPDATE.\n');

  // Two separate connections = two separate customers.
  const anna = await db.pool.connect();
  const ben = await db.pool.connect();

  try {
    await anna.query('begin');
    await ben.query('begin');

    // --- BOTH CHECK, before either acts ---
    const annaSees = await anna.query('select quantity from stock where watch_id = $1', [WATCH_ID]);
    const benSees = await ben.query('select quantity from stock where watch_id = $1', [WATCH_ID]);

    console.log('Anna checks the shelf and sees: ' + annaSees.rows[0].quantity);
    console.log('Ben checks the shelf and sees:  ' + benSees.rows[0].quantity);

    const annaSaysYes = annaSees.rows[0].quantity >= 1;
    const benSaysYes = benSees.rows[0].quantity >= 1;

    console.log('\nAnna\'s code decides: ' + (annaSaysYes ? 'YES, there is one' : 'no'));
    console.log('Ben\'s code decides:  ' + (benSaysYes ? 'YES, there is one' : 'no'));

    // THIS is the bug, visible in one line.
    check('the old code told BOTH customers yes for ONE watch', [annaSaysYes, benSaysYes], [true, true]);

    console.log('\nBoth were promised the same watch. Now they both try to take it.\n');

    // --- now they act ---
    await anna.query('update stock set quantity = quantity - 1 where watch_id = $1', [WATCH_ID]);
    await anna.query('commit');
    console.log('Anna took it and committed. Stock is now 0.');

    let benFailed = false;
    let benError = '';

    try {
      // Ben's update waits for Anna's commit, then tries to take one
      // from a shelf that now has none: 0 - 1 = -1.
      await ben.query('update stock set quantity = quantity - 1 where watch_id = $1', [WATCH_ID]);
      await ben.query('commit');
      console.log('Ben ALSO took it. Stock is now -1. The watch was sold twice.');
    } catch (error) {
      benFailed = true;
      benError = error.message;
      await ben.query('rollback');
      console.log('Ben\'s update was REJECTED by the database:');
      console.log('  "' + error.message + '"');
    }

    check('the database refused to let stock go negative', benFailed, true);
    check('stock ended at 0, not -1', await stockOf(WATCH_ID), 0);

    console.log('\n  Read that carefully. The CODE sold the watch twice.');
    console.log('  The only thing that stopped an oversell was the');
    console.log('  check(quantity >= 0) constraint we wrote in step 1 -');
    console.log('  and the customer it saved got an ugly database error,');
    console.log('  not the polite "Not enough stock" message from part 1.');
    console.log('');
    console.log('  Remove that constraint and the shop would happily have');
    console.log('  sold a watch it did not own.');
  } finally {
    // Always give both connections back, whatever happened.
    anna.release();
    ben.release();
  }
}


// ------------------------------------------------------------
// Put the shop back exactly as we found it.
// ------------------------------------------------------------
async function cleanUp(originalStock) {
  const deleted = await db.query(
    'delete from orders where customer_email = $1 returning id',
    [TEST_EMAIL]
  );

  await setStock(WATCH_ID, originalStock);

  console.log('\nCleaned up: removed ' + deleted.rows.length +
    ' test order(s) and set Skyline Pilot stock back to ' + originalStock + '.');
}


// ============================================================
async function main() {
  let originalStock = null;

  try {
    try {
      const health = await fetch(BASE_URL + '/api/health');

      if (!health.ok) {
        throw new Error('health check replied ' + health.status);
      }
    } catch (error) {
      console.error('\nCould not reach the shop at ' + BASE_URL);
      console.error('Start it in another terminal first:  npm start\n');
      return;
    }

    originalStock = await stockOf(WATCH_ID);

    await partOneTwoBuyersOneWatch();
    await partTwoACrowd();
    await partThreeTheOldWay();

    heading('RESULT');
    console.log('  ' + passed + ' passed, ' + failed + ' failed');

    if (failed === 0) {
      console.log('\n  The shop cannot oversell. However many people reach for');
      console.log('  the last watch at the same moment, exactly one gets it and');
      console.log('  everybody else is told politely why not.');
      console.log('');
      console.log('  The whole fix was moving the check INSIDE the update:');
      console.log('');
      console.log('    update stock set quantity = quantity - $1');
      console.log('     where watch_id = $2 and quantity >= $1');
    }
  } catch (error) {
    console.error('\nThe test could not finish:', error.message);
  } finally {
    if (originalStock !== null) {
      await cleanUp(originalStock);
    }

    await db.pool.end();
    process.exit(failed === 0 ? 0 : 1);
  }
}

main();
