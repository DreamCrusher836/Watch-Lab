// ============================================================
// server.js - the front door of the application.
//
// Its job is small and it should stay small:
//   1. start Express
//   2. serve the files in /public to the browser
//   3. (later) connect the route files in /routes
//   4. prove on startup that the database is reachable
// ============================================================

require('dotenv').config({ quiet: true });

const express = require('express');
const path = require('path');
const db = require('./db');

// Our route files. Each one exports a "router" - a bundle of related routes.
const watchesRouter = require('./routes/watches');
const staffRouter = require('./routes/staff');

const app = express();

// ------------------------------------------------------------
// MIDDLEWARE (new concept)
//
// Middleware is a function Express runs on every incoming request
// BEFORE it reaches our route. Think of airport security: every
// passenger passes through it on the way to their gate.
//
// express.json() looks at requests that carry JSON in their body
// (like our future "place order" request) and turns that raw text
// into a normal JavaScript object on req.body. Without this line,
// req.body would be undefined and we would be very confused.
// ------------------------------------------------------------
app.use(express.json());

// ------------------------------------------------------------
// Serve the /public folder as a plain website.
//
// __dirname is "the folder this file is in", so this works no matter
// where you start the server from. After this line, a browser asking
// for http://localhost:3000/style.css gets public/style.css, and a
// request for "/" gets public/index.html automatically.
// ------------------------------------------------------------
app.use(express.static(path.join(__dirname, 'public')));

// ------------------------------------------------------------
// PLUG IN THE ROUTERS.
//
// app.use(address, router) means: "every route inside this router
// hangs off this address". So the route written as router.get('/')
// inside watches.js actually answers at /api/watches, and
// router.get('/:id') answers at /api/watches/4.
//
// The benefit: if we ever wanted to move the shop to /api/v2/watches,
// we would change ONE line here, not every route in the file.
// ------------------------------------------------------------
app.use('/api/watches', watchesRouter);
app.use('/api/staff', staffRouter);


// ------------------------------------------------------------
// A health check route.
//
// This is the simplest possible way to answer the question
// "is the server alive AND can it really talk to the database?"
// It is the first thing to open when something seems broken.
//
// 'select now()' asks Postgres for its current time. The answer does
// not matter - what matters is that we got an answer at all.
// ------------------------------------------------------------
app.get('/api/health', async function (req, res) {
  // try/catch: if anything inside try throws an error, we jump to
  // catch instead of the whole server crashing.
  try {
    const result = await db.query('select now() as database_time');

    res.json({
      ok: true,
      message: 'Server is running and the database answered.',
      databaseTime: result.rows[0].database_time,
    });
  } catch (error) {
    // Log the full technical error in OUR terminal, where only we see it.
    console.error('Health check failed:', error.message);

    // The most likely cause by far, so we check for it by name and say so.
    if (!process.env.DATABASE_URL) {
      console.error('Reason: DATABASE_URL is empty in your .env file.');
    }

    // Send the visitor a short, plain message.
    // WHY not send them error.message? Because database errors can leak
    // table names, file paths and other hints that help an attacker.
    // Detailed errors go in the log; visitors get the short version.
    res.status(500).json({
      ok: false,
      message: 'The server could not reach the database.',
    });
  }
});

// ------------------------------------------------------------
// A catch-all for unknown /api addresses.
//
// Without this, asking for /api/typo falls through to express.static,
// finds no such file, and returns Express's default HTML error page -
// which is baffling when you expected JSON. This makes the app answer
// every /api request in the same language it was asked in.
// ------------------------------------------------------------
app.use('/api', function (req, res) {
  res.status(404).json({ error: 'No such API route: ' + req.method + ' ' + req.originalUrl });
});


// ------------------------------------------------------------
// STARTING THE SERVER - and why it is wrapped in an "if".
//
// On your laptop, this file IS the program: node runs it directly, and
// it must open a port and listen. "require.main === module" is Node's
// way of asking "was I started directly, or did another file require
// me?" It is the same idea as a recipe that says "if you are cooking
// this on its own, preheat the oven".
//
// On Vercel there is no long-running server to listen on a port. Vercel
// wakes our app up for one request, hands it over, and puts it back to
// sleep. It imports this file and uses the exported app directly, so
// require.main is NOT this module and app.listen() is skipped.
//
// One file, both worlds, no duplicated code.
// ------------------------------------------------------------
if (require.main === module) {
  const port = process.env.PORT || 3000;

  app.listen(port, function () {
    console.log('Watch Store Lab is running at http://localhost:' + port);
    console.log('Health check: http://localhost:' + port + '/api/health');
  });
}

// Export the app so Vercel (via api/index.js) can use it.
module.exports = app;
