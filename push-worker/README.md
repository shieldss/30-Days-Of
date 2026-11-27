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
- The app sends up to 30 days of upcoming reminder times for active challenges. Open the app online after changing a schedule or travelling. Marking a day done/skipped, pausing or ending a challenge, or resetting the app also resyncs; offline changes do not reach the Worker until you're back online.
- **Notifications** off cancels pending jobs and keeps the connection for next time; **Disconnect push** also unsubscribes this browser. Unpaired devices keep the old in-app reminder mode. A connected device doesn't send duplicate foreground reminders.
- The Worker stores the browser push subscription and scheduled reminder dates/times and types. It does not receive challenge names, goal text, notes, or history. The push text is generic, and the payload is encrypted. Pairing is per device and not exported in backups. A delivered reminder can be delayed by your browser, OS settings, or network; the relay drops expired jobs.
