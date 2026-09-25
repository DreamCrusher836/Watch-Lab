// ============================================================
// js/shop.js - the shop front (index.html).
//
// Its job: ask our own API for the watches, draw a card for each one,
// and let the customer add them to the cart.
// ============================================================

// The empty <div> in the HTML that we are going to fill with cards.
const grid = document.getElementById('watch-grid');

// We keep the watches here after loading them, so that when someone
// clicks "Add to cart" we can look up that watch's stock without
// asking the server all over again.
let loadedWatches = [];


// ------------------------------------------------------------
// We have no photographs, so each type of watch gets an emoji "dial".
// An object used like this is a LOOKUP TABLE: instead of a long
// if/else chain, we ask it a question by name.
// ------------------------------------------------------------
const emojiForType = {
  'Diver': '🌊',
  'Dress': '🎩',
  'Chronograph': '⏱️',
  'Pilot': '✈️',
  'Field': '🧭',
  'Smartwatch': '📱',
};


// ------------------------------------------------------------
// Turn 24900 into "€249.00".
//
// Remember: the database stores cents as whole numbers, because
// decimals are unreliable for money. Dividing by 100 is the LAST
// thing we do, purely so a human can read it.
//
// Intl.NumberFormat is built into every browser. It knows where the
// currency symbol goes and which separators a country uses.
// ------------------------------------------------------------
function formatPrice(priceInCents) {
  const euros = priceInCents / 100;

  return new Intl.NumberFormat('en-IE', {
    style: 'currency',
    currency: 'EUR',
  }).format(euros);
}


// ------------------------------------------------------------
// Make text safe to put inside HTML.
//
// WHY (new concept - XSS):
// We build our cards by writing HTML as text. If a watch were ever
// named  <img src=x onerror="steal()">  the browser would run that
// code as part of our page. That attack is called cross-site
// scripting, or XSS.
//
// Our six watch names are our own and perfectly safe - but the habit
// matters more than this one page. The moment ANY text comes from a
// customer (a name at checkout, a review), this is what stops it.
//
// The trick: set it as .textContent, which the browser treats as plain
// text, then read .innerHTML back out - now correctly escaped, so
// "<" has become "&lt;" and can no longer start a tag.
// ------------------------------------------------------------
function escapeHtml(text) {
  const holder = document.createElement('div');
  holder.textContent = text;
  return holder.innerHTML;
}


// ------------------------------------------------------------
// Decide which stock label to show.
//
// Returning a small object (rather than printing anything) keeps this
// function easy to read and easy to change: all the wording lives in
// one place, and the drawing code below stays simple.
// ------------------------------------------------------------
function stockLabel(quantity) {
  if (quantity === 0) {
    return { className: 'badge--out', text: 'Sold out' };
  }

  if (quantity === 1) {
    return { className: 'badge--low', text: 'Only 1 left' };
  }

  if (quantity <= 3) {
    return { className: 'badge--low', text: 'Only ' + quantity + ' left' };
  }

  return { className: 'badge--ok', text: quantity + ' in stock' };
}


// ------------------------------------------------------------
// Build the HTML for one watch card.
// ------------------------------------------------------------
function watchCardHtml(watch) {
  const badge = stockLabel(watch.quantity);
  const isSoldOut = watch.quantity === 0;
  const emoji = emojiForType[watch.type] || '⌚';   // a fallback, just in case

  // "data-watch-id" is a DATA ATTRIBUTE: a place to park a value on an
  // HTML element so our JavaScript can read it back later. When the
  // button is clicked we will ask it "which watch are you?" instead of
  // having to keep a separate list of buttons.
  //
  // The "disabled" attribute on a sold-out button does two jobs: the
  // browser refuses to fire a click, AND our CSS greys it out. Looking
  // disabled and being disabled must always go together.
  return `
    <article class="watch-card">
      <div class="watch-card__dial">
        <div class="watch-card__face">${emoji}</div>
      </div>
      <div class="watch-card__body">
        <p class="watch-card__type">${escapeHtml(watch.type)}</p>
        <h2 class="watch-card__name">${escapeHtml(watch.name)}</h2>
        <p class="watch-card__desc">${escapeHtml(watch.description)}</p>

        <div class="watch-card__row">
          <span class="watch-card__price">${formatPrice(watch.price_cents)}</span>
          <span class="badge ${badge.className}">${badge.text}</span>
        </div>

        <button
          class="btn btn--primary btn--full"
          data-watch-id="${watch.id}"
          ${isSoldOut ? 'disabled' : ''}
        >${isSoldOut ? 'Unavailable' : 'Add to cart'}</button>

        <p class="watch-card__note muted" data-note-for="${watch.id}"></p>
      </div>
    </article>
  `;
}


// ------------------------------------------------------------
// Show a short message under one watch's button, and clear it again
// after a moment so the page does not fill up with old notices.
// ------------------------------------------------------------
function showNote(watchId, text, isError) {
  const note = document.querySelector('[data-note-for="' + watchId + '"]');

  if (!note) {
    return;
  }

  note.textContent = text;
  note.style.color = isError ? 'var(--danger)' : 'var(--ok)';

  // setTimeout runs a function later - here, 2.5 seconds later.
  setTimeout(function () {
    note.textContent = '';
  }, 2500);
}


// ------------------------------------------------------------
// Handle a click on any "Add to cart" button.
//
// EVENT DELEGATION (new concept):
// Instead of attaching a listener to each of the six buttons, we
// attach ONE to the grid that contains them. Clicks bubble upwards
// from the element you hit to its parents, so the grid hears them all.
//
// Why bother? Because the buttons do not exist when the page loads -
// we create them after the data arrives. One listener on the container
// works for buttons added at any time, and there is only ever one
// listener to remove. It is a receptionist for the whole floor
// instead of a secretary at every desk.
// ------------------------------------------------------------
function handleGridClick(event) {
  // event.target is the exact thing clicked. closest('button') walks
  // upwards looking for a button, so it still works if the click
  // landed on text inside the button.
  const button = event.target.closest('button');

  // Clicked the card but not a button - nothing to do.
  if (!button) {
    return;
  }

  // Read the id we parked on the element. Attributes are always text,
  // so convert it to a number before comparing it to our data.
  const watchId = Number(button.dataset.watchId);

  const watch = loadedWatches.find(function (item) {
    return item.id === watchId;
  });

  if (!watch) {
    return;
  }

  const result = addToCart(watch.id, watch.quantity);

  showNote(watch.id, result.message, !result.ok);
}


// ------------------------------------------------------------
// Load the watches and draw them.
// ------------------------------------------------------------
async function loadWatches() {
  try {
    const response = await fetch('/api/watches');

    // fetch does NOT throw on a 404 or a 500 - it only throws if the
    // request could not be made at all. So we must check .ok ourselves.
    if (!response.ok) {
      throw new Error('The server replied ' + response.status);
    }

    loadedWatches = await response.json();

    if (loadedWatches.length === 0) {
      grid.innerHTML = '<p class="muted">No watches found. Have you run the SQL file in Supabase?</p>';
      return;
    }

    // map() turns each watch into its HTML, and join('') glues the
    // pieces into one string. We write to the page ONCE, at the end.
    // Writing inside the loop would make the browser redraw six times.
    grid.innerHTML = loadedWatches.map(watchCardHtml).join('');
  } catch (error) {
    console.error('Could not load the watches:', error);
    grid.innerHTML = '<div class="message message--error">Could not load the watches. Is the server running?</div>';
  }
}


// Listen for clicks anywhere in the grid, then load the data.
grid.addEventListener('click', handleGridClick);
loadWatches();
