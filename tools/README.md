# tools/ - supplier offer feeds

SiteStock's catalogue is a curated list of ~16 products. **Real supplier prices,
stock and product links** come from merchant product feeds (Awin, once an
affiliate account exists) and land in the `supplier_offers` table. Until a feed
is imported the table is empty and the app shows the catalogue's own price
labelled "indicative" - nothing here invents a price.

| File | What it is |
|---|---|
| `import_offers.py` | Feed CSV (path or https URL, `.gz` ok) + mapping CSV -> the `import_supplier_offers()` database function. Standard library only. |
| `sync_all_offers.py` | Runs the importer once per supplier in the `OFFER_FEEDS` env var. What the scheduled workflow calls. |
| `suggest_mapping.py` | Ranks a REAL feed's rows against every catalogue product+variant and drafts the mapping CSV (confident matches only) plus a candidates file for a human to review. Uses `catalogue_snapshot.json`. |
| `go_live.py` | The go-live switchboard: `check` (read-only readiness report), `awin` (record the publisher/merchant ids), `billing-copy` (Stripe wording for the legal pages), `operator` (swap the operator name/address/email everywhere). Dry run unless `--apply`. |
| `set_stripe_secrets.ps1` | Hidden-prompt helper that stores the three Stripe values as Supabase secrets - run it yourself; keys never pass through chat. |
| `feeds/<slug>.map.csv` | **Your** hand-built mapping for a real supplier (empty until you make one). |
| `sample_feed/` | Synthetic test data (example.com URLs, obviously fake). For local testing only - **never import it into the hosted database.** |

## The day you get an Awin account (about 20 minutes of work)

1. **Site setting.** Put your Awin *publisher id* in `public/js/env.js`
   (`window.SITESTOCK_AFFILIATE = { awinPublisherId: '12345' }`). Public value, not a secret.
2. **Per supplier.** In the Supabase SQL editor, for each merchant that has approved
   you (their merchant id is on their Awin programme page):
   `update suppliers set affiliate_network = 'awin', affiliate_merchant_id = '<id>' where name = 'Wickes Trade';`
   Links to that supplier are now wrapped in Awin tracking and the app shows
   "we may earn a commission" beside them. Both values must be set together (DB constraint).
3. **Get the feed.** Awin -> Toolbox -> Create-a-Feed: choose the merchant, format CSV,
   compression gzip, include at least `merchant_product_id`, `product_name`,
   `search_price`, `in_stock`, `merchant_deep_link`, `merchant_image_url`. Copy the
   generated URL (it contains your API key - treat it as a secret).
4. **Map the products.** Download the feed once, find the rows for your catalogue's
   products, and write `tools/feeds/wickes-trade.map.csv`:
   ```
   external_id,product_key,variant_label
   1234567,p3,25kg bag
   ```
   `external_id` = the feed's `merchant_product_id`; `product_key` = the catalogue key
   (`p1`..`p16`, see `select catalogue_key, name from products`); `variant_label` must
   match one of that product's variant labels **exactly**, or be blank for a whole-product
   price. Rows not in the mapping are ignored. A human does this on purpose: a wrong
   automatic match would put a real price on the wrong product.
5. **Try it without sending anything:**
   `python tools/import_offers.py --supplier "Wickes Trade" --feed feed.csv --map tools/feeds/wickes-trade.map.csv --dry-run`
   It prints how many rows were importable, unmapped, or dropped (bad price/URL).
6. **Turn on the daily sync.** GitHub -> repo Settings -> Secrets and variables -> Actions:
   `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` (the service-role key), and
   `OFFER_FEEDS` = `{"Wickes Trade": "https://productdata.awin.com/..."}`.
   Then run the *Sync supplier offers* workflow once by hand and check the log.

## Things to know

- **Column names are assumptions.** `import_offers.py` defaults to Awin's documented
  feed column names, written from memory and **not yet tested against a real Awin
  feed** (none exists yet). If your first real feed uses different headers, pass
  `--columns cols.json` (`{"price": ["my_price_column"]}`) - no code change needed.
- **Each run is a full sync.** Offers missing from the feed are switched off (an item
  the merchant delists disappears from the app). Because of that the importer refuses to
  send zero rows (a failed download would otherwise wipe every price) and `--min-rows N`
  lets you require a sane minimum. `manual` offers (source = 'manual') are never touched.
- **Prices are checked again at order time.** `create_order` refuses if the price a
  browser sends no longer matches the offer in the database, so a stale page can't lock in
  an old price; the app then reloads the offers and shows the new price.
- **Only https product links are kept.** A feed row with any other URL scheme still
  imports its price, but with no link.
- Tests: `python -m pytest tests/unit` (no network, no database).

## Go-live

The full sequence (accounts, test-mode run, live switch, rollback) is `.tools/GO_LIVE_RUNBOOK.md`;
`python tools/go_live.py check` shows what is ready and what is left at any moment.
