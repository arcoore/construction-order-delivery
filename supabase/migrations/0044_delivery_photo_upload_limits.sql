-- Server-side upload validation for the delivery-photos bucket.
--
-- deliveryPhotos.js already checks file.type / file.size in the browser, but
-- that's trivially bypassed by a direct storage.upload() call. Enforce the
-- same rules at the Storage layer, where they can't be skipped:
--
--   * file_size_limit 10 MB - matches the client check.
--   * allowed_mime_types: raster image formats only. Storage rejects an
--     upload whose declared content-type isn't in this list regardless of
--     what the client claims. image/svg+xml is deliberately EXCLUDED - an
--     SVG can carry <script>, and these files are handed back to viewers as
--     signed URLs that a browser would render inline.
--
-- Nothing about how photos are read, recorded, or RLS-scoped changes (see
-- 0039). The bucket stays private; files are still only reachable through a
-- short-lived signed URL to someone who can already see the order.

update storage.buckets
set
  file_size_limit = 10485760,  -- 10 * 1024 * 1024
  allowed_mime_types = array[
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/heic',
    'image/heif',
    'image/gif'
  ]
where id = 'delivery-photos';
