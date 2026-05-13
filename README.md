# Nuvio Trakt Bridge

Standalone static web tool for importing Trakt watched history, playback progress, watchlist, and collection data into Nuvio Sync.

## Privacy model

- The sync work runs in the user's browser.
- Tiny Trakt OAuth endpoints are required for a real website so the Trakt app secret stays server-side.
- The page calls Nuvio directly from the user's browser.
- Nuvio email/password are only used in the browser for the Nuvio Supabase auth request and are never stored by this tool.
- Trakt and Nuvio session tokens only live in memory while the page is open. Refreshing the page disconnects both accounts.
- The bridge does not create cookies and does not save UI preferences in `localStorage` or `sessionStorage`; old bridge storage keys are cleared on load.
- There is no analytics, bridge database, log upload, or telemetry.

If you host this publicly, serve it over HTTPS and avoid adding third-party scripts. Whoever controls the hosted JavaScript could change what the browser sends, so the safest deployment is a static host you control.

## Official API references used

- Nuvio Cloud API docs: `https://nuvioapp.space/docs`
- Nuvio Public API markdown asset: `https://nuvioapp.space/assets/NUVIO_PUBLIC_API--7B_Ix8m.md`
- Trakt API contracts: `https://github.com/trakt/trakt-api`
- Trakt API docs: `https://trakt.docs.apiary.io/`

## What it syncs

- Trakt watched movies and watched show episodes to Nuvio `sync_push_watched_items`.
- Trakt playback progress to Nuvio `sync_push_watch_progress`.
- Optional Trakt watchlist and collection items into the Nuvio library.

Nuvio watch history and watch progress pushes are non-destructive merge endpoints. Nuvio library is a full-replace endpoint, so this tool first pulls the current Nuvio library, merges Trakt imports, dedupes by `content_id`, then pushes the complete merged list.

## Run locally

For Trakt login testing, use the included tiny server instead of a static file server:

```powershell
$env:TRAKT_CLIENT_ID="your_64_character_trakt_client_id"
$env:TRAKT_CLIENT_SECRET="your_app_client_secret"
$env:TRAKT_REDIRECT_URI="http://127.0.0.1:4173/api/trakt/callback"
node .\server.js
```

Then open `http://127.0.0.1:4173/`.

When `TRAKT_CLIENT_ID` is set, `server.js` serves the browser config automatically. The public client ID is not preloaded into the page; it is returned by the login endpoint after the user presses `Connect Trakt`.

For a hosted website, the site owner does this setup once on the server or serverless host. End users do not provide Trakt app details before pressing `Connect Trakt`.


## ID mapping notes

Nuvio examples use IDs like `tmdb:550`, while Nuvio's own Trakt import code prefers IMDb IDs when Trakt provides them, then `tmdb:<id>`, then numeric `trakt:<id>`. The bridge follows that same order. TVDB IDs and Trakt slugs are only used for matching your optional remaps; they are not pushed raw because Nuvio's Trakt ID parser does not treat them as primary content IDs.

```json
{
  "tvdb:12345": "tmdb:67890",
  "trakt:show:123": "tt0903747"
}
```
