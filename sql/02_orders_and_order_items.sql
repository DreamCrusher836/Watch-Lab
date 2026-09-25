-- ============================================================
-- Watch Store Lab - Step 4
-- Tables: orders + order_items
--
-- HOW TO USE THIS FILE:
-- Copy everything below into the Supabase SQL Editor and press Run.
--
-- Safe to run again: it drops these two tables first. That throws
-- away any test orders you have made, which is exactly what you want
-- in a practice project and never what you want in a real shop.
--
-- It does NOT touch watches or stock, so your six watches stay put.
-- ============================================================


drop table if exists order_items cascade;
drop table if exists orders cascade;


-- ------------------------------------------------------------
-- TABLE: orders
-- One row per attempt to buy something. "Attempt", not "sale" -
-- an order exists from the moment the customer clicks Place order,
-- long before anyone has paid.
-- ------------------------------------------------------------
create table orders (
  id serial primary key,

  -- No login in this project, so the customer simply types these at
  -- checkout. We store them as plain text because that is genuinely
  -- all they are: a name and an email, not credentials.
  customer_name text not null,
  customer_email text not null,

  -- THE STATUS, AND WHY IT IS CONSTRAINED
  --
  -- An order is only ever one of three things:
  --   pending - created, stock held, nobody has paid yet
  --   paid    - the payment provider said yes
  --   failed  - the payment provider said no, stock given back
  --
  -- The "check" makes those three the ONLY values the column will
  -- accept. Without it, a typo anywhere in our code ('Paid', 'padi',
  -- 'complete') would be stored happily, and later every query that
  -- looks for 'paid' would quietly miss those orders. Bugs like that
  -- are horrible to find, because nothing ever errors - the numbers
  -- are just wrong.
  --
  -- "default 'pending'" means we never have to remember to set it.
  status text not null default 'pending'
    check (status in ('pending', 'paid', 'failed')),

  -- The total, in cents, worked out by the SERVER from database
  -- prices. We store it rather than recalculating it later, because
  -- if a watch's price changes next month, this order must still show
  -- what the customer actually agreed to pay. A receipt is a record of
  -- a moment, not a live calculation.
  total_cents integer not null check (total_cents >= 0),

  created_at timestamptz not null default now()
);


-- ------------------------------------------------------------
-- TABLE: order_items
-- One row per LINE on the order. An order for two Harbour Divers and
-- one Apex Chrono is one row in "orders" and two rows in here.
--
-- WHY A SEPARATE TABLE?
-- Because an order can contain any number of watches, and a column
-- cannot hold "any number of things". This shape - one "orders" row
-- with many "order_items" rows pointing back at it - is called a
-- ONE-TO-MANY relationship, and it is the most common shape in all
-- of database design. Think of the order as the receipt header and
-- these as the printed lines below it.
-- ------------------------------------------------------------
create table order_items (
  id serial primary key,

  -- Which order this line belongs to.
  -- "on delete cascade": delete an order and its lines go too. A line
  -- with no order is meaningless, so we never want one left behind.
  order_id integer not null references orders(id) on delete cascade,

  -- Which watch was bought.
  -- NOTE there is no "on delete cascade" here, deliberately. If someone
  -- tried to delete a watch that appears on a past order, the database
  -- will REFUSE. That is correct: you must not be able to erase a watch
  -- and silently destroy the history of who bought it.
  watch_id integer not null references watches(id),

  -- House rule from the project design: 1 to 5 of any one watch.
  -- The database enforces it as well as our JavaScript does.
  quantity integer not null check (quantity >= 1 and quantity <= 5),

  -- THE MOST IMPORTANT COLUMN HERE.
  --
  -- The price of ONE of this watch, at the moment of the order.
  -- We copy it rather than looking it up from "watches" later, because
  -- prices change. If the Apex Chrono goes up to EUR 399 next year,
  -- an order placed today must still say EUR 329 - otherwise every old
  -- receipt silently rewrites itself and your accounts stop matching
  -- what the customer's bank actually charged.
  --
  -- The name for this is a "point-in-time" or historical value, and
  -- knowing when to copy data instead of linking to it is one of the
  -- real skills of database design.
  unit_price_cents integer not null check (unit_price_cents >= 0)
);


-- ------------------------------------------------------------
-- AN INDEX (new concept)
--
-- We will constantly ask "give me all the lines for order 12".
-- Without an index, Postgres reads EVERY row in order_items and
-- checks each one - fine with 20 rows, painful with 2 million.
--
-- An index is the alphabetical index at the back of a book: a
-- pre-sorted lookup so you can jump straight to the right page
-- instead of reading the whole book.
--
-- The trade-off: indexes make reading faster and writing slightly
-- slower, and they take up space. So you add them where you know
-- you will search, not everywhere.
-- ------------------------------------------------------------
create index order_items_order_id_index on order_items (order_id);


-- ------------------------------------------------------------
-- A quick check that the tables exist and are empty.
-- You should see two rows, both with a count of 0.
-- ------------------------------------------------------------
select 'orders' as table_name, count(*) as rows from orders
union all
select 'order_items' as table_name, count(*) as rows from order_items;
