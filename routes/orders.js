// ============================================================
// routes/orders.js - creating and reading orders.
//
//   POST /api/orders      -> turn a cart into an order, and hold stock
//   GET  /api/orders/:id  -> an order with its lines and status
//
// The POST route now runs inside a DATABASE TRANSACTION. Read the
// long explanation above the route before changing anything in it.
// ============================================================

const express = require('express');
const db = require('../db');

const router = express.Router();


// ------------------------------------------------------------
// VALIDATION HELPERS
//
// Each answers a single yes/no question. Small functions with honest
// names turn the main route into something you can read out loud.
// ------------------------------------------------------------

function isNonEmptyText(value, maxLength) {
  if (typeof value !== 'string') {
    return false;
  }

  const trimmed = value.trim();

  return trimmed.length > 0 && trimmed.length <= maxLength;
}


function looksLikeAnEmail(value) {
  if (typeof value !== 'string') {
    return false;
  }

  // Deliberately simple: something, an @, something, a dot, something,
  // no spaces.
  //
  // WHY NOT A CLEVERER ONE? You cannot tell whether an email address
  // really exists by looking at it - the only real test is sending a
  // message to it. A monstrous regex would reject valid addresses and
  // still let fake ones through. This catches typos like
  // "kevin.gmail.com", which is all we are honestly trying to do.
  const pattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  return pattern.test(value.trim());
}


// ------------------------------------------------------------
// Check the shape of the whole request body.
//
// Returns an error message as text, or null if all is well. Returning
// the message rather than sending a response from in here keeps this
// function easy to follow: it decides WHETHER something is wrong, the
// route decides what to do about it.
// ------------------------------------------------------------
function findProblemWithOrderRequest(body) {
  if (!isNonEmptyText(body.customerName, 100)) {
    return 'Please give a name (up to 100 characters).';
  }

  if (!looksLikeAnEmail(body.customerEmail)) {
    return 'Please give a valid email address.';
  }

  if (!Array.isArray(body.items) || body.items.length === 0) {
    return 'The order must contain at least one watch.';
  }

  if (body.items.length > 20) {
    return 'That is too many different watches for one order.';
  }

  const seenWatchIds = [];

  for (let index = 0; index < body.items.length; index++) {
    const item = body.items[index];

    if (!item || typeof item !== 'object') {
      return 'One of the order lines is not readable.';
    }

    const watchId = Number(item.watchId);
    const quantity = Number(item.quantity);

    if (!Number.isInteger(watchId) || watchId < 1) {
      return 'One of the order lines has a bad watch id.';
    }

    // The house rule from the project design, checked HERE on the
    // server - where the customer cannot reach it.
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 5) {
      return 'Quantity must be a whole number from 1 to 5.';
    }

    // The same watch twice would mean two lines fighting over one
    // stock row. Our cart never does this, but a hand-made request
    // could, so we refuse plainly rather than guessing what was meant.
    if (seenWatchIds.includes(watchId)) {
      return 'The same watch appears twice in the order.';
    }

    seenWatchIds.push(watchId);
  }

  return null;
}


// ------------------------------------------------------------
// Roll back without ever throwing a second error.
//
// If the connection itself has died, ROLLBACK will fail too. We do not
// want that second failure to hide the first one - the original error
// is the interesting one. So we swallow this one and just make a note.
//
// (Postgres would abandon an unfinished transaction anyway when the
// connection closes. This is belt and braces.)
// ------------------------------------------------------------
async function safeRollback(client) {
  try {
    await client.query('rollback');
  } catch (rollbackError) {
    console.error('Rollback itself failed:', rollbackError.message);
  }
}


// ============================================================
// POST /api/orders
//
// Body: {
//   customerName: "Kevin",
//   customerEmail: "kevin@example.com",
//   items: [ { watchId: 1, quantity: 2 } ]
// }
//
// Note what the body does NOT contain: any prices. The browser is
// never asked what something costs, and would be ignored if it said.
//
// ------------------------------------------------------------
// WHAT IS A TRANSACTION? (the big idea of this step)
//
// A transaction is a group of database statements wrapped in
// "all of this, or none of it".
//
//   BEGIN     - start. From now on, nothing we write is real to
//               anybody else yet.
//   COMMIT    - done. Everything becomes real, together, instantly.
//   ROLLBACK  - forget it. Everything since BEGIN is discarded. Not
//               "undone step by step" - it was never really written.
//
// It is a bank transfer. Taking money out of one account and putting
// it into another must be one indivisible act. Half of it happening
// is not "partly a transfer" - it is money destroyed.
//
// Placing an order is the same shape: create the order, write every
// line, hold every watch. Any subset of that is corruption.
//
// Run tests/broken-order-demo.js to see the difference for yourself,
// with real numbers, against this very database.
// ============================================================
router.post('/', async function (req, res) {
  // --- 1. Is the request even sensible? ---
  // We do this BEFORE touching the database at all. The cheapest
  // query is the one you never send.
  const problem = findProblemWithOrderRequest(req.body);

  if (problem) {
    return res.status(400).json({ error: problem });
  }

  const customerName = req.body.customerName.trim();
  const customerEmail = req.body.customerEmail.trim();

  // ------------------------------------------------------------
  // SORT THE LINES BY WATCH ID. This looks pointless. It is not.
  //
  // Imagine two orders arriving at the same instant. Order A wants
  // watches 1 and 3; order B wants watches 3 and 1.
  //
  // A locks row 1, then reaches for row 3.
  // B locks row 3, then reaches for row 1.
  //
  // Now each is holding what the other needs, and neither can move.
  // That is a DEADLOCK. Postgres notices and kills one of them, so
  // one poor customer gets a random error for no reason.
  //
  // The cure is absurdly simple: everyone always takes the rows in
  // the same order. Like two people unloading a van who both agree to
  // always pick up the left-hand box first - they can never end up
  // each waiting on the other.
  // ------------------------------------------------------------
  const items = req.body.items.slice().sort(function (first, second) {
    return Number(first.watchId) - Number(second.watchId);
  });

  // ------------------------------------------------------------
  // CHECK OUT ONE CONNECTION AND KEEP IT.
  //
  // Everywhere else we use db.query(), which borrows any free
  // connection from the pool and hands it straight back. That is
  // perfect for single queries and USELESS for a transaction: BEGIN
  // on one connection and COMMIT on another means nothing.
  //
  // pool.connect() takes one taxi out of the rank and keeps it for
  // the whole journey. We must remember to give it back - see the
  // "finally" block right at the bottom.
  // ------------------------------------------------------------
  const client = await db.pool.connect();

  try {
    await client.query('begin');

    const pricedLines = [];
    let totalCents = 0;

    for (const item of items) {
      const watchId = Number(item.watchId);
      const quantity = Number(item.quantity);

      // --- 2. What does the shop say this watch costs? ---
      //
      // The price comes from the DATABASE, every time. This is
      // business rule number one, and it is enforced simply by never
      // reading a price from req.body at all.
      const lookup = await client.query(
        `select
           watches.id,
           watches.name,
           watches.price_cents,
           stock.quantity
         from watches
         join stock on stock.watch_id = watches.id
         where watches.id = $1`,
        [watchId]
      );

      if (lookup.rows.length === 0) {
        await safeRollback(client);
        return res.status(404).json({ error: 'One of the watches no longer exists.' });
      }

      const watch = lookup.rows[0];

      // ------------------------------------------------------------
      // --- 3. TAKE THE STOCK. This one statement is the heart of
      //        the whole project. ---
      //
      // Look closely at the WHERE clause:
      //
      //     where watch_id = $2 and quantity >= $1
      //
      // The check ("are there enough?") and the action ("take them")
      // happen in ONE statement. Postgres locks that row for the
      // instant it takes to run, so nothing can slip in between.
      //
      // WHY THAT MATTERS - the race condition:
      // The old code did this instead:
      //
      //     if (watch.quantity < quantity) { refuse }      // check
      //     ... other statements ...
      //     update stock set quantity = quantity - $1      // act
      //
      // Two customers can BOTH pass that check before either one
      // subtracts. Both are told yes. The last watch is sold twice.
      // The gap between looking and acting is the bug.
      //
      // Here there is no gap. Whoever's statement runs second finds
      // "quantity >= 1" is no longer true, matches no rows, and is
      // refused. Exactly one of them can win. Step 9 proves it.
      //
      // "returning quantity" hands back what is left, so we do not
      // need a second query to find out.
      // ------------------------------------------------------------
      const stockUpdate = await client.query(
        `update stock
            set quantity = quantity - $1,
                updated_at = now()
          where watch_id = $2
            and quantity >= $1
        returning quantity`,
        [quantity, watchId]
      );

      // rowCount is how many rows the statement actually changed.
      // Zero means the WHERE matched nothing, which - since we know
      // the watch exists - can only mean there was not enough stock.
      if (stockUpdate.rowCount === 0) {
        await safeRollback(client);

        // Any stock we took for EARLIER lines in this same order has
        // just been given back automatically by the rollback. We do
        // not have to remember what we did and undo it by hand. That
        // is the entire point of a transaction.
        //
        // (watch.quantity below is the number we read a moment ago,
        // used only to write a friendly message. The binding decision
        // was made by the UPDATE, not by this number.)
        return res.status(409).json({
          error: 'Not enough stock for ' + watch.name + '. Only ' + watch.quantity + ' left.',
        });
      }

      pricedLines.push({
        watchId: watch.id,
        quantity: quantity,
        unitPriceCents: watch.price_cents,
      });

      totalCents = totalCents + (watch.price_cents * quantity);
    }

    // --- 4. Create the order itself ---
    const orderResult = await client.query(
      `insert into orders (customer_name, customer_email, status, total_cents)
       values ($1, $2, 'pending', $3)
       returning id, status, total_cents`,
      [customerName, customerEmail, totalCents]
    );

    const order = orderResult.rows[0];

    // --- 5. Write one line per watch ---
    for (const line of pricedLines) {
      await client.query(
        `insert into order_items (order_id, watch_id, quantity, unit_price_cents)
         values ($1, $2, $3, $4)`,
        [order.id, line.watchId, line.quantity, line.unitPriceCents]
      );
    }

    // --- 6. COMMIT: everything above becomes real, all at once ---
    //
    // Until this line ran, no other connection could see any of it.
    // After it, all of it is permanent. There is no moment in between
    // where an outsider could see half an order.
    await client.query('commit');

    // 201 means "Created" - the right code when a request has made a
    // new thing. Plain 200 would work, but 201 says something now
    // exists that did not before.
    res.status(201).json({
      ok: true,
      orderId: order.id,
      status: order.status,
      totalCents: order.total_cents,
    });
  } catch (error) {
    // ANY unexpected failure lands here: a dropped connection, a
    // constraint we did not anticipate, a bug in our own code.
    // Whatever it was, the order must not half-exist.
    await safeRollback(client);

    console.error('POST /api/orders failed:', error.message);
    res.status(500).json({ error: 'Could not create the order.' });
  } finally {
    // ------------------------------------------------------------
    // GIVE THE CONNECTION BACK. Always. Whatever happened.
    //
    // "finally" runs after success, after an error, and even after
    // those "return" statements above - JavaScript will not let a
    // return skip it.
    //
    // Forget this and every failed request keeps a connection
    // forever. The pool empties, and eventually the whole app hangs
    // waiting for a taxi that is never coming back. It is a horrible
    // bug to chase, because it only appears under load.
    // ------------------------------------------------------------
    client.release();
  }
});


// ------------------------------------------------------------
// GET /api/orders/:id
// The order with its lines, for the pay and confirmation pages.
//
// This one is a plain read - no transaction needed. A transaction
// protects a group of WRITES from being half-applied; there is
// nothing here to half-apply.
// ------------------------------------------------------------
router.get('/:id', async function (req, res) {
  try {
    const orderId = Number(req.params.id);

    if (!Number.isInteger(orderId) || orderId < 1) {
      return res.status(400).json({ error: 'The order id must be a whole number.' });
    }

    const orderResult = await db.query(
      `select id, customer_name, customer_email, status, total_cents, created_at
         from orders
        where id = $1`,
      [orderId]
    );

    if (orderResult.rows.length === 0) {
      return res.status(404).json({ error: 'No order with that id.' });
    }

    // The lines, joined to watches so we can show names not id numbers.
    //
    // Note we take unit_price_cents from ORDER_ITEMS, not from watches -
    // that is the price the customer actually agreed to, frozen at the
    // moment they ordered.
    const itemsResult = await db.query(
      `select
         order_items.watch_id,
         order_items.quantity,
         order_items.unit_price_cents,
         watches.name,
         watches.type
       from order_items
       join watches on watches.id = order_items.watch_id
       where order_items.order_id = $1
       order by order_items.id`,
      [orderId]
    );

    const order = orderResult.rows[0];

    res.json({
      id: order.id,
      customerName: order.customer_name,
      customerEmail: order.customer_email,
      status: order.status,
      totalCents: order.total_cents,
      createdAt: order.created_at,
      items: itemsResult.rows,
    });
  } catch (error) {
    console.error('GET /api/orders/:id failed:', error.message);
    res.status(500).json({ error: 'Could not load that order.' });
  }
});


module.exports = router;
