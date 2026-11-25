# Whisper

Whisper is an iPhone app for sending short, anonymous messages to people physically near you: the car in the next lane, another table at a restaurant. There's no login and no names. The other person has to accept before they see the message, so nobody gets spammed.

- **Main use:** traffic. "Your headlights are off", "Can I merge in front of you?", "I'm the white Toyota, can I get into the right lane?"
- **Also:** bars, restaurants and other venues.

## How it works

Whisper finds people by GPS through a small server, and requests arrive as push notifications, so it works with the app in the background.

1. **Go visible.** You get an anonymous session, and the app sends your location every 4 seconds. iOS shows the blue location pill while it runs.
2. **See who's nearby.** Within your range (Close 40 m, Normal 80 m, Wide 150 m) you see each person's nickname, description, rough distance and direction ("~25 m · ahead left"). Exact coordinates are never shared.
3. **Send.** Pick a quick message or type your own (140 characters max), to one person or everyone nearby.
4. **They decide.** The push says only "Blue Fox · White Toyota wants to send you a message". They tap Accept, Decline or Decline & block, right from the lock screen. Only Accept releases the text, and declined text is deleted.
5. **Go hidden.** Tapping Go hidden, 3 hours passing, or 15 minutes of inactivity erases the session.

**Anti-spam:** you can only message people currently near you. There's a cap of 3 unanswered requests per person and 6 sends a minute, and blocking hides both people from each other. On top of that:

- "Everyone nearby" can be used once every 2 minutes.
- The same text (ignoring case, spacing and punctuation) can go to at most 5 people in 10 minutes.
- If 5 people decline your messages within 10 minutes, you can't send for 10 minutes.
- One live session per phone: going visible again replaces the old session, so one phone can't pose as several people.
- Locations that jump faster than ~430 km/h are rejected, which stops spoofed GPS from teleporting next to someone.
- Each IP is limited to 600 requests a minute and 50 live sessions. These limits are generous on purpose, because phones on the same carrier often share an IP. Rate-limited answers carry `Retry-After`.
- Suspensions from reports ban the phone for 24 hours but the network for only 1 hour, for the same reason.

**Privacy:** no accounts, a random nickname, in-memory storage only, and no logging of locations or message text. The one exception is an abuse report: the text of a message someone reports goes to the moderators.

## Safety and moderation

Whisper carries anonymous messages between strangers, so App Store guideline 1.2 applies. It needs a content filter, a way to report and block people, timely action on reports, and published contact details. Here's how each is covered:

- **Content filter.** Messages, nicknames and descriptions are checked against a word and phrase list (insults, sexual content, threats, slurs) before anything is delivered. Common evasions are normalised first: `f.u.c.k`, `fuuuck`, `b1tch` and accents. Add words with `BLOCKLIST_EXTRA`.
- **Report.** You can report a request, an accepted message, or someone on the nearby list (swipe or long-press). A report always blocks the person as well.
- **Block.** Available from the nearby list and from any request. Blocking hides both people from each other.
- **Automatic suspension.** When 3 different people report someone, their session ends, their device (push token) is banned for 24 hours, and their network for 1 hour.
- **Timely response.** Every report is logged and posted to `REPORT_WEBHOOK_URL` (a Slack or Discord webhook), so you hear about it within seconds. With `ADMIN_TOKEN` set, `GET /admin/reports` lists recent reports and `POST /admin/sessions/:id/suspend` suspends someone by hand.
- **Terms and contact.** On first launch people agree to zero-tolerance terms, and the app shows a support email (`Config.supportEmail`).

## Siri and voice sending

Drivers shouldn't type, so the common messages work by voice through Siri, including Siri in CarPlay:

- "Hey Siri, **Whisper headlights off**" (also: *can I merge*, *trunk open*, *tire low*, *gas cap open*, *something dragging*, *turn signal on*, *thanks*)
- "Hey Siri, **send a custom Whisper**" asks what it should say, and the dictated text goes through the same content filter
- "Hey Siri, **go visible on Whisper**" / "**hide me on Whisper**"

A spoken message goes to **the car ahead** by default: the closest person whose direction is "ahead", then "ahead left" or "ahead right", then simply the closest. In the Shortcuts app you can pick "the closest person" or "everyone nearby" instead. Siri reads back who it went to. These are App Intents in `ios/Whisper/Intents/`, so there's no extension and no extra entitlement.

A full CarPlay screen is a separate step: Apple only grants the CarPlay entitlement to messaging apps through SiriKit messaging, which needs a request to Apple.

## Repository layout

```
server/            Zero-dependency Node.js server (Node 20+), deploys to Railway
  src/state.js     In-memory state: sessions, requests, blocks, reports
  src/app.js       HTTP routes on top of state.js
  src/apns.js      Apple Push client (HTTP/2, JWT ES256)
  src/geo.js       Distance, bearing, "ahead left" labels
  test/            node:test suite (npm test)
ios/               SwiftUI app, iOS 17+
  project.yml      XcodeGen spec (generates Whisper.xcodeproj)
  Whisper/         App sources; Config.swift holds the server URL
  Whisper/Intents/ Siri and Shortcuts (App Intents)
scripts/
  fake-person.mjs  A fake nearby person for testing with one phone
```

## API

All `/v1` calls except `POST /v1/sessions` need `Authorization: Bearer <token>`.

| Method | Path | What it does |
|---|---|---|
| POST | `/v1/sessions` | Go visible, get an anonymous token |
| GET | `/v1/me` | Your nickname, description and expiry |
| PATCH | `/v1/me` | Update nickname, description, push token, radius |
| DELETE | `/v1/me` | Go hidden (erases you) |
| PUT | `/v1/me/location` | Report location (`lat`, `lon`, `accuracy`, `heading`) |
| GET | `/v1/nearby?radius=normal` | People nearby: nickname, distance, direction |
| POST | `/v1/requests` | Ask to message one person (`to: <id>`) or everyone nearby (`to: "everyone"`) |
| GET | `/v1/inbox` | Incoming requests and messages, sent statuses |
| POST | `/v1/requests/:id/accept` | Accept and receive the text |
| POST | `/v1/requests/:id/decline` | Decline, optionally block (`{"block": true}`) |
| POST | `/v1/blocks` | Block someone from the nearby list (`personId`) |
| POST | `/v1/reports` | Report a request or message (`requestId`) or a person (`personId`), with `reason` and an optional `note`. This also blocks them |
| GET | `/admin/reports` | Recent reports (needs `Authorization: Bearer $ADMIN_TOKEN`) |
| POST | `/admin/sessions/:id/suspend` | Suspend someone for 24 hours (admin) |
| GET | `/health` | `{"ok":true}` |

Background location reports and background polling don't count as activity. Any user action, or a request sent with `X-Whisper-Foreground: 1` while the app is on screen, does.

## Setup

1. **Deploy the server.** In Railway choose New Project → Deploy from GitHub, pick this repo, set Root Directory to `server`, and generate a domain. Check that `/health` returns `{"ok":true}`. Keep it at 1 replica, because all state is in memory (`server/railway.json` already sets this).
2. **Create the APNs key.** This needs an Apple Developer account ($99 a year). In the developer portal go to Keys → +, enable Apple Push Notifications service, and download the `.p8` file (you can only download it once).
3. **Set the Railway variables:**
   - `APNS_KEY`: the contents of the `.p8` file (newlines or `\n` both work)
   - `APNS_KEY_ID`: the key's 10-character ID
   - `APNS_TEAM_ID`: your team ID
   - `APNS_BUNDLE_ID`: the app's bundle ID, e.g. `com.yourname.whisper`
   - `APNS_ENV`: `sandbox` for builds run from Xcode (the default), `production` for TestFlight and the App Store
   - `REPORT_WEBHOOK_URL`: a Slack or Discord incoming webhook that receives abuse reports (strongly recommended)
   - `ADMIN_TOKEN`: a long random string that turns on the `/admin` endpoints
   - `BLOCKLIST_EXTRA`: optional extra filtered words or phrases, comma-separated
   - `REVIEW_DEMO_CODE`: a secret phrase of at least 6 characters that turns on App Review demo mode (see below)
4. **Configure the app.** Set `apiBaseURL` in `ios/Whisper/Config.swift` to the Railway URL and `supportEmail` to an address you read, and set `PRODUCT_BUNDLE_IDENTIFIER` in `ios/project.yml` to match `APNS_BUNDLE_ID`.
5. **Build.** Run `brew install xcodegen`, then `cd ios && xcodegen`, then open `Whisper.xcodeproj` in Xcode, pick your Team under Signing & Capabilities, and run on a real iPhone (push and GPS don't work properly in the simulator).
6. **Test with one phone.** Run `node scripts/fake-person.mjs <url> <lat> <lon>` with your own coordinates. A "Test Bot · Grey Tesla" appears next to you, asks to message you, and auto-accepts what you send it.

## App Review demo mode

App Review tests with one phone and can't run `fake-person.mjs`. With `REVIEW_DEMO_CODE` set, anyone whose description is that code gets a **Test Bot · Grey Tesla** about 15 m away within a few seconds. The bot:

- follows them as they move, so it stays nearby
- sends them a request right away, so they can try Accept, Decline and Report
- accepts anything they send it, so they can see the "Accepted" status and push

The code is replaced with "App Review" as soon as the server sees it, so nobody nearby ever learns it. The bot leaves when the reviewer goes hidden or their session times out. Put the code in the App Review notes, and change or remove it after approval.

## Running the server locally

```sh
cd server
npm test          # no dependencies to install
npm start         # listens on $PORT or 3000; pushes are skipped without APNS_* set
```

## Status

v0.2. The server passes its test suite and an end-to-end run against the fake person. The iOS app has not been compiled yet, because that needs Xcode on a Mac. (v0.1 was a Bluetooth-only prototype that needed the app open on both phones.)

### Known limits

- GPS is accurate to about 5–10 m outdoors and worse indoors, so people's descriptions do the real work of telling who's who.
- Being visible keeps GPS running, about like a navigation app.
- A server restart wipes sessions. The app reconnects quietly with the same nickname.
- Apple reviews background-location apps closely, and the driving use case adds distracted-driving scrutiny.

### Next steps

- [ ] First Xcode build and a two-phone test
- [ ] Check "Whisper" availability on the App Store
- [ ] Test Siri phrases on a device; consider a CarPlay entitlement request
- [ ] Redis GEO store if it needs more than one server instance
