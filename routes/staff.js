// ============================================================
// routes/staff.js - stock management, for shop staff only.
//
//   GET /api/staff/stock            -> the full stock list
//   PUT /api/staff/stock/:watchId   -> set a new quantity
//
// These routes can CHANGE data, so unlike the watch routes they are
// protected. A customer who could set their own stock levels could
// give themselves a sold-out watch.
// ============================================================

const express = require('express');
const db = require('../db');

const router = express.Router();


// ------------------------------------------------------------
// THE STAFF KEY CHECK (a middleware of our own)
//
// This is a MOCK stand-in for a real login system. In a real shop you
// would have proper user accounts, hashed passwords, sessions or JSON
// Web Tokens, and a "role" on each account. We are not learning
// authentication in this project, so we use the simplest thing that
// demonstrates the IDEA: a shared secret word.
//
// The caller must send a header:   x-staff-key: <the value from .env>
// No key, or the wrong key, and they get 401 and nothing else happens.
//
// WHY A HEADER AND NOT THE URL?
// Anything in a URL gets written to server logs, browser history and
// the address bar. Headers are not logged by default, so secrets
// belong there. (In production it must also be HTTPS, so the header
// is encrypted in transit.)
//
// "next" is the important bit. Calling next() means "this request
// passed, carry on to the actual route". NOT calling it means the
// request stops here. It is the bouncer on the door: step aside, or
// you do not get in.
// ------------------------------------------------------------
function requireStaffKey(req, res, next) {
  const providedKey = req.header('x-staff-key');

  if (!providedKey || providedKey !== process.env.STAFF_KEY) {
    // 401 means "Unauthorized": we do not know who you are.
    // Notice the message does not say WHICH part was wrong. Telling an
    // attacker "the key was close" or "no key was sent" helps them.
    return res.status(401).json({ error: 'Staff key missing or incorrect.' });
  }

  next();
}

// router.use(...) applies this middleware to EVERY route in this file.
// Writing it once here is safer than remembering to add it to each
// route by hand - the day you forget is the day you have a hole.
router.use(requireStaffKey);


// ------------------------------------------------------------
// GET /api/staff/stock
// The whole stock list, ordered by name so it reads like a stock sheet.
// ------------------------------------------------------------
router.get('/stock', async function (req, res) {
  try {
    const result = await db.query(`
      select
        watches.id as watch_id,
        watches.name,
        watches.type,
        watches.price_cents,
        stock.quantity,
        stock.updated_at
      from watches
      join stock on stock.watch_id = watches.id
      order by watches.name
    `);

    res.json(result.rows);
  } catch (error) {
    console.error('GET /api/staff/stock failed:', error.message);
    res.status(500).json({ error: 'Could not load the stock list.' });
  }
});


// ------------------------------------------------------------
// PUT /api/staff/stock/:watchId
// Body: { "quantity": 12 }
//
// WHY PUT AND NOT POST?
// A rough rule: POST means "create something new", PUT means "set this
// thing to exactly this value". We are replacing a quantity with a new
// one, so PUT fits. PUT is also meant to be safe to repeat: sending
// "set it to 12" three times leaves it at 12, not 36.
// ------------------------------------------------------------
router.put('/stock/:watchId', async function (req, res) {
  try {
    const watchId = Number(req.params.watchId);

    // req.body.quantity comes from the JSON the caller sent.
    // If they sent no body at all, req.body is an empty object and
    // this is undefined - which Number() turns into NaN, which fails
    // the check below. So we do not need a separate "is it missing" test.
    const newQuantity = Number(req.body.quantity);

    if (!Number.isInteger(watchId) || watchId < 1) {
      return res.status(400).json({ error: 'The watch id must be a whole number.' });
    }

    // VALIDATE BEFORE WRITING.
    // The database also refuses negatives (our check constraint), but
    // catching it here gives the member of staff a sentence they can
    // understand instead of a raw Postgres error.
    //
    // Number.isInteger also rejects 4.5 and NaN for us in one go.
    if (!Number.isInteger(newQuantity) || newQuantity < 0) {
      return res.status(400).json({ error: 'Quantity must be a whole number of 0 or more.' });
    }

    // An upper limit is not strictly required, but a typo like 100000
    // (a slipped finger on "100") should not quietly become reality.
    if (newQuantity > 999) {
      return res.status(400).json({ error: 'Quantity must be 999 or less.' });
    }

    // "returning" (new concept, and a Postgres treat):
    // Normally an UPDATE just tells you how many rows it changed. Adding
    // "returning" makes it hand back the changed rows as well, so we get
    // the new state without running a second SELECT. One trip, not two.
    const result = await db.query(
      `update stock
         set quantity = $1,
             updated_at = now()
       where watch_id = $2
       returning watch_id, quantity, updated_at`,
      [newQuantity, watchId]
    );

    // If nothing came back, no stock row had that watch_id - so the
    // watch does not exist. Nothing was changed; we say so plainly.
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'No watch with that id.' });
    }

    res.json({
      ok: true,
      message: 'Stock updated.',
      stock: result.rows[0],
    });
  } catch (error) {
    console.error('PUT /api/staff/stock/:watchId failed:', error.message);
    res.status(500).json({ error: 'Could not update the stock.' });
  }
});


module.exports = router;
