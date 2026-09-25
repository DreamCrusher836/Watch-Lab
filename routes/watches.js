// ============================================================
// routes/watches.js - the public, read-only watch endpoints.
//
// Anyone can call these. They only ever READ, never write, so there
// is nothing here to protect with a password.
//
//   GET /api/watches      -> all six watches with their stock
//   GET /api/watches/:id  -> one watch with its stock
// ============================================================

const express = require('express');
const db = require('../db');

// ------------------------------------------------------------
// A ROUTER (new concept)
//
// A router is a mini-app that holds a group of related routes.
// Instead of piling every route into server.js, we keep the watch
// routes here, the staff routes in staff.js, and so on. server.js
// then just plugs each router in at the right address.
//
// It is like the departments of a shop: menswear, footwear, returns.
// Each has its own counter; the shop directory at the entrance says
// which floor each one is on.
// ------------------------------------------------------------
const router = express.Router();


// ------------------------------------------------------------
// One shared piece of SQL, written once and reused by both routes.
//
// THE JOIN (new concept)
// Our data lives in two tables, but the browser wants one tidy object
// per watch: name, price AND how many are left. A JOIN glues rows from
// two tables together using something they have in common.
//
// "join stock on stock.watch_id = watches.id" means:
// for each watch row, find the stock row whose watch_id matches this
// watch's id, and show them side by side as a single result row.
//
// It is like putting the product catalogue next to the stock sheet and
// lining up the pages by product number.
// ------------------------------------------------------------
const SELECT_WATCH_WITH_STOCK = `
  select
    watches.id,
    watches.name,
    watches.type,
    watches.description,
    watches.price_cents,
    stock.quantity
  from watches
  join stock on stock.watch_id = watches.id
`;


// ------------------------------------------------------------
// GET /api/watches
// Returns every watch, with its stock, as a JSON array.
// ------------------------------------------------------------
router.get('/', async function (req, res) {
  try {
    const result = await db.query(SELECT_WATCH_WITH_STOCK + ' order by watches.id');

    // result.rows is a plain array of plain objects - exactly what we
    // want to send. res.json() converts it to JSON text and sets the
    // correct Content-Type header for us.
    res.json(result.rows);
  } catch (error) {
    console.error('GET /api/watches failed:', error.message);
    res.status(500).json({ error: 'Could not load the watches.' });
  }
});


// ------------------------------------------------------------
// GET /api/watches/:id
//
// The ":id" part is a URL PARAMETER. Asking for /api/watches/4 puts
// the text "4" into req.params.id. Note: TEXT, not a number - every
// part of a URL arrives as text, which is why we convert it below.
// ------------------------------------------------------------
router.get('/:id', async function (req, res) {
  try {
    // Number(...) turns the text "4" into the number 4.
    // If someone asks for /api/watches/banana, Number gives us NaN
    // ("not a number"), and Number.isInteger(NaN) is false.
    const watchId = Number(req.params.id);

    // WHY CHECK THIS AT ALL, when the query is parameterised anyway?
    // Two reasons. First, a clear 400 ("you asked wrong") is far more
    // useful to whoever called us than a confusing database error.
    // Second, it keeps rubbish away from the database entirely - the
    // cheapest request is the one we never send.
    //
    // 400 means "Bad Request": the fault is with the caller, not us.
    if (!Number.isInteger(watchId) || watchId < 1) {
      return res.status(400).json({ error: 'The watch id must be a whole number.' });
    }

    // $1 is a placeholder. The value travels separately, in the array,
    // so Postgres can never mistake it for part of the instruction.
    const result = await db.query(
      SELECT_WATCH_WITH_STOCK + ' where watches.id = $1',
      [watchId]
    );

    // A query that finds nothing is NOT an error - it succeeded, and
    // the honest answer is "there are zero rows". So we check the count
    // ourselves and reply 404 ("Not Found").
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'No watch with that id.' });
    }

    // rows[0] is the first (and here, only) row found.
    res.json(result.rows[0]);
  } catch (error) {
    console.error('GET /api/watches/:id failed:', error.message);
    res.status(500).json({ error: 'Could not load that watch.' });
  }
});


module.exports = router;
