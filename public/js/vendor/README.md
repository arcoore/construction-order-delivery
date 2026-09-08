# js/vendor/ — the vendored Supabase JS SDK

`supabaseClient.js` imports `createClient` from `supabase-js.bundle.js` here.
Before, it imported from `https://esm.sh/@supabase/supabase-js@<version>` at
runtime, which meant the login screen could not start until a third-party CDN
answered, and put `esm.sh` in every page's Content-Security-Policy. Vendoring
removes both: the app now loads with **no external script request at all**.

Still no bundler / npm — these are plain ES modules the browser loads directly,
same as the rest of `public/js/`. They are just esm.sh's own build output,
saved to disk instead of fetched every page load.

## Files (pinned to @supabase/supabase-js 2.115.0)

| file | what it is |
|---|---|
| `supabase-js.bundle.js` | the SDK, all five `@supabase/*` sub-packages inlined by esm.sh's `?bundle` |
| `buffer.js` `process.js` `events.js` `tty.js` `async_hooks.js` | Node built-in shims the bundle needs in a browser |

Every internal import was rewritten from esm.sh's absolute paths
(`/node/buffer.mjs`, …) to relative `./*.js`, and the trailing
`//# sourceMappingURL=` comment was dropped (the `.map` is not vendored).
Nothing else in the code was changed.

## Regenerating on a version bump

```bash
V=2.115.0            # the new pinned version
cd /tmp
# 1. the bundle stub tells you the real bundle path
curl -sL "https://esm.sh/@supabase/supabase-js@$V?bundle&target=es2022"
# 2. fetch the bundle + follow its /node/*.mjs imports until every leaf is fetched
#    (currently: supabase-js.bundle -> buffer, process; process -> events, tty;
#     events -> async_hooks; buffer/tty/async_hooks are leaves)
# 3. save each into public/js/vendor/ renamed *.mjs -> *.js
# 4. rewrite each `from "/node/X.mjs"` (and the bundle path) to `from "./X.js"`
# 5. strip the trailing `//# sourceMappingURL=` line
# 6. bump the version note in supabaseClient.js
# 7. re-test: sign in, Realtime, and a full Worker -> Owner -> Buyer -> Driver
#    order lifecycle, against the local stack and hosted
```

The Python helper used the first time is in the session scratchpad; the steps
above are enough to redo it by hand.
