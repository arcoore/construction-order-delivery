SYNTHETIC SAMPLE DATA - NOT REAL MERCHANT DATA.

These files exist to test tools/import_offers.py and to demo the offers UI
locally. Every SKU, price and URL is made up (URLs are example.com). They mimic
the column layout of an Awin product feed as best it is known; the first REAL
feed may need a --columns override (see tools/README.md).

  wickes_sample.csv / jewson_sample.csv   feed-shaped rows
  wickes_map.csv    / jewson_map.csv      external_id -> SiteStock product + variant

Never load these into the hosted database.
