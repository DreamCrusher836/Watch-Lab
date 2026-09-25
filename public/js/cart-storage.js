// ============================================================
// js/cart-storage.js - the shopping cart, kept in the browser.
//
// This file is loaded by SEVERAL pages (the shop, the cart, the
// header badge), which is why it lives on its own instead of inside
// one page's script. If two pages each had their own copy of these
// functions, the day you fixed a bug in one you would forget the other.
// ============================================================


// ------------------------------------------------------------
// WHAT IS localStorage? (new concept)
//
// A small box of text that the browser keeps for a website, on the
// visitor's own computer. It survives closing the tab and even
// restarting the machine. Our server never sees it.
//
// It is like a scrap of paper in the customer's pocket, not a note
// kept behind the shop counter. That has consequences:
//
//   - The cart follows the browser, not the person. Open the shop on
//     your phone and the cart is empty, because it is a different pocket.
//   - The customer can edit it. It is their computer. So we must NEVER
//     trust what is in it.
//
// That last point is the important one, and it is why we store only
// the watch id and how many - NOT the price. When the order is placed,
// the server looks every price up in the database and ignores anything
// the browser claims. Otherwise someone could edit their own cart to
// say a EUR 329 chronograph costs EUR 1.
// ------------------------------------------------------------

// The name of our box. A constant, so a typo becomes an obvious error
// in one place instead of a silently empty cart.
const CART_KEY = 'watch-store-cart';

// House rule from the project design: nobody may order more than 5 of
// one watch. Written once here so every page agrees on the number.
const MAX_PER_WATCH = 5;


// ------------------------------------------------------------
// Read the cart. Always returns an array, never undefined.
//
// Everything is wrapped in try/catch because localStorage holds TEXT.
// If that text is not valid JSON - the customer edited it, or an old
// version of our code wrote a different shape - JSON.parse throws and
// would break every page that loads. We would rather start from an
// empty cart than show a broken site.
// ------------------------------------------------------------
function getCart() {
  try {
    const savedText = localStorage.getItem(CART_KEY);

    // getItem returns null if we have never saved anything.
    if (!savedText) {
      return [];
    }

    const cart = JSON.parse(savedText);

    // Even valid JSON might not be an array (someone could store `5`).
    if (!Array.isArray(cart)) {
      return [];
    }

    return cart;
  } catch (error) {
    console.error('Could not read the cart, starting empty:', error);
    return [];
  }
}


// ------------------------------------------------------------
// Save the cart back, then update the little number in the header.
// ------------------------------------------------------------
function saveCart(cart) {
  try {
    // localStorage only stores text, so we turn our array into JSON text.
    localStorage.setItem(CART_KEY, JSON.stringify(cart));
  } catch (error) {
    // This can genuinely fail - private browsing modes sometimes block it.
    console.error('Could not save the cart:', error);
  }

  updateCartBadge();
}


// ------------------------------------------------------------
// Add one watch to the cart.
//
// Returns a small object saying what happened, so the page that called
// it can show a sensible message. Returning a result instead of
// popping up an alert keeps this file reusable: it decides WHAT
// happened, the page decides how to SAY it.
// ------------------------------------------------------------
function addToCart(watchId, stockAvailable) {
  const cart = getCart();

  // find() gives us the matching item, or undefined if it is not there.
  const existingItem = cart.find(function (item) {
    return item.watchId === watchId;
  });

  // How many of this watch are already in the cart?
  const quantityNow = existingItem ? existingItem.quantity : 0;
  const quantityWanted = quantityNow + 1;

  // Rule: never more than the shop actually has.
  // NOTE: this check is a COURTESY, not security. The stock number came
  // from the browser and the cart lives on the customer's computer, so
  // both can be faked. The real, binding check happens on the server
  // when the order is placed (step 4 and 5). Checking here just means
  // the customer finds out now instead of at checkout.
  if (quantityWanted > stockAvailable) {
    return { ok: false, message: 'Only ' + stockAvailable + ' in stock.' };
  }

  // Rule: never more than 5 of one watch.
  if (quantityWanted > MAX_PER_WATCH) {
    return { ok: false, message: 'Limit is ' + MAX_PER_WATCH + ' per watch.' };
  }

  if (existingItem) {
    existingItem.quantity = quantityWanted;
  } else {
    // Only the id and the quantity. No price - see the note at the top.
    cart.push({ watchId: watchId, quantity: 1 });
  }

  saveCart(cart);

  return { ok: true, message: 'Added to cart.' };
}


// ------------------------------------------------------------
// How many items are in the cart altogether?
// reduce() walks the array adding each quantity onto a running total
// that starts at 0.
// ------------------------------------------------------------
function countCartItems() {
  const cart = getCart();

  return cart.reduce(function (runningTotal, item) {
    return runningTotal + item.quantity;
  }, 0);
}


// ------------------------------------------------------------
// Show the item count next to "Cart" in the header.
// Every page calls this on load, so the number is always right.
// ------------------------------------------------------------
function updateCartBadge() {
  const badge = document.getElementById('cart-count');

  // Not every page has the badge, so check before touching it.
  // Reading a property of null is one of the most common JavaScript
  // errors there is, and this one line prevents it.
  if (!badge) {
    return;
  }

  const count = countCartItems();

  badge.textContent = count;

  // Hide the badge entirely when the cart is empty - a grey "0" is
  // noise, and an empty cart has nothing to say.
  badge.hidden = count === 0;
}


// ------------------------------------------------------------
// Change how many of one watch are in the cart.
//
// Used by the cart page, where the customer can type a new number
// instead of clicking Add over and over.
// ------------------------------------------------------------
function setCartQuantity(watchId, newQuantity, stockAvailable) {
  // Setting it to zero is the natural way to say "remove this".
  if (newQuantity <= 0) {
    removeFromCart(watchId);
    return { ok: true, message: 'Removed.' };
  }

  if (!Number.isInteger(newQuantity)) {
    return { ok: false, message: 'Quantity must be a whole number.' };
  }

  if (newQuantity > MAX_PER_WATCH) {
    return { ok: false, message: 'Limit is ' + MAX_PER_WATCH + ' per watch.' };
  }

  // Again: a courtesy, not security. The server checks for real.
  if (newQuantity > stockAvailable) {
    return { ok: false, message: 'Only ' + stockAvailable + ' in stock.' };
  }

  const cart = getCart();

  const item = cart.find(function (entry) {
    return entry.watchId === watchId;
  });

  if (!item) {
    return { ok: false, message: 'That watch is not in the cart.' };
  }

  item.quantity = newQuantity;
  saveCart(cart);

  return { ok: true, message: 'Updated.' };
}


// ------------------------------------------------------------
// Take one watch out of the cart completely.
//
// filter() builds a NEW array containing only the items that pass the
// test - here, everything that is not the one we are removing. We
// rebuild rather than deleting in place because it is far easier to
// read, and cart arrays are tiny.
// ------------------------------------------------------------
function removeFromCart(watchId) {
  const cart = getCart();

  const remaining = cart.filter(function (item) {
    return item.watchId !== watchId;
  });

  saveCart(remaining);
}


// ------------------------------------------------------------
// Empty the cart. Called after an order is successfully placed -
// at that point the watches are held in the database, so the note in
// the customer's pocket has done its job and should not linger.
// ------------------------------------------------------------
function clearCart() {
  saveCart([]);
}


// Run once as soon as this file loads, so the header is correct
// the moment any page appears.
updateCartBadge();
