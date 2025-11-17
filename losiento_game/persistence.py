from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Dict, List, Optional
import os
import uuid

try:
    from google.cloud import firestore  # type: ignore
except Exception:
    firestore = None  # type: ignore

from .models import GameSettings, GameState, Seat, Pawn, PawnPosition, Card, game_state_to_dict
from .engine import (
    initialize_game,
    TRACK_LEN,
    SAFE_ZONE_LEN,
    SLIDES,
    safe_entry_index,
    shuffle_deck,
    build_deck,
    get_legal_moves,
    apply_move,
    Move,
)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _new_game_id() -> str:
    return uuid.uuid4().hex[:8]


def _select_move(moves: List[Move], payload: Dict[str, Any]) -> Move:
    if not moves:
        raise ValueError("no_legal_moves")
    if not isinstance(payload, dict) or not payload:
        if len(moves) == 1:
            return moves[0]
        raise ValueError("move_selection_required")

    idx = payload.get("moveIndex")
    if isinstance(idx, int) and 0 <= idx < len(moves):
        return moves[idx]

    move_desc = payload.get("move")
    if isinstance(move_desc, dict):
        candidates = moves
        field_map = {
            "pawnId": "pawn_id",
            "targetPawnId": "target_pawn_id",
            "secondaryPawnId": "secondary_pawn_id",
            "direction": "direction",
            "steps": "steps",
            "secondaryDirection": "secondary_direction",
            "secondarySteps": "secondary_steps",
        }
        for key, attr in field_map.items():
            if key in move_desc:
                val = move_desc[key]
                candidates = [m for m in candidates if getattr(m, attr) == val]
        if len(candidates) == 1:
            return candidates[0]
        if not candidates:
            raise ValueError("invalid_move_selection_no_match")
        raise ValueError("invalid_move_selection_ambiguous")

    if len(moves) == 1:
        return moves[0]

    raise ValueError("invalid_move_selection")


class InMemoryPersistence:
    def __init__(self) -> None:
        self.games: Dict[str, Dict[str, Any]] = {}
        self.user_active_game: Dict[str, str] = {}

    def _ensure_user_free(self, user_id: str) -> None:
        if user_id in self.user_active_game:
            raise ValueError("active_game_exists")

    def _get_game(self, game_id: str) -> Dict[str, Any]:
        game = self.games.get(game_id)
        if not game:
            raise ValueError("game_not_found")
        return game

    def host_game(self, user_id: str, max_seats: int, display_name: Optional[str]) -> Dict[str, Any]:
        self._ensure_user_free(user_id)
        game_id = _new_game_id()
        created = _now()
        seats: List[Seat] = []
        for idx in range(max_seats):
            color = ["red", "blue", "yellow", "green"][idx]
            if idx == 0:
                seats.append(
                    Seat(
                        index=idx,
                        color=color,
                        is_bot=False,
                        player_id=user_id,
                        display_name=display_name or user_id,
                        status="joined",
                    )
                )
            else:
                seats.append(
                    Seat(
                        index=idx,
                        color=color,
                        is_bot=False,
                        player_id=None,
                        display_name=None,
                        status="open",
                    )
                )
        doc: Dict[str, Any] = {
            "game_id": game_id,
            "host_id": user_id,
            "host_name": display_name or user_id,
            "created_at": created,
            "updated_at": created,
            "phase": "lobby",
            "settings": GameSettings(max_seats=max_seats),
            "seats": seats,
            "state": None,
        }
        self.games[game_id] = doc
        self.user_active_game[user_id] = game_id
        return doc

    def list_joinable_games(self, user_id: str) -> List[Dict[str, Any]]:
        games: List[Dict[str, Any]] = []
        for g in self.games.values():
            if g["phase"] != "lobby":
                continue
            seats: List[Seat] = g["seats"]
            open_human = any((not s.is_bot and s.status == "open") for s in seats)
            if not open_human:
                continue
            total = len(seats)
            current = sum(1 for s in seats if s.status == "joined" or s.is_bot)
            games.append(
                {
                    "gameId": g["game_id"],
                    "hostName": g["host_name"],
                    "currentPlayers": current,
                    "maxSeats": total,
                }
            )
        return games

    def join_game(self, game_id: str, user_id: str, display_name: Optional[str]) -> Dict[str, Any]:
        if user_id in self.user_active_game and self.user_active_game[user_id] != game_id:
            raise ValueError("active_game_exists")
        game = self._get_game(game_id)
        if game["phase"] != "lobby":
            raise ValueError("not_lobby")
        seats: List[Seat] = game["seats"]
        target: Optional[Seat] = None
        for s in seats:
            if not s.is_bot and s.status == "open" and s.player_id is None:
                target = s
                break
        if target is None:
            raise ValueError("no_open_seat")
        target.player_id = user_id
        target.display_name = display_name or user_id
        target.status = "joined"
        game["updated_at"] = _now()
        self.user_active_game[user_id] = game_id
        return game

    def leave_game(self, game_id: str, user_id: str) -> Dict[str, Any]:
        game = self._get_game(game_id)
        seats: List[Seat] = game["seats"]
        if game["host_id"] == user_id:
            game["phase"] = "aborted"
            game["updated_at"] = _now()
            for s in seats:
                if s.player_id and s.player_id in self.user_active_game:
                    del self.user_active_game[s.player_id]
            return game
        for s in seats:
            if s.player_id == user_id:
                s.player_id = None
                s.display_name = None
                s.is_bot = True
                s.status = "bot"
        if user_id in self.user_active_game:
            del self.user_active_game[user_id]
        game["updated_at"] = _now()
        return game

    def kick_player(self, game_id: str, host_id: str, seat_index: int) -> Dict[str, Any]:
        game = self._get_game(game_id)
        if game["host_id"] != host_id:
            raise ValueError("not_host")
        seats: List[Seat] = game["seats"]
        if not (0 <= seat_index < len(seats)):
            raise ValueError("invalid_seat")
        seat = seats[seat_index]
        if seat.player_id and seat.player_id in self.user_active_game:
            del self.user_active_game[seat.player_id]
        if seat_index == 0:
            raise ValueError("cannot_kick_host")
        seat.player_id = None
        seat.display_name = None
        seat.is_bot = True
        seat.status = "bot"
        game["updated_at"] = _now()
        return game

    def configure_seat(self, game_id: str, host_id: str, seat_index: int, is_bot: bool) -> Dict[str, Any]:
        game = self._get_game(game_id)
        if game["host_id"] != host_id:
            raise ValueError("not_host")
        if game["phase"] != "lobby":
            raise ValueError("not_lobby")
        seats: List[Seat] = game["seats"]
        if not (0 <= seat_index < len(seats)):
            raise ValueError("invalid_seat")
        if seat_index == 0:
            return game
        seat = seats[seat_index]
        if is_bot:
            if seat.player_id and seat.player_id in self.user_active_game:
                del self.user_active_game[seat.player_id]
            seat.player_id = None
            seat.display_name = None
            seat.is_bot = True
            seat.status = "bot"
        else:
            seat.player_id = None
            seat.display_name = None
            seat.is_bot = False
            seat.status = "open"
        game["updated_at"] = _now()
        return game

    def start_game(self, game_id: str, host_id: str) -> Dict[str, Any]:
        game = self._get_game(game_id)
        if game["host_id"] != host_id:
            raise ValueError("not_host")
        if game["phase"] != "lobby":
            raise ValueError("not_lobby")
        seats: List[Seat] = game["seats"]
        humans = [s for s in seats if not s.is_bot and s.player_id]
        active_seats = [s for s in seats if s.player_id or s.is_bot]
        if len(active_seats) < 2 or len(humans) < 1:
            raise ValueError("insufficient_players")
        settings: GameSettings = game["settings"]
        state = initialize_game(game["game_id"], host_id, settings, seats)
        game["state"] = state
        game["phase"] = "active"
        game["updated_at"] = _now()
        return game

    def get_active_game_for_user(self, user_id: str) -> Optional[Dict[str, Any]]:
        game_id = self.user_active_game.get(user_id)
        if not game_id:
            return None
        return self.games.get(game_id)

    # --- Core gameplay helpers (in-memory only) ---

    def _ensure_deck(self, state: GameState) -> None:
        if not state.deck:
            # Rebuild and reshuffle when deck is exhausted
            if state.settings.deck_seed is not None:
                state.deck = shuffle_deck(state.settings.deck_seed)
            else:
                # Fresh random deck if no seed
                state.deck = build_deck()
                random = __import__("random")  # lazy import to avoid extra top-level imports
                random.shuffle(state.deck)
            state.discard_pile.clear()

    def _draw_card(self, state: GameState) -> Card:
        self._ensure_deck(state)
        card = state.deck.pop(0)
        state.discard_pile.append(card)
        return card

    def _advance_turn(self, game: Dict[str, Any], state: GameState) -> None:
        seats: List[Seat] = game["seats"]
        n = len(seats)
        idx = state.current_seat_index
        for _ in range(n):
            idx = (idx + 1) % n
            s = seats[idx]
            if s.player_id or s.is_bot:
                state.current_seat_index = idx
                state.turn_number += 1
                return

    def _find_seat_index_for_user(self, game: Dict[str, Any], user_id: str) -> Optional[int]:
        for s in game["seats"]:
            if s.player_id == user_id:
                return s.index
        return None

    def _find_pawn_on_track(self, state: GameState, track_index: int) -> Optional[Pawn]:
        for p in state.pawns:
            pos = p.position
            if pos.kind == "track" and pos.index == track_index:
                return p
        return None

    def _find_pawn_in_safety(self, state: GameState, seat_index: int, safety_index: int) -> Optional[Pawn]:
        for p in state.pawns:
            pos = p.position
            if pos.kind == "safety" and p.seat_index == seat_index and pos.index == safety_index:
                return p
        return None

    def _pawns_for_seat(self, state: GameState, seat_index: int) -> List[Pawn]:
        return [p for p in state.pawns if p.seat_index == seat_index]

    def _advance_track(self, index: int, steps: int) -> int:
        return (index + steps) % TRACK_LEN

    def _retreat_track(self, index: int, steps: int) -> int:
        return (index - steps) % TRACK_LEN

    def _apply_slides_and_safety(self, state: GameState, pawn: Pawn, track_index: int, *, forward: bool) -> tuple[PawnPosition, Optional[List[int]]]:
        """Apply slide and safety-zone entry rules for a pawn landing on a track index.

        Returns (final_position, slide_indices or None).
        """

        slide = SLIDES.get(track_index)
        slide_indices: Optional[List[int]] = None
        if slide is not None:
            slide_indices = list(slide["indices"])  # type: ignore[assignment]
            end_idx = slide_indices[-1]
            owner_seat = int(slide["owner_seat"])  # type: ignore[arg-type]
            is_near_safety = bool(slide["is_near_safety"])  # type: ignore[arg-type]
            if forward and is_near_safety and owner_seat == pawn.seat_index:
                # Slide into the owner's Safety Zone
                return PawnPosition(kind="safety", index=0), slide_indices
            # Normal slide: end on the last slide square
            track_index = end_idx

        # Safety Zone entry by forward move only
        if forward and track_index == safe_entry_index(pawn.seat_index):
            return PawnPosition(kind="safety", index=0), slide_indices

        return PawnPosition(kind="track", index=track_index), slide_indices

    def _bump_pawns_on_indices(self, state: GameState, indices: List[int], moving_pawn: Pawn) -> None:
        for p in state.pawns:
            if p is moving_pawn:
                continue
            pos = p.position
            if pos.kind == "track" and pos.index in indices:
                p.position = PawnPosition(kind="start", index=None)

    def _apply_single_forward(self, state: GameState, pawn: Pawn, steps: int) -> bool:
        pos = pawn.position
        if pos.kind == "home":
            return False
        if pos.kind == "start":
            # Leaving Start: first step goes to the start of this color's first slide
            start_idx = safe_entry_index(pawn.seat_index) - (SAFE_ZONE_LEN - 1)
            # safe_entry_index is the last square of first slide (index 2), so start of slide is entry-2
            start_idx %= TRACK_LEN
            if steps < 1:
                return False
            track_index = start_idx
            remaining = steps - 1
            if remaining > 0:
                track_index = self._advance_track(track_index, remaining)
            final_pos, slide_indices = self._apply_slides_and_safety(state, pawn, track_index, forward=True)
        elif pos.kind == "track":
            track_index = self._advance_track(pos.index or 0, steps)
            final_pos, slide_indices = self._apply_slides_and_safety(state, pawn, track_index, forward=True)
        elif pos.kind == "safety":
            new_index = (pos.index or 0) + steps
            if new_index < SAFE_ZONE_LEN:
                final_pos, slide_indices = PawnPosition(kind="safety", index=new_index), None
            elif new_index == SAFE_ZONE_LEN:
                final_pos, slide_indices = PawnPosition(kind="home", index=None), None
            else:
                return False
        else:
            return False

        # Handle bumps
        if final_pos.kind == "track":
            target = self._find_pawn_on_track(state, final_pos.index or 0)
            if target is not None and target.seat_index == pawn.seat_index:
                # Cannot bump own pawn on direct landing
                return False
            # Bump opponent on destination
            if target is not None:
                target.position = PawnPosition(kind="start", index=None)

        if final_pos.kind == "safety":
            target = self._find_pawn_in_safety(state, pawn.seat_index, final_pos.index or 0)
            if target is not None:
                # No stacking in Safety Zone
                return False

        # Slides may bump additional pawns (including our own)
        if slide_indices:
            self._bump_pawns_on_indices(state, slide_indices, pawn)

        pawn.position = final_pos
        return True

    def _apply_single_backward(self, state: GameState, pawn: Pawn, steps: int) -> bool:
        pos = pawn.position
        if pos.kind in ("start", "home"):
            return False
        if pos.kind == "track":
            track_index = self._retreat_track(pos.index or 0, steps)
            final_pos, slide_indices = self._apply_slides_and_safety(state, pawn, track_index, forward=False)
        else:  # safety
            cur = pos.index or 0
            if steps <= cur:
                final_pos, slide_indices = PawnPosition(kind="safety", index=cur - steps), None
            else:
                remaining = steps - (cur + 1)
                from_entry = safe_entry_index(pawn.seat_index)
                track_index = self._retreat_track(from_entry, remaining)
                final_pos, slide_indices = self._apply_slides_and_safety(state, pawn, track_index, forward=False)

        if final_pos.kind == "track":
            target = self._find_pawn_on_track(state, final_pos.index or 0)
            if target is not None and target.seat_index == pawn.seat_index:
                return False
            if target is not None:
                target.position = PawnPosition(kind="start", index=None)

        if final_pos.kind == "safety":
            target = self._find_pawn_in_safety(state, pawn.seat_index, final_pos.index or 0)
            if target is not None:
                return False

        if slide_indices:
            self._bump_pawns_on_indices(state, slide_indices, pawn)

        pawn.position = final_pos
        return True

    def _try_forward_any(self, state: GameState, seat_index: int, steps: int, *, allow_from_start: bool) -> bool:
        # Prefer leaving Start if allowed
        if allow_from_start:
            for p in self._pawns_for_seat(state, seat_index):
                if p.position.kind == "start" and self._apply_single_forward(state, p, steps):
                    return True
        # Then try board pawns
        for p in self._pawns_for_seat(state, seat_index):
            if p.position.kind in ("track", "safety") and self._apply_single_forward(state, p, steps):
                return True
        return False

    def _try_backward_any(self, state: GameState, seat_index: int, steps: int) -> bool:
        for p in self._pawns_for_seat(state, seat_index):
            if p.position.kind in ("track", "safety") and self._apply_single_backward(state, p, steps):
                return True
        return False

    def _apply_card_for_seat(self, game: Dict[str, Any], state: GameState, seat_index: int, card: Card) -> None:
        # Simple heuristic: pick the first legal move that matches card rules.
        if card == "1":
            self._try_forward_any(state, seat_index, 1, allow_from_start=True)
        elif card == "2":
            self._try_forward_any(state, seat_index, 2, allow_from_start=True)
        elif card == "3":
            self._try_forward_any(state, seat_index, 3, allow_from_start=False)
        elif card == "4":
            self._try_backward_any(state, seat_index, 4)
        elif card == "5":
            self._try_forward_any(state, seat_index, 5, allow_from_start=False)
        elif card == "7":
            # For now, treat 7 as a single 7-step forward move (no split).
            self._try_forward_any(state, seat_index, 7, allow_from_start=False)
        elif card == "8":
            self._try_forward_any(state, seat_index, 8, allow_from_start=False)
        elif card == "10":
            # Prefer 10 forward; if impossible, try 1 backward.
            moved = self._try_forward_any(state, seat_index, 10, allow_from_start=False)
            if not moved:
                self._try_backward_any(state, seat_index, 1)
        elif card == "11":
            # For now, support only forward 11 (no switch behaviour yet).
            self._try_forward_any(state, seat_index, 11, allow_from_start=False)
        elif card == "12":
            self._try_forward_any(state, seat_index, 12, allow_from_start=False)
        elif card == "Sorry!":
            # Take one pawn from Start to a square occupied by an opponent.
            pawns = self._pawns_for_seat(state, seat_index)
            start_pawn = next((p for p in pawns if p.position.kind == "start"), None)
            if not start_pawn:
                return
            for p in state.pawns:
                if p.seat_index == seat_index:
                    continue
                pos = p.position
                if pos.kind != "track":
                    continue
                # Cannot target Safety Zone or Home; already filtered.
                # Cannot target if it would violate self-bump (not possible here) or stacking rules.
                target_idx = pos.index or 0
                # Landing on a slide start is allowed; use slide rules.
                final_pos, slide_indices = self._apply_slides_and_safety(state, start_pawn, target_idx, forward=True)
                if final_pos.kind == "track":
                    # Bump the target pawn (and any pawns on slide)
                    p.position = PawnPosition(kind="start", index=None)
                    if slide_indices:
                        self._bump_pawns_on_indices(state, slide_indices, start_pawn)
                    start_pawn.position = final_pos
                    return
                if final_pos.kind == "safety":
                    # Sorry! cannot enter Safety Zones; skip this target.
                    continue

    def _check_winner(self, game: Dict[str, Any], state: GameState) -> None:
        if state.result != "active":
            return
        for s in game["seats"]:
            pawns = self._pawns_for_seat(state, s.index)
            if pawns and all(p.position.kind == "home" for p in pawns):
                state.result = "win"
                state.winner_seat_index = s.index
                state.phase = "finished"
                game["phase"] = "finished"
                return

    def play_move(self, game_id: str, user_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
        game = self._get_game(game_id)
        state = game.get("state")
        if not isinstance(state, GameState):
            raise ValueError("game_not_started")
        if state.result != "active":
            raise ValueError("game_over")

        seat_index = self._find_seat_index_for_user(game, user_id)
        if seat_index is None:
            raise ValueError("not_in_game")
        if seat_index != state.current_seat_index:
            raise ValueError("not_your_turn")

        card = self._draw_card(state)

        # Use the pure rules engine to compute and apply a move.
        moves = get_legal_moves(state, seat_index, card)
        if moves:
            selected_move = _select_move(moves, payload)
            state = apply_move(state, selected_move)
            game["state"] = state

        self._check_winner(game, state)

        # Card 2 grants an extra turn (draw another card) even if no move occurred.
        if state.result == "active" and card == "2":
            extra_card = self._draw_card(state)
            extra_moves = get_legal_moves(state, seat_index, extra_card)
            if extra_moves:
                # For the extra draw we continue to pick the first legal
                # move; client selection for this secondary move is not yet
                # supported.
                state = apply_move(state, extra_moves[0])
                game["state"] = state
            self._check_winner(game, state)

        if state.result == "active" and card != "2":
            self._advance_turn(game, state)

        game["updated_at"] = _now()
        return game

    def bot_step(self, game_id: str) -> Dict[str, Any]:
        game = self._get_game(game_id)
        state = game.get("state")
        if not isinstance(state, GameState):
            raise ValueError("game_not_started")
        if state.result != "active":
            raise ValueError("game_over")

        seats: List[Seat] = game["seats"]
        current = state.current_seat_index
        if not seats[current].is_bot:
            raise ValueError("not_bot_turn")

        card = self._draw_card(state)
        moves = get_legal_moves(state, current, card)
        if moves:
            # Bots choose a random legal move among the available options.
            rnd = __import__("random")
            move = rnd.choice(moves)
            state = apply_move(state, move)
            game["state"] = state
        self._check_winner(game, state)

        if state.result == "active" and card == "2":
            extra_card = self._draw_card(state)
            extra_moves = get_legal_moves(state, current, extra_card)
            if extra_moves:
                rnd = __import__("random")
                move = rnd.choice(extra_moves)
                state = apply_move(state, move)
                game["state"] = state
            self._check_winner(game, state)

        if state.result == "active" and card != "2":
            self._advance_turn(game, state)

        game["updated_at"] = _now()
        return game

    def to_client(self, game: Dict[str, Any], user_id: str) -> Dict[str, Any]:
        state = game.get("state")
        if isinstance(state, GameState):
            state_dict = game_state_to_dict(state)
        else:
            state_dict = None
        seats: List[Seat] = game["seats"]
        return {
            "gameId": game["game_id"],
            "phase": game["phase"],
            "hostId": game["host_id"],
            "hostName": game["host_name"],
            "settings": {
                "maxSeats": game["settings"].max_seats,
                "deckSeed": game["settings"].deck_seed,
            },
            "seats": [
                {
                    "index": s.index,
                    "color": s.color,
                    "isBot": s.is_bot,
                    "playerId": s.player_id,
                    "displayName": s.display_name,
                    "status": s.status,
                }
                for s in seats
            ],
            "state": state_dict["state"] if state_dict else None,
        }


class FirestorePersistence:
    def __init__(self, client: Optional[Any] = None) -> None:
        if firestore is None:
            raise RuntimeError("google-cloud-firestore not available")
        if client is not None:
            self.client = client
        else:
            self.client = firestore.Client(project=os.environ.get("GOOGLE_CLOUD_PROJECT"))

    # --- Helpers ---

    def _games_collection(self):
        return self.client.collection("losiento_games")

    def _users_collection(self):
        return self.client.collection("losiento_users")

    def _ensure_user_free(self, user_id: str) -> None:
        """Raise if the user already has an active game (based on losiento_users)."""

        user_ref = self._users_collection().document(user_id)
        snap = user_ref.get()
        if snap.exists:
            data = snap.to_dict() or {}
            if data.get("activeGameId"):
                raise ValueError("active_game_exists")

    def _snapshot_to_game(self, snap: Any) -> Dict[str, Any]:
        data = snap.to_dict() or {}
        # Ensure we always expose a gameId field
        if "gameId" not in data:
            data["gameId"] = snap.id
        return data

    def _decode_state(self, game_id: str, data: Dict[str, Any]) -> GameState:
        """Reconstruct a GameState object from a Firestore game document."""

        state_dict = data.get("state")
        if not isinstance(state_dict, dict):
            raise ValueError("game_not_started")

        settings_data = data.get("settings") or {}
        seats_data: List[Dict[str, Any]] = data.get("seats", [])
        max_seats_val = settings_data.get("maxSeats")
        if not isinstance(max_seats_val, int):
            max_seats_val = len(seats_data)
        deck_seed = settings_data.get("deckSeed")
        settings = GameSettings(max_seats=max_seats_val, deck_seed=deck_seed)

        seats: List[Seat] = []
        for s in seats_data:
            seats.append(
                Seat(
                    index=int(s.get("index", 0)),
                    color=str(s.get("color", "")),
                    is_bot=bool(s.get("isBot")),
                    player_id=s.get("playerId"),
                    display_name=s.get("displayName"),
                    status=s.get("status", "open"),
                )
            )

        board = state_dict.get("board") or {}
        pawns_data = board.get("pawns") or []
        pawns: List[Pawn] = []
        for p in pawns_data:
            pos = p.get("position") or {}
            pawns.append(
                Pawn(
                    pawn_id=str(p.get("pawnId", "")),
                    seat_index=int(p.get("seatIndex", 0)),
                    position=PawnPosition(
                        kind=str(pos.get("type", "start")),
                        index=pos.get("index"),
                    ),
                )
            )

        return GameState(
            game_id=game_id,
            host_id=str(data.get("hostId", "")),
            phase=str(data.get("phase", "active")),
            settings=settings,
            seats=seats,
            deck=list(state_dict.get("deck") or []),
            discard_pile=list(state_dict.get("discardPile") or []),
            pawns=pawns,
            turn_number=int(state_dict.get("turnNumber", 0)),
            current_seat_index=int(state_dict.get("currentSeatIndex", 0)),
            winner_seat_index=state_dict.get("winnerSeatIndex"),
            result=str(state_dict.get("result", "active")),
        )

    def _ensure_deck(self, state: GameState) -> None:
        if not state.deck:
            if state.settings.deck_seed is not None:
                state.deck = shuffle_deck(state.settings.deck_seed)
            else:
                state.deck = build_deck()
                rnd = __import__("random")
                rnd.shuffle(state.deck)
            state.discard_pile.clear()

    def _draw_card(self, state: GameState) -> Card:
        self._ensure_deck(state)
        card = state.deck.pop(0)
        state.discard_pile.append(card)
        return card

    def _advance_turn(self, seats_data: List[Dict[str, Any]], state: GameState) -> None:
        n = len(seats_data)
        idx = state.current_seat_index
        for _ in range(n):
            idx = (idx + 1) % n
            s = seats_data[idx]
            if s.get("playerId") or s.get("isBot"):
                state.current_seat_index = idx
                state.turn_number += 1
                return

    def _check_winner_state(self, state: GameState) -> None:
        if state.result != "active":
            return
        for seat in state.seats:
            pawns = [p for p in state.pawns if p.seat_index == seat.index]
            if pawns and all(p.position.kind == "home" for p in pawns):
                state.result = "win"
                state.winner_seat_index = seat.index
                state.phase = "finished"
                return

    def _log_move_doc(
        self,
        game_ref: Any,
        game_id: str,
        card: Card,
        seat_index: int,
        player_id: Optional[str],
        state_before: Dict[str, Any],
        state_after: Dict[str, Any],
        transaction: Any | None = None,
    ) -> None:
        """Append a move document under losiento_games/{gameId}/moves.

        state_before/state_after are the inner "state" dicts produced by
        game_state_to_dict(state)["state"].
        """

        moves_ref = game_ref.collection("moves")

        # Compute sequential index for this move. When a transaction is
        # provided, use a transactional query so that index assignment is
        # consistent under concurrent writers.
        if transaction is not None and firestore is not None:
            index = 0
            query = moves_ref.order_by("index", direction=firestore.Query.DESCENDING).limit(1)
            docs = list(transaction.get(query))
            if docs:
                last = docs[0].to_dict() or {}
                last_index = last.get("index")
                if isinstance(last_index, int):
                    index = last_index + 1
            move_doc_ref = moves_ref.document()
        else:
            index = 0
            for _ in moves_ref.stream():
                index += 1
            move_doc_ref = moves_ref.document()

        before_pawns = (state_before.get("board") or {}).get("pawns") or []
        after_pawns = (state_after.get("board") or {}).get("pawns") or []

        before_by_id: Dict[str, Any] = {
            str(p.get("pawnId")): p.get("position") for p in before_pawns
        }
        after_by_id: Dict[str, Any] = {
            str(p.get("pawnId")): p.get("position") for p in after_pawns
        }

        changed_pawns: List[Dict[str, Any]] = []
        for pawn_id, after_pos in after_by_id.items():
            before_pos = before_by_id.get(pawn_id)
            if before_pos != after_pos:
                changed_pawns.append(
                    {
                        "pawnId": pawn_id,
                        "fromPosition": before_pos,
                        "toPosition": after_pos,
                    }
                )

        resulting_state_hash = hash(repr(state_after))

        payload = {
            "index": index,
            "seatIndex": seat_index,
            "playerId": player_id,
            "card": card,
            "moveData": {"pawns": changed_pawns},
            "resultingStateHash": str(resulting_state_hash),
            "createdAt": _now(),
        }

        if transaction is not None:
            transaction.set(move_doc_ref, payload)
        else:
            move_doc_ref.set(payload)

    def host_game(self, user_id: str, max_seats: int, display_name: Optional[str]) -> Dict[str, Any]:
        """Create a lobby game document and mark user as active in losiento_users.

        This mirrors the InMemoryPersistence.host_game behaviour but stores
        data in Firestore. Game state is not created until start_game (which is
        still unimplemented here).
        """

        self._ensure_user_free(user_id)

        if max_seats < 2 or max_seats > 4:
            raise ValueError("invalid_max_seats")

        game_id = _new_game_id()
        now = _now()
        seats: List[Dict[str, Any]] = []
        for idx in range(max_seats):
            color = ["red", "blue", "yellow", "green"][idx]
            if idx == 0:
                seats.append(
                    {
                        "index": idx,
                        "color": color,
                        "isBot": False,
                        "playerId": user_id,
                        "displayName": display_name or user_id,
                        "status": "joined",
                    }
                )
            else:
                seats.append(
                    {
                        "index": idx,
                        "color": color,
                        "isBot": False,
                        "playerId": None,
                        "displayName": None,
                        "status": "open",
                    }
                )

        game_data: Dict[str, Any] = {
            "gameId": game_id,
            "hostId": user_id,
            "hostName": display_name or user_id,
            "createdAt": now,
            "updatedAt": now,
            "phase": "lobby",
            "settings": {
                "maxSeats": max_seats,
                "deckSeed": None,
            },
            "seats": seats,
            "state": None,
        }

        game_ref = self._games_collection().document(game_id)
        game_ref.set(game_data)

        # Track active game for the user
        user_ref = self._users_collection().document(user_id)
        user_ref.set({"activeGameId": game_id, "displayName": display_name or user_id}, merge=True)

        snap = game_ref.get()
        return self._snapshot_to_game(snap)

    def list_joinable_games(self, user_id: str) -> List[Dict[str, Any]]:
        """Return lobby games with at least one open human seat.

        This mirrors InMemoryPersistence.list_joinable_games, but data comes
        from Firestore.
        """

        results: List[Dict[str, Any]] = []
        games_ref = self._games_collection()
        # Filter on phase == lobby in Firestore, then filter seats client-side.
        for snap in games_ref.where("phase", "==", "lobby").stream():
            data = snap.to_dict() or {}
            seats: List[Dict[str, Any]] = data.get("seats", [])
            open_human = any((not s.get("isBot") and s.get("status") == "open") for s in seats)
            if not open_human:
                continue
            total = len(seats)
            current = sum(1 for s in seats if s.get("status") == "joined" or s.get("isBot"))
            results.append(
                {
                    "gameId": data.get("gameId", snap.id),
                    "hostName": data.get("hostName", ""),
                    "currentPlayers": current,
                    "maxSeats": total,
                }
            )
        return results

    def join_game(self, game_id: str, user_id: str, display_name: Optional[str]) -> Dict[str, Any]:
        """Join an existing lobby game, claiming an open human seat.

        Behaviour mirrors InMemoryPersistence.join_game but persists changes in
        Firestore. This implementation does not yet use transactions, so there
        is a small risk of race conditions if many users join simultaneously.
        """

        # Enforce single active game per user
        user_ref = self._users_collection().document(user_id)
        user_snap = user_ref.get()
        if user_snap.exists:
            udata = user_snap.to_dict() or {}
            existing = udata.get("activeGameId")
            if existing and existing != game_id:
                raise ValueError("active_game_exists")

        game_ref = self._games_collection().document(game_id)
        snap = game_ref.get()
        if not snap.exists:
            raise ValueError("game_not_found")

        data = snap.to_dict() or {}
        if data.get("phase") != "lobby":
            raise ValueError("not_lobby")

        seats: List[Dict[str, Any]] = data.get("seats", [])
        target_index: Optional[int] = None
        for s in seats:
            if not s.get("isBot") and s.get("status") == "open" and not s.get("playerId"):
                target_index = s.get("index")
                break
        if target_index is None:
            raise ValueError("no_open_seat")

        for s in seats:
            if s.get("index") == target_index:
                s["playerId"] = user_id
                s["displayName"] = display_name or user_id
                s["status"] = "joined"
                break

        data["seats"] = seats
        data["updatedAt"] = _now()
        game_ref.set(data)

        user_ref.set({"activeGameId": game_id, "displayName": display_name or user_id}, merge=True)

        snap = game_ref.get()
        return self._snapshot_to_game(snap)

    def leave_game(self, game_id: str, user_id: str) -> Dict[str, Any]:
        """Handle a player leaving a Firestore-backed game.

        Behaviour mirrors InMemoryPersistence.leave_game and the spec:
        - If the host leaves (lobby or active), abort the game and clear
          activeGameId for all participants.
        - If a non-host leaves, convert their seat into a bot seat and clear
          their activeGameId.
        """

        game_ref = self._games_collection().document(game_id)
        snap = game_ref.get()
        if not snap.exists:
            raise ValueError("game_not_found")

        data = snap.to_dict() or {}
        seats: List[Dict[str, Any]] = data.get("seats", [])
        host_id = data.get("hostId")
        now = _now()

        if host_id == user_id:
            # Host leaving aborts the game regardless of phase.
            data["phase"] = "aborted"
            # If state exists, mark result as aborted.
            state = data.get("state")
            if isinstance(state, dict):
                state["result"] = "aborted"
                data["state"] = state
            data["abortedReason"] = "host_left"
            data["endedAt"] = now
            data["updatedAt"] = now
            game_ref.set(data)

            # Clear activeGameId for all players in seats.
            for s in seats:
                pid = s.get("playerId")
                if pid:
                    user_ref = self._users_collection().document(pid)
                    user_ref.set({"activeGameId": None}, merge=True)

            return self._snapshot_to_game(game_ref.get())

        # Non-host: convert their seat into a bot seat.
        seat_found = False
        for s in seats:
            if s.get("playerId") == user_id:
                s["playerId"] = None
                s["displayName"] = None
                s["isBot"] = True
                s["status"] = "bot"
                seat_found = True

        data["seats"] = seats
        data["updatedAt"] = now
        game_ref.set(data)

        # Clear the user's activeGameId regardless of whether a seat was found.
        user_ref = self._users_collection().document(user_id)
        user_ref.set({"activeGameId": None}, merge=True)

        return self._snapshot_to_game(game_ref.get())

    def kick_player(self, game_id: str, host_id: str, seat_index: int) -> Dict[str, Any]:
        """Host-only kick: convert a target seat into a bot and clear its activeGameId."""

        game_ref = self._games_collection().document(game_id)
        snap = game_ref.get()
        if not snap.exists:
            raise ValueError("game_not_found")

        data = snap.to_dict() or {}
        if data.get("hostId") != host_id:
            raise ValueError("not_host")

        seats: List[Dict[str, Any]] = data.get("seats", [])
        if not (0 <= seat_index < len(seats)):
            raise ValueError("invalid_seat")
        if seat_index == 0:
            raise ValueError("cannot_kick_host")

        seat = seats[seat_index]
        kicked_player_id = seat.get("playerId")

        seat["playerId"] = None
        seat["displayName"] = None
        seat["isBot"] = True
        seat["status"] = "bot"

        data["seats"] = seats
        data["updatedAt"] = _now()
        game_ref.set(data)

        # Clear activeGameId for the kicked user, if any.
        if kicked_player_id:
            user_ref = self._users_collection().document(kicked_player_id)
            user_ref.set({"activeGameId": None}, merge=True)

        return self._snapshot_to_game(game_ref.get())

    def configure_seat(self, game_id: str, host_id: str, seat_index: int, is_bot: bool) -> Dict[str, Any]:
        """Host-only seat configuration in lobby.

        Mirrors InMemoryPersistence.configure_seat semantics:
        - Only allowed while phase == "lobby".
        - Seat 0 (host) is not reconfigurable.
        - When toggling to bot, clear any existing player assignment and
          activeGameId for that user.
        - When toggling to human, mark seat as open human (no playerId yet).
        """

        game_ref = self._games_collection().document(game_id)
        snap = game_ref.get()
        if not snap.exists:
            raise ValueError("game_not_found")

        data = snap.to_dict() or {}
        if data.get("hostId") != host_id:
            raise ValueError("not_host")
        if data.get("phase") != "lobby":
            raise ValueError("not_lobby")

        seats: List[Dict[str, Any]] = data.get("seats", [])
        if not (0 <= seat_index < len(seats)):
            raise ValueError("invalid_seat")
        if seat_index == 0:
            # Mirror in-memory behaviour: do nothing for host seat.
            return self._snapshot_to_game(snap)

        seat = seats[seat_index]
        if is_bot:
            # Converting to bot clears player and activeGameId.
            prior_player_id = seat.get("playerId")
            if prior_player_id:
                user_ref = self._users_collection().document(prior_player_id)
                user_ref.set({"activeGameId": None}, merge=True)
            seat["playerId"] = None
            seat["displayName"] = None
            seat["isBot"] = True
            seat["status"] = "bot"
        else:
            seat["playerId"] = None
            seat["displayName"] = None
            seat["isBot"] = False
            seat["status"] = "open"

        data["seats"] = seats
        data["updatedAt"] = _now()
        game_ref.set(data)

        return self._snapshot_to_game(game_ref.get())

    def start_game(self, game_id: str, host_id: str) -> Dict[str, Any]:
        """Initialize an active GameState for a Firestore-backed game.

        Mirrors InMemoryPersistence.start_game: validates host, phase, and
        player counts, then uses the rules engine to initialize the game
        state and transitions the document to phase == "active".
        """

        game_ref = self._games_collection().document(game_id)
        snap = game_ref.get()
        if not snap.exists:
            raise ValueError("game_not_found")

        data = snap.to_dict() or {}
        if data.get("hostId") != host_id:
            raise ValueError("not_host")
        if data.get("phase") != "lobby":
            raise ValueError("not_lobby")

        seats_data: List[Dict[str, Any]] = data.get("seats", [])
        humans = [s for s in seats_data if not s.get("isBot") and s.get("playerId")]
        active_seats = [s for s in seats_data if s.get("playerId") or s.get("isBot")]
        if len(active_seats) < 2 or len(humans) < 1:
            raise ValueError("insufficient_players")

        settings_data = data.get("settings") or {}
        max_seats_val = settings_data.get("maxSeats")
        if not isinstance(max_seats_val, int):
            max_seats_val = len(seats_data)
        deck_seed = settings_data.get("deckSeed")
        settings = GameSettings(max_seats=max_seats_val, deck_seed=deck_seed)

        seats: List[Seat] = []
        for s in seats_data:
            seats.append(
                Seat(
                    index=int(s.get("index", 0)),
                    color=str(s.get("color", "")),
                    is_bot=bool(s.get("isBot")),
                    player_id=s.get("playerId"),
                    display_name=s.get("displayName"),
                    status=s.get("status", "open"),
                )
            )

        state = initialize_game(game_id, host_id, settings, seats)
        state_dict = game_state_to_dict(state)

        # Persist only the inner "state" payload in the Firestore document.
        data["state"] = state_dict["state"]
        data["phase"] = "active"
        data["updatedAt"] = _now()

        game_ref.set(data)

        # Return the updated game snapshot shaped like other FirestorePersistence methods.
        return self._snapshot_to_game(game_ref.get())

    def get_active_game_for_user(self, user_id: str) -> Optional[Dict[str, Any]]:
        """Lookup activeGameId in losiento_users and return that game document.

        Returns a game dict (as produced by _snapshot_to_game) or None.
        """

        user_ref = self._users_collection().document(user_id)
        snap = user_ref.get()
        if not snap.exists:
            return None
        data = snap.to_dict() or {}
        game_id = data.get("activeGameId")
        if not game_id:
            return None

        game_ref = self._games_collection().document(game_id)
        game_snap = game_ref.get()
        if not game_snap.exists:
            return None
        return self._snapshot_to_game(game_snap)

    def play_move(self, game_id: str, user_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
        """Apply a human player's move for a Firestore-backed game.

        This method now runs inside a Firestore transaction so that state
        updates and move logging are atomic and protected against concurrent
        writes.
        """

        game_ref = self._games_collection().document(game_id)

        if firestore is None:
            raise RuntimeError("firestore_client_unavailable")

        @firestore.transactional
        def _play_move_txn(
            transaction: Any,
            game_ref: Any,
            game_id: str,
            user_id: str,
            payload: Dict[str, Any],
        ) -> Dict[str, Any]:
            snap = transaction.get(game_ref)
            if not snap.exists:
                raise ValueError("game_not_found")

            data = snap.to_dict() or {}
            if data.get("phase") != "active":
                raise ValueError("game_not_started")

            state = self._decode_state(game_id, data)
            if state.result != "active":
                raise ValueError("game_over")

            seats_data: List[Dict[str, Any]] = data.get("seats", [])
            seat_index: Optional[int] = None
            for s in seats_data:
                if s.get("playerId") == user_id:
                    seat_index = int(s.get("index", 0))
                    break
            if seat_index is None:
                raise ValueError("not_in_game")
            if seat_index != state.current_seat_index:
                raise ValueError("not_your_turn")

            card = self._draw_card(state)

            moves = get_legal_moves(state, seat_index, card)
            if moves:
                # Snapshot state before and after applying the selected move so
                # we can log a move document.
                before_state_for_logging = game_state_to_dict(state)["state"]

                selected_move = _select_move(moves, payload)
                state = apply_move(state, selected_move)

                after_state_for_logging = game_state_to_dict(state)["state"]
                self._log_move_doc(
                    game_ref=game_ref,
                    game_id=game_id,
                    card=card,
                    seat_index=seat_index,
                    player_id=user_id,
                    state_before=before_state_for_logging,
                    state_after=after_state_for_logging,
                    transaction=transaction,
                )

            self._check_winner_state(state)

            # Card 2 grants an extra turn (draw another card) even if no move occurred.
            if state.result == "active" and card == "2":
                extra_card = self._draw_card(state)
                extra_moves = get_legal_moves(state, seat_index, extra_card)
                if extra_moves:
                    before_state_for_logging = game_state_to_dict(state)["state"]
                    state = apply_move(state, extra_moves[0])
                    after_state_for_logging = game_state_to_dict(state)["state"]
                    self._log_move_doc(
                        game_ref=game_ref,
                        game_id=game_id,
                        card=extra_card,
                        seat_index=seat_index,
                        player_id=user_id,
                        state_before=before_state_for_logging,
                        state_after=after_state_for_logging,
                        transaction=transaction,
                    )
                self._check_winner_state(state)

            if state.result == "active" and card != "2":
                self._advance_turn(seats_data, state)

            state_dict = game_state_to_dict(state)
            data["state"] = state_dict["state"]
            data["phase"] = state.phase
            data["updatedAt"] = _now()

            transaction.set(game_ref, data)

            result: Dict[str, Any] = dict(data)
            if "gameId" not in result:
                result["gameId"] = game_id
            return result

        transaction = self.client.transaction()
        return _play_move_txn(transaction, game_ref, game_id, user_id, payload)

    def bot_step(self, game_id: str) -> Dict[str, Any]:
        """Apply a bot move for the current bot-controlled seat.

        Uses a Firestore transaction so that state updates and move logging
        are atomic and resilient to concurrent callers.
        """

        game_ref = self._games_collection().document(game_id)

        if firestore is None:
            raise RuntimeError("firestore_client_unavailable")

        @firestore.transactional
        def _bot_step_txn(transaction: Any, game_ref: Any, game_id: str) -> Dict[str, Any]:
            snap = transaction.get(game_ref)
            if not snap.exists:
                raise ValueError("game_not_found")

            data = snap.to_dict() or {}
            if data.get("phase") != "active":
                raise ValueError("game_not_started")

            state = self._decode_state(game_id, data)
            if state.result != "active":
                raise ValueError("game_over")

            seats_data: List[Dict[str, Any]] = data.get("seats", [])
            current = state.current_seat_index
            if not (0 <= current < len(seats_data)) or not seats_data[current].get("isBot"):
                raise ValueError("not_bot_turn")

            card = self._draw_card(state)
            moves = get_legal_moves(state, current, card)
            if moves:
                before_state_for_logging = game_state_to_dict(state)["state"]
                rnd = __import__("random")
                move = rnd.choice(moves)
                state = apply_move(state, move)
                after_state_for_logging = game_state_to_dict(state)["state"]
                self._log_move_doc(
                    game_ref=game_ref,
                    game_id=game_id,
                    card=card,
                    seat_index=current,
                    player_id=None,
                    state_before=before_state_for_logging,
                    state_after=after_state_for_logging,
                    transaction=transaction,
                )

            self._check_winner_state(state)

            if state.result == "active" and card == "2":
                extra_card = self._draw_card(state)
                extra_moves = get_legal_moves(state, current, extra_card)
                if extra_moves:
                    before_state_for_logging = game_state_to_dict(state)["state"]
                    rnd = __import__("random")
                    move = rnd.choice(extra_moves)
                    state = apply_move(state, move)
                    after_state_for_logging = game_state_to_dict(state)["state"]
                    self._log_move_doc(
                        game_ref=game_ref,
                        game_id=game_id,
                        card=extra_card,
                        seat_index=current,
                        player_id=None,
                        state_before=before_state_for_logging,
                        state_after=after_state_for_logging,
                        transaction=transaction,
                    )
                self._check_winner_state(state)

            if state.result == "active" and card != "2":
                self._advance_turn(seats_data, state)

            state_dict = game_state_to_dict(state)
            data["state"] = state_dict["state"]
            data["phase"] = state.phase
            data["updatedAt"] = _now()

            transaction.set(game_ref, data)

            result: Dict[str, Any] = dict(data)
            if "gameId" not in result:
                result["gameId"] = game_id
            return result

        transaction = self.client.transaction()
        return _bot_step_txn(transaction, game_ref, game_id)

    def to_client(self, game: Dict[str, Any], user_id: str) -> Dict[str, Any]:
        """Shape a Firestore game dict into the client-facing payload.

        The shape mirrors InMemoryPersistence.to_client, but uses plain dicts
        rather than dataclasses.
        """

        seats: List[Dict[str, Any]] = game.get("seats", [])
        settings = game.get("settings", {})
        return {
            "gameId": game.get("gameId"),
            "phase": game.get("phase"),
            "hostId": game.get("hostId"),
            "hostName": game.get("hostName"),
            "settings": {
                "maxSeats": settings.get("maxSeats"),
                "deckSeed": settings.get("deckSeed"),
            },
            "seats": [
                {
                    "index": s.get("index"),
                    "color": s.get("color"),
                    "isBot": s.get("isBot"),
                    "playerId": s.get("playerId"),
                    "displayName": s.get("displayName"),
                    "status": s.get("status"),
                }
                for s in seats
            ],
            # For now, state is only present for future start_game / gameplay
            # implementations. Lobby games have state = None.
            "state": (game.get("state") if game.get("state") is not None else None),
        }
