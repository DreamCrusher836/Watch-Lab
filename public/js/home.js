// ============================================================
// js/home.js - fills in the "Build status" panel on the home page.
//
// It calls our own API and reports what came back, so the page is a
// live check that the server and the database are both working.
// ============================================================

// Grab the box we are going to write into. document.getElementById
// finds the element whose id="status-panel" in the HTML.
const statusPanel = document.getElementById('status-panel');


// ------------------------------------------------------------
// A small helper for drawing one line in the panel.
//
// It returns HTML text rather than printing it, so the caller can
// decide where it goes. Small functions that do one thing are much
// easier to debug than one big one that does five.
// ------------------------------------------------------------
function messageHtml(kind, text) {
  // kind is 'success', 'error' or 'info' - it picks the colour.
  return '<div class="message message--' + kind + '">' + text + '</div>';
}


// ------------------------------------------------------------
// The main job. It is "async" because talking to the server takes
// time, and "await" lets us write the waiting in a straight line
// instead of nesting callbacks.
// ------------------------------------------------------------
async function loadStatus() {
  // We build up the HTML in a variable and write it to the page ONCE
  // at the end. Writing to the page repeatedly makes it flicker.
  let html = '';

  // --- Check 1: is the database reachable? ---
  try {
    // fetch() asks our own server for a URL, exactly as the browser's
    // address bar would, but from JavaScript.
    const healthResponse = await fetch('/api/health');
    const health = await healthResponse.json();

    if (health.ok) {
      html += messageHtml('success', '<strong>Database connected.</strong> The server asked Postgres for the time and got an answer.');
    } else {
      html += messageHtml('error', '<strong>Database unreachable.</strong> Check DATABASE_URL in your .env file, then look at the terminal.');
    }
  } catch (error) {
    // We land here if the request itself failed - server not running,
    // no network. The error object is logged for us, not shown to
    // visitors, because it can contain technical detail.
    console.error('Health check request failed:', error);
    html += messageHtml('error', '<strong>No answer from the server.</strong> Is it running?');
  }

  // --- Check 2: can we read the watches? ---
  try {
    const watchesResponse = await fetch('/api/watches');

    // fetch does NOT throw on a 404 or 500 - it only throws if the
    // request could not be made at all. So we must check .ok ourselves.
    // This catches a lot of beginners out.
    if (!watchesResponse.ok) {
      throw new Error('Server replied ' + watchesResponse.status);
    }

    const watches = await watchesResponse.json();

    // Count how many are completely sold out, just to show something
    // interesting. filter() keeps only the items that pass the test.
    const soldOut = watches.filter(function (watch) {
      return watch.quantity === 0;
    });

    html += messageHtml('success',
      '<strong>' + watches.length + ' watches loaded</strong> from the database, ' +
      soldOut.length + ' of them sold out.');

    html += messageHtml('info',
      'Next up: step 3 turns this page into the real shop front.');
  } catch (error) {
    console.error('Loading watches failed:', error);
    html += messageHtml('error', '<strong>Could not load the watches.</strong> Have you run sql/01_watches_and_stock.sql in Supabase?');
  }

  statusPanel.innerHTML = html;
}


// Run it as soon as the script loads.
loadStatus();
