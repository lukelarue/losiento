# Lo Siento – Project Specification

This document specifies the implementation plan for **Lo Siento**, an online, iframe-embedded adaptation of the board game *Sorry!* using a Python backend and Firestore-based realtime synchronization.

Authoritative game rules are defined in `rules.md` and must remain the single source of truth.

---

## 1. Scope and Goals

- **Goal:** Implement a multiplayer Lo Siento game that:
  - Runs in an iframe on the main site (similar to Minesweeper).
  - Uses a **server-authoritative Python backend**.
  - Uses **Firestore** to broadcast authoritative game state and record moves.
  - Supports **2–4 players**, any mix of humans and bots (at least 1 human).
  - Allows players to leave and rejoin mid-game, with bots taking over when humans leave.
  - Enforces all rules described in `rules.md` and provides adequate tests.


---

## 2. High-Level Architecture

- **Frontend**
  - Static web app served from the `losiento` project (mirroring Minesweeper approach).
  - Embedded in the main site via `<iframe>`.
  - Uses Firestore client SDK to subscribe to game/lobby documents.
  - Uses simple JS/TS state management to:
    - Display lobby (Host/Join views).
    - Display joinable games list.
    - Display in-game board and controls.

- **Backend (Python)**
  - Server-authoritative rules and state transitions.
  - Exposes HTTP endpoints (or Cloud Functions) for:
    - Hosting/joining/starting games.
    - Leaving and kicking players.
    - Submitting moves.
    - Triggering bot moves.
  - Reads/writes game documents and move documents in Firestore.

- **Firestore**
  - Stores:
    - Game documents (lobbies and active games).
    - Per-game moves history.
    - Optional per-user mapping to enforce "one active game at a time".
  - Used as the broadcast channel for current game state.

---

## 3. Firestore Data Model

### 3.1 Collections Overview

- `losiento_games/{gameId}` (main game document)
- `losiento_games/{gameId}/moves/{moveId}` (subcollection)
- Optional: `losiento_users/{userId}` to store `activeGameId` for quick lookup.

### 3.2 Game Document Structure (`losiento_games/{gameId}`)

**Core fields**

- `gameId: string` – document ID (random or short code).
- `hostId: string` – user id of host.
- `hostName: string` – display name of host.
- `createdAt: timestamp`.
- `updatedAt: timestamp`.
- `phase: "lobby" | "active" | "finished" | "aborted"`.
- `settings: { ... }`:
  - `maxSeats: number` – 2–4.
  - `deckSeed: string` or `number` – optional deterministic seed for deck shuffling.

**Seats / players**

- `seats: Array<Seat>` where each `Seat` is:
  - `index: number` – 0..3.
  - `color: string` – e.g. "red", "blue", "yellow", "green".
  - `isBot: boolean`.
  - `playerId: string | null` – Firestore auth uid or internal user id.
  - `displayName: string | null`.
  - `status: "open" | "joined" | "bot"`.

Constraints:

- Exactly `settings.maxSeats` seats are defined (2–4).
- At least one seat at any time must have `isBot == false` and `playerId != null` (for at least 1 human) when starting.

**Authoritative game state** (only used during `phase == "active"` or beyond):

- `state: { ... }`:
  - `turnNumber: number` – increments each completed turn.
  - `currentSeatIndex: number` – whose turn it is.
  - `deck: string[]` – remaining cards (e.g. ["1", "2", "4", ...]).
  - `discardPile: string[]` – cards already used.
  - `board: BoardState` – all pawn positions.
  - `lastMove: { ... } | null` – optional move summary for UI (e.g. which pawn moved from A to B, card, bumps, slides). **Note:** this field is not yet implemented in the current backend; the prototype UI instead infers recent moves from `discardPile` and the evolving `board` state.
  - `winnerSeatIndex: number | null`.
  - `result: "active" | "win" | "aborted"`.

**BoardState suggestion**

- `board: { pawns: Pawn[] }` where each `Pawn`:
  - `pawnId: string` – unique id per pawn.
  - `seatIndex: number` – owner seat.
  - `position: { type: "start" | "track" | "safety" | "home"; index?: number }`:
    - `type == "start"` – pawn still in Start.
    - `type == "track"` – `index` is board track index.
    - `type == "safety"` – `index` is offset into that seat's Safety Zone.
    - `type == "home"` – pawn is in Home.

**Game completion**

- `endedAt: timestamp | null`.
- `abortedReason: string | null` – e.g. "host_left".

### 3.3 Moves Subcollection (`losiento_games/{gameId}/moves/{moveId}`)

Each move doc is **append-only** and reflects a validated server-side move.

Fields:

- `index: number` – 0, 1, 2, ... (turn index to preserve order).
- `seatIndex: number` – whose turn it was.
- `playerId: string | null` – human id if applicable; null if bot.
- `card: string` – e.g. "1", "2", "7", "Sorry!".
- `moveData: { ... }` – details sufficient to reconstruct:
  - `pawnId` / `pawnIds` used.
  - `fromPosition(s)`.
  - `toPosition(s)`.
  - Any split for a 7.
  - Whether a bump occurred and which pawn was bumped.
  - Whether any slide(s) occurred.
- `resultingStateHash: string` – hash of resulting `state` (for debugging/verification).
- `createdAt: timestamp`.

### 3.4 Users Collection (Optional Convenience)

`losiento_users/{userId}`:

- `activeGameId: string | null` – the game a user is currently in.
- Possibly `displayName` and other metadata reused in seats.

This simplifies enforcing "one active game at a time".

---

## 4. Backend (Python) Design

### 4.1 Rules Engine

Implement a pure, deterministic rules engine module, e.g. `engine.py`:

- Core types:
  - `GameState`, `BoardState`, `Pawn`, `Card`, `Seat`, etc.
- Pure functions:
  - `initialize_game(settings, seats, deckSeed) -> GameState`.
  - `draw_card(state) -> (stateWithCard, card)`.
  - `get_legal_moves(state, seatIndex, card) -> List<Move>`.
  - `apply_move(state, move) -> GameState`.
  - `check_winner(state) -> Optional[seatIndex]`.

Requirements:

- Implement all rules from `rules.md`:
  - 4 pawns per player.
  - 1/2/Sorry! to leave Start.
  - Exact count required to enter Home.
  - Slides allowed on any color.
  - Special "slide into Safety Zone" rule when landing on slide start before Safety Zone.
  - Safety Zones rules.
  - All card-specific behaviors (2 extra draw, 7 split, 10 forward/back, 11 switch, Sorry! limitations, etc.).
- Return full before/after positions needed for move logging and UI.

### 4.2 HTTP / RPC Endpoints

The actual FastAPI service exposes JSON endpoints under `API_BASE = "/api/losiento"`. The
backend derives `userId` from request headers (IAP / forwarded / `X-User-Id`) rather than
from the JSON body; the bodies below omit `userId` for that reason.

- `POST /api/losiento/host`
  - Body: `{ max_seats, display_name? }`.
  - Behavior:
    - Ensure caller has no active game.
    - Create `losiento_games/{gameId}` in `lobby` phase with seats configured (host in seat 0).
    - Set `activeGameId` for the host user.

- `GET /api/losiento/joinable`
  - Behavior:
    - List lobby games with at least one open human seat.
    - Returns `{ games: [{ gameId, hostName, currentPlayers, maxSeats }, ...] }`.

- `POST /api/losiento/join`
  - Body: `{ game_id, display_name? }`.
  - Behavior:
    - Ensure caller has no other active game.
    - Ensure target game is in `lobby` and has an open human seat.
    - Claim a seat, update `seats` / `updatedAt`, set caller’s `activeGameId`.

- `POST /api/losiento/leave`
  - Body: `{ game_id }`.
  - Behavior:
    - If caller is host:
      - Mark game as `aborted` (if `active`) or otherwise terminate the lobby.
      - Clear `activeGameId` for all players in that game.
    - If caller is non-host:
      - Convert their seat to `isBot = true`, `playerId = null`, `status = "bot"`.
      - Clear their `activeGameId`.

- `POST /api/losiento/kick`
  - Body: `{ game_id, seat_index }`.
  - Behavior:
    - Verify caller is host.
    - For lobby or active game:
      - Convert target seat to `isBot = true`, `playerId = null`, `status = "bot"`.
      - Clear kicked user’s `activeGameId`.

- `POST /api/losiento/configure-seat`
  - Body: `{ game_id, seat_index, is_bot }` (allowed only in `lobby`).
  - Behavior:
    - Host toggles seat between bot/human (respecting at least 1 human total and 2+ total players before start).

- `POST /api/losiento/start`
  - Body: `{ game_id }`.
  - Behavior:
    - Validate `phase == "lobby"` and there are at least 2 total seats occupied (human or bot) and at least 1 human.
    - Initialize `state` using rules engine and shuffled deck.
    - Set `phase = "active"`.

- `GET /api/losiento/state`
  - Behavior:
    - Look up caller’s `activeGameId` in `losiento_users/{userId}`.
    - If none, return **204 No Content** (no response body) to indicate that the caller currently has no active game.
    - Otherwise, return **200 OK** with the current game shaped via `to_client` (including `state` inner payload for board and turn info).

- `GET /api/losiento/legal-movers`
  - Query: `?game_id=<id>`.
  - Behavior:
    - Ensure the caller is a player in the specified game, the game `phase == "active"`, `state.result == "active"`, and it is the caller’s turn.
    - Reconstruct a `GameState` (in-memory or from Firestore), make a **copy** of it, and simulate drawing the next card on the copy using `_draw_card`.
    - Use the rules engine `get_legal_moves` to compute legal moves for the caller’s seat and that card.
    - Return `{ gameId, card, pawnIds, moves }` where:
      - `card` is the actual upcoming card that will be drawn for this seat.
      - `pawnIds` is the set of `pawnId`s that have at least one legal move for that card.
      - `moves` is an array of legal-move descriptors shaped like the `clientMovePayload.move` fields plus an `index` field, e.g. `{ index, pawnId, targetPawnId, secondaryPawnId, direction, steps, secondaryDirection, secondarySteps }`.
    - This endpoint is **advisory** and does not mutate the stored game state; it exists to help the frontend highlight pawns that can move and to present concrete move options (including 7-split, 11 switch, and Sorry! targets) before the player commits a `/play`.

- `POST /api/losiento/play`
  - Body: `{ game_id, payload }` where `payload` is the `clientMovePayload`.
  - Behavior:
    - Load game doc for `game_id` and ensure caller is a player in that game.
    - Verify `phase == "active"`, it is the caller’s turn, and the seat is not bot.
    - Draw a card from the authoritative deck; derive legal moves via rules engine.
    - Validate `payload` against legal moves using the shared move-selection helper:
      - Supports `payload.moveIndex` or a structured `payload.move` descriptor.
      - If multiple legal moves exist and payload is missing or ambiguous, reject the request.
    - Apply the chosen move using the rules engine; for card `2`, draw and apply an extra move.
    - Append a move doc under `losiento_games/{gameId}/moves` (Firestore implementation).
    - Update `state` in the game document, including `turnNumber`, `currentSeatIndex`, `deck`, `discardPile`, `board`, `winnerSeatIndex`, `result`.

- `POST /api/losiento/bot-step`
  - Query: `?game_id=<id>`.
  - Behavior:
    - If game `phase != "active"`, return.
    - Ensure `currentSeatIndex` is a bot seat and enough time has elapsed since last update.
    - Draw a card, compute legal moves via rules engine, randomly select a move, and apply it.
    - For card `2`, draw and apply an extra move chosen randomly from legal options.
    - Update `state` and append a move doc (Firestore implementation).

### 4.3 Concurrency and Transactions

- Use Firestore transactions or retries to handle concurrent writes:
  - When applying moves, always re-read latest game doc, verify `phase` and `currentSeatIndex`, then update.
  - Reject stale or double-submitted moves.

---

### 4.4 `clientMovePayload` Schema

Human moves are specified using a `clientMovePayload` object, passed as `payload` in
`POST /api/losiento/play`. This payload is **not** trusted; the backend always
derives legal moves from the rules engine and then uses the payload only to
choose **which** legal move to apply.

The helper `_select_move(moves, payload)` implements this selection logic and
is used by both `InMemoryPersistence` and `FirestorePersistence`.

Shape:

```jsonc
{
  "moveIndex": 0,              // optional, integer index into legal moves
  "move": {                    // optional, structured descriptor
    "pawnId": "...",         // string
    "targetPawnId": "...",   // string or null
    "secondaryPawnId": "...",// string or null (for 7-split)
    "direction": "forward",  // "forward" | "backward" | null
    "steps": 7,               // integer or null
    "secondaryDirection": "forward", // for 7-split
    "secondarySteps": 3       // integer or null
  }
}
```

Selection rules:

- If there are **no** legal moves, the backend rejects the request
  (`no_legal_moves`).
- If `payload` is missing/empty and there is **exactly one** legal move, that
  move is applied.
- If `moveIndex` is a valid integer within the legal-move list, that move is
  chosen.
- Otherwise, if `move` is provided, the backend:
  - Starts with the full list of legal moves.
  - Filters by each present field (`pawnId`, `targetPawnId`, etc.), keeping
    only moves whose corresponding `Move` attributes match exactly.
  - If exactly one candidate remains, that move is applied.
  - If no candidates remain, the request is rejected as
    `invalid_move_selection_no_match`.
  - If multiple candidates remain, the request is rejected as
    `invalid_move_selection_ambiguous`.
- If none of the above apply and there is more than one legal move, the request
  is rejected as `move_selection_required`.

This ensures that:

- Clients can use the **simple index** form during early development or when
  they have the legal-move list available.
- More advanced clients can use a **structured descriptor** that is robust
  across different internal move orderings.

Examples:

- **Simple numeric move (card 3)**

  Legal moves from the engine might include:

  ```jsonc
  [
    { "pawn_id": "p0", "direction": "forward", "steps": 3, ... },
    { "pawn_id": "p1", "direction": "forward", "steps": 3, ... }
  ]
  ```

  The client may choose either:

  ```json
  { "moveIndex": 0 }
  ```

  or

  ```json
  { "move": { "pawnId": "p1", "direction": "forward", "steps": 3 } }
  ```

- **7-split**

  A 7-split move is encoded in the engine `Move` as:

  ```jsonc
  {
    "card": "7",
    "seat_index": 0,
    "pawn_id": "pA",
    "direction": "forward",
    "steps": 4,
    "secondary_pawn_id": "pB",
    "secondary_direction": "forward",
    "secondary_steps": 3
  }
  ```

  The client can select this move via:

  ```json
  {
    "move": {
      "pawnId": "pA",
      "secondaryPawnId": "pB",
      "direction": "forward",
      "steps": 4,
      "secondaryDirection": "forward",
      "secondarySteps": 3
    }
  }
  ```

- **11-switch**

  For a switch move, the engine `Move` will have `card = "11"` and
  `target_pawn_id` set to the opponent pawn to swap with. The client can select
  that move with:

  ```json
  { "move": { "pawnId": "myPawnId", "targetPawnId": "opponentPawnId" } }
  ```

- **Sorry!**

  For a Sorry! move, the engine `Move` will have `card = "Sorry!"`,
  `pawn_id` set to the pawn leaving Start, and `target_pawn_id` set to the
  opponent pawn being bumped. The client can select a particular target via:

  ```json
  { "move": { "pawnId": "myStartPawnId", "targetPawnId": "targetPawnId" } }
  ```

Note: the current prototype UI uses the simple `"moveIndex": 0` form for
human moves; a future, richer UI can use the structured `move` descriptors to
allow explicit user choice when multiple legal moves exist.

---

## 5. Frontend / UX Flows

### 5.1 Entry Point

- When user navigates to the Lo Siento iframe:
  - Call backend/Firestore to determine if user has `activeGameId`.
  - If yes, **auto-join** that game and show in-game UI.
  - If no, show **Lobby screen**:
    - Buttons: **Host a Game**, **Join a Game**.

### 5.2 Host a Game Screen

- Form:
  - `Number of players (seats)` – 2–4.
  - For each seat: toggle between **Human** and **Bot** (must keep at least 1 human overall).
- After creation:
  - Show lobby view for that game:
    - Host name.
    - List of seats with status (open/joined/bot).
    - For each human seat: show player name or "Waiting for player".
    - Host controls:
      - Add/remove bots (only in lobby).
      - Kick players.
      - Start game button (enabled when >=2 total players and at least 1 human).

### 5.3 Join Game Screen

- Shows scrollable list of joinable games (`phase == "lobby"`):
  - For each game:
    - Host name or game label.
    - `currentPlayers / maxSeats` (humans + bots).
    - Simple status indicator.
  - "Join" button for games with at least one open human seat.
- On join success:
  - User moves to that game's lobby view.

### 5.4 In-Game Screen

- Show:
  - A basic **visual board** with pawns for all seats (not just a raw JSON dump of game state).
    - Slide spaces on the outer track are rendered with a subtle blue background.
    - The **start** of each slide is marked with an `X`, the **end** with an open `O`, and the spaces in between show arrow glyphs (`→`, `↓`, `←`, `↑`) pointing in the slide direction.
    - The square directly outside each Start (Start exit) and the square where that color enters its Safety Zone (Safe entry) are both visually highlighted, matching the in-game legend.
    - A small **Legend** panel explains these markings (blue background = slide, X = start, O = end, arrows = slide direction, green ring = Safety entry, yellow ring = Start exit).
  - Indicator of current player turn and drawn card.
  - Whenever the top of the discard pile (last drawn card) changes, display a small popup/overlay in the UI with a short human-readable description of that card.
  - Simple move UI:
    - Highlight selected pawn and possible destinations.
    - For complex cards (7 split, 11 switch, Sorry!), display simple choices.
- Controls:
  - **Leave game** button for non-hosts (triggers `leave_game`).
  - **Kick player** and basic seat info for host.
- When host leaves:
  - Game immediately transitions to `aborted` and frontend sends players back to lobby entry screen.

---

## 6. Bot Behavior

- Bots are represented as seats with `isBot = true` and `playerId = null`.
- When a human leaves or is kicked:
  - Backend converts their seat to bot and the game continues.
- Rejoining behavior:
  - When a user with `activeGameId` opens Lo Siento:
    - If their previous seat was turned into a bot in that game and game is still `active`, backend should:
      - Re-associate that seat with the returning user (clear `isBot`, set `playerId`, `displayName`).
- Turn handling:
  - When `currentSeatIndex` is bot:
    - After ~1 second (enforced on backend via timestamp comparison), backend picks a random legal move and applies it.

---

## 7. Security and Invariants

- **Single active game per user**
  - Maintain `activeGameId` in `losiento_users/{userId}`.
  - Backend must ensure:
    - A user cannot host or join if `activeGameId` is non-null.

- **Move authorization**
  - Firestore security rules and backend checks must ensure:
    - Only backend functions modify `state` and `moves` (clients never write `state` directly).
    - Only the current seat's player can submit a move for that seat.

- **Game invariants**
  - `state.board` and `state.deck` must always reflect a legal position according to rules engine.
  - When `result != "active"`, no further moves are accepted.

---

## 8. Testing Plan

All rules in `rules.md` must be covered by automated tests.

### 8.1 Rules Engine Unit Tests

- **Deck & drawing**
  - Deck has 45 cards with correct counts.
  - Drawing through entire deck works; 2 grants extra draw.

- **Movement basics**
  - 1/2/Sorry! leave Start behavior.
  - Standard forward/back moves for 3,4,5,8,10,11,12.
  - 10 backward when 10-forward is impossible.

- **7 card**
  - Single-pawn 7 forward.
  - Split 7 across two pawns.
  - Enforcing full use of 7 spaces.
  - 7 cannot leave Start and cannot move backwards.

- **11 card**
  - Forward 11.
  - Switch with opponent pawn.
  - Cannot switch with pawns in Safety Zone.
  - Cannot leave Start.

- **Sorry! card**
  - From Start to opponent pawn, bumping correctly.
  - Cannot target Safety Zone or Home pawns.
  - No pawns in Start or no legal targets → no move.

- **Bumping & self-bump prohibition**
  - Landing on opponent bumps them to Start.
  - Moves that would land on own pawn are rejected if no alternative move exists.

- **Slides**
  - Sliding when landing on slide start.
  - House rule: sliding on own color works.
  - All pawns on slide path are sent to their Start, including sliding player.
  - Special slide-into-Safety-Zone rule.
  - Interactions with card `Sorry!` when the landing space is another color's slide start (slide still applies and bumps all pawns along the slide).

- **Safety Zones and Home**
  - Only own pawns can enter Safety Zone.
  - Pawns in Safety Zones cannot be bumped, switched, or targeted by Sorry!.
  - Forced backward out of Safety Zone makes pawn vulnerable again.
  - Exact-count Home entry; overshoot is illegal.

- **Win condition**
  - Game ends when a player’s 4th pawn reaches Home.
  - No ties (ensure simultaneous win is impossible in state transitions).

### 8.2 Backend Integration Tests

- Host/join/start flows:
  - Host creates game, players join, host starts game.
  - Enforce 2–4 seats and at least 1 human.

- Single active game invariant:
  - Attempting to host/join while already in a game fails.
  - Leaving clears `activeGameId`.

- Leaving, kicking, and host abort:
  - Non-host leave → seat becomes bot, game continues.
  - Host leave → game is aborted, players return to lobby state.
  - Kicking player → seat becomes bot and kicked user’s `activeGameId` cleared.

- Rejoin behavior:
  - Player leaves, bot takes over seat.
  - Player revisits Lo Siento while game still active → seat re-bound to player, bot disabled.

- Bot moves:
  - When `currentSeatIndex` is bot, backend picks random legal move and applies after approximate delay.

- Firestore updates:
  - Each accepted move appends a move doc and updates `state` atomically.

---

## 9. Implementation Tasks Checklist

1. **Project setup**
   - Mirror Minesweeper’s folder and deployment structure under `losiento`.
   - Add Python backend skeleton with dependencies (Firestore client, web framework, etc.).
   - Configure static frontend hosting for Lo Siento iframe.

2. **Firestore schema and rules**
   - Create `losiento_games` and `losiento_users` collections.
   - Implement security rules to restrict who can read/write what.

3. **Rules engine (Python)**
   - Implement data structures and pure functions in `engine.py`.
   - Add unit tests covering all rules in `rules.md`.

4. **Backend endpoints**
   - Implement `host_game`, `join_game`, `leave_game`, `kick_player`, `configure_seat`, `start_game`, `play_move`, `bot_step`.
   - Add integration tests for core flows.

5. **Frontend lobby UI**
   - Implement entry screen (Host/Join).
   - Implement Host Game screen with seat configuration.
   - Implement Join Game list and join flow.

6. **Frontend in-game UI**
   - Implement a basic visual board representation with pawns for all seats, not just a raw JSON dump of game state.
   - Implement move selection UX including complex cards.
   - Wire Firestore listeners to re-render based on `losiento_games/{gameId}`.

7. **Bot integration**
   - Implement backend-side bot move selection using rules engine.
   - Implement 1s delay and ensure bots trigger when needed.

8. **Polish and validation**
   - Ensure rejoin flows work correctly for humans.
   - Validate that all rule/invariant tests pass.
   - Verify iframe embedding behavior and navigation back to lobby.

---

## 10. Deployment (Terraform + Cloud Run)

Lo Siento should follow the same general deployment approach as Minesweeper: a Python backend running on **Cloud Run**, provisioned/configured via **Terraform**, and reachable from the main site.

### 10.1 Cloud Run Service

- Create a dedicated Cloud Run service, e.g. `losiento-api`.
- Image built from the `losiento` backend Dockerfile.
- Key configuration (mirroring Minesweeper where reasonable):
  - Region and project set via standard Terraform variables.
  - Appropriate concurrency and CPU/memory settings.
  - Environment variables:
    - `GOOGLE_CLOUD_PROJECT`
    - Firestore/credentials-related envs used by the Python client.
    - Any feature flags needed for Lo Siento (e.g. `ALLOW_ANON`, `DEFAULT_USER_ID` if you mirror local/demo behavior).
  - Ingress and authentication handled consistently with Minesweeper (e.g. internal behind a gateway or public with auth in the platform layer).

### 10.2 Terraform Modules and State

- Add a Terraform module or resource set for Lo Siento alongside Minesweeper:
  - `google_cloud_run_service.losiento_api` for the service.
  - IAM bindings (service account invoker roles, etc.).
- Reuse the existing pattern where **Terraform ignores the container image digest** so CI can deploy new revisions (same approach as Minesweeper’s Cloud Run deployment):
  - Use `lifecycle { ignore_changes = [template[0].spec[0].containers[0].image] }` or the equivalent pattern already used for Minesweeper.
- Optionally share service accounts, logging/monitoring configuration, and Firestore project setup with Minesweeper, assuming same GCP project.

### 10.3 CI/CD

- Extend the existing CI/CD pipeline that builds and deploys Minesweeper to also:
  - Build the `losiento` backend image.
  - Push to the container registry (Artifact Registry or GCR).
  - Update the Cloud Run service (using pinned image digests if that’s your existing pattern).
- Ensure Terraform plans remain clean regarding image digests (only infrastructure drift, not image updates).

### 10.4 Frontend Hosting

- Serve the Lo Siento frontend using the same mechanism as Minesweeper:
  - Either static hosting (e.g. under an existing web app) or via the main React app’s routes.
  - The `losiento` iframe in the main site points at the frontend URL, which in turn calls the Lo Siento backend (Cloud Run) via the platform’s APIs.

---

## 11. Local Development and NPM Integration

Lo Siento should be runnable locally alongside the existing stack (`lukelaruecom` repo) so that `npm run dev:stack:all:win` can bring up:

- Firestore emulator
- Login API
- Chat API
- Minesweeper backend
- Lo Siento backend
- Frontend

### 11.1 Local Backend Command (Windows)

Plan to add a new NPM script in `lukelaruecom/package.json` for running the Lo Siento backend in development, conceptually similar to `dev:minesweeper:win`. For example:

- `dev:losiento:win`
  - Powershell command that:
    - `Set-Location` into the `losiento` project directory.
    - Ensures a local virtualenv exists (e.g. `.venv`), installs backend requirements from `requirements.txt` if needed.
    - Exports environment variables pointing at the Firestore emulator and GCP project id used for local dev (e.g. `FIRESTORE_EMULATOR_HOST='127.0.0.1:8080'`, `GOOGLE_CLOUD_PROJECT='demo-firestore'`).
    - Starts the Python server via `uvicorn` (e.g. `app.main:app`) on a dedicated port (for example `8001`), leaving Minesweeper on `8000`.

Implementation details will mirror the existing `dev:minesweeper:win` script structure to keep local setup consistent.

### 11.2 Integrating with `dev:stack:all:win`

In `lukelaruecom/package.json` there is currently a `dev:stack:all:win` script that starts:

- Firestore emulator
- Login API
- Chat API
- Minesweeper backend (`dev:minesweeper:win`)
- Frontend (via `dev:stack:all:win:web`)

Plan to:

1. Add `dev:losiento:win` as described above.
2. Update `dev:stack:all:win` to run `dev:losiento:win` in parallel with the existing commands (using the same `npm-run-all` pattern).
3. Ensure any `wait-on` dependencies (ports) are updated if needed so the frontend can safely assume Lo Siento’s backend is available.

### 11.3 Local Frontend Behavior

- When running the full stack locally:
  - The main site (apps/web) should expose a Lo Siento page that embeds the Lo Siento iframe or otherwise routes to the Lo Siento frontend.
  - The Lo Siento frontend should be configured (e.g. via environment variables or config file) to call the Lo Siento backend on its local dev port.
- Ensure the Firestore emulator configuration for Lo Siento matches the rest of the stack (same project id, emulator host, etc.).

---

## 12. Implementation Status (WIP)

This section tracks the current implementation status against the spec.

- **Backend skeleton (Python FastAPI service)**
  - **Status:** Completed (initial)
  - Notes:
    - `app/main.py` created with FastAPI app, CORS, user-id extraction, and endpoints for host/join/leave/kick/configure-seat/start/state/play_move/bot_step.
    - Static frontend mount is wired to `losiento/frontend` if present.

- **Game models & deck**
  - **Status:** Completed (initial)
  - Notes:
    - `losiento_game/models.py` defines `Card`, `PawnPosition`, `Pawn`, `Seat`, `GameSettings`, `GameState`, and `game_state_to_dict` consistent with the spec.
    - `losiento_game/engine.py` implements deck construction and shuffling with the correct 45-card composition.
    - `InMemoryPersistence._ensure_deck` and the Firestore equivalent rebuild the deck when it is exhausted (using the configured seed when present) and clear the `discard_pile` before drawing further cards.

- **Board geometry (outer track, slides, Safety Zones)**
  - **Status:** Completed (geometry wired into code)
  - Notes:
    - `rules.md` documents the per-color track segment pattern and safe-zone entry (section 5.7).
    - `losiento_game/engine.py` defines constants for track length, segment layout, slide positions, and safe-zone entry indices derived from those rules.

- **Rules engine: movement & cards**
  - **Status:** Implemented (initial; frontend move-selection UI pending)
  - Notes:
    - Core movement, bumping, slides, Safety Zones, Home entry, and basic card behavior are implemented in pure engine functions `get_legal_moves` and `apply_move` in `losiento_game/engine.py`.
    - `InMemoryPersistence.play_move(...)` and `bot_step(...)` now use this engine API: draw a card, enumerate legal moves, and apply the first legal move (matching the previous heuristic).
    - Advanced card behaviors are partially implemented:
      - Card `7` now supports both a single 7-step forward move and splitting the 7 spaces across **two pawns**, enforcing that all 7 spaces are used in total and that both portions move **forward only**. The rules engine encodes split moves explicitly in the `Move` structure so they can be surfaced to clients.
      - Card `11` supports both the "move 11 spaces forward" behavior **and** a basic "switch with an opponent pawn" behavior when both pawns are on the track; some nuances such as slide interactions after a switch remain simplified.
      - `Sorry!` moves from Start to opponent pawns on the track and bumps them; some edge cases (e.g., full validation of all legal targets and move choice) are simplified.
    - **Completed work – pure rules engine API (ls-10):**
      - Movement and card-resolution logic has been extracted into pure helpers and `get_legal_moves` / `apply_move` in `losiento_game/engine.py`.
      - `get_legal_moves(state, seat_index, card)` enumerates legal moves without mutating state.
      - `apply_move(state, move)` applies a chosen move and returns a new `GameState`.
      - `InMemoryPersistence.play_move` / `bot_step` are wired to call this engine API instead of their own movement logic.
    - **Remaining work – frontend move-selection UI (ls-11 follow-up):**
      - Advanced card behaviors (7-split, 11-switch with track-only targets, Sorry! targeting with slide interactions) are implemented and covered by tests in the rules engine and persistence layers.
      - The backend validates `clientMovePayload` against `get_legal_moves` using `_select_move` and the schema is documented (section 4.4); bots already choose a random legal move from `get_legal_moves`.
      - Remaining selection work is frontend-only: surfacing legal-move options to humans and allowing them to send a structured `payload.move` instead of always defaulting to `{ moveIndex: 0 }`.

- **In-memory persistence & gameplay**
  - **Status:** Implemented (initial gameplay)
  - Notes:
    - `InMemoryPersistence` in `losiento_game/persistence.py` supports:
      - Hosting games, listing joinable games, joining, leaving, kicking, configuring seats, and starting games.
      - Enforces one active game per user and the lobby constraints (2–4 seats, at least 1 human to start).
      - Stores a `GameState` object for active games.
    - `play_move(...)`:
      - Draws from an authoritative deck, uses the rules engine (`get_legal_moves` / `apply_move`) to apply card behavior, and advances the turn.
      - Enforces basic turn ownership (`not_your_turn`, `not_in_game`) and game lifecycle (`game_not_started`, `game_over`).
      - Implements card `2` extra-draw behavior.
      - Uses a shared move-selection helper that interprets a `clientMovePayload` provided in the HTTP body:
        - Supports `payload.moveIndex` (0-based) to pick a specific move out of the legal moves list.
        - Also supports `payload.move` as a structured descriptor (e.g. `{ pawnId, targetPawnId, secondaryPawnId, direction, steps, secondaryDirection, secondarySteps }`) which is matched against fields of the engine `Move` objects.
        - If there is **exactly one** legal move, the payload may be omitted and that move is applied.
        - If there are **multiple** legal moves and the payload is missing or does not uniquely match any legal move, `play_move` raises a validation error (e.g. `move_selection_required`, `invalid_move_selection_*`).
    - `bot_step(...)`:
      - Verifies it is a bot’s turn and then draws and applies a card for that bot via the same rules engine API.
      - Implements card `2` extra-draw behavior for bots as well.
      - Bots choose a random legal move from those returned by `get_legal_moves` (for the main card and for the extra draw on a 2).

 - **Firestore-backed persistence**
  - **Status:** Implemented (lobby + start + seat management + per-turn gameplay + moves logging + concurrency)
  - Notes:
    - `FirestorePersistence` in `losiento_game/persistence.py` now implements lobby, game-start, seat/player management, and per-turn gameplay operations against `losiento_games` / `losiento_users`:
      - `host_game` – creates a lobby game document with configured seats, sets `activeGameId` for the host.
      - `list_joinable_games` – lists lobby games with at least one open human seat.
      - `join_game` – joins a lobby game, claims an open human seat, and sets `activeGameId` for the user.
      - `get_active_game_for_user` – reads `activeGameId` from `losiento_users/{userId}` and returns the corresponding game document.
      - `start_game` – validates host and player counts, initializes a `GameState` via the rules engine, and persists its serialized `state` payload into the Firestore game document while transitioning `phase` to `"active"`.
      - `leave_game` – handles host and non-host leave according to the spec (host aborts the game and clears all `activeGameId`s; non-host converts their seat to a bot and clears their own `activeGameId`).
      - `kick_player` – host-only, converts the target seat to a bot and clears the kicked user’s `activeGameId`.
      - `configure_seat` – host-only in lobby, toggles seats between bot and human, clearing `activeGameId` when converting a human seat to a bot.
      - `play_move` – applies human moves using the rules engine and serialized `GameState` stored in the Firestore document, including card draws (with card `2` extra-draw) and the same `clientMovePayload`-based selection semantics as the in-memory implementation (`moveIndex` or a structured `move` descriptor, with selection required when multiple moves exist).
      - `bot_step` – applies bot turns using the rules engine with random legal move selection and card `2` extra-draw semantics, mirroring the in-memory implementation.
      - `to_client` – shapes a Firestore game document into the client-facing JSON payload.
    - Firestore-backed **concurrency** is implemented:
      - `FirestorePersistence.play_move` and `bot_step` run inside Firestore transactions so that state updates and move logging are applied atomically and stale or concurrent updates are rejected.

- **Frontend & iframe integration**
  - **Status:** In progress (prototype)
  - Notes:
    - A minimal static frontend now exists under `losiento/frontend` (`index.html`, `style.css`, `app.js`) and is served by the backend root route when present.
    - The prototype implements:
      - A lobby screen to host or join games via the existing `/api/losiento/host`, `/join`, `/joinable`, `/leave`, and `/start` endpoints.
      - An in-game screen with a **basic visual board**: a 60-cell track grid with colored pawn markers per seat, plus simple Start / Safety / Home summaries per color.
      - The in-game header displays the current turn, current seat, and the last drawn card (from the discard pile), and the Start/Safety summaries visually highlight the current seat.
      - Simple controls for `Play turn`, `Bot step`, and `Leave game`.
      - A **minimal move-selection UX**:
        - Clicking on a pawn dot on the track highlights it and stores its `pawnId` as the preferred pawn for the next human move.
        - When `Play turn` is pressed, the frontend sends either:
          - `payload: { move: { pawnId } }` if a pawn has been selected, or
          - `payload: { moveIndex: 0 }` if no pawn has been selected.
        - The backend uses `_select_move` to match this payload against the legal moves for the drawn card. Because the backend does not yet expose the full legal-move list to the client, this UI is a **heuristic**: it works well when pawnId alone uniquely identifies the intended move, but for complex cards with multiple options (e.g. 7-split) the selection may still be ambiguous or rejected. A richer move-selection UI (with explicit per-move choices) remains future work.
    - apps/web has not yet been updated to expose a Lo Siento route/page or iframe.
    - The first in-game UI requirement (a basic visual board-and-pawns view, not just JSON) is now satisfied at prototype level; further work is needed for richer UX and explicit move selection when multiple moves exist.

- **Terraform / Cloud Run deployment**
  - **Status:** Not started
  - Notes:
    - No `google_cloud_run_service` for Lo Siento has been added to `lukelaruecom/infra/cloud_run.tf` yet.
    - Dockerfile for Lo Siento exists and is suitable for building a Cloud Run image.

- **Local dev / npm integration**
  - **Status:** Completed (initial wiring)
  - Notes:
    - `lukelaruecom/package.json` now includes:
      - `dev:losiento:win` script to run the Lo Siento backend (port 8001) using a local virtualenv and Firestore emulator.
      - `dev:stack:all:win:web` updated to wait on the Lo Siento backend port.
      - `dev:stack:all:win` updated to run `dev:losiento:win` alongside the rest of the stack.

### 12.1 Near-term next steps (backend rules – Option A)

1. **Extract pure rules engine API (COMPLETED – ls-10)**
   - `get_legal_moves` and `apply_move` are implemented in `losiento_game/engine.py` and `InMemoryPersistence.play_move` / `bot_step` are wired to use them.
   - Foundational unit tests now exist under `losiento/tests/test_engine_basic.py`, covering deck composition, core movement, slides (including cross-color and slide-into-safety), Safety Zones, Home entry, self-bump prohibition, and key card behaviors (7-split, 10 forward/backward fallback, 11 forward/switch with restrictions, and Sorry! targeting/bumps).
   - Remaining coverage work (ls-12) focuses on a few gaps and edge-case combinations, such as deck/draw sequencing and 2’s extra-draw behavior, plus any additional regression tests discovered during playtesting.

2. **Implement advanced card behaviors & selection (COMPLETED – ls-11)**
   - Advanced card behaviors (7-split, 11-switch with restrictions, Sorry! targeting including slide interactions) are implemented in `losiento_game/engine.py` and exercised via `InMemoryPersistence` / `FirestorePersistence`.
   - The backend validates `clientMovePayload` against `get_legal_moves` using `_select_move`, and the schema is documented in section 4.4; bots already choose random legal moves.
   - Remaining work in this area is frontend-focused: building a richer in-game UI that can display the set of legal moves for the current card and send an explicit `payload.move` reflecting the user’s choice.

3. **Refine Integration Status**
   - Once the advanced behaviors and selection logic are in place, update this section to mark the rules engine as **Implemented (initial)** and adjust notes to describe any remaining edge cases or future enhancements.


