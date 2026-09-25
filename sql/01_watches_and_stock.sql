-- ============================================================
-- Watch Store Lab - Step 1
-- Tables: watches + stock, and the 6 seed watches.
--
-- HOW TO USE THIS FILE:
-- Copy everything below and paste it into the Supabase SQL Editor,
-- then press "Run". You only need to do this once.
--
-- This file is safe to run more than once: it deletes the tables
-- first and rebuilds them from scratch. That is fine for a practice
-- project, but you would NEVER do this on a real shop's database,
-- because it throws away all the real data.
-- ============================================================


-- ------------------------------------------------------------
-- Start clean.
-- "CASCADE" means: also drop anything that depends on these tables.
-- We drop "stock" first because it points at "watches".
-- ------------------------------------------------------------
drop table if exists stock cascade;
drop table if exists watches cascade;


-- ------------------------------------------------------------
-- TABLE 1: watches
-- One row per watch model we sell. This table holds facts that
-- almost never change: the name, the type, the price.
-- ------------------------------------------------------------
create table watches (
  -- "serial" means Postgres fills this in for us, counting 1, 2, 3...
  -- "primary key" means: this column uniquely identifies the row.
  -- No two watches can ever share an id.
  id serial primary key,

  -- "text not null" = some words, and the row is rejected if it is missing.
  name text not null,
  type text not null,
  description text not null,

  -- WHY cents and not euros?
  -- Computers are bad at decimals: 0.1 + 0.2 does not give exactly 0.3.
  -- That is a disaster for money. So we store whole numbers of cents
  -- (24900 = EUR 249.00) and only divide by 100 when we SHOW the price.
  -- Every serious payment system (Stripe, PayPal...) does it this way.
  price_cents integer not null,

  -- Records when the row was added. "default now()" means Postgres
  -- fills in the current time automatically if we do not supply one.
  created_at timestamptz not null default now()
);


-- ------------------------------------------------------------
-- TABLE 2: stock
-- How many of each watch we physically have.
--
-- WHY A SEPARATE TABLE, instead of a "quantity" column on watches?
-- Because the two kinds of data behave completely differently.
-- A watch's name and price are read constantly and changed rarely.
-- Its stock number changes on EVERY single sale. Keeping the fast-
-- changing number in its own small table keeps our locking (which we
-- meet in step 5) tight and simple: we lock the stock row, not the
-- whole watch. It is the same reason a shop keeps a stock sheet
-- separate from the product catalogue.
-- ------------------------------------------------------------
create table stock (
  id serial primary key,

  -- FOREIGN KEY (new concept):
  -- "references watches(id)" tells Postgres that this number must be
  -- the id of a real row in the watches table. It is a rule the
  -- database itself enforces, so we can never end up with a stock row
  -- for watch #999 that does not exist. It is like saying "this
  -- shelf label must match a real product in the catalogue".
  --
  -- "on delete cascade" = if a watch is deleted, delete its stock row too.
  -- "unique" = a watch can have AT MOST ONE stock row. This is what makes
  -- it a one-to-one relationship, and it stops us accidentally creating
  -- two competing stock counts for the same watch.
  watch_id integer not null unique references watches(id) on delete cascade,

  -- CHECK CONSTRAINT (new concept):
  -- A rule the database refuses to break. If any code anywhere - ours,
  -- a script, a mistake typed into Supabase - ever tries to set the
  -- quantity below zero, the database rejects the change outright.
  --
  -- WHY THIS MATTERS: this is our last line of defence. Our JavaScript
  -- will also check stock, but JavaScript can have bugs. The database
  -- cannot be talked around. "Never sell a watch we do not have" is
  -- too important to guard in only one place.
  quantity integer not null check (quantity >= 0),

  updated_at timestamptz not null default now()
);


-- ------------------------------------------------------------
-- SEED DATA: the 6 watches.
-- "Seeding" just means putting starter rows into an empty database
-- so there is something to look at while we build.
--
-- Notice we do NOT write the ids ourselves - "serial" does that.
-- "returning id" is not used here; instead, below, we look each
-- watch up by name so we never have to guess what id it got.
-- ------------------------------------------------------------
insert into watches (name, type, description, price_cents) values
  ('Harbour Diver',   'Diver',        'A sturdy 300m dive watch with a rotating bezel and a luminous dial.', 24900),
  ('Meridian Dress',  'Dress',        'A slim, quiet dress watch on a leather strap. Made for cuffs and occasions.', 18900),
  ('Apex Chrono',     'Chronograph',  'A three-register stopwatch chronograph with a tachymeter scale.', 32900),
  ('Skyline Pilot',   'Pilot',        'A large, highly legible cockpit watch with an oversized crown.', 27900),
  ('Trailhead Field', 'Field',        'A light, rugged field watch on canvas. Built to be knocked about.', 14900),
  ('Pulse Smart',     'Smartwatch',   'A modern smartwatch with heart-rate tracking and a 7-day battery.', 19900);


-- ------------------------------------------------------------
-- SEED DATA: one stock row per watch.
--
-- Read this as: "insert into stock the id of the watch called X,
-- together with this quantity". The little "select id from watches
-- where name = ..." is called a subquery - it is just a lookup that
-- happens inside the bigger statement, so we do not have to know
-- in advance which id Postgres handed out.
--
-- Two of these are deliberately awkward, because they are what we
-- are here to test:
--   Skyline Pilot = 1  -> the "two people buy the last one" race in step 9
--   Pulse Smart   = 0  -> the sold-out case the shop page must handle
-- ------------------------------------------------------------
insert into stock (watch_id, quantity) values
  ((select id from watches where name = 'Harbour Diver'),    8),
  ((select id from watches where name = 'Meridian Dress'),   5),
  ((select id from watches where name = 'Apex Chrono'),      3),
  ((select id from watches where name = 'Skyline Pilot'),    1),
  ((select id from watches where name = 'Trailhead Field'), 10),
  ((select id from watches where name = 'Pulse Smart'),      0);


-- ------------------------------------------------------------
-- A last check so you can see it worked.
-- This JOINs the two tables: "show me each watch next to its stock row".
-- The join condition (watches.id = stock.watch_id) is how we follow
-- the foreign key from one table to the other.
-- You should see 6 rows in the results panel.
-- ------------------------------------------------------------
select
  watches.id,
  watches.name,
  watches.type,
  watches.price_cents,
  stock.quantity
from watches
join stock on stock.watch_id = watches.id
order by watches.id;
