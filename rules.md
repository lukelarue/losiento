# Lo Siento – Rules

Lo Siento is an online adaptation of the classic board game *Sorry!* with a few house rules and a digital multiplayer implementation.

This document describes the rules used by the Lo Siento implementation, including where they differ from classic *Sorry!*.

## 1. Components

- A game board with four colored tracks, slides, Safety Zones, and Home areas.
- A standard Lo Siento deck of **45 cards**:
  - Five `1` cards.
  - Four of each of: `Sorry!`, `2`, `3`, `4`, `5`, `7`, `8`, `10`, `11`, `12`.
- For each player:
  - **4 pawns** of a single color.

## 2. Players and Objective

- **Players:** 2–4 players per game.
  - Any mix of human and bot players is allowed.
  - There must be **at least one human player** in every game.
- **Pawns:** Each player controls **4 pawns** of one color.
- **Objective:** Be the first player to move all 4 of your pawns from Start into your Home.
  - Only one player can win; the game ends immediately when one player’s fourth pawn reaches Home.
  - Because play is turn-based and only the current player’s pawns move, **ties are not possible**.

## 3. Setup

1. Each player chooses a color and places their 4 pawns in that color’s **Start** area.
2. One player is selected to go first (online, the host’s seat order determines turn order).
3. The deck is shuffled and placed face down as a draw pile.

In the online version, a **host** creates the game and chooses:

- The number of enabled seats (2–4 players).
- Which seats are human vs. bot (with at least one human).

The host can start the game once there are at least **2 total players** (humans + bots).

## 4. Turn Sequence

On a player’s turn:

1. The player draws the top card of the deck (in the digital version, the server determines this card).
2. Using that card, the player must make a legal move if one exists:
   - If multiple moves are available, the player may choose any one of them.
   - If no legal moves are available for that card, the player’s turn is forfeited (but card 2 may still grant an extra draw; see below).
3. After resolving the move and any resulting bumps or slides, the turn passes to the next player in turn order.

## 5. Movement Rules

### 5.1 Leaving Start

- All of a player’s pawns begin in Start.
- A pawn may only move from Start onto the main track when the player draws a **1**, **2**, or **Sorry!** card.
  - A 1 or 2 moves a pawn from Start to the space directly outside Start for that color.
  - A 2 used to leave Start does **not** allow that pawn to move an extra space; it only enters the first space.
  - A `Sorry!` card can also move a pawn directly from Start to an opponent’s occupied space (see card details below).

### 5.2 Normal Movement

- Pawns move along the track according to the number and direction indicated on the card.
- Pawns may **jump over** other pawns when moving; each square counts as one space.

### 5.3 Bumping

- If a pawn ends its move on a space occupied by an opponent’s pawn, the opponent’s pawn is **bumped back to its Start**.
- Players **cannot bump their own pawns** back to Start.
  - If the only way to complete a legal move would result in landing on a space occupied by one of their own pawns, that move is not allowed.
  - If no other legal move exists, the player’s turn is forfeited.

### 5.4 Slides (with house rules)

- Certain board spaces are the **start of a slide**.
- If a pawn **lands exactly on the start of a slide**, it immediately slides forward to the last square of that slide.
- **House rule:** In Lo Siento, you may slide on **any color**, including your own.
- As the pawn slides:
  - All pawns on any space of the slide (including the sliding player’s own pawns) are sent back to their respective Starts.

#### Sliding into the Safety Zone (house rule)

- Some slides end on the square directly outside a player’s Safety Zone.
- **House rule:** If a pawn lands on the start of such a slide and the slide would normally end on the space immediately before that player’s Safety Zone, the pawn:
  1. Slides along the slide as usual, then
  2. Continues into the first square of that player’s **Safety Zone**.

### 5.5 Safety Zones

- The last few squares before each player’s Home are that player’s **Safety Zone**, specially colored to match their Home.
- For each color, the Safety Zone is a short **inward lane** off the main track made up of **5 Safety Zone spaces** that lead into that color’s single Home space.
- Only pawns of that color may enter that Safety Zone.
- While in a Safety Zone, pawns are **safe**:
  - They cannot be bumped by opponents.
  - They cannot be switched using an 11 card.
  - They cannot be targeted by a `Sorry!` card.
- If a pawn is forced by a card (such as a 4 or 10) to move **backward out of the Safety Zone**, it is no longer safe and can once again be bumped or switched until it re-enters the Safety Zone.

### 5.6 Entering Home

- A pawn may only move into its Home space by **exact count**.
- Only a move that lands a pawn exactly on Home is allowed to place that pawn into Home.
- Once a pawn reaches Home, it stays there for the rest of the game.
- Pawns already in Home are **fully safe**:
  - They cannot be bumped or displaced.
  - They cannot be switched using an 11 card.
  - They cannot be targeted by a `Sorry!` card.

### 5.7 Board Layout and Geometry

- The board has a single **outer track loop** shared by all players. This loop is divided into **four identical color segments**, one per player color.
- Each color segment contains, in order around the track:
  - That color’s **first slide**.
  - A stretch of normal track.
  - That color’s **second slide**.
  - A stretch of normal track leading into the **next color’s first slide**.

- For each color, starting from the space **directly outside that color’s Start** and moving forward along the track:
  1. You move along your **first slide**, which consists of **4 slide spaces** of your color on the outer track.
  2. From the **end of your first slide**, there are **5 normal track spaces** until you reach the **start of your second slide**.
  3. Your **second slide** is **5 slide spaces** long.
  4. From the end of your second slide, there is **1 normal track space** until you reach the **start of the next color’s first slide**, which is again a **4‑space slide**. This pattern repeats for all four colors.

- **Corners:** Visually, the **corner** of each side of the board is the space immediately **before** a color’s first slide.

- **Safe Zone entry:**
  - For each color, starting from that color’s first slide **start** and counting forward along the track:
    - The **entry to that color’s Safety Zone** is located at the **last square of that color’s first slide**.
  - From that entry point, a pawn of that color can move **off the main track** into its Safety Zone on a forward move.
  - The Safety Zone contains **5 spaces** before reaching Home (as described in section 5.5), and those spaces are only accessible to pawns of the matching color, followed by that color’s single Home space.

### 5.8 ASCII board diagram (reference)

The following ASCII diagram shows one concrete layout of the outer track, slides, Start spaces (`S`), and the location of each color’s Home (`H`):

```text
# > - - o # # # # > - - - o # #
#   #   S                     v
o   #             H # # # # # |
|   #                         |
|   #                       S o
|   #                         #
^   H                         #
#                             #
#                             #
#                         H   v
#                         #   |
o S                       #   |
|                         #   |
| # # # # # H             #   o
^                     S   #   #
# # o - - - < # # # # o - - < #
```

Notice a few features:

- The `#` characters are empty squares.
- The `S` characters are Start spaces.
- The `H` characters mark each color’s Home.
- For readability, the **5 Safety Zone spaces** that lead into each `H` are not drawn individually; they run straight inward from the main track toward the `H` for that color.
- The `>`, `v`, `<`, and `^` characters mark the start of slides in each direction.
- The `|` and `-` characters are the middle of slides (vertical and horizontal).
- The `o` characters are the end of slides.
- Each column in the diagram is separated by a column of spaces to make it appear more square-like.

## 6. Card Reference

The Lo Siento deck has 45 cards. Card counts and their meanings are as follows:

- **1**
  - Either move a pawn from Start **or** move one pawn **1 space forward**.

- **2**
  - Either move a pawn from Start **or** move one pawn **2 spaces forward**.
  - Drawing a 2, **even if no pawn can move**, entitles the player to **draw again at the end of their turn**.

- **3**
  - Move one pawn **3 spaces forward**.

- **4**
  - Move one pawn **4 spaces backward**.

- **5**
  - Move one pawn **5 spaces forward**.

- **7**
  - Move one pawn **7 spaces forward**, **or** split the 7 spaces between **two pawns** (for example, 4 spaces for one pawn and 3 for another).
  - The 7 **cannot** be used to move a pawn out of Start.
  - The **entire** 7 spaces must be used; if the player cannot assign all 7 spaces to legal moves, the card cannot be played and the turn ends.
  - The 7 may not be used to move any pawn backward.

- **8**
  - Move one pawn **8 spaces forward**.

- **10**
  - Choose one of the following:
    - Move one pawn **10 spaces forward**, or
    - Move one pawn **1 space backward**.
  - If none of the player’s pawns can legally move forward 10 spaces, they **must** move one pawn back 1 space if possible.

- **11**
  - Choose one of the following:
    - Move one pawn **11 spaces forward**, or
    - **Switch** the positions of one of the player’s pawns with one opponent’s pawn.
  - An 11 **cannot** be used to:
    - Move a pawn out of Start.
    - Switch with a pawn in a Safety Zone.
  - If the player cannot move forward 11 spaces and does not have a legal switch, they may end their turn without moving.

- **12**
  - Move one pawn **12 spaces forward**.

- **Sorry!**
  - Take one pawn from your Start and move it directly to a space occupied by an opponent’s pawn, sending that pawn back to its Start.
  - A `Sorry!` card **cannot** target:
    - Pawns in a Safety Zone, or
    - Pawns already in Home.
  - If the player has no pawns in Start, or there is no opponent pawn on any legal target space, the turn ends with no movement.

## 7. Winning the Game

- The first player to move **all 4** of their pawns into their Home wins.
- As soon as a player’s last pawn enters Home, the game ends immediately and no further turns are taken.
- There are **no ties**.

## 8. Digital Lo Siento Rules (Online Implementation)

The online Lo Siento implementation adds rules about lobbies, hosting, bots, and reconnection. These do not change the board rules above.

### 8.1 Sessions and Single-Game Limit

- Each player can be part of **at most one active Lo Siento game** at a time.
- When a player visits the Lo Siento page:
  - If they are in an active game, they are returned to that in-progress session.
  - If they are not in an active game, they see the **lobby screen** with options to **Host a Game** or **Join a Game**.

### 8.2 Hosting and Joining

- **Host a Game**
  - Creates a new lobby with the creator as **host**.
  - The host chooses:
    - Number of seats (2–4 players).
    - Which seats are human vs. bot (at least one human overall).
  - The lobby is visible in the **Join a Game** list to other players who are not in a game.
  - The host can:
    - Add or remove bot seats.
    - Kick any joined player from the lobby or in-game.
    - Start the game once there are at least **2 total players** (humans + bots).

- **Join a Game**
  - Shows a scrollable list of joinable lobbies, including:
    - Host name (or short game label).
    - Current number of players (humans + bots).
    - Maximum seats for that game.
  - Players can select a game and join an open human seat.

### 8.3 Leaving, Kicking, and Host Behavior

- **Leaving**
  - Any non-host player may leave a game at any time (including closing the page).
  - When a player leaves:
    - Their seat is immediately converted to a **bot-controlled seat**.
    - The game continues for remaining players.
  - If a player later revisits the Lo Siento page while their old game is still active and they are not already in another active game, they are automatically returned to that game and reclaim control of their original seat; their seat stops being bot-controlled.

- **Kicking**
  - The host may kick any non-host player from the lobby or an active game.
  - When a player is kicked during an active game, their seat is also converted to a **bot-controlled seat**.

- **Host Leaving**
  - If the **host leaves** an active game, the entire game is **aborted**.
  - All remaining players are returned to the lobby state; they have no active Lo Siento game.

### 8.4 Bots

- Any seat may be configured as a **bot**. Bots:
  - Use random legal moves. They do not attempt strategy beyond choosing among legal options uniformly at random.
  - Take their turn automatically when it is their turn.
  - Wait approximately **1 second** before making a move, so human players can see that a bot turn is happening.
- When a human leaves or is kicked, their seat becomes bot-controlled so that the game can continue to completion.

### 8.5 Server-Authoritative Rules and State

- The game state is managed by a **Python backend** using a server-authoritative model, similar to the Minesweeper implementation:
  - All rule enforcement (card draws, legal moves, bumping, slides, Safety Zone rules, Home entry, and win detection) is performed on the server.
  - Clients cannot modify the authoritative game state directly.
  - Each move is recorded in storage, and the server maintains an **authoritative current board state** for each game.
  - State is synchronized via Firestore (or equivalent), so that:
    - All players see the same up-to-date board state.
    - Clients can only make moves when it is their turn, and only if the server validates the move as legal under these rules.