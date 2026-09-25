// ============================================================
// tests/duplicate-webhook.js
//
// Proves that sending the SAME payment event twice changes the shop
// exactly once.
//
// RUN IT LIKE THIS:
//   1. In one terminal:   npm start
//   2. In another:        node tests/duplicate-webhook.js
//
// It cleans up after itself, so your shop is left as it was.
//
// ------------------------------------------------------------
// WHY THIS TEST EXISTS
//
// Payment providers promise to deliver each event AT LEAST once,
// never exactly once. If their call to us times out, or our server
// hiccups while replying, they send it again. This is normal,
// correct behaviour on their part.
//
// So "what happens if this arrives twice?" is not a paranoid
// question. It is a guarantee that it WILL happen, and the only
// question is whether our shop survives it.
//
// The word for code that is safe to run more than once is
// IDEMPOTENT. That is what we are testing.
// ============================================================

require('dotenv').config({ quiet: true });

const crypto = require('crypto');
const db = require('../db');

const BASE_URL = 'http://localhost:' + (process.env.PORT || 3000);
const WEBHOOK_URL = BASE_URL + '/api/webhooks/payment';

// Trailhead Field - the watch with the most stock, so we are not
// fighting over anything scarce.
const TEST_WATCH_ID = 5;

// A distinctive email, so the cleanup at the end can only ever delete
// orders that this test created.
const TEST_EMAIL = 'duplicate-webhook-test@lab.local';


// ------------------------------------------------------------
// Tiny test helpers. We are not installing a test framework for
// this - two functions and a counter do everything we need, and you
// can read every line of them.
// ------------------------------------------------------------
let passed = 0;
let failed = 0;

function check(description, actual, expected) {
  // JSON.stringify lets us compare numbers, strings and small objects
  // with one line instead of three different kinds of comparison.
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


// ------------------------------------------------------------
// Small wrappers around the things we do repeatedly.
// ------------------------------------------------------------

async function stockOf(watchId) {
  const result = await db.query('select quantity from stock where watch_id = $1', [watchId]);
  return result.rows[0].quantity;
}

async function statusOf(orderId) {
  const result = await db.query('select status from orders where id = $1', [orderId]);
  return result.rows[0].status;
}

async function paymentRowsFor(eventId) {
  const result = await db.query('select count(*) as n from payments where event_id = $1', [eventId]);
  return Number(result.rows[0].n);
}


// Build an event exactly as routes/payments.js would.
function makeEvent(orderId, outcome) {
  return {
    eventId: 'evt_' + crypto.randomUUID(),
    type: outcome === 'success' ? 'payment.succeeded' : 'payment.failed',
    orderId: orderId,
    outcome: outcome,
    createdAt: new Date().toISOString(),
  };
}


// Send an event to the webhook, exactly as the provider would -
// over real HTTP, with the shared secret in the header.
async function sendEvent(event) {
  const response = await fetch(WEBHOOK_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-webhook-secret': process.env.WEBHOOK_SECRET,
    },
    body: JSON.stringify(event),
  });

  return { status: response.status, body: await response.json() };
}


// Place an order through the real API, so we are testing the actual
// shop rather than a made-up situation.
async function placeOrder(quantity) {
  const response = await fetch(BASE_URL + '/api/orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      customerName: 'Duplicate Webhook Test',
      customerEmail: TEST_EMAIL,
      items: [{ watchId: TEST_WATCH_ID, quantity: quantity }],
    }),
  });

  const body = await response.json();

  if (!response.ok) {
    throw new Error('Could not place the test order: ' + (body.error || response.status));
  }

  return body.orderId;
}


// ============================================================
// PART 1 - the same event, sent twice, one after the other.
//
// This is the everyday case: the provider's first call succeeded but
// our reply got lost on the way back, so from their point of view it
// failed and they try again a minute later.
// ============================================================
async function partOneSameEventTwice() {
  heading('PART 1 - the same event sent twice, one after the other');

  const stockAtStart = await stockOf(TEST_WATCH_ID);
  console.log('Stock before the order: ' + stockAtStart);

  const orderId = await placeOrder(2);
  const stockWhileHeld = await stockOf(TEST_WATCH_ID);

  console.log('Placed order #' + orderId + ' for 2 watches. Stock now held at ' + stockWhileHeld + '.');

  check('placing the order held 2 watches', stockWhileHeld, stockAtStart - 2);

  // One event. We will send this identical object twice.
  const event = makeEvent(orderId, 'failed');
  console.log('\nEvent id: ' + event.eventId);

  // --- first delivery ---
  const first = await sendEvent(event);
  console.log('\nFirst delivery  -> ' + first.status + ' ' + JSON.stringify(first.body.message));

  const statusAfterFirst = await statusOf(orderId);
  const stockAfterFirst = await stockOf(TEST_WATCH_ID);

  check('first delivery was accepted', first.status, 200);
  check('first delivery was not treated as a duplicate', first.body.duplicate, false);
  check('the order is now failed', statusAfterFirst, 'failed');
  check('the 2 held watches went back on the shelf', stockAfterFirst, stockAtStart);

  // --- second delivery: the exact same event object ---
  const second = await sendEvent(event);
  console.log('Second delivery -> ' + second.status + ' ' + JSON.stringify(second.body.message));

  const statusAfterSecond = await statusOf(orderId);
  const stockAfterSecond = await stockOf(TEST_WATCH_ID);

  // ------------------------------------------------------------
  // THESE FOUR CHECKS ARE THE WHOLE POINT OF THE FILE.
  // ------------------------------------------------------------

  // 200, not an error. An error would make a real provider keep
  // retrying an event we have already handled - forever.
  check('the duplicate was still answered 200', second.status, 200);

  check('the duplicate was recognised as a duplicate', second.body.duplicate, true);

  check('the order status did NOT change again', statusAfterSecond, 'failed');

  // If the duplicate had been processed, the stock would have gone
  // back a SECOND time and we would now be two watches richer than
  // we started - inventory invented out of thin air.
  check('the stock did NOT go back twice', stockAfterSecond, stockAtStart);

  check('only one payment row exists for this event', await paymentRowsFor(event.eventId), 1);

  return orderId;
}


// ============================================================
// PART 2 - a DIFFERENT event arriving after the order is finished.
//
// Not a duplicate this time: a brand new event, with a new id,
// saying the opposite thing. Business rule four says a finished order
// is never changed again.
// ============================================================
async function partTwoLateContradictingEvent(orderId) {
  heading('PART 2 - a new, contradicting event after the order is final');

  const stockBefore = await stockOf(TEST_WATCH_ID);

  console.log('Order #' + orderId + ' is currently: ' + (await statusOf(orderId)));
  console.log('Now the provider sends a SUCCESS event for the same order.');

  const lateEvent = makeEvent(orderId, 'success');
  const result = await sendEvent(lateEvent);

  console.log('\nResult -> ' + result.status + ' ' + JSON.stringify(result.body.message));

  check('the late event was answered 200', result.status, 200);
  check('it was not a duplicate (the id is new)', result.body.duplicate, false);
  check('but nothing was changed', result.body.changed, false);
  check('the order is still failed', await statusOf(orderId), 'failed');
  check('the stock was not touched', await stockOf(TEST_WATCH_ID), stockBefore);

  // The event was still RECORDED, even though we did not act on it.
  // That is deliberate: payments is a log of everything the provider
  // told us, which is what you need when a customer disputes a charge.
  check('the event was still recorded for the audit trail', await paymentRowsFor(lateEvent.eventId), 1);
}


// ============================================================
// PART 3 - the same event arriving twice at the EXACT same moment.
//
// This is the hard case, and it is why we used a unique constraint
// and "on conflict do nothing" rather than a check in JavaScript.
//
// A JavaScript check would be: look it up, then insert if missing.
// Two copies arriving together could BOTH look, BOTH find nothing,
// and BOTH insert. The database has no such gap.
// ============================================================
async function partThreeSimultaneousDuplicates() {
  heading('PART 3 - the same event twice, at the exact same moment');

  const stockAtStart = await stockOf(TEST_WATCH_ID);
  const orderId = await placeOrder(1);

  console.log('Placed order #' + orderId + ' for 1 watch.');

  const event = makeEvent(orderId, 'failed');
  console.log('Event id: ' + event.eventId);
  console.log('Sending it twice simultaneously...\n');

  // Promise.all starts both requests without waiting for the first
  // to finish, so they are genuinely in flight at the same time.
  const [first, second] = await Promise.all([
    sendEvent(event),
    sendEvent(event),
  ]);

  console.log('Reply A -> ' + first.status + ' duplicate=' + first.body.duplicate);
  console.log('Reply B -> ' + second.status + ' duplicate=' + second.body.duplicate);

  // We cannot know WHICH one wins the race - and we do not care.
  // What matters is that exactly one of them did the work.
  const duplicateFlags = [first.body.duplicate, second.body.duplicate].sort();

  check('both were answered 200', [first.status, second.status], [200, 200]);
  check('exactly one was treated as the duplicate', duplicateFlags, [false, true]);
  check('the order is failed', await statusOf(orderId), 'failed');
  check('the stock went back exactly once', await stockOf(TEST_WATCH_ID), stockAtStart);
  check('only one payment row exists', await paymentRowsFor(event.eventId), 1);

  return orderId;
}


// ------------------------------------------------------------
// Put everything back.
// ------------------------------------------------------------
async function cleanUp(stockAtVeryStart) {
  const deleted = await db.query(
    'delete from orders where customer_email = $1 returning id',
    [TEST_EMAIL]
  );

  // Deleting the orders removes their order_items and payments rows
  // too, thanks to "on delete cascade" on both foreign keys.
  await db.query(
    'update stock set quantity = $1, updated_at = now() where watch_id = $2',
    [stockAtVeryStart, TEST_WATCH_ID]
  );

  console.log('\nCleaned up: removed test order(s) ' +
    deleted.rows.map(function (r) { return '#' + r.id; }).join(', ') +
    ' and put stock back to ' + stockAtVeryStart + '.');
}


// ============================================================
// Run everything.
// ============================================================
async function main() {
  let stockAtVeryStart = null;

  try {
    // Fail early and clearly if the server is not running, rather
    // than throwing a confusing "fetch failed" from somewhere deep in
    // the test.
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

    stockAtVeryStart = await stockOf(TEST_WATCH_ID);

    // The test needs room to place two small orders.
    if (stockAtVeryStart < 3) {
      console.error('\nWatch ' + TEST_WATCH_ID + ' only has ' + stockAtVeryStart + ' in stock.');
      console.error('This test needs at least 3. Top it up on the staff page and try again.\n');
      return;
    }

    const orderId = await partOneSameEventTwice();
    await partTwoLateContradictingEvent(orderId);
    await partThreeSimultaneousDuplicates();

    heading('RESULT');
    console.log('  ' + passed + ' passed, ' + failed + ' failed');

    if (failed === 0) {
      console.log('\n  The webhook is IDEMPOTENT: the same event can arrive any');
      console.log('  number of times, in any order, even simultaneously, and the');
      console.log('  shop changes exactly once.');
    }
  } catch (error) {
    console.error('\nThe test could not finish:', error.message);
    console.error('Have you run sql/03_payments.sql in Supabase?');
  } finally {
    // Clean up whatever happened - including after a failure, so a
    // broken test never leaves your shop in a strange state.
    if (stockAtVeryStart !== null) {
      await cleanUp(stockAtVeryStart);
    }

    await db.pool.end();

    // Tell the shell whether the test passed. 0 means success, 1 means
    // failure - that is the convention every build tool understands.
    process.exit(failed === 0 ? 0 : 1);
  }
}

main();
