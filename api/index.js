// ============================================================
// api/index.js - the doorway Vercel looks for.
//
// Vercel does not run "node server.js". Instead it looks in the /api
// folder, treats each file as a small function, and calls the thing
// that file exports whenever a request arrives.
//
// An Express app IS a function that takes (request, response) - which
// is exactly what Vercel wants - so we can simply hand ours over.
// This file is a two-line adaptor: all the real code stays in
// server.js, and nothing about running locally changes.
// ============================================================

module.exports = require('../server.js');
