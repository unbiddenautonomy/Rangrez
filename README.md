# Rangrez

An online dice-drafting game for 1 to 4 players: draft colored dice and place them into a stained-glass window, following the color and value restrictions of your window pattern. Players join the same room by a 4-letter code (or a shared link) from any device and play in real time.

## Run it

### On Cloudflare (recommended for playing online)

The app runs as a Cloudflare Worker. Each room is a Durable Object named by its code, which holds the players' live WebSocket connections and saves the game after every move. Custom patterns are stored in one more Durable Object. Static files in `public/` are served by Workers Static Assets. Everything fits in Cloudflare's free plan.

**Deploy from GitHub (Workers Builds):** in the Cloudflare dashboard go to Workers & Pages → Create → Import a repository, pick this repo, and keep the defaults (build command empty, deploy command `npx wrangler deploy`). The Worker name must be `rangrez` to match `wrangler.jsonc`. Every push to `main` then deploys automatically. You get a URL like `https://rangrez.<your-subdomain>.workers.dev`.

**Or deploy from your computer:**

```bash
npm install
npx wrangler login
npm run deploy
```

**Test the Cloudflare version locally:** `npm run dev:cf`, then open http://localhost:8787.

### With plain Node.js

Requires Node.js 19 or newer.

```bash
npm install
npm start            # http://localhost:3000 (set PORT to change)
```

Friends on the same Wi-Fi can open `http://<your-computer-ip>:3000`. Custom patterns are saved to `data/custom-patterns.json`.

### Playing

Open the page, enter a name, press **Create a room**, then share the code or the **Copy link** button. Reloading the page or losing connection reconnects you to your seat automatically.

## How to play

- Each player is dealt 4 window patterns, one per difficulty tier (3 to 6), and a secret color. Difficulty = favor tokens you get.
- 10 rounds. Each round the pool has 2 × players + 1 dice. Turn order goes around and back (1-2-3-3-2-1), so everyone drafts twice. The start player rotates each round.
- On your turn you may place one die and use one tool, in any order, then end your turn.
- Placement: first die on an edge or corner; every later die must touch a placed die (diagonals count). Dice of the same color or the same value may never be orthogonally adjacent. Tinted cells need that color; faded-die cells need that value.
- Tools cost 1 favor the first time anyone uses them in a game, then 2.
- Scoring: 3 public objectives + pips of your secret color + favor left − 1 per empty cell.

## Window patterns

`server/patterns.js` holds 64 hand-designed windows, 16 at each difficulty. Difficulty is also the number of favor tokens you get.

| Difficulty | Restrictions | Design rule |
|---|---|---|
| 3 | 8 to 9 | Mostly colors, at most 3 values, spread out, open edges to start from |
| 4 | 9 to 11 | About half values, a few restricted cells side by side |
| 5 | 12 to 13 | Mostly values, in clusters, restricted edges |
| 6 | 14 to 15 | Values dominate, dense blocks, very few open cells |

`node tools/windows.js` checks that no window asks for impossible neighbours, that every window can be completely filled, and simulates games to measure how many cells a sensible player leaves empty. On average that's 1.2 empty cells at difficulty 3, 1.4 at 4, 1.9 at 5 and 2.5 at 6.

### Your own patterns

The **Pattern editor** on the start page lets you paint patterns on a grid (or import JSON), with a name and difficulty 3 to 6. They're saved on the server (a Durable Object on Cloudflare, `data/custom-patterns.json` on Node). In the waiting room the host picks which set to deal from: originals, custom, or both.

JSON format:

```json
[{ "name": "My Window", "difficulty": 4, "rows": ["R...3", ".G.4.", "..B..", "1...Y"] }]
```

`.` open · `R` crimson · `Y` amber · `G` jade · `B` cobalt · `P` violet · `1`-`6` value

## Bots

In the waiting room the host can add **Easy**, **Medium** or **Hard** bots, so you can play solo or fill empty seats. Easy places random legal dice. Medium protects restricted cells and favors its secret color. Hard also avoids moves that make cells unfillable, plays toward the public objectives and uses dice-changing tools. In simulated 3-player games Easy averages about 23 points, Medium about 44 and Hard about 50.

## Test

With a server running, `PORT=3000 npm test` (Node) or `HOST=localhost:8787 npm test` (wrangler dev) plays a full 3-player game with bots over WebSockets.

## Code layout

- `server/game.js`: rules engine (drafting, placement, tools, scoring)
- `server/patterns.js`: the 64 built-in window patterns
- `server/room.js`: one room's players, seats, messages and bot turns, shared by both servers
- `server/bots.js`: Easy, Medium and Hard bots
- `server/index.js`: Node server
- `worker/index.js`: Cloudflare Worker and Durable Objects
- `public/`: the browser app
