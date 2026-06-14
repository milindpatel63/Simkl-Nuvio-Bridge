# Nuvio Simkl Bridge

Standalone static web tool for importing Simkl watched history, playback progress, and watchlist data into Nuvio Sync. Perfect for movies, TV shows, and anime with per-episode tracking.

## Quick Start

### Prerequisites

1. **Simkl account**: Sign up at [simkl.com](https://simkl.com)
2. **Simkl API credentials**: Create an app at [simkl.com/apps](https://simkl.com/apps)
3. **Nuvio account**: Set up at [nuvioapp.space](https://nuvioapp.space)
4. **Node.js**: v14+ installed locally

### Setup & Run

1. **Clone this repository**:
```bash
git clone https://github.com/haaihond/Trakt-Nuvio-Bridge.git
cd Trakt-Nuvio-Bridge
```

2. **Install dependencies** (if needed):
```bash
npm install
```

3. **Set environment variables** with your Simkl credentials:

**On Linux/macOS**:
```bash
export SIMKL_CLIENT_ID="your_simkl_client_id"
export SIMKL_CLIENT_SECRET="your_simkl_client_secret"
export SIMKL_REDIRECT_URI="http://127.0.0.1:4173/api/simkl/callback"
node server.js
```

**On Windows (PowerShell)**:
```powershell
$env:SIMKL_CLIENT_ID="your_simkl_client_id"
$env:SIMKL_CLIENT_SECRET="your_simkl_client_secret"
$env:SIMKL_REDIRECT_URI="http://127.0.0.1:4173/api/simkl/callback"
node server.js
```

**On Windows (Command Prompt)**:
```cmd
set SIMKL_CLIENT_ID=your_simkl_client_id
set SIMKL_CLIENT_SECRET=your_simkl_client_secret
set SIMKL_REDIRECT_URI=http://127.0.0.1:4173/api/simkl/callback
node server.js
```

4. **Open in browser**: Navigate to `http://127.0.0.1:4173/`

5. **Sync your data**:
   - Click **"Connect Simkl"** to authenticate with your Simkl account
   - Enter your **Nuvio email and password**
   - Select which data to sync:
     - ✓ Sync Watch History (movies, TV episodes, anime episodes)
     - ✓ Sync Progress (resume points for in-progress shows)
     - ✓ Sync Watchlist (optional: import your watchlist to Nuvio library)
   - Review the preview to see what will be synced
   - Click **"Run Sync"** to import into Nuvio

## Features

- **Movies**: Full watch history sync
- **TV Shows**: Per-episode watch tracking with episode remapping
- **Anime**: Full per-episode sync with MyAnimeList (MAL) ID support
- **Smart Episode Remapping**: Automatically maps episodes between different numbering systems (e.g., absolute vs seasonal)
- **Playback Progress**: Continues watch progress syncs to Nuvio
- **Watchlist Import**: Optional import of Simkl watchlist items into your Nuvio library

## Privacy & Security

- All sync work runs in your browser—no data leaves your computer except to Simkl and Nuvio
- Nuvio credentials are only used for browser authentication and never stored
- Session tokens live only in memory; they're cleared when you close the page
- No cookies, localStorage, or analytics
- OAuth endpoints (on your server) keep your Simkl app secret server-side

**Important**: If you host this publicly, use HTTPS and don't add third-party scripts. Whoever controls the JavaScript could intercept your Simkl/Nuvio auth tokens.

## How to Get Your Simkl Credentials

1. Go to [simkl.com/apps](https://simkl.com/apps) and sign in
2. Click **"Create New App"**
3. Fill in the form:
   - **App Name**: "Nuvio Bridge" (or whatever you'd like)
   - **Redirect URI**: `http://127.0.0.1:4173/api/simkl/callback` (for local testing)
   - **Description**: Optional, e.g., "Personal sync tool for Nuvio"
4. After creating, you'll see:
   - **Client ID** → copy this to `SIMKL_CLIENT_ID`
   - **Client Secret** → copy this to `SIMKL_CLIENT_SECRET`

## ID Mapping Notes

The bridge maps content using multiple ID systems in priority order:
1. **IMDb** (tt1234567) — most compatible
2. **TMDB** (tmdb:98765)
3. **MyAnimeList** (mal:12345) — for anime titles
4. **Simkl** (simkl:show:123) — fallback

If you need custom ID remapping (e.g., force a title to use a specific IMDb ID), you can add a remap JSON file.

## Troubleshooting

**"Allow pop-ups for this site"**
- Your browser blocked the Simkl login popup. Check your browser popup blocker and allow this site.

**"The Simkl login endpoint is missing"**
- You didn't set the environment variables. Make sure `SIMKL_CLIENT_ID` and `SIMKL_CLIENT_SECRET` are exported before running `server.js`.

**Episodes not syncing**
- Check that your Nuvio profile has metadata addons enabled (needed for per-episode tracking)
- Verify the show/anime is in your Nuvio library or will be auto-added

**Anime episodes numbered differently**
- The bridge auto-detects numbering differences and remaps them. If remapping fails, check your Nuvio addon settings.

## Official API References

- [Nuvio Cloud API](https://nuvioapp.space/docs)
- [Simkl API Documentation](https://simkl.com/api/)
