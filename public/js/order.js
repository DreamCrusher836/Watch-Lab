// ============================================================
// js/order.js - the final confirmation page.
//
// It reads the order id from the URL, asks the server for the order,
// and shows one of three outcomes: paid, failed, or still waiting.
// ============================================================

const orderPage = document.getElementById('order-page');

// The id arrives in the query string, e.g. /order.html?orderId=12
// (See the note in pay.js about why simple numeric ids would be a
// privacy problem in a real shop.)
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
// Everything that differs between the three outcomes, in one place.
//
// Keeping the wording here rather than scattered through if/else
// branches means you can change what the customer reads without
// touching any logic - and you can see all three messages side by
// side and check they make sense together.
// ------------------------------------------------------------
function outcomeFor(status) {
  if (status === 'paid') {
    return {
      emoji: '✅',
      heading: 'Payment received',
      badge: '<span class="badge badge--ok">Paid</span>',
      blurb: 'Thank you. Your watches are reserved and on their way. ' +
             '(Not really — nothing is actually shipped from a practice shop.)',
      actionHtml: '<a class="btn btn--primary" href="/">Back to the shop</a>',
    };
  }

  if (status === 'failed') {
    return {
      emoji: '⚠️',
      heading: 'Payment failed',
      badge: '<span class="badge badge--out">Payment failed</span>',
      blurb: 'Your payment did not go through, so nothing was charged. ' +
             'The watches we were holding have gone back on the shelf for ' +
             'someone else, so you would need to order again.',
      actionHtml: '<a class="btn btn--primary" href="/">Back to the shop</a>',
    };
  }

  // Anything else means "pending" - the customer has not paid yet.
  return {
    emoji: '⏳',
    heading: 'Awaiting payment',
    badge: '<span class="badge badge--low">Awaiting payment</span>',
    blurb: 'This order has not been paid for yet. Your watches are being ' +
           'held until it is.',
    actionHtml: '<a class="btn btn--primary" href="/pay.html?orderId=' +
                encodeURIComponent(orderId) + '">Go to payment</a>',
  };
}


async function loadOrder() {
  // The id came from the URL, so it could be anything at all.
  if (!orderId || !/^[0-9]+$/.test(orderId)) {
    orderPage.innerHTML = '<div class="message message--error">No order was specified.</div>';
    return;
  }

  try {
    const response = await fetch('/api/orders/' + orderId);

    if (response.status === 404) {
      orderPage.innerHTML = '<div class="message message--error">We could not find that order.</div>';
      return;
    }

    if (!response.ok) {
      throw new Error('The server replied ' + response.status);
    }

    const order = await response.json();
    const outcome = outcomeFor(order.status);

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

    // toLocaleString turns the database timestamp into something a
    // person reads, in their own country's format.
    const placedAt = new Date(order.createdAt).toLocaleString('en-IE');

    orderPage.innerHTML = `
      <div class="outcome">
        <div class="outcome__mark">${outcome.emoji}</div>
        <h1>${outcome.heading}</h1>
        <p>${outcome.blurb}</p>
        <div class="mt-5">${outcome.actionHtml}</div>
      </div>

      <div class="card mt-5">
        <div class="row" style="justify-content: space-between;">
          <h2 class="card__title" style="margin: 0;">Order #${order.id}</h2>
          ${outcome.badge}
        </div>
        <p class="muted">
          ${escapeHtml(order.customerName)} · ${escapeHtml(order.customerEmail)}<br>
          Placed ${escapeHtml(placedAt)}
        </p>
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
  } catch (error) {
    console.error('Could not load the order:', error);
    orderPage.innerHTML = '<div class="message message--error">Could not load your order. Is the server running?</div>';
  }
}


loadOrder();
