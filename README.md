# 30 Days of…

A calm, local-first progressive web app for personal 30-day challenges. Track multiple challenges, daily notes and optional results, streaks, awards, reminders, and progress without an account or server.

## Screenshots

_Add screenshots here after deploying the app._

## Features

- Today dashboard with active challenge cards and quick check-ins
- Guided challenge setup, current-day offset, weekly goals, and optional measurement tracking
- 30-day calendar with completed, missed, today, earlier unrecorded, skipped, and upcoming states
- Editable daily status, result, and notes; completion can be undone for five seconds
- Active, paused, completed, and archived challenge states; paused timelines hold and resume without accumulating missed days; duplicate a challenge to begin again
- Streaks, completion rate, week-by-week progress, awards, and challenge history
- JSON export/import with merge and replace options
- Light, dark, or system theme
- Opt-in browser notifications and separate reminder times
- Installable offline PWA with update prompt
- Responsive layout, keyboard focus styles, semantic controls, and reduced-motion support

## Architecture

This is a static, dependency-free HTML/CSS/JavaScript application. Challenge data and settings are persisted in IndexedDB, with a localStorage fallback when IndexedDB is unavailable. The service worker caches the application shell and same-origin resources. No account, analytics, API, or server is required.

## Run locally

From the project directory, start any static HTTP server. For example, with Python installed:

```sh
python3 -m http.server 8000
```

Open <http://localhost:8000>. Service workers and PWA installation require localhost or HTTPS; opening `index.html` directly from disk will not enable them.

## GitHub setup and Pages deployment

1. Create a GitHub repository and put the contents of this project at its repository root.
2. Commit and push the files to the `main` branch.
3. In repository **Settings → Pages**, set the build/deployment source to **GitHub Actions**.
4. The included `.github/workflows/pages.yml` publishes the repository root whenever a commit reaches `main`. The workflow can also be started from the Actions tab with **Run workflow**.
5. Wait for the Pages deployment job to finish, then open the URL shown in the job summary.

All application resources use relative paths (`./...`) and the web manifest scopes itself to its folder, so GitHub Pages project sites under `https://<owner>.github.io/<repository>/` work without a build step or repository-specific path edits. Keep `index.html`, `challenge-app.js`, `styles.css`, `manifest.json`, `sw.js`, and `assets/` together at the published root.

For a custom domain, configure it in Pages and add the DNS records GitHub provides. Use HTTPS so service worker, notifications, and installation features are available.

## Install the PWA

The site must be served from `localhost` or HTTPS. The app keeps its data on the device where it is installed.

- **Android:** open the deployed site in Chrome. Select **Install app** if offered, or choose **Install app / Add to Home screen** from the browser menu.
- **iPhone and iPad:** open the site in Safari, tap **Share**, then **Add to Home Screen**. iOS controls the install experience and does not expose the Android-style install prompt.
- **macOS and desktop:** in a supported browser, use its install icon in the address bar or the browser menu's **Install app** command.

## Offline behavior

After the first successful load, the service worker stores the app shell and same-origin resources. The application, challenge records, and settings continue to work offline. A later deployment downloads in the background; the app displays an **Update now** prompt only when a newer service worker is waiting. Choosing **Update now** activates the new version and refreshes the app while IndexedDB user data remains intact.

The first visit requires a network connection. Browser storage can be cleared by browser settings, private browsing, or device cleanup, so export backups periodically.

## Notifications and limitations

Pausing holds the challenge calendar. When you resume, dates on and after the pause day shift forward by the time spent paused, so paused days do not count as missed.

Notifications are off until enabled in Settings and browser permission is granted. Daily and incomplete-day reminder times are checked while the app is open or when it becomes visible. A static PWA has no server push or guaranteed background scheduler, so browsers may suspend it when fully closed; this app does not claim that closed-app reminders are guaranteed. Browser and operating-system notification settings also affect delivery.

## Backup and restore

Choose **Settings → Export backup** to download a dated JSON file containing challenges and preferences. **Import backup** validates the structure, then lets you merge by challenge ID or replace current data. Replacing asks for confirmation. Store backups somewhere separate from the device running the app.

## Project structure

```text
.
├── .github/workflows/pages.yml  # GitHub Pages deployment
├── assets/
│   ├── icon-192.png             # Install icon
│   ├── icon-512.png             # Install icon
│   ├── icon-maskable-512.png    # Maskable install icon
│   ├── icon.svg                 # Scalable app icon
│   └── logo.svg                 # In-app logo
├── challenge-app.js              # UI, challenge logic, storage, awards, backups
├── index.html                   # App shell
├── manifest.json                # PWA metadata
├── styles.css                   # Responsive UI and themes
└── sw.js                        # Offline cache and update lifecycle
```

## Data and date model

Each challenge stores the selected date as the date corresponding to the entered current challenge day. The calendar derives Day 1 by subtracting `startingDay - 1` local calendar days. Dates are parsed at local noon to avoid UTC midnight date shifts. Earlier days are unrecorded by default; setup can mark them complete. Only elapsed challenge days at or after the chosen current day count as missed unless the user records them otherwise.

## Release process

The app version is centralized as `VERSION` in `challenge-app.js`; update the service-worker cache name in `sw.js` to a new unique build identifier and increment the asset query string in `index.html` and `sw.js` when preparing a new version. Use semantic versioning, update this README if user-facing behavior changes, then commit to `main`. GitHub Actions publishes the new version and the service worker offers it to installed users.

## Accessibility

The interface uses labelled form controls, semantic buttons and links, visible keyboard focus, status text that does not rely on color alone, accessible progress attributes, and reduced-motion handling. Dialogs can be dismissed by clicking outside or pressing Escape.

## License

No third-party graphics or logos are used. Add a license file if you plan to publish the repository under a specific open-source license.
