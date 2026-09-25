// ============================================================
// routes/payments.js - our pretend payment provider.
//
//   POST /api/payments/simulate
//   Body: { orderId: 12, outcome: "success" | "failed" }
//
// ------------------------------------------------------------
// WHAT IS A WEBHOOK? (the big idea of this step)
//
// When you pay with a real provider (Stripe, Adyen, PayPal), your
// shop does NOT sit and wait for an answer. Card payments can take
// seconds, need bank checks, sometimes need the customer to approve
// something in their banking app. Holding a web request open that
// long would be hopeless.
//
// So the conversation is turned around. The shop says "here is a
// payment to process, and here is my address". Later - a second
// later, or a minute later - the PROVIDER calls the SHOP back to
// report what happened. That callback is a webhook.
//
// It is the difference between waiting on hold, and leaving your
// number and being rung back. A webhook is the ring-back.
//
// Two things follow, and they are the whole reason steps 7 and 8 exist:
//
//   1. The call comes from OUTSIDE, from a machine we do not control,
//      to a public URL. Anyone who finds that URL can call it too and
//      claim a payment succeeded. So it must be authenticated.
//
//   2. Providers guarantee "at least once" delivery, not "exactly
//      once". If their call times out, or our server hiccups while
//      replying, they try again. So the SAME event genuinely arrives
//      twice, and we must handle that without shipping two watches.
//
// This file plays the part of the provider so we can trigger both
// situations on demand.
// ============================================================

const express = require('express');
const crypto = require('crypto');
const db = require('../db');

const router = express.Router();


// ------------------------------------------------------------
// POST /api/payments/simulate
//
// In real life the customer would be sent to the provider's own
// payment page. Here, two buttons on pay.html call this instead, and
// we decide the outcome ourselves - which is exactly what makes a
// failed payment easy to test.
// ------------------------------------------------------------
router.post('/simulate', async function (req, res) {
  try {
    const orderId = Number(req.body.orderId);
    const outcome = req.body.outcome;

    if (!Number.isInteger(orderId) || orderId < 1) {
      return res.status(400).json({ error: 'The order id must be a whole number.' });
    }

    // Only two outcomes exist. Anything else is a caller mistake, and
    // we say so rather than quietly guessing what they meant.
    if (outcome !== 'success' && outcome !== 'failed') {
      return res.status(400).json({ error: 'Outcome must be "success" or "failed".' });
    }

    // --- Does this order actually exist? ---
    //
    // A real provider would know, because the shop told it about the
    // payment up front. We check so that a typed-in order id gives a
    // clear 404 instead of a confusing webhook failure later.
    //
    // Note we do NOT check the status here. Deciding what to do about
    // an order that is already paid is the WEBHOOK's job (step 7), and
    // it has to be able to cope regardless - because a real provider
    // can resend an old event at any time.
    const orderLookup = await db.query(
      'select id, status, total_cents from orders where id = $1',
      [orderId]
    );

    if (orderLookup.rows.length === 0) {
      return res.status(404).json({ error: 'No order with that id.' });
    }

    const order = orderLookup.rows[0];

    // ------------------------------------------------------------
    // BUILD THE EVENT.
    //
    // THE EVENT ID IS THE IMPORTANT PART.
    //
    // Every event gets its own permanent, unique id. If the provider
    // sends this same event five times - because our reply got lost,
    // or their network blinked - all five copies carry the SAME id.
    //
    // That id is what lets us say "I have already dealt with this
    // one" and ignore the repeats. It is the reference number on a
    // letter: receiving three photocopies of the same letter is not
    // three separate requests.
    //
    // crypto.randomUUID() is built into Node. It produces something
    // like "9f1c2e7a-...", random enough that a collision will never
    // happen in practice. The "evt_" prefix is only for human eyes,
    // so you can tell at a glance what kind of id you are looking at.
    //
    // Step 7 stores it in the payments table with a UNIQUE constraint,
    // and step 8 proves the duplicate handling really works.
    // ------------------------------------------------------------
    const event = {
      eventId: 'evt_' + crypto.randomUUID(),
      type: outcome === 'success' ? 'payment.succeeded' : 'payment.failed',
      orderId: order.id,
      outcome: outcome,
      amountCents: order.total_cents,
      createdAt: new Date().toISOString(),
    };

    // ------------------------------------------------------------
    // WORK OUT OUR OWN ADDRESS.
    //
    // The provider has to call us over real HTTP, so we need a real
    // URL. We build it from the incoming request rather than writing
    // "http://localhost:3000" into the code, because the same code
    // has to work on your laptop AND on Vercel, where the address is
    // something else entirely.
    //
    //   req.protocol  -> "http" locally, "https" in production
    //   req.get('host') -> "localhost:3000" or "your-app.vercel.app"
    // ------------------------------------------------------------
    const webhookUrl = req.protocol + '://' + req.get('host') + '/api/webhooks/payment';

    console.log('[fake provider] sending ' + event.type + ' for order ' + order.id + ' (' + event.eventId + ')');

    // ------------------------------------------------------------
    // SEND IT.
    //
    // fetch is built into Node 18 and later - no package needed.
    //
    // The x-webhook-secret header is the shared password between the
    // "provider" and our shop. The webhook route rejects anything
    // without it, which is what stops a stranger posting
    // "payment succeeded" to our public URL and getting a free watch.
    //
    // Real providers use something stronger (a signature over the
    // whole body, so the message cannot be altered either), but a
    // shared secret shows the idea with far less machinery.
    // ------------------------------------------------------------
    const webhookResponse = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-webhook-secret': process.env.WEBHOOK_SECRET,
      },
      body: JSON.stringify(event),
    });

    const webhookResult = await webhookResponse.json();

    // Hand the whole exchange back to the browser so the pay page can
    // show what happened. A real provider would never tell the
    // customer's browser this much - it is here purely so you can SEE
    // the machinery working instead of guessing.
    res.json({
      ok: webhookResponse.ok,
      message: 'Event sent to the shop\'s webhook.',
      event: event,
      webhookStatus: webhookResponse.status,
      webhookReply: webhookResult,
    });
  } catch (error) {
    console.error('POST /api/payments/simulate failed:', error.message);
    res.status(500).json({ error: 'The simulated payment could not be sent.' });
  }
});


module.exports = router;
