# The Daily Dirt

A Jackbox-style tabloid party game for 3 to 10 friends. One screen (TV or laptop) is the front page,
everyone else plays from their phone by entering a four-letter room code or scanning the QR code.

## How a night goes

| Round | Name | What happens | Scoring |
| --- | --- | --- | --- |
| 1 | **Hot Takes** | Each player fills in two tabloid headlines about people in the room. Answers face off head to head and the room votes. Every headline comes with a secret **Plant word**; sneak it into your answer for a bonus. | 1,000 points split by vote share. +500 "Scoop!" for a unanimous win (3+ voters). +250 for a planted word that gets a vote, +500 if it also wins. |
| 2 | **Anonymous Source** | Everyone confesses one *true* thing about themselves while two friends write fakes. The room votes for the truth. | Spot the truth: +500. Each person fooled by your lie: +500. Each person who didn't believe your truth: +250. |
| 3 | **Connect the Dots** | Each player gets two scandals from earlier in the night and writes the headline that links them. Everyone picks a top story and a runner-up. | Top story pick: 1,000 per vote. Runner-up pick: 500 per vote. |

The night ends with a front page: the winner, the top story, awards (Smoothest Liar, Human Lie Detector,
Too Wild To Believe, Master Gardener) and the best headlines.

Extras: emoji reactions that float across the TV, an audience mode for late joiners (they vote now and play
next game), phone reconnection if a screen locks, host-screen reclaim on refresh, and "play again" with the same
crew and fresh prompts.

## Running it

```bash
npm install
npm start            # http://localhost:3000
```

- Open `/host` on the TV. It shows the room code, join URL and QR code.
- Phones open the site root and enter the code (or scan the QR, or visit `/XXXX` with the code).
- The first player in is the VIP and can start the game; the TV can start it too.

Environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port (Railway sets this). |
| `PUBLIC_URL` | derived from the request | Force the join URL shown on the TV, e.g. `https://dirt.example.com`. |
| `DD_TIMER_SCALE` | `1` | Multiply every timer (0.3 makes a quick test game). |

## Tests

```bash
npm test                         # engine unit tests + socket integration tests
node test/ui.playwright.js       # real browser: a TV and three phones play a whole game
node test/visual.playwright.js   # dense-layout screenshots for a 9-player game
```

## Deploying

The repo includes `railway.json`. Deploy it as a single Node service with a public domain; rooms live in memory,
so run one replica.

## Project layout

```
server/index.js    express + socket.io wiring, room registry, QR codes
server/game.js     the game engine (phases, timers, scoring, views)
server/content.js  prompts, plant words, decoy lies, copy
public/host.html   the TV
public/index.html  the phone controller
test/              engine, socket and browser tests
```
