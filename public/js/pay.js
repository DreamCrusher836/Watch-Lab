// ============================================================
// js/pay.js - the payment page.
//
// For now it only shows the order. Step 6 adds the two simulated
// payment buttons, and step 7 makes the webhook update the status.
// ============================================================

const orderSummary = document.getElementById('order-summary');
const paymentCard = document.getElementById('payment-card');
const paymentMessage = document.getElementById('payment-message');
const paySuccessButton = document.getElementById('pay-success');
const payFailedButton = document.getElementById('pay-failed');
const payButtonsRow = document.getElementById('pay-buttons');
const viewOrderLink = document.getElementById('view-order');
const eventCard = document.getElementById('event-card');
const eventLog = document.getElementById('event-log');


// ------------------------------------------------------------
// READING THE ORDER ID OUT OF THE URL (new concept)
//
// The cart page sent us to:  /pay.html?orderId=12
//
// Everything after the "?" is the QUERY STRING. URLSearchParams is
// built into the browser and reads it properly, so we do not have to
// chop the text up by hand and get it wrong.
//
// A NOTE ON SAFETY: this id came from the URL, so the visitor can
// change it to any number they like and look at someone else's order.
// In a real shop that would be a privacy leak, and you would fix it
// either by requiring a login, or by giving orders long unguessable
// ids (a UUID) instead of 1, 2, 3. We are keeping simple numbers
// because they are much easier to learn with - but it is worth
// knowing that this exact shortcut has caused real data breaches.
// ------------------------------------------------------------
const params = new URLSearchParams(window.location.search);
const orderId = params.get('orderId');


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


// ------------------------------------------------------------
// Turn a status into something a human wants to read.
// ------------------------------------------------------------
function statusBadge(status) {
  if (status === 'paid') {
    return '<span class="badge badge--ok">Paid</span>';
  }

  if (status === 'failed') {
    return '<span class="badge badge--out">Payment failed</span>';
  }

  return '<span class="badge badge--low">Awaiting payment</span>';
}


async function loadOrder() {
  // The id arrives as text from the URL, and could be anything.
  if (!orderId || !/^[0-9]+$/.test(orderId)) {
    orderSummary.innerHTML = '<div class="message message--error">No order was specified.</div>';
    return;
  }

  try {
    const response = await fetch('/api/orders/' + orderId);

    if (response.status === 404) {
      orderSummary.innerHTML = '<div class="message message--error">We could not find that order.</div>';
      return;
    }

    if (!response.ok) {
      throw new Error('The server replied ' + response.status);
    }

    const order = await response.json();

    // map() turns each item into a table row, join('') glues them.
    const rows = order.items.map(function (item) {
      return `
        <tr>
          <td>
            <strong>${escapeHtml(item.name)}</strong><br>
            <span class="muted">${escapeHtml(item.type)} · ${formatPrice(item.unit_price_cents)} each</span>
          </td>
          <td>${item.quantity}</td>
          <td class="text-right">${formatPrice(item.unit_price_cents * item.quantity)}</td>
        </tr>
      `;
    }).join('');

    orderSummary.innerHTML = `
      <div class="card">
        <div class="row" style="justify-content: space-between;">
          <h2 class="card__title" style="margin: 0;">Order #${order.id}</h2>
          <span id="order-status-badge">${statusBadge(order.status)}</span>
        </div>
        <p class="muted">For ${escapeHtml(order.customerName)} · ${escapeHtml(order.customerEmail)}</p>
      </div>

      <div class="table-wrap mt-4">
        <table>
          <thead>
            <tr><th>Watch</th><th>Qty</th><th class="text-right">Line total</th></tr>
          </thead>
          <tbody>${rows}</tbody>
          <tfoot>
            <tr>
              <th>Total</th>
              <th></th>
              <th class="text-right cart-total">${formatPrice(order.totalCents)}</th>
            </tr>
          </tfoot>
        </table>
      </div>
    `;

    // Only offer to pay while the order is still waiting for payment.
    // Once it is paid or failed, that decision is final - business
    // rule four - so showing the buttons would be a lie.
    paymentCard.hidden = false;

    if (order.status !== 'pending') {
      // The order is already finished. Hide the buttons, but do NOT
      // hide the whole card - somebody arriving on this link needs a
      // way onwards, and a dead end is a bad page.
      payButtonsRow.hidden = true;

      showPaymentMessage(
        order.status === 'paid' ? 'success' : 'error',
        'This order has already been ' + escapeHtml(order.status) + '. It cannot be paid again.'
      );

      viewOrderLink.href = '/order.html?orderId=' + encodeURIComponent(orderId);
      viewOrderLink.hidden = false;
    }
  } catch (error) {
    console.error('Could not load the order:', error);
    orderSummary.innerHTML = '<div class="message message--error">Could not load your order. Is the server running?</div>';
  }
}


// ============================================================
// SENDING A SIMULATED PAYMENT
// ============================================================

function showPaymentMessage(kind, text) {
  paymentMessage.innerHTML = '<div class="message message--' + kind + '">' + text + '</div>';
}


// ------------------------------------------------------------
// Ask our fake provider to process the payment with a chosen outcome.
//
// The customer's browser never talks to the webhook. It asks the
// PROVIDER to act, and the provider calls the shop back. Keeping that
// separation is the whole point of the exercise - it is how the real
// thing works, and it is why a stranger cannot simply post
// "payment succeeded" to our shop.
// ------------------------------------------------------------
async function simulatePayment(outcome) {
  paymentMessage.innerHTML = '';

  // Both buttons go dead while we wait. Otherwise an impatient click
  // sends a second payment for the same order.
  paySuccessButton.disabled = true;
  payFailedButton.disabled = true;

  try {
    const response = await fetch('/api/payments/simulate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderId: Number(orderId), outcome: outcome }),
    });

    const result = await response.json();

    if (!response.ok) {
      showPaymentMessage('error', escapeHtml(result.error || 'The payment could not be sent.'));
      return;
    }

    // Show the event exactly as it travelled. JSON.stringify's third
    // argument is how many spaces to indent by - without it you get
    // one unreadable line.
    eventLog.textContent =
      'Event sent by the provider:\n' +
      JSON.stringify(result.event, null, 2) +
      '\n\nThe shop replied ' + result.webhookStatus + ':\n' +
      JSON.stringify(result.webhookReply, null, 2);

    eventCard.hidden = false;

    // The webhook has now actually done something, so report what.
    const reply = result.webhookReply || {};

    if (reply.status === 'paid') {
      showPaymentMessage('success',
        'The shop received the event and marked order #' + escapeHtml(String(orderId)) + ' as <strong>paid</strong>.');
    } else if (reply.status === 'failed') {
      showPaymentMessage('error',
        'The shop received the event, marked the order <strong>failed</strong>, and put the held stock back on the shelf.');
    } else if (reply.duplicate) {
      showPaymentMessage('info',
        'The shop had already processed that event, so nothing changed. That is exactly what should happen.');
    } else {
      showPaymentMessage('info', escapeHtml(reply.message || 'The shop received the event.'));
    }

    // Refresh the badge at the top of the page. Without this it would
    // still read "Awaiting payment" underneath a message saying the
    // order was paid - a small thing that makes a page feel broken.
    //
    // We update just the badge rather than redrawing the whole summary,
    // so the event panel below stays on screen for you to read.
    const badgeHolder = document.getElementById('order-status-badge');

    if (badgeHolder && reply.status) {
      badgeHolder.innerHTML = statusBadge(reply.status);
    }

    // The order is finished now, so paying again makes no sense.
    payButtonsRow.hidden = true;
    viewOrderLink.href = '/order.html?orderId=' + encodeURIComponent(orderId);
    viewOrderLink.hidden = false;
  } catch (error) {
    console.error('Simulating the payment failed:', error);
    showPaymentMessage('error', 'Could not reach the server.');
  } finally {
    // "finally" runs whether we succeeded or failed, so the buttons
    // can never be left stuck disabled after an error.
    paySuccessButton.disabled = false;
    payFailedButton.disabled = false;
  }
}


paySuccessButton.addEventListener('click', function () {
  simulatePayment('success');
});

payFailedButton.addEventListener('click', function () {
  simulatePayment('failed');
});


loadOrder();
