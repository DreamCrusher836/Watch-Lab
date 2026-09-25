// ============================================================
// routes/webhooks.js - where the payment provider calls US back.
//
//   POST /api/webhooks/payment
//
// This route does four things, all inside one transaction:
//   1. record the event (and notice if we have seen it before)
//   2. move the order from "pending" to "paid" or "failed" - once
//   3. put the held stock back if the payment failed
//   4. reply in a way the provider will understand
//
// ------------------------------------------------------------
// HOW A WEBHOOK ROUTE IS DIFFERENT FROM EVERY OTHER ROUTE
//
// Our other routes are called by our own web pages. This one is
// called by a machine on the internet, at a public address, with no
// login and no session. Three consequences:
//
//   1. Anyone who discovers the URL can call it. So the FIRST thing
//      we do is check a secret, before reading anything else.
//
//   2. We must reply quickly. Providers treat a slow reply as a
//      failure and send the event again.
//
//   3. Our reply is not for a human. It is an instruction:
//        200  - received AND dealt with; stop sending this
//        4xx  - this event is malformed; do not bother retrying
//        5xx  - I did not handle it; please send it again later
//      Choosing the wrong one is how people end up with a provider
//      retrying forever, or worse, silently losing a payment.
// ============================================================

const express = require('express');
const db = require('../db');

const router = express.Router();


// ------------------------------------------------------------
// THE SECRET CHECK.
//
// A shared password that only our fake provider and our shop know.
// It lives in .env as WEBHOOK_SECRET.
//
// WHY THIS MATTERS, concretely:
// Without it, anyone could run
//
//   curl -X POST https://our-shop/api/webhooks/payment \
//        -d '{"orderId":1,"outcome":"success"}'
//
// and mark their own order as paid without ever paying. It is the
// single biggest hole in a naive webhook, and it is a real-world
// mistake, not a theoretical one.
//
// 401 tells the caller "I do not know who you are". We deliberately
// do not say whether the header was missing or merely wrong - that
// only helps somebody guessing.
//
// A note on real life: providers normally do something stronger than
// a shared password. They send a SIGNATURE calculated from the whole
// message body plus a secret, so you can also prove the message was
// not altered on the way. Same idea, heavier arithmetic.
// ------------------------------------------------------------
function requireWebhookSecret(req, res, next) {
  const providedSecret = req.header('x-webhook-secret');

  if (!providedSecret || providedSecret !== process.env.WEBHOOK_SECRET) {
    console.warn('[webhook] rejected a call with a missing or wrong secret');
    return res.status(401).json({ error: 'Invalid webhook secret.' });
  }

  next();
}


// Roll back without ever throwing a second error - see the same
// helper and explanation in routes/orders.js.
async function safeRollback(client) {
  try {
    await client.query('rollback');
  } catch (rollbackError) {
    console.error('Rollback itself failed:', rollbackError.message);
  }
}


// ============================================================
// POST /api/webhooks/payment
// ============================================================
router.post('/payment', requireWebhookSecret, async function (req, res) {
  const event = req.body;

  // Even with the right secret, never trust the shape of the body.
  // A genuine provider having a bad day can send you nonsense too.
  //
  // These are all 400s: the event is broken, so retrying will not
  // help, and we want the provider to give up rather than loop.
  if (!event || typeof event.eventId !== 'string' || event.eventId.length === 0) {
    return res.status(400).json({ error: 'The event has no eventId.' });
  }

  if (event.outcome !== 'success' && event.outcome !== 'failed') {
    return res.status(400).json({ error: 'The event outcome must be "success" or "failed".' });
  }

  const orderId = Number(event.orderId);

  if (!Number.isInteger(orderId) || orderId < 1) {
    return res.status(400).json({ error: 'The event has a bad orderId.' });
  }

  // "success" becomes the order status "paid"; "failed" stays "failed".
  const newStatus = event.outcome === 'success' ? 'paid' : 'failed';

  const client = await db.pool.connect();

  try {
    await client.query('begin');

    // ------------------------------------------------------------
    // STEP 1 - does this order exist?
    //
    // A 404 is a 4xx, so a real provider would stop retrying. That is
    // right: an event for an order that does not exist will never
    // succeed no matter how many times it is sent.
    // ------------------------------------------------------------
    const orderLookup = await client.query(
      'select id, status from orders where id = $1',
      [orderId]
    );

    if (orderLookup.rows.length === 0) {
      await safeRollback(client);
      return res.status(404).json({ error: 'No order with that id.' });
    }

    // ============================================================
    // STEP 2 - RECORD THE EVENT, AND SPOT A DUPLICATE.
    //
    // This is the heart of the whole step, and it is one statement.
    //
    // "on conflict (event_id) do nothing" means: try to insert this
    // row, and if it would break the unique rule on event_id, quietly
    // do nothing instead of raising an error.
    //
    // Combined with "returning id", that gives us a beautifully
    // simple test:
    //
    //   got a row back  -> this event is NEW, carry on
    //   got nothing     -> we have seen it before, stop here
    //
    // WHY NOT "look it up first, then insert if missing"?
    // Because that is two steps with a gap in between, and two copies
    // of the event arriving at the same instant could both look, both
    // find nothing, and both insert. Exactly the race condition we met
    // with stock in step 5, and exactly the same cure: let ONE
    // indivisible database operation do the checking.
    //
    // The word for code that is safe to run twice is IDEMPOTENT.
    // Step 8 fires the same event twice and proves this works.
    // ============================================================
    const recorded = await client.query(
      `insert into payments (order_id, event_id, outcome)
       values ($1, $2, $3)
       on conflict (event_id) do nothing
       returning id`,
      [orderId, event.eventId, event.outcome]
    );

    if (recorded.rowCount === 0) {
      // A duplicate. Nothing to do - and that is the correct outcome,
      // not an error.
      //
      // We COMMIT rather than roll back because there is genuinely
      // nothing to undo, and committing releases the transaction
      // cleanly.
      //
      // We reply 200, NOT an error. 200 means "dealt with, stop
      // sending this". An error would make the provider try again,
      // and we would be right back here in a loop.
      await client.query('commit');

      console.log('[webhook] ignored duplicate ' + event.eventId + ' for order ' + orderId);

      return res.json({
        received: true,
        duplicate: true,
        orderId: orderId,
        message: 'This event was already processed. Nothing changed.',
      });
    }

    // ============================================================
    // STEP 3 - MOVE THE ORDER, BUT ONLY IF IT IS STILL PENDING.
    //
    // Business rule four: an order goes from "pending" to "paid" or
    // "failed" exactly once, and a finished order is never touched
    // again.
    //
    // Look at the WHERE clause. It is the same trick as the stock
    // update in step 5: the check ("is it still pending?") and the
    // action ("change it") are ONE statement, so nothing can slip in
    // between them.
    //
    // If rowCount is 0, the order was already paid or failed - maybe
    // a different event got here first. We record the new event (we
    // already did, above, as an audit trail) but we do NOT touch the
    // order.
    // ============================================================
    const statusChange = await client.query(
      `update orders
          set status = $1
        where id = $2
          and status = 'pending'
      returning id, status, total_cents`,
      [newStatus, orderId]
    );

    if (statusChange.rowCount === 0) {
      // The order was already final. The event is logged; the order
      // is left exactly as it was.
      await client.query('commit');

      console.log('[webhook] ' + event.eventId + ': order ' + orderId + ' was already final, left alone');

      return res.json({
        received: true,
        duplicate: false,
        changed: false,
        orderId: orderId,
        status: orderLookup.rows[0].status,
        message: 'This order was already finished. It was not changed.',
      });
    }

    // ============================================================
    // STEP 4 - IF THE PAYMENT FAILED, PUT THE STOCK BACK.
    //
    // We took the watches off the shelf when the order was created,
    // to hold them while the customer paid. The payment failed, so
    // they go back on the shelf for someone else.
    //
    // Note the "order by watch_id" - the same trick as in
    // routes/orders.js. Everyone touches the stock rows in the same
    // order, so two things happening at once can never end up each
    // waiting on the other. (See the deadlock note in orders.js.)
    // ============================================================
    let stockReturned = [];

    if (newStatus === 'failed') {
      const lines = await client.query(
        `select watch_id, quantity
           from order_items
          where order_id = $1
          order by watch_id`,
        [orderId]
      );

      for (const line of lines.rows) {
        await client.query(
          `update stock
              set quantity = quantity + $1,
                  updated_at = now()
            where watch_id = $2`,
          [line.quantity, line.watch_id]
        );

        stockReturned.push({ watchId: line.watch_id, quantity: line.quantity });
      }

      console.log('[webhook] payment failed for order ' + orderId + ', put ' +
        lines.rows.length + ' line(s) of stock back');
    }

    // ------------------------------------------------------------
    // COMMIT - the event record, the status change and the returned
    // stock all become real together. Until this line, an outsider
    // could not see any of it.
    //
    // This is why it all has to be one transaction. Imagine these as
    // three separate statements and the server dying in the middle:
    // the order says "failed" but the stock never came back, and six
    // watches are missing from the shelf that nobody owns.
    // ------------------------------------------------------------
    await client.query('commit');

    console.log('[webhook] ' + event.eventId + ': order ' + orderId + ' is now ' + newStatus);

    res.json({
      received: true,
      duplicate: false,
      changed: true,
      orderId: orderId,
      status: newStatus,
      stockReturned: stockReturned,
      message: 'Order ' + orderId + ' is now ' + newStatus + '.',
    });
  } catch (error) {
    await safeRollback(client);

    console.error('POST /api/webhooks/payment failed:', error.message);

    // A 500 tells the provider "I did not handle this", so a real one
    // will send it again later. That is exactly what we want: a fault
    // on our side must never silently lose a payment.
    //
    // And because the route is idempotent, that retry is safe.
    res.status(500).json({ error: 'Could not process the event.' });
  } finally {
    // Always give the connection back. See the long note in
    // routes/orders.js about why forgetting this eventually hangs
    // the whole application.
    client.release();
  }
});


module.exports = router;
