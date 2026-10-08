# Hopper: Garden Crossing

Online grasshopper racing for Ark80s. Up to 8 players race across five lanes of traffic.
First across the flowers wins. Four locations rotate each round: the garden, the barnyard,
the driveway and the kitchen floor. Traffic speeds up every round.

## Files

- `wrangler.jsonc` Worker config (static files plus one Durable Object class, `Room`)
- `src/worker.js` race server: one room per code, WebSocket at `/ws?room=CODE`
- `public/` the game (`index.html`, `style.css`, `sprites.js`, `game.js`)
- `test/room.test.mjs` server logic and traffic checks (`npm test`)

## Deploy from an Android phone (Termux)

```
pkg install nodejs unzip
termux-setup-storage
unzip ~/storage/downloads/hopper.zip -d ~/hopper
cd ~/hopper
npm install
npx wrangler login
npx wrangler deploy
```

The game goes live at `https://hopper.<your-subdomain>.workers.dev`.
Change `"name"` in `wrangler.jsonc` to pick a different address.

If `npm install` fails on Termux because of the `workerd` package, deploy the same way you
deployed your other Ark80s Workers (GitHub repo connected to Cloudflare), since this project is
a normal Worker with an `assets` folder.

## How online play works

- Quick Race joins `OPEN1`, `OPEN2` and so on (8 players each).
- New Room makes a four letter code. Invite sends a link that opens straight into that room.
- The race starts when every hopper in the room taps Ready.
- The server owns the race clock, the finish times and the points. Traffic is built from a
  shared seed, so everyone sees the same cars at the same moment.
- Points: 1st 1000, 2nd 700, 3rd 500 and so on, plus 50 per life left.

## Controls

On-screen arrows, swipe on the field, or arrow keys and WASD.
