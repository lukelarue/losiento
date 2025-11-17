# Lo Siento (FastAPI + Firestore)

Python 3.11+ FastAPI service implementing **Lo Siento**, an online adaptation of the board game *Sorry!* with a minimal iframe-friendly frontend and Firestore-backed persistence and concurrency.

This project mirrors the overall structure and deployment approach of the Minesweeper service, but with a richer rules engine and multiplayer lobby/gameplay flow.

## Features

- **Rules engine in pure Python** (`losiento_game/engine.py`)
  - Implements the Lo Siento/Sorry! rules from `rules.md`:
    - 4 pawns per player, Start / Safety / Home zones.
    - 1/2/Sorry! to leave Start, exact count to enter Home.
    - Slides (including cross-color slides and slide-into-safety behavior).
    - Safety Zone rules and self-bump prohibition.
    - Card behaviors including 2 (extra draw), 7 (split), 10 (forward/backward), 11 (switch), and Sorry! (target/bump + slides).
  - Exposes `get_legal_moves` and `apply_move` with a `Move` structure that encodes both simple and complex moves (7-split, 11-switch, Sorry!).

- **Persistence layer with Firestore and in-memory implementations** (`losiento_game/persistence.py`)
  - In-memory implementation (`InMemoryPersistence`) for tests and local development without Firestore.
  - Firestore implementation (`FirestorePersistence`) for real multi-user games:
    - `losiento_games/{gameId}` documents for lobby and active games.
    - `losiento_games/{gameId}/moves/{moveId}` subcollection for move history.
    - Optional `losiento_users/{userId}` documents to track `activeGameId`.
  - Both implementations use the same rules engine API and `clientMovePayload` selection helper.

- **REST API** (`/api/losiento`) implemented in `app/main.py`:
  - Lobby & game lifecycle: host, list joinable games, join, leave, kick, configure seats, start.
  - Gameplay: state, play (human move), bot-step (bot move), and a legal-movers preview.

- **Minimal iframe-friendly frontend** (`frontend/index.html`, `frontend/app.js`, `frontend/style.css`)
  - No framework; served statically by the FastAPI app at `/`.
  - Lobby UI to host or join games.
  - In-game UI:
    - 60-cell track grid with colored pawn markers per seat.
    - Start / Safety / Home summaries per seat.
    - Header showing current turn, current seat, last drawn card, and game result.
    - Buttons for **Play turn**, **Bot step**, and **Leave game**.
    - Minimal move-selection UX:
      - Backend preview endpoint highlights pawns that have at least one legal move for the upcoming card.
      - Clicking a highlighted pawn chooses it as the preferred mover for the next Play.

- **Tests** (`losiento/tests/test_engine_basic.py`)
  - Coverage for deck composition, movement, slides, Safety Zones, Home entry, advanced card behavior, selection, and persistence-level semantics (win condition, card 2 extra draw, deck rebuild).

- **Spec-first design** (`project_spec.md`)
  - Detailed spec for Firestore schema, rules engine, endpoints, and frontend flows.
  - Implementation-status section kept in sync with the actual code.

---

## Quickstart (Local)

This project is designed to run either fully **in-memory** (no Firestore, simplest) or against a **Firestore emulator** for more realistic multi-user flows.

### 1. Create virtualenv and install dependencies

```bash
python -m venv .venv
# Windows PowerShell
. .venv/Scripts/Activate.ps1
# Windows Cmd
.venv\Scripts\activate.bat
# macOS/Linux
source .venv/bin/activate

pip install -r requirements.txt
```

### 2. (Optional) Configure `.env.local` for Firestore emulator

If you want to use the Firestore emulator (rather than the default in-memory persistence), create a `.env.local` file like:

```makefile
# Use Firestore emulator by default
USE_INMEMORY=0
FIRESTORE_EMULATOR_HOST=localhost:8080
GOOGLE_CLOUD_PROJECT=fake-losiento-local
ALLOW_ANON=1
DEFAULT_USER_ID=local-demo
```

- `USE_INMEMORY=1` can be used to force the in-memory persistence (no Firestore).
- `ALLOW_ANON=1` and `DEFAULT_USER_ID` enable anonymous local play via a stub user id.

### 3. Run with in-memory persistence (no emulator)

With no `.env.local` and no special environment variables, the app defaults to `USE_INMEMORY=1` and uses `InMemoryPersistence`. This is the quickest way to try the game locally:

```bash
uvicorn app.main:app --reload
# Then open http://localhost:8001 (or whatever port uvicorn reports)
```

You can also force this mode explicitly:

```bash
# Windows PowerShell
$env:USE_INMEMORY="1"
uvicorn app.main:app --reload
```

### 4. Start the Firestore emulator

Choose one of the options below.

#### Option A: Docker Compose (emulator only)

```bash
docker compose up -d emulator
```

#### Option B: gcloud (run in a separate terminal)

```bash
gcloud beta emulators firestore start --host-port=localhost:8080
```

### 5. Run the Lo Siento server against the emulator

In another terminal (with your virtualenv activated):

```bash
uvicorn app.main:app --reload
# Open http://localhost:8001 or the configured port
```

On startup you will see a log line indicating which persistence is active, for example:

```bash
[losiento] Persistence=FirestorePersistence USE_INMEMORY=0 FIRESTORE_EMULATOR_HOST=localhost:8080 GOOGLE_CLOUD_PROJECT=fake-losiento-local
```

If `USE_INMEMORY=1`, you will see `Persistence=InMemoryPersistence` instead.

### About `.env.local`

`.env.local` is used to store environment variables for local development. It is not committed to the repo and is ignored by Git. This allows you to keep local settings separate from production configuration.

---

## Local Dev with Firestore Emulator

The Lo Siento service can be run standalone, or as part of the unified stack with the main website.

### Option A: Docker Compose (backend + emulator)

If a `docker-compose.yml` is present for Lo Siento, you can typically do:

```bash
docker compose up --build
# Backend at http://localhost:8001, emulator at http://localhost:8080 (or as configured)
```

(See comments in the compose file for the exact ports and image names.)

### Option B: Run Emulator with gcloud locally

1. Install the Google Cloud SDK and components.
2. Start the emulator:

   ```bash
   gcloud beta emulators firestore start --host-port=localhost:8080
   ```

3. In another terminal, run the app pointing at the emulator:

   ```bash
   # Windows PowerShell
   $env:FIRESTORE_EMULATOR_HOST="localhost:8080"
   $env:GOOGLE_CLOUD_PROJECT="fake-losiento-local"
   uvicorn app.main:app --reload
   ```

4. Open the service root in your browser (e.g., `http://localhost:8001`) to load the frontend.

---

## Unified Local Dev with lukelaruecom (Windows)

If you also have the website monorepo checked out as a sibling folder (`../lukelaruecom`), you can run a unified stack that includes:

- The main website
- Login API, chat API
- Firestore emulator
- This Lo Siento service

From `../lukelaruecom`:

```bash
npm install
# Just the Lo Siento backend (uses emulator + in-memory where configured)
npm run dev:losiento:win

# Or the full stack (web + APIs + emulator + Lo Siento)
npm run dev:stack:all:win
```

The full-stack `dev:stack:all:win` command will:

- Start a shared Firestore emulator at `127.0.0.1:8080` (and UI at `127.0.0.1:4001`, depending on config).
- Run the website plus APIs.
- Start the Lo Siento backend on its configured port (e.g., 8001) with environment variables similar to:
  - `USE_INMEMORY=0`
  - `FIRESTORE_EMULATOR_HOST=127.0.0.1:8080`
  - `GOOGLE_CLOUD_PROJECT=demo-firestore`
  - `ALLOW_ANON=1`, `DEFAULT_USER_ID=local-demo`

The unified script auto-creates a local Python virtualenv and installs `requirements.txt` for Lo Siento if needed (mirroring the Minesweeper flow).

The website’s lobby page will load Lo Siento in an iframe from the configured backend URL.

---

## API

Base path: `/api/losiento`

Authentication is stubbed similarly to Minesweeper:

- Supply `X-User-Id` in requests for multi-user scenarios.
- If omitted and `ALLOW_ANON=1`, the backend falls back to `DEFAULT_USER_ID` from the environment.

### Lobby & lifecycle

- `POST /api/losiento/host`
  - Body: `{ "max_seats": 2-4, "display_name"?: string }`
  - Creates a lobby game with the caller as host in seat 0.

- `GET /api/losiento/joinable`
  - Returns joinable lobby games with at least one open human seat.

- `POST /api/losiento/join`
  - Body: `{ "game_id": string, "display_name"?: string }`
  - Joins an existing lobby game.

- `POST /api/losiento/leave`
  - Body: `{ "game_id": string }`
  - Host leaving aborts the game; non-host leaving converts their seat to a bot.

- `POST /api/losiento/kick`
  - Body: `{ "game_id": string, "seat_index": number }`
  - Host-only; converts the target seat to a bot.

- `POST /api/losiento/configure-seat`
  - Body: `{ "game_id": string, "seat_index": number, "is_bot": boolean }`
  - Host-only, lobby-only; toggles seats between human and bot.

- `POST /api/losiento/start`
  - Body: `{ "game_id": string }`
  - Validates player counts and initializes an authoritative `GameState` via the rules engine.

- `GET /api/losiento/state`
  - Looks up the caller’s `activeGameId` and returns the shaped game payload, including the inner `state` for board and turn info.

### Gameplay & bots

- `GET /api/losiento/legal-movers`
  - Query: `?game_id=<id>`
  - Simulates drawing the next card on a copied `GameState`, computes legal moves, and returns:
    - `{ "gameId": string, "pawnIds": string[] }` – the pawns that have at least one legal move for the upcoming card.
  - Does **not** mutate the stored game state; used by the frontend to highlight legal movers.

- `POST /api/losiento/play`
  - Body: `{ "game_id": string, "payload": clientMovePayload }`
  - Draws a card from the real deck, computes legal moves, validates the payload against them, and applies the chosen move.
  - For card `2`, draws and applies an extra move (selection semantics are handled in the backend).

- `POST /api/losiento/bot-step`
  - Query: `?game_id=<id>`
  - If it is a bot’s turn, draws a card and applies a randomly selected legal move (plus extra move for card `2`).

For full details, see `project_spec.md` §4 (HTTP / RPC Endpoints) and §4.4 (`clientMovePayload` schema).

---

## Frontend / UX

The prototype frontend in `frontend/` is intentionally minimal but already supports playing games end-to-end:

- **Lobby screen**
  - Host a game (2–4 seats, display name).
  - Join joinable games from a list.

- **In-game screen**
  - Shows:
    - Track grid (0–59) with pawn markers by seat/color.
    - Start/Safety/Home summaries by seat.
    - Current turn, current seat, last drawn card, and game result.
  - Controls:
    - `Play turn` (human move)
    - `Bot step` (advance bot turns)
    - `Leave game`

- **Move selection UX (prototype)**
  - Before a human turn, the frontend calls `/api/losiento/legal-movers` and highlights pawns that can move for the upcoming card.
  - Clicking a highlighted pawn selects it for the next `Play turn`.
  - `Play turn` sends one of:
    - `payload: { "move": { "pawnId": "..." } }` if the user has selected a pawn.
    - `payload: { "moveIndex": 0 }` if no pawn is selected (fallback).
  - The backend validates this against the real legal moves for the drawn card using `_select_move`. For complex cards (e.g. 7-split) where pawnId alone is ambiguous, the backend may still require a more detailed selection in the future.

Over time, this UI is intended to evolve into a richer move-selection panel that lists all legal moves with human-friendly descriptions.

---

## Testing

Engine and persistence tests live under `losiento/tests/`.

```bash
python -m unittest losiento/tests/test_engine_basic.py
# or simply
python -m unittest
```

These tests primarily use `InMemoryPersistence` and the pure rules engine. Firestore integration is exercised indirectly via manual/local testing and can be extended with integration tests if desired.

---

## Project Structure

- `app/`
  - `main.py` – FastAPI application, endpoint definitions, persistence selection, and static frontend mounting.
- `losiento_game/`
  - `models.py` – dataclasses for cards, pawns, seats, `GameSettings`, and `GameState`.
  - `engine.py` – core rules engine (movement, slides, Safety Zones, card logic, win condition).
  - `persistence.py` – in-memory and Firestore persistence implementations, move selection, and bot logic.
- `frontend/`
  - `index.html` – static HTML shell for the iframe UI.
  - `app.js` – lobby and in-game UI logic, API calls, and minimal move-selection behavior.
  - `style.css` – styles for the game board, lobby, and HUD.
- `tests/`
  - `test_engine_basic.py` – unit tests for the rules engine, move selection, and in-memory persistence behaviors.
- `project_spec.md`
  - Detailed specification and implementation status for Lo Siento.
- `rules.md`
  - Authoritative description of the Lo Siento/Sorry! rules.

For deeper architectural details and remaining TODOs, see `project_spec.md` §12 (Implementation Status and Next Steps).
