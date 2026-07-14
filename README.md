# worker-cms-plugin-checkin

Event check-in plugin for [Worker CMS](https://github.com/eventuai) — QR/barcode scanning, guest lookup, main-attendee/plus-guest/session check-in, walk-in registration and badge printing. Pairs with `cms-plugin-events`, which owns the `event` / `mail_list` / `guest` / `label` content types this plugin reads and writes.

## Features

- **Admin dashboard** (`/admin/plugins/checkin`, CMS login required) — events with check-in configured, per-list check-in counts, guest search, and a link to that event's kiosk.
- **Passcode-lite kiosk** (`/kiosk/{eventId}`) — a door/tablet device unlocks with the event's `checkin_lite_passcode` (no CMS login needed) and can then:
  - scan a QR/barcode or enter a code manually — searches every guest list on the event
  - search guests by name/email/organization across the whole event
  - check in / undo the main attendee, named or unnamed plus guests (individually or all at once), and per-session check-ins (for multi-session events)
  - register a walk-in guest on the spot, landing in the event's "Adhoc" list, with optional immediate check-in
  - bind an RFID tag to a guest for future scans
  - preview and print a badge from the event's label template, via the browser print dialog, a WebUSB label printer, or a local printer-server relay
- **Direct QR check-in links** (`/checkin/{listId}/{guestId}/{sig}`, `/checkin/{listId}/{guestId}/{index}/{sig}`) — resolves the signed guest QR codes `cms-plugin-events` already generates, so a guest can check themselves in (or a staff member can) by opening the printed/emailed QR link directly, without the kiosk UI.

## Architecture notes

- No blueprint/schema changes to `cms-plugin-events` — this plugin only reads/writes its `event`/`mail_list`/`guest`/`label` pages through its own CMS Plugin API client (plugin id `checkin`).
- `guest.checkin[]` only stores `status`/`date`/`message`; which attendee/plus-guest-index/session a check-in belongs to is encoded into `message` via a parseable convention (`src/checkin-actions.ts`), so no schema change was needed to support multi-session and multi-plus-guest tracking.
- RFID tags reuse the existing `barcode` guest attribute — there's no dedicated RFID field.
- Verifying `cms-plugin-events`' already-minted guest QR signatures requires a **copy** of that plugin's `PLUGIN_SECRET` in this plugin's `EVENTS_PLUGIN_SECRET` env var (see `wrangler.toml`) — the two plugins don't share a binding.
- Badge printing ports the legacy Eventuai checkin app's client-side printer stack (`views/assets/js/printer.js`, `encoder.js`, `zxing-wasm.js`) — WebUSB pairing, a local printer-server HTTP relay with RLE compression, SVG→bitmap ESC/P encoding, and camera-based QR/barcode scanning.

## Configuration

```
wrangler secret put PLUGIN_SECRET         # this plugin's own CMS Plugin API credential
wrangler secret put EVENTS_PLUGIN_SECRET  # copy of cms-plugin-events' PLUGIN_SECRET
```

`CMS_URL` and `PUBLIC_BASE_URL` are set as vars in `wrangler.toml` (the latter is this Worker's own public origin, used to build absolute kiosk links from the CMS-hosted admin dashboard).

## Development

```
npm install
npm run typecheck
npm test
npm run dev      # wrangler dev
```
