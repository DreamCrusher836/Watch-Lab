// ============================================================
// js/cart.js - the cart page.
//
// The cart in localStorage holds only watch ids and quantities. To
// SHOW it we need names and prices, so this page fetches the watches
// from the server and matches them up.
//
// That is not a workaround - it is the design. The browser storing no
// prices is exactly what stops anyone editing one.
// ============================================================

const cartContents = document.getElementById('cart-contents');
const cartMessage = document.getElementById('cart-message');
const checkoutCard = document.getElementById('checkout-card');
const checkoutForm = document.getElementById('checkout-form');
const checkoutMessage = document.getElementById('checkout-message');
const placeOrderButton = document.getElementById('place-order');

// The watches as the server knows them. Loaded once when the page opens.
let watchesFromServer = [];


function formatPrice(priceInCents) {
  return new Intl.NumberFormat('en-IE', {
    style: 'currency',
    currency: 'EUR',
  }).format(priceInCents / 100);
}


function escapeHtml(text) {
  const holder = document.createElement('div');
  holder.textContent = text;
  return holder.innerHTML;
}


function showMessage(element, kind, text) {
  element.innerHTML = '<div class="message message--' + kind + '">' + text + '</div>';
}


function clearMessage(element) {
  element.innerHTML = '';
}


// ------------------------------------------------------------
// Join the cart to the watch data.
//
// For each line in the pocket-note cart, find the matching watch from
// the server. If it is not there (the watch was deleted while the
// customer was away), we simply drop that line rather than crashing.
//
// This is the same idea as a database JOIN, done by hand in JavaScript.
// ------------------------------------------------------------
function buildCartLines() {
  const cart = getCart();
  const lines = [];

  for (const item of cart) {
    const watch = watchesFromServer.find(function (candidate) {
      return candidate.id === item.watchId;
    });

    if (!watch) {
      continue;   // skip a watch that no longer exists
    }

    lines.push({
      watchId: watch.id,
      name: watch.name,
      type: watch.type,
      unitPriceCents: watch.price_cents,
      stockAvailable: watch.quantity,
      quantity: item.quantity,
      // The line total. Worked out here purely for DISPLAY - the
      // server works out the real total again from its own prices.
      lineTotalCents: watch.price_cents * item.quantity,
    });
  }

  return lines;
}


// ------------------------------------------------------------
// Draw one row of the cart.
// ------------------------------------------------------------
function cartLineHtml(line) {
  // If the shop has sold out since this went in the cart, say so
  // clearly rather than letting the customer discover it at checkout.
  const tooMany = line.quantity > line.stockAvailable;

  const warning = tooMany
    ? '<span class="badge badge--out">Only ' + line.stockAvailable + ' left</span>'
    : '';

  return `
    <tr>
      <td>
        <strong>${escapeHtml(line.name)}</strong><br>
        <span class="muted">${escapeHtml(line.type)} · ${formatPrice(line.unitPriceCents)} each</span>
        ${warning}
      </td>
      <td>
        <input
          type="number"
          class="stock-input"
          data-quantity-for="${line.watchId}"
          value="${line.quantity}"
          min="1"
          max="5"
          step="1"
          aria-label="Quantity of ${escapeHtml(line.name)}"
        >
      </td>
      <td class="text-right"><strong>${formatPrice(line.lineTotalCents)}</strong></td>
      <td class="text-right">
        <button class="btn btn--danger" data-remove-for="${line.watchId}">Remove</button>
      </td>
    </tr>
  `;
}


// ------------------------------------------------------------
// Draw the whole cart, or the empty state.
// ------------------------------------------------------------
function renderCart() {
  const lines = buildCartLines();

  if (lines.length === 0) {
    cartContents.innerHTML = `
      <div class="card">
        <h2 class="card__title">Your cart is empty</h2>
        <p class="muted">Nothing here yet.</p>
        <a class="btn btn--primary mt-4" href="/">Browse the watches</a>
      </div>
    `;

    // No point showing a checkout form with nothing to check out.
    checkoutCard.hidden = true;
    return;
  }

  // reduce() adds every line total onto a running sum that starts at 0.
  const totalCents = lines.reduce(function (runningTotal, line) {
    return runningTotal + line.lineTotalCents;
  }, 0);

  cartContents.innerHTML = `
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Watch</th>
            <th>Qty</th>
            <th class="text-right">Line total</th>
            <th><span class="visually-hidden">Remove</span></th>
          </tr>
        </thead>
        <tbody id="cart-rows">
          ${lines.map(cartLineHtml).join('')}
        </tbody>
        <tfoot>
          <tr>
            <th>Total</th>
            <th></th>
            <th class="text-right cart-total">${formatPrice(totalCents)}</th>
            <th></th>
          </tr>
        </tfoot>
      </table>
    </div>
  `;

  checkoutCard.hidden = false;
}


// ------------------------------------------------------------
// Load the watches, then draw.
// ------------------------------------------------------------
async function loadAndRender() {
  try {
    const response = await fetch('/api/watches');

    if (!response.ok) {
      throw new Error('The server replied ' + response.status);
    }

    watchesFromServer = await response.json();

    renderCart();
  } catch (error) {
    console.error('Could not load the watches:', error);
    cartContents.innerHTML = '<div class="message message--error">Could not reach the shop. Is the server running?</div>';
  }
}


// ------------------------------------------------------------
// Clicks inside the cart table - one listener for all of them.
// (See the note on event delegation in shop.js.)
// ------------------------------------------------------------
cartContents.addEventListener('click', function (event) {
  const button = event.target.closest('button');

  if (!button || !button.dataset.removeFor) {
    return;
  }

  removeFromCart(Number(button.dataset.removeFor));

  clearMessage(cartMessage);
  renderCart();
});


// ------------------------------------------------------------
// Changing a quantity box.
//
// "change" fires when the customer finishes editing (leaves the box
// or presses Enter), not on every keystroke. "input" would fire as
// they type, which would fight them mid-number - deleting "12" to
// type "3" would briefly be an empty box and we would react to it.
// ------------------------------------------------------------
cartContents.addEventListener('change', function (event) {
  const input = event.target.closest('[data-quantity-for]');

  if (!input) {
    return;
  }

  const watchId = Number(input.dataset.quantityFor);
  const newQuantity = Number(input.value);

  const watch = watchesFromServer.find(function (candidate) {
    return candidate.id === watchId;
  });

  if (!watch) {
    return;
  }

  const result = setCartQuantity(watchId, newQuantity, watch.quantity);

  if (!result.ok) {
    showMessage(cartMessage, 'error', result.message);
  } else {
    clearMessage(cartMessage);
  }

  // Redraw either way: on success to update the totals, on failure to
  // put the box back to the value that is actually stored.
  renderCart();
});


// ------------------------------------------------------------
// PLACING THE ORDER.
// ------------------------------------------------------------
checkoutForm.addEventListener('submit', async function (event) {
  // Stop the browser reloading the page - we are handling this ourselves.
  event.preventDefault();

  clearMessage(checkoutMessage);

  const cart = getCart();

  if (cart.length === 0) {
    showMessage(checkoutMessage, 'error', 'Your cart is empty.');
    return;
  }

  // DISABLE THE BUTTON WHILE WE WAIT.
  //
  // Without this, an impatient double-click sends the request twice
  // and creates TWO orders, each holding stock. It is the simplest
  // and most common cause of duplicate orders in real shops.
  //
  // Note this is only good manners, not a guarantee - a determined
  // person can still send the request twice. Making the SERVER safe
  // against repeats is a much bigger idea, and it is what step 8 is
  // all about.
  placeOrderButton.disabled = true;
  placeOrderButton.textContent = 'Placing your order…';

  try {
    const response = await fetch('/api/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Notice what we send: names, an email, and ids with quantities.
      // No prices. There is nothing here worth tampering with.
      body: JSON.stringify({
        customerName: document.getElementById('customer-name').value,
        customerEmail: document.getElementById('customer-email').value,
        items: cart.map(function (item) {
          return { watchId: item.watchId, quantity: item.quantity };
        }),
      }),
    });

    const result = await response.json();

    if (!response.ok) {
      // The server sends a plain-English reason (out of stock, bad
      // email, and so on), so we show its wording rather than ours.
      showMessage(checkoutMessage, 'error', escapeHtml(result.error || 'Could not place the order.'));

      // Stock may have moved since the page loaded, so refresh the
      // numbers - the customer should see the new reality.
      await loadAndRender();
      return;
    }

    // The order exists and the stock is held in the database, so the
    // note in the pocket has done its job.
    clearCart();

    // Off to the payment page, carrying the order id in the URL.
    window.location.href = '/pay.html?orderId=' + result.orderId;
  } catch (error) {
    console.error('Placing the order failed:', error);
    showMessage(checkoutMessage, 'error', 'Could not reach the server. Please try again.');
  } finally {
    // "finally" runs whether we succeeded or failed. Putting the button
    // back here means it can never be left stuck on "Placing your
    // order…" after an error - a very easy bug to create by putting
    // this line in only one of the two paths.
    placeOrderButton.disabled = false;
    placeOrderButton.textContent = 'Place order';
  }
});


loadAndRender();
