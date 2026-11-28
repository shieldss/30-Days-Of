# Background reminders for 30 Days of…

Deploy a **separate** Worker on the same free Cloudflare account you used for Fuel & Flow. This does not modify your Fuel & Flow Worker, URL, or pairing key. [Workers Free limits](https://developers.cloudflare.com/durable-objects/platform/pricing/).

## One-time setup

On a computer with Node.js 22+ and access to the Cloudflare account:

```sh
git clone https://github.com/shieldss/30-Days-Of.git ~/30-days-of-push
cd ~/30-days-of-push/push-worker
npx wrangler whoami
node setup.mjs you@example.com
```

If `whoami` says you aren't logged in, run `npx wrangler login` and approve in your browser before running setup. Replace `you@example.com` with a valid email you control for the standard Web Push operator contact. Stay on Workers Free. Setup prints the new `thirty-days-of-push.…workers.dev` address and its own pairing key. If deployment is interrupted after creating the private secrets file, retry with `npx wrangler deploy --secrets-file .push-secrets.local.json`. Keep that file and the pairing key private; do not commit or share them.

On the device you want notified, open **30 Days of… → Settings → Notifications → Background push**. Enter the newly deployed URL and its key, tap **Connect push**, and allow browser notifications. Set each reminder's toggle and time as before. On iPhone/iPad, use the app installed from the Home Screen.

## Behavior

- The daily reminder counts active, scheduled challenges with reminders allowed. The incomplete reminder only schedules when at least one such challenge is not complete or skipped that day. If both are set for the same minute, one notification is sent.
- The app sends up to 30 days of upcoming reminder times for active challenges, using this device’s clock and time zone. The absolute time reflects daylight saving on each reminder date. A nonexistent spring-forward time moves forward by the gap; a repeated fall-back time uses the first occurrence. Open the app online after changing schedules, time zones or travelling. Marking a day done/skipped, pausing or ending a challenge, or resetting the app also resyncs; offline changes do not reach the Worker until you're back online.
- **Notifications** off cancels pending jobs and keeps the connection for next time; **Disconnect push** also unsubscribes this browser. Unpaired devices keep the old in-app reminder mode. A connected device doesn't send duplicate foreground reminders.
- The Worker stores the browser push subscription and scheduled reminder dates/times and types. It does not receive challenge names, goal text, notes, or history. The push text is generic, and the payload is encrypted. Pairing is per device and not exported in backups. A delivered reminder can be delayed by your browser, OS settings, or network; the relay drops expired jobs.

## Update an existing Worker

To apply a Worker fix, update the existing checkout and deploy in place:

```sh
cd ~/30-days-of-push
git pull --ff-only
cd push-worker
npx wrangler deploy
```

Use the same Cloudflare account and Worker name. Do not rerun initial setup or rotate the pairing key. Open the app online and tap **Settings → Notifications → Background push → Sync now** to send the current schedule.

For development, run `node push-worker/runtime-tests/run.mjs` from the repository root with `workerd` on PATH (or pass its full path after the script name). It tests both scheduled reminder types through real local SQLite Durable Object alarms against a simulated provider, and verifies provider redirects are not followed. Use `node --test` at the root to also test local-time conversion and browser subscription recovery.

## Check notifications

- **Sync now** contacts the Worker even if the schedule hasn't changed. It restores a missing browser subscription with the existing pairing when the browser allows it, then reports how many reminders the Worker actually queued, the next time in this device’s time zone, and the last delivery result. Already-sent reminders won't repeat.
- **Test browser notification only** checks whether the device can display a notification, not whether push delivery works. It does not need the Worker.
- **Send test push** needs the current Worker. It makes a real, separately labeled push without changing challenge progress, reminder settings, or pending reminders. If the provider accepts the test, check for the notification on that device. An accepted request does not guarantee that the device displayed it.

- **Test in 1 minute** uses the same Worker alarm as live reminders, and does not need an active challenge. Close the app or lock the device and watch for **30 Days of… · Scheduled test**. If needed, reopen and tap **Sync now** to see whether the provider accepted the scheduled test. Provider acceptance does not prove the phone displayed it.
