-- ============================================================
-- Watch Store Lab - Step 7
-- Table: payments
--
-- HOW TO USE THIS FILE:
-- Copy everything below into the Supabase SQL Editor and press Run.
--
-- It only drops and recreates "payments", so your watches, stock,
-- orders and order_items are all left alone.
-- ============================================================


drop table if exists payments cascade;


-- ------------------------------------------------------------
-- TABLE: payments
--
-- A log of every event the payment provider has ever sent us.
-- Not "every payment" - every EVENT. If the provider tells us the
-- same thing twice, that is still only one row here, and that single
-- fact is what protects the whole shop.
-- ------------------------------------------------------------
create table payments (
  id serial primary key,

  order_id integer not null references orders(id) on delete cascade,

  -- ============================================================
  -- THE MOST IMPORTANT WORD IN THIS FILE IS "unique".
  --
  -- Payment providers promise to deliver each event AT LEAST once -
  -- never exactly once. If their call to us times out, or our server
  -- hiccups while replying, they send the same event again. Sometimes
  -- three or four times. This is normal, correct behaviour on their
  -- part: losing a payment notification is far worse than sending one
  -- twice.
  --
  -- Every copy carries the SAME event_id.
  --
  -- So we let the DATABASE be the memory. "unique" means Postgres
  -- physically cannot store the same event_id twice. The second
  -- attempt is refused, and that refusal is how our code knows "I
  -- have seen this one before - do nothing".
  --
  -- WHY PUT THIS IN THE DATABASE RATHER THAN IN JAVASCRIPT?
  -- Because a JavaScript check would be "look it up, then insert it" -
  -- two separate steps with a gap in between. Two copies of the event
  -- arriving at the same instant could both look, both find nothing,
  -- and both insert. It is the same race condition we met with stock
  -- in step 5, and it has the same cure: let one indivisible database
  -- operation do the checking.
  --
  -- The word for code that is safe to run twice is IDEMPOTENT.
  -- Step 8 proves ours is.
  -- ============================================================
  event_id text not null unique,

  -- What the provider told us. Constrained for the same reason the
  -- order status is: a typo must be rejected, not quietly stored.
  outcome text not null check (outcome in ('success', 'failed')),

  created_at timestamptz not null default now()
);


-- We will often ask "what events have arrived for order 12?", so we
-- give Postgres a pre-sorted lookup for that column. (See the note on
-- indexes in sql/02.)
create index payments_order_id_index on payments (order_id);


-- ------------------------------------------------------------
-- A check that it worked. You should see one row, with a count of 0.
-- ------------------------------------------------------------
select 'payments' as table_name, count(*) as rows from payments;
