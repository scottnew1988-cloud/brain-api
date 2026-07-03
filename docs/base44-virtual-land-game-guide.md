# Virtual Land Empire — Base44 Build Guide

A step-by-step prompt sequence for building a SimCity-style virtual land ownership
game in [Base44](https://base44.com). You (the creator) are the **Freeholder/Admin**:
you control zoning, infrastructure rollout, and planning laws. Players create
accounts, buy plots of land on one shared landmass, receive an emailed ownership
certificate, develop their land, and can resell or rent it out.

---

## How to use this guide

Base44 builds apps conversationally — you give it one prompt, it generates/updates
the app (database entities, pages, logic, integrations), you preview and test, then
you give the next prompt. **Do not paste all the prompts at once.** Go in order,
one at a time, and after each one:

1. Open the **Entities** tab and confirm the fields it created match what's below.
2. Click **Preview** and click around — don't just trust the description.
3. If something's wrong, don't move to the next prompt yet — reply with a
   correction first (e.g. *"the Plot entity is missing the `zone_type` field,
   please add it as an enum: residential, commercial, industrial, park, road"*).
4. Only once a step works, move to the next prompt.

This keeps Base44's context consistent and avoids it re-guessing your data model
halfway through, which is the #1 cause of a "broken" build.

A note on scale: "a large landmass" rendered as tens of thousands of individually
clickable HTML tiles will be slow. The plan below uses **10,000 plots** (a 100×100
grid, grouped into 100 districts of 10×10 plots each) as a v1 that feels big but
stays performant, with districts as the zoom-in unit. You can ask Base44 to expand
this later once the core loop works.

---

## Step 0 — Create the app

Go to base44.com → **New App**. Name it (e.g. "Landkeep" or whatever you like).
Don't type anything else yet — start with Step 1's prompt as your first message.

---

## Step 1 — Seed prompt: core concept & data model

This is the most important prompt. It sets up the entities everything else will
build on, so be thorough.

```
Build a browser-based virtual land ownership game called [YOUR GAME NAME].

CONCEPT:
Players create an account and join a single shared virtual world made of one
large landmass. The landmass is divided into a grid of ownable land plots.
Players can buy unowned plots, develop them with buildings, resell them at a
price they choose, or rent out developed buildings for recurring income. I am
the platform owner ("the Freeholder") and have an admin role that controls
zoning, infrastructure, and planning rules across the whole map — players don't
control this, only their own plots within the rules I set.

DATA MODEL — please create these entities:

1. User (extend the built-in auth user):
   - is_admin (boolean, default false)
   - wallet_balance (number, default 0) — in-game currency balance
   - display_name (text)

2. District:
   - name (text)
   - grid_x, grid_y (number) — position of this district in a 10x10 district grid
   - zone_type (enum: residential, commercial, industrial, park, road, unzoned) — set by admin
   - has_road (boolean, default false)
   - has_power (boolean, default false)
   - has_water (boolean, default false)
   - max_building_density (number, default 1) — planning law set by admin

3. Plot:
   - plot_code (text, unique, e.g. "D07-034")
   - district_id (relation to District)
   - grid_x, grid_y (number) — position within the district (0-9, 0-9)
   - owner_id (relation to User, nullable)
   - status (enum: unowned, owned, listed_for_sale, listed_for_rent) default unowned
   - base_price (number) — admin-set starting price when unowned
   - list_price (number, nullable) — price the owner sets when reselling
   - development_level (number, default 0, range 0-5)
   - building_type (enum: none, house, apartment_block, shop, factory, park_feature) default none
   - building_value (number, default 0)
   - rent_price (number, nullable)
   - tenant_id (relation to User, nullable)
   - purchased_date (date, nullable)

4. Certificate:
   - certificate_number (text, unique)
   - plot_id (relation to Plot)
   - owner_id (relation to User)
   - issued_date (date)
   - plot_snapshot (JSON — copy of plot's key details at time of issue, so history is preserved even if plot changes later)
   - pdf_url (file/text)

5. Transaction:
   - type (enum: purchase, resale, rent_payment, admin_fee)
   - plot_id (relation to Plot)
   - from_user_id (relation to User, nullable — null means "the bank/unowned pool")
   - to_user_id (relation to User)
   - amount (number)
   - platform_fee (number, default 0)
   - created_date (date)

6. BuildingType (reference/catalog data, admin-editable):
   - name (text)
   - allowed_zones (multi-select: residential, commercial, industrial, park)
   - cost (number)
   - value_added (number)
   - rent_income_per_period (number)
   - icon (text)

PAGES to scaffold now (empty/placeholder is fine, we'll build these out step by
step in later prompts):
- Landing page explaining the game
- Sign up / Login (use built-in auth)
- World Map page
- Player Dashboard ("My Land")
- Marketplace page
- Admin Panel (only visible/accessible if current user is_admin)

Don't build the full logic yet — just get this data model and page scaffolding
in place correctly first.
```

**Check:** open Entities and confirm all 6 entities exist with those fields and
relations. Fix anything wrong before continuing.

---

## Step 2 — Accounts & player dashboard

```
Now build out player accounts:

1. On sign up, automatically give every new User a wallet_balance of 5000 (starting
   in-game currency) and is_admin = false.
2. Make my account ([YOUR EMAIL]) an admin: set is_admin = true for that user.
3. Build the Player Dashboard page ("My Land"):
   - Shows the logged-in player's wallet_balance at the top
   - Shows a grid/list of all Plots where owner_id = current user, each as a card
     showing plot_code, district, development_level, building_type, current
     estimated value (base_price + building_value), and status
   - Shows total portfolio value (sum of current value across owned plots)
   - Clicking a plot card opens the plot's detail panel (we'll build this in a
     later step — for now just link to a placeholder plot detail page)
4. Add a top navigation bar visible on every page with: World Map, Marketplace,
   My Land, Wallet balance, and (only for admins) an "Admin Panel" link.
```

**Check:** sign up a test player account, confirm it gets 5000 balance and the
dashboard loads with an empty "no land yet" state. Confirm your admin account
shows the Admin Panel link and a test player account does not.

---

## Step 3 — Generate the world map

```
Build the World Map page:

1. Generate 100 District records arranged in a 10x10 grid (grid_x/grid_y 0-9),
   giving each a name like "District 07" and zone_type = unzoned, has_road/
   has_power/has_water = false by default.
2. For each District, generate 100 Plot records arranged in a 10x10 grid within
   that district (grid_x/grid_y 0-9), with plot_code formatted like
   "D{district grid_x}{district grid_y}-{plot grid_x}{plot grid_y}", status =
   unowned, and base_price = 100 (we'll vary pricing by zone later).
   That's 10,000 total plots.
3. The World Map should render at the district level by default: a 10x10 grid of
   district tiles, each colour-coded by zone_type (grey = unzoned, green = park,
   blue = residential, orange = commercial, purple = industrial, dark grey =
   road), with a small indicator of what % of plots in that district are owned.
4. Clicking a district zooms into a detail view showing that district's 10x10
   grid of individual plots, colour-coded by status (light grey = unowned,
   green = owned, yellow = listed for sale, blue = listed for rent).
5. Add a "back to full map" button from the district view.
6. Add a legend explaining the colours.
7. Make the map read-only for now (no buying yet) — clicking a plot just shows
   its plot_code, status, and price in a small tooltip/popover.
```

**Check:** confirm exactly 10,000 plots got generated (spot-check counts in the
Entities tab), and that zooming in/out works smoothly.

---

## Step 4 — Buying land

```
Enable buying land:

1. In the district detail view, clicking an unowned plot opens a "Buy Land"
   modal showing plot_code, base_price, district zoning, and a Confirm Purchase
   button.
2. On confirm: check the buyer's wallet_balance is >= base_price. If not, show
   an error and don't proceed.
3. If sufficient funds: deduct base_price from buyer's wallet_balance, set the
   Plot's owner_id to the buyer, status to owned, purchased_date to now.
4. Create a Transaction record: type = purchase, plot_id, from_user_id = null,
   to_user_id = buyer, amount = base_price, platform_fee = 0.
5. Allow selecting multiple adjacent unowned plots at once (shift-click or a
   "select mode" toggle) and buying them in a single transaction, one
   Transaction + ownership update per plot, charged as a single total to the
   wallet.
6. After purchase, show a success screen confirming ownership and refresh the
   map so the plot(s) now show as owned/green.
```

**Check:** buy a plot as a test player, confirm wallet balance drops, plot turns
green on the map, and a Transaction record was created.

---

## Step 5 — Ownership certificate + email

```
Add an ownership certificate system:

1. Whenever a Plot is purchased (both first purchase from the admin AND resale
   between players), automatically create a Certificate record: generate a
   unique certificate_number (format "CERT-{plot_code}-{timestamp}"), owner_id
   = new owner, plot_id, issued_date = now, and plot_snapshot = a JSON copy of
   the plot's district name, zone_type, size, and price at the time of issue.
2. Generate a certificate as a nicely designed printable document/image
   containing: game name, "Certificate of Land Ownership", owner's display
   name, plot_code, district name and zone, purchase price, issue date,
   certificate_number, and a decorative border — store it and link it as
   pdf_url on the Certificate record.
3. Email the certificate to the owner's registered email address automatically
   right after purchase, with a subject like "Your Land Certificate — Plot
   {plot_code}" and the certificate attached/embedded.
4. If a plot is resold, issue a brand NEW certificate to the new owner (don't
   overwrite the old one — old certificates stay in the Certificate table as
   history tied to the previous owner).
```

**Check:** buy a plot, confirm an email arrives with the certificate, and a
Certificate record exists linked to that plot and owner.

---

## Step 6 — View certificate & plot details by clicking

```
Build the full Plot Detail view (replace the earlier tooltip for owned plots):

1. Clicking any plot (owned or unowned) opens a detail panel/page showing:
   plot_code, district, zone_type, status, current owner's display name (if
   owned), development_level, building_type, current estimated value.
2. If the plot is owned, show its current Certificate: render the certificate
   image/PDF inline with a "Download Certificate" button.
3. If the current logged-in user IS the owner, also show owner-only controls:
   "Develop This Land", "List for Sale", "List for Rent", "Cancel Listing" (we
   will wire these buttons up in the next steps — for now just show them,
   greyed out is fine if not yet functional).
4. If the plot is unowned, show the "Buy Land" flow from Step 4 instead.
```

**Check:** click an owned plot as its owner — see the certificate. Log in as a
different player and click the same plot — confirm the owner-only buttons are
hidden for you.

---

## Step 7 — Resale marketplace

```
Add player-to-player resale:

1. Wire up "List for Sale" on the plot detail page: owner enters a list_price,
   confirms, and the Plot's status becomes listed_for_sale with that list_price
   saved.
2. Add "Cancel Listing" to revert status back to owned and clear list_price.
3. Build the Marketplace page: a list/grid of all Plots with status =
   listed_for_sale, showing plot_code, district, zone, list_price,
   development_level, and building_type. Add filters for zone_type, price
   range, and district.
4. Clicking a marketplace listing opens the plot detail page with a "Buy Now"
   button (instead of the owner-only controls, since the buyer isn't the
   owner).
5. On purchase of a resale: check buyer's wallet_balance >= list_price. Deduct
   list_price from buyer, credit (list_price - platform_fee) to the seller's
   wallet_balance, where platform_fee = 5% of list_price and goes to my admin
   account's wallet_balance. Update owner_id to the buyer, status back to
   owned, clear list_price. Create a Transaction (type = resale) recording the
   sale amount and platform_fee. Issue a new Certificate and email it to the
   new owner as in Step 5.
```

**Check:** as player A, buy a plot then list it for sale. As player B, buy it
from the marketplace. Confirm balances update correctly on both sides, you (the
admin) receive the 5% fee, and player B gets a new emailed certificate.

---

## Step 8 — Development (SimCity-style building)

```
Add land development:

1. Seed the BuildingType catalog with these rows:
   - House: allowed_zones=[residential], cost=200, value_added=150,
     rent_income_per_period=20
   - Apartment Block: allowed_zones=[residential], cost=800, value_added=700,
     rent_income_per_period=90
   - Shop: allowed_zones=[commercial], cost=400, value_added=350,
     rent_income_per_period=45
   - Factory: allowed_zones=[industrial], cost=1000, value_added=850,
     rent_income_per_period=100
   - Park Feature: allowed_zones=[park], cost=150, value_added=100,
     rent_income_per_period=0
2. Wire up "Develop This Land" on the plot detail page: show only BuildingTypes
   whose allowed_zones includes this plot's district zone_type. If the district
   isn't zoned yet (zone_type = unzoned) or lacks required infrastructure
   (has_road AND has_power both required to develop — has_water required
   additionally for apartment_block and factory), disable development and show
   why (e.g. "This district needs road access before you can build here.").
3. On selecting a building type: check owner's wallet_balance >= cost, deduct
   cost from owner, set the Plot's building_type, increase development_level by
   1 (cap at 5), add value_added to building_value.
4. Show development_level visually on the map (e.g. plot tile shading gets
   darker/richer per level) and show a small building icon matching
   building_type on the district zoomed-in view.
5. Allow re-developing an already-developed plot to upgrade further (e.g. House
   -> Apartment Block) as long as development_level < 5, following the same
   cost/value_added logic, replacing building_type.
```

**Check:** in an unzoned/no-infrastructure district, confirm development is
blocked with a clear message. As admin, zone a district and toggle its
infrastructure on (you'll build the actual admin controls in Step 10 — for now
you can flip these fields directly in the Entities tab to test), then confirm
development becomes available and works.

---

## Step 9 — Renting

```
Add the rental system:

1. Wire up "List for Rent" on the plot detail page (only available if
   building_type is not "none"): owner enters a rent_price, confirms, Plot
   status becomes listed_for_rent.
2. Add a "Rentals" tab on the Marketplace page listing all Plots with status =
   listed_for_rent, showing building_type, rent_price, and district.
3. Clicking "Rent This" as another player: check renter's wallet_balance >=
   rent_price, deduct it, credit (rent_price - 10% platform fee) to the owner,
   set tenant_id to the renter, status stays listed_for_rent but mark it as
   "currently rented" with a rented_until date one billing period (7 real days)
   from now. Create a Transaction (type = rent_payment).
4. Add a scheduled/background job that, once a rented plot's rented_until date
   passes, either auto-renews it (charging the tenant again if they have
   sufficient balance and crediting the owner) or, if the tenant can't pay,
   clears tenant_id and reverts status to listed_for_rent so it's available
   again. Notify both owner and tenant by email when a rental renews or lapses.
5. On the plot detail page, if the current user is the tenant, show a "Currently
   Renting" badge and rented_until date. If the current user is the owner, show
   who's renting it and the income received so far.
```

**Check:** rent a plot as a test tenant, confirm income appears for the owner,
and (if you can shorten the rental period for testing) confirm the
renew/lapse job runs correctly.

---

## Step 10 — Admin "Freeholder" control panel

```
Build the Admin Panel (only accessible to users where is_admin = true):

1. Zoning tab: a grid of all 100 Districts. Clicking one lets me set its
   zone_type (residential/commercial/industrial/park/road/unzoned). Changing a
   district's zone updates the map colouring immediately for all players.
2. Infrastructure tab: for each District, toggles for has_road, has_power,
   has_water. Turning these on should immediately unlock development
   eligibility for plots in that district per the rules from Step 8.
3. Planning Laws tab: for each District, a max_building_density number input
   (this caps development_level a plot in that district can reach — enforce
   this cap in the Step 8 development logic). Also let me edit the
   BuildingType catalog (cost, value_added, rent_income_per_period, allowed
   zones) from here.
4. Pricing tab: let me set base_price per District (applies to all currently
   unowned plots in that district) so land in developed/well-zoned districts
   can cost more than raw unzoned land.
5. Economy tab: show total platform revenue (sum of platform_fee across all
   Transactions), a live feed of the most recent 50 Transactions across the
   whole game, and my own wallet_balance.
6. Players tab: a table of all Users with their wallet_balance, number of
   plots owned, and total portfolio value, sortable — this is my leaderboard/
   oversight view.
7. Moderation: let me un-list any plot that's for sale or for rent (force
   cancel), and, as a last resort, force-transfer a plot back to "unowned" (for
   handling disputes/abuse) with a required reason field that gets logged.
```

**Check:** log in as admin, zone an unzoned district as residential, flip on
road+power, confirm a player can now buy and develop plots there. Confirm a
non-admin account cannot reach /admin at all (should redirect or 403).

---

## Step 11 — Notifications & leaderboard polish

```
Final polish pass:

1. Add an in-app notification bell (and matching email) for: purchase
   confirmed, sale confirmed (you sold a plot), rent income received, someone
   rented your listing, a district you own land in changed zoning or gained
   infrastructure, rental lapsed because tenant couldn't pay.
2. Add a public Leaderboard page ranking players by total portfolio value
   (sum of base_price/list_price-adjusted value + building_value across owned
   plots), showing top 20 with display_name and plot count.
3. Add empty states everywhere (new player with no land, marketplace with no
   listings, etc.) with a friendly call to action.
4. Do a responsive pass so the World Map, Dashboard, and Marketplace work
   reasonably on tablet/mobile, not just desktop.
5. Add a short onboarding tooltip/tour for first-time players covering: here's
   the map, here's how to buy land, here's your certificate, here's how to
   develop and rent.
```

**Check:** run through the whole loop once more as a brand-new player end to
end: sign up → tour → buy a plot → get certificate email → develop it → list it
for rent → have a second test account rent it → check the leaderboard updates.

---

# Part 2 — Commercial Real Estate & In-Game Shopping

Everything above is the core residential/land-ownership loop. This part adds a
parallel commercial path on top of it: landowners can develop commercial plots
and lease the building to a **Business** (representing a real company), which
then sells products through an in-game storefront. The storefront and checkout
are one shared system owned by you (the admin) — every sale is split between
the business and your platform automatically, the same way rent is split
today.

Do this only after Part 1 (Steps 1–11) is working — it reuses the zoning,
development, and rent-billing patterns already built, rather than duplicating
them.

---

## Step 12 — Commercial data model

```
Extend the data model to support commercial real estate that can be leased to
businesses who sell products through an in-game shop. This sits alongside
everything already built — players still buy/develop/resell land and rent to
other players exactly as before; this adds a separate, business-only path for
commercial buildings.

New entities:

1. Business:
   - business_name (text)
   - description (text)
   - category (enum: retail, food_and_drink, services, entertainment, other)
   - logo_url (file/text)
   - owner_user_id (relation to User) — the player account operating this business
   - status (enum: pending_approval, active, suspended) default pending_approval
   - wallet_balance (number, default 0) — the business's own earnings balance,
     separate from the owning player's personal wallet_balance
   - created_date (date)

2. Lease:
   - plot_id (relation to Plot)
   - landlord_id (relation to User) — the plot's owner
   - business_id (relation to Business, nullable until a business applies)
   - rent_price (number)
   - billing_period_days (number, default 30)
   - status (enum: available_for_lease, pending_landlord_approval, active, ended)
   - lease_start (date, nullable)
   - next_payment_due (date, nullable)
   - auto_renew (boolean, default true)

3. Product:
   - business_id (relation to Business)
   - name (text)
   - description (text)
   - price (number)
   - image_url (file/text)
   - stock_quantity (number, nullable — leave blank for unlimited/digital goods)
   - category (text)
   - is_active (boolean, default true)

4. Order:
   - buyer_id (relation to User)
   - business_id (relation to Business)
   - items (JSON — array of {product_id, product_name, unit_price, quantity})
   - subtotal (number)
   - platform_fee (number)
   - total (number)
   - status (enum: paid, fulfilled, cancelled) default paid
   - created_date (date)

5. Update Plot: add commercial_lease_id (relation to Lease, nullable) linking
   to its current active lease, if any.

6. Update the Transaction "type" enum to also include: commercial_lease_payment,
   product_sale.

Don't build any UI yet — just get this schema in place correctly and confirm
it in the Entities tab before continuing.
```

**Check:** confirm all 4 new entities and the 2 field/enum updates exist as
described.

---

## Step 13 — Business accounts & approval

```
Add the ability for players to register and run a business:

1. Add a "Start a Business" flow, reachable from the main nav: a form
   collecting business_name, description, category, logo_url. On submit,
   create a Business record with owner_user_id = current user, status =
   pending_approval.
2. Build a Business Dashboard page (visible only to the business's
   owner_user_id, or to admins) showing the business's status, wallet_balance,
   its current Lease if any, and tabs for "Products" and "Orders" — empty
   states are fine for now, Steps 15-16 fill these in.
3. In the Admin Panel, add a "Businesses" tab: list all Business records,
   filterable by status, and let me approve (status -> active) or reject/
   suspend (status -> suspended) any business, with an optional reason logged.
4. Only businesses with status = active can apply for a commercial lease or
   list products — enforce this both in the UI and in the backend logic.
   Pending/suspended businesses see a clear status message instead of the
   Products/Orders tabs.
5. Email the business owner when their business is approved or suspended.
```

**Check:** register a test business, confirm it's `pending_approval` and
locked out of leasing/products, approve it from the Admin Panel, confirm the
owner gets an email and the dashboard unlocks.

---

## Step 14 — Leasing commercial land to businesses

```
Add commercial leasing on top of existing land ownership:

1. A Plot is eligible for business leasing only if: its District's zone_type
   is commercial, AND the plot has been developed with building_type = shop
   (using the existing development system from earlier steps).
2. On an eligible plot the current user owns, add a "List for Business Lease"
   action next to the existing "List for Rent" (List for Rent still works as
   before, for renting to other players — this is a separate, business-only
   path). The owner enters rent_price and billing_period_days, creating a
   Lease record with status = available_for_lease linked to that plot.
3. Add a "Commercial Units" tab to the existing Marketplace page listing every
   Plot with an available_for_lease Lease: district, plot_code, rent_price,
   billing_period_days.
4. A user managing an active Business can click "Apply to Lease" on a listing.
   This sets the Lease's business_id and status = pending_landlord_approval,
   and notifies the landlord.
5. The landlord sees pending applications on their Plot Detail page (or a "My
   Leases" section of the Dashboard) and can Approve or Reject:
   - Approve: Lease status = active, lease_start = now, next_payment_due =
     now + billing_period_days; set Plot.commercial_lease_id to this lease and
     Plot.status = leased_commercial.
   - Reject: clear business_id, revert Lease status = available_for_lease.
6. Add a recurring job, following the same pattern as the residential rent job
   from Step 9: when next_payment_due arrives, charge rent_price from the
   Business's wallet_balance to the landlord's wallet_balance minus a
   commercial lease platform fee, then advance next_payment_due by
   billing_period_days. If the Business can't pay: Lease status = ended, clear
   Plot.commercial_lease_id, revert Plot.status, notify both parties. Record
   every payment as a Transaction (type = commercial_lease_payment).
```

**Check:** as a landowner, develop a commercial plot with a shop, list it for
business lease. As a test business, apply. Approve it as the landlord, and
confirm the recurring rent job charges correctly (shorten the billing period
for testing if you can).

---

## Step 15 — In-game storefronts

```
Add the visual, browsable storefront for each leased commercial unit:

1. When a Plot with status = leased_commercial is clicked on the World Map,
   its Plot Detail view should show the leasing Business's storefront instead
   of plain plot info: logo, business_name, description, category, and a grid
   of that business's active Products (built next step) with "View Product" /
   "Add to Cart" actions. Keep a small collapsed "Land Info" section below
   showing the landlord and lease terms, for transparency.
2. On the Business Dashboard's "Products" tab, let the business owner add,
   edit, deactivate, and delete Products (name, description, price,
   image_url, stock_quantity, category).
3. Add a global "Shopping" page, separate from the map: lists all active
   Products from all active leased businesses, with search and category
   filters — a directory of every store in the world, browsable without
   navigating the physical map.
```

**Check:** add a couple of products as the test business, confirm they show
up both on the plot's storefront view and on the global Shopping page.

---

## Step 16 — Shopping cart, checkout & the platform-owned payment split

```
Build the actual purchasing flow — this is the platform-owned shopping system
that ties everything together:

1. Add a persistent shopping cart (can hold products from multiple different
   businesses at once), with an icon/counter in the top nav and standard add/
   remove/adjust-quantity behaviour.
2. Build a Checkout page: shows cart contents grouped by business, subtotal,
   a platform_fee_percent (admin-configurable, default 8%) applied per
   business's line items, and the total. On confirm:
   - Check the buyer's wallet_balance >= total; block with an error if not.
   - Deduct total from the buyer's wallet_balance.
   - For each business represented in the cart: create one Order (buyer_id,
     business_id, items = that business's line items, subtotal, platform_fee,
     total = subtotal - platform_fee), credit (subtotal - platform_fee) to
     that Business's wallet_balance, credit platform_fee to my admin User's
     wallet_balance, and create a matching Transaction (type = product_sale).
   - For any Product with a numeric stock_quantity, decrement it by the
     purchased quantity (skip this for products with no stock_quantity set —
     treat those as unlimited/digital).
   - Clear the cart and show an order confirmation screen.
3. Email the buyer a receipt (order number, itemized list, total) and notify
   each business owner by email/in-app notification of their new order(s).
4. On the Business Dashboard's "Orders" tab, list that business's Orders with
   buyer name, items, total, date, and status, and let the owner mark an order
   "fulfilled" (a status flag for record-keeping — no physical shipping logic
   needed).
```

**Check:** add products from two different test businesses to one cart,
checkout, confirm: buyer's balance drops by the full total, each business's
wallet_balance increases by its share minus the fee, your admin wallet
receives the combined platform fees, both an Order and Transaction exist per
business, and both buyer and sellers get notified.

---

## Step 17 — Admin oversight of the commercial economy

```
Extend the Admin Panel:

1. Add a "Marketplace" tab: total product_sale revenue, total
   commercial_lease_payment revenue, my platform wallet_balance breakdown by
   source, and a live feed of recent Orders and commercial Leases across the
   game.
2. Add a "Marketplace Settings" section letting me edit the global
   platform_fee_percent (used at checkout) and a separate
   commercial_lease_fee_percent (used on lease rent payments).
3. Let me moderate individual Products (deactivate one without suspending the
   whole business) and view/force-end any Lease (e.g. for a policy
   violation), with a required reason logged — same pattern as the existing
   plot moderation tools from Step 10.
4. Add the count of active Businesses and total commercial GMV (gross
   merchandise value across all Orders) to the existing Economy tab.
```

**Check:** confirm the Marketplace tab's numbers match what you'd expect from
your test orders and lease payments, and that changing platform_fee_percent
changes what a new checkout charges.

---

## Step 18 — Optional stretch: multi-unit malls

Only attempt this once Steps 12–17 are fully working and tested.

```
Add a "Shopping Mall" building type (allowed_zones=[commercial], higher cost,
only buildable at development_level 4+) that supports up to 4 separate Lease
slots on a single Plot instead of just one, so a single landowner can lease to
multiple businesses from one plot — like a real shopping mall with several
units. This changes the Plot/Lease relationship from one-to-one to
one-to-many: a mall Plot can have several active Leases at once (one per
unit slot), while a plain Shop Plot still supports at most one.
```

---

## Commercial flow QA checklist

- [ ] Register a business, confirm it's blocked until admin approval
- [ ] Approve it as admin, confirm the owner is emailed and the dashboard unlocks
- [ ] Develop a commercial plot with a shop, list it for business lease
- [ ] Apply to lease it as the business, approve as landlord, confirm the
      plot shows as leased and the storefront renders
- [ ] Confirm the recurring lease-rent job charges the business and pays the
      landlord (minus platform fee) on schedule, and lapses gracefully if the
      business can't pay
- [ ] Add products as the business, confirm they appear on the plot storefront
      and the global Shopping page
- [ ] Buy from two different businesses in one cart checkout, confirm the
      payment split (business wallets, your admin wallet) and stock
      decrements are correct
- [ ] Confirm buyer receipt email and business order notifications arrive
- [ ] Confirm the Admin Marketplace tab's revenue numbers and fee settings work

---

## Manual QA checklist (do this after Step 11, not a Base44 prompt)

- [ ] Sign up as two separate test players + confirm your admin account
- [ ] Buy an unowned plot, receive certificate email, view certificate by
      clicking the plot
- [ ] List that plot for resale, buy it with the second account, confirm
      certificate reissued to new owner and you (admin) received the 5% fee
- [ ] Try to develop a plot in an unzoned district — confirm it's blocked
- [ ] As admin, zone a district + add infrastructure, confirm development
      unlocks
- [ ] Develop a plot, confirm value and map appearance update
- [ ] List a developed plot for rent, rent it with a second account, confirm
      income flow and rental expiry/renewal behaviour
- [ ] Confirm non-admins cannot access the Admin Panel
- [ ] Force-unlist and force-transfer a plot as admin, confirm it logs a reason
- [ ] Check the leaderboard and Economy tab numbers add up

---

## Tips for prompting Base44 well

- **One feature per prompt.** Resist the urge to combine steps — Base44 (like
  any AI builder) does better with a tight, verifiable scope per turn.
- **Name your entities and fields explicitly**, as done above. Vague prompts
  ("add a buying feature") make it guess your schema, which is where things
  drift.
- **Test in Preview after every step**, not just at the end — it's much
  cheaper to fix a wrong field name after Step 3 than after Step 10.
- If a prompt produces something wrong, don't restart — reply conversationally
  in the same thread: *"the platform_fee on resale should be 5% not a flat
  amount, please fix that calculation."*
- Keep an eye on the Entities tab as your source of truth; if Base44's
  description of what it built doesn't match the actual schema, trust the
  schema.
- Once the whole loop works with test/play-money `wallet_balance`, you can ask
  Base44 in a follow-up prompt to swap the wallet for real payments via its
  Stripe integration — do that as its own step, after the game logic is solid,
  not before.
