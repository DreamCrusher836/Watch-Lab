// ============================================================
// js/staff.js - the stock room page (staff.html).
//
// Two jobs:
//   1. take the staff key and try it against the server
//   2. show the stock sheet and let staff change quantities
// ============================================================

// Grab the pieces of the page once, at the top, instead of searching
// for them again on every click. Clearer, and slightly faster.
const keyCard = document.getElementById('key-card');
const keyForm = document.getElementById('key-form');
const keyInput = document.getElementById('staff-key');
const keyMessage = document.getElementById('key-message');

const stockSection = document.getElementById('stock-section');
const stockRows = document.getElementById('stock-rows');
const stockMessage = document.getElementById('stock-message');
const signOutButton = document.getElementById('sign-out');


// ------------------------------------------------------------
// The key is held in an ordinary variable, and NOWHERE else.
//
// WHY NOT localStorage, so staff do not retype it?
// Because localStorage lives on disk and survives forever. Any script
// that ever runs on this page could read it, and it stays behind on a
// shared computer long after the person has walked away. A secret
// held in a variable disappears the instant the tab is closed.
//
// The cost is retyping the key after a refresh. That is the right
// trade: a small inconvenience for staff beats a stored password.
// ------------------------------------------------------------
let staffKey = '';


// ------------------------------------------------------------
// Small shared helpers.
// ------------------------------------------------------------

function showMessage(element, kind, text) {
  element.innerHTML = '<div class="message message--' + kind + '">' + text + '</div>';
}

function clearMessage(element) {
  element.innerHTML = '';
}

function formatPrice(priceInCents) {
  return new Intl.NumberFormat('en-IE', {
    style: 'currency',
    currency: 'EUR',
  }).format(priceInCents / 100);
}

// See the long explanation in shop.js - this makes text safe to place
// inside HTML, so a name could never smuggle in a <script> tag.
function escapeHtml(text) {
  const holder = document.createElement('div');
  holder.textContent = text;
  return holder.innerHTML;
}


// ------------------------------------------------------------
// Draw one row of the stock sheet.
//
// Each row carries its own watch id on the Save button, so a click
// knows which watch it belongs to without us keeping a separate list.
// ------------------------------------------------------------
function stockRowHtml(item) {
  return `
    <tr>
      <td>${escapeHtml(item.name)}</td>
      <td class="muted">${escapeHtml(item.type)}</td>
      <td>${formatPrice(item.price_cents)}</td>
      <td>
        <!-- type="number" gives us the little up/down arrows and a
             numeric keypad on phones. min and max make the browser
             warn about silly values.

             IMPORTANT: none of that is security. A visitor can send
             any number they like straight to the API, bypassing this
             page entirely. That is exactly why routes/staff.js checks
             the quantity again on the server. The browser's job is to
             be helpful; the server's job is to be strict. -->
        <input
          type="number"
          class="stock-input"
          data-input-for="${item.watch_id}"
          value="${item.quantity}"
          min="0"
          max="999"
          step="1"
          aria-label="Stock for ${escapeHtml(item.name)}"
        >
      </td>
      <td>
        <button class="btn btn--ghost" data-save-for="${item.watch_id}">Save</button>
      </td>
    </tr>
  `;
}


// ------------------------------------------------------------
// Ask the server for the stock sheet, using the key we hold.
//
// Returns true if it worked, false if the key was refused. The caller
// decides what to do about it - this function just reports.
// ------------------------------------------------------------
async function loadStock() {
  try {
    // The second argument to fetch is the OPTIONS object. Here we use
    // it to add our own header. This is how the key reaches the server.
    const response = await fetch('/api/staff/stock', {
      headers: { 'x-staff-key': staffKey },
    });

    // 401 means the server did not accept the key.
    if (response.status === 401) {
      return false;
    }

    if (!response.ok) {
      throw new Error('The server replied ' + response.status);
    }

    const stock = await response.json();

    stockRows.innerHTML = stock.map(stockRowHtml).join('');

    return true;
  } catch (error) {
    console.error('Could not load the stock:', error);
    showMessage(stockMessage, 'error', 'Could not load the stock sheet. Is the server running?');
    return true;   // the key was fine; something else broke
  }
}


// ------------------------------------------------------------
// Save one row's new quantity.
// ------------------------------------------------------------
async function saveStock(watchId) {
  const input = document.querySelector('[data-input-for="' + watchId + '"]');

  if (!input) {
    return;
  }

  // Input values are always TEXT, even in a number box. Convert first.
  const newQuantity = Number(input.value);

  // A friendly check before we bother the server. The server checks
  // again anyway - this just gives a faster, clearer answer.
  if (!Number.isInteger(newQuantity) || newQuantity < 0 || newQuantity > 999) {
    showMessage(stockMessage, 'error', 'Quantity must be a whole number between 0 and 999.');
    return;
  }

  try {
    const response = await fetch('/api/staff/stock/' + watchId, {
      // PUT means "set this to exactly this value" (see LEARNING_NOTES).
      method: 'PUT',
      headers: {
        'x-staff-key': staffKey,
        // This header tells the server the body is JSON. Without it,
        // express.json() ignores the body and req.body stays empty -
        // a classic and very confusing bug.
        'Content-Type': 'application/json',
      },
      // The body must be TEXT, so we turn our object into JSON.
      body: JSON.stringify({ quantity: newQuantity }),
    });

    const result = await response.json();

    if (!response.ok) {
      // The server sends a plain-English reason, so we show that
      // rather than inventing our own wording.
      showMessage(stockMessage, 'error', escapeHtml(result.error || 'Could not save.'));
      return;
    }

    showMessage(stockMessage, 'success', 'Saved. New quantity: ' + result.stock.quantity + '.');
  } catch (error) {
    console.error('Could not save the stock:', error);
    showMessage(stockMessage, 'error', 'Could not reach the server.');
  }
}


// ------------------------------------------------------------
// Signing in.
// ------------------------------------------------------------
keyForm.addEventListener('submit', async function (event) {
  // A form's normal behaviour is to reload the whole page. We want to
  // stay put and talk to the server ourselves, so we cancel that.
  // Forgetting this line makes the page flash and appear to do nothing.
  event.preventDefault();

  clearMessage(keyMessage);

  // .trim() removes stray spaces, which are very easy to paste by accident.
  staffKey = keyInput.value.trim();

  if (!staffKey) {
    showMessage(keyMessage, 'error', 'Please enter the staff key.');
    return;
  }

  const accepted = await loadStock();

  if (!accepted) {
    staffKey = '';
    showMessage(keyMessage, 'error', 'That key was not accepted.');
    return;
  }

  // Swap the two sections over. "hidden" is a plain HTML attribute.
  keyCard.hidden = true;
  stockSection.hidden = false;

  // Clear the box so the key is not left sitting on screen.
  keyInput.value = '';
});


// ------------------------------------------------------------
// Signing out: forget the key and show the form again.
// ------------------------------------------------------------
signOutButton.addEventListener('click', function () {
  staffKey = '';
  stockRows.innerHTML = '';
  clearMessage(stockMessage);

  stockSection.hidden = true;
  keyCard.hidden = false;
});


// ------------------------------------------------------------
// One listener for every Save button - see the note on event
// delegation in shop.js. The rows do not exist yet when this runs,
// which is exactly why the listener goes on their container.
// ------------------------------------------------------------
stockRows.addEventListener('click', function (event) {
  const button = event.target.closest('button');

  if (!button || !button.dataset.saveFor) {
    return;
  }

  saveStock(Number(button.dataset.saveFor));
});
