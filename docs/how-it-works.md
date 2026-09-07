# How Plutus works

This is written for one reader: the owner, looking at his own project some months from
now and needing to remember why it works the way it does. It is not marketing and it is
not for a recruiter. Every term gets one plain line the first time it shows up, because
the whole point of this document is that nothing in it should need a second document to
understand.

## What this is

Plutus is a service for moving money around safely, and for trading two crypto pairs on
top of that same money system. A ledger is just an organised record of who has what and
where every unit of it came from; Plutus's ledger writes that record in a way that a
stranger can check by hand rather than take on trust. The exchange, added in the second
half of the build, lets a trading program place buy and sell orders against a simulated
market whose prices track real Bitcoin and Ethereum prices, without ever risking real
money. Both halves are one HTTP API, meaning every feature is reached by sending a
request to a web address rather than through a screen.

## The pieces, and why each is built the way it is

**The ledger.** A ledger is a closed set of accounts, all in one place, that can only ever
move money between each other or to and from an account called `world` that represents
money entering or leaving the system entirely. Nothing in Plutus ever edits a balance
directly. Every change is a transfer, a list of exact amounts moving from named accounts
to named accounts, and the transfer either fully happens or fully does not. This is built
this way because a balance that can be nudged by hand is a balance nobody can fully trust
later; a balance that only ever changes through a recorded transfer always has a paper
trail explaining how it got there.

**Accounts.** An account belongs to one ledger and holds exactly one kind of asset, such
as US dollars or Bitcoin, never a mix. Splitting accounts this way means a bug in, say,
Bitcoin handling can never accidentally touch a dollar balance, because they are not even
stored in the same row.

**Holds.** A hold sets money aside without moving it yet, the way a hotel places a hold on
a credit card at check in before it knows the final bill. It is later captured, meaning
the reserved amount, or part of it, actually moves, or released, meaning it goes back
untouched. Trading uses holds constantly: placing a buy order holds the money it might
spend before anyone knows whether, or how much of, the order will actually fill.

**The journal and the chain.** Every write to a ledger appends one entry to that ledger's
journal, an ordered log of everything that has ever happened to it. Each entry also
stores a cryptographic hash, a short fixed length fingerprint, of the entry immediately
before it. Change one old entry, even a field nobody looks at day to day, and every
hash after it stops matching what it should be. This is what lets the verify endpoint
prove a ledger's whole history is intact rather than just report today's balances and
hope nothing was quietly edited along the way.

**Idempotency.** A network can fail in the moment after a server has already done the
work but before the answer gets back, which leaves a client unsure whether to try again.
An idempotency key is a value the client makes up once and sends with a write; if the
same key comes back, Plutus returns the original answer instead of doing the work twice.
This turns "did that actually go through" from a guess into a safe retry.

**Webhooks.** A webhook is Plutus calling the client's own server to say something
happened, rather than waiting for the client to keep asking. Every webhook is signed, its
body run through a secret only the two sides know, so a receiver can prove a delivery
really came from Plutus and was not forged or altered in transit.

**Signing.** Ledger calls prove who is asking with a bearer token, a secret string sent
straight in a header. Trading calls need more than that, because a stolen trading request
that gets replayed a minute later could still make an unwanted trade. So a signed trading
request carries a timestamp and a signature computed from the exact request, timestamp,
method, path and body all mixed together with a secret key, and it is refused if the
timestamp is too old or the signature does not match. The server never even stores the
raw secret, only a fingerprint of it, so a database leak alone can never be turned into a
forged signature.

**Matching.** Matching is the process of pairing a new order against orders already
resting on the book, the public list of everyone's current unfilled buy and sell orders.
Plutus does this pairing entirely inside one database function, guarded by a lock so only
one order on a given market is ever being matched at a time. That is slower than the
specialised, all in memory engines real exchanges run, on purpose: it means a match and
the money it moves are the same database transaction, so it is not possible for a trade
to exist that the ledger disagrees with. A market order carries no price protection: it
walks the book until its amount is spent with no worst price bound, so on a thin book it
can fill far from the last traded price. A limit order is the way to bound it.

**The house.** The house is the counterparty a trader's order can fill against when no
other trader is currently on the other side. It is not a hidden advantage, just an
ordinary account that places a small ladder of buy and sell orders around the current
market price, refreshed only when someone actually looks at that market, not on a
constant timer. Building it this way means it costs nothing while nobody is trading and
never quietly drifts stale in the background.

**Market data.** These are the read only endpoints, the order book, recent trades, price
tickers, that anyone can call without a key. They are cached for two seconds so a burst
of polling does not hammer the database for numbers that were correct two seconds ago
anyway.

**The stream.** The stream is a live feed of order book changes and trades, so a client
does not have to keep asking "what changed" over and over. It uses Server Sent Events, a
plain, one directional stream of updates over ordinary HTTP, rather than a WebSocket, a
different kind of connection that can send data both ways at once, because Server Sent
Events was the one that could be trusted to actually work on the hosting Plutus runs on.

**The sweep.** The sweep is one job that runs once a day to do the tidying no single
request should be responsible for: closing holds that expired, deleting old test data,
retrying webhooks that got stuck, and topping the house account back up if a long run of
trading drained it. Nothing about the sweep is required for a single order or transfer to
work; if it never ran, the system would just slowly accumulate cleanup, not break.

## How to read the live site and the docs page

The site at the root address is the reference guide, written for anyone deciding whether
to use Plutus at all: what it is, how the pieces above fit together, working examples,
and the two proof endpoints. The `/docs` page is different: it is generated straight from
the same schemas that validate every request, so it can never describe a field that does
not exist or miss one that does. When in doubt about an exact field name or an exact
error code, `/docs` is the source of truth; the reference guide is the source of
understanding.

## How to make a change safely

Every change starts on its own branch, never directly on the main branch, so a half
finished idea never blocks anything else. Before it is trusted, it needs a passing test
that specifically exercises the new behaviour, not just the existing suite happening to
still pass. Then it gets reviewed, by asking for a second pass on the diff before it
merges, because a change that only ever got looked at by the person who wrote it tends to
have its author's own blind spots baked in. Only after tests pass and review is done does
it deploy, and a deploy is always a plain redeploy of a known build, never a hand edited
change made straight on the live server.

## How to read a review finding

A finding usually names three things: what is wrong, why it matters, and where it lives.
The middle part is the one worth reading slowly, because "this could fail" is not the
same weight as "this can silently lose money" or "this only ever shows up under load."
Fix the thing the finding actually describes, not a nearby thing that looks similar; then
rerun the exact test or check that caught it, so the finding is closed on evidence, not
on the assumption that the obvious fix must have worked.

## What went wrong during the build, and what it taught

A self trade, an order matching against another order from the same key, used to crash
the matching engine instead of being refused. It became a clean rejection instead, which
is the general lesson: a case that should never happen still needs a named, deliberate
answer, not a crash that assumes it truly never will.

Fees were originally charged per fill. On an order that filled in several small pieces,
rounding each of those fees up on its own could add up to slightly more than the amount
that had actually been reserved for fees. The fix was to charge the fee once against the
order's running total filled so far, not once per fill, so rounding never compounds past
what was set aside.

A large order's price multiplied by its quantity could overflow the 64 bit integer type
being used for money, the same way a car odometer rolls over past its maximum reading. The
fix moved that one multiplication into Postgres's arbitrary precision numeric type before
converting back down, so an order too large to represent safely is refused by name instead
of silently wrapping around into a wrong, smaller number.

A hold on a partly filled order was being closed with the wrong operation, the one meant
for a hold that never drew any money, on an order that actually had. The fix made hold
closure ask what actually happened to that hold, capturing it if any money was drawn from
it and releasing it only if none was, rather than assuming based on the order's type
alone.

The very first live deployment loaded the wrong file as the app's starting point, because
the hosting platform's own scanner guessed based on a naming pattern and guessed wrong.
Renaming the internal factory file so it no longer looked like a plausible entry point
fixed it. The lesson was to make the intended entry point the only file that could
plausibly be mistaken for one, rather than fighting a guess after the fact.

A ledger that had ever recorded a transfer could not be deleted, because the transfer's
own detail rows still pointed at accounts that belonged to that ledger, and the database
correctly refused to leave those rows pointing at nothing. Making those detail rows and
holds delete automatically when their account does, a database feature called cascading,
fixed it.

The database connection pool, the small set of reusable database connections every
request borrows from, had no listener for the error a hosted database sends when it
quietly drops a connection that has been sitting idle. Without a listener, Node.js treats
that as a fatal, uncaught error and the whole running function would have died over
something the pool itself already knew how to recover from. Adding one listener that logs
the drop instead of doing nothing fixed it before it ever happened in production.

Pulling environment variables from the hosting platform down to a local machine, a
variable marked sensitive comes back as a placeholder value instead of the real one, by
that platform's own design, not a bug. The lesson was procedural: never assume a freshly
pulled environment file actually contains a real secret; check it, or set sensitive values
by hand.

Early on, test files that each created and traded on the same two markets would
occasionally see each other's orders, because they shared one database and nothing
stopped one file's leftover orders from still being on the book when the next file ran.
Making every exchange test start by clearing its own markets fixed the flakiness for
good, rather than chasing each individual failure it caused.

Finally, the test suite itself would sometimes crash outright on the machine used to build
this, with no clear error pointing at the code. It turned out to be plain low free memory,
not a bug at all: running many test files in parallel, each with its own database
connection and its own copy of the compiled code in memory, could exceed what was
available. Capping how many test files run at once, and giving each one more room to use
before Node.js gives up, fixed it. The lesson underneath all of these is the same one:
when something fails in a way that looks impossible, check the boring, unglamorous
explanation, a resource limit, an assumption about what "never happens," before reaching
for a complicated one.
