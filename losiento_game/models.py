from __future__ import annotations

from dataclasses import dataclass
from typing import List, Optional, Literal, Dict, Any


Card = Literal["1", "2", "3", "4", "5", "7", "8", "10", "11", "12", "Sorry!"]


@dataclass
class PawnPosition:
    kind: Literal["start", "track", "safety", "home"]
    index: Optional[int] = None


@dataclass
class Pawn:
    pawn_id: str
    seat_index: int
    position: PawnPosition


@dataclass
class Seat:
    index: int
    color: str
    is_bot: bool
    player_id: Optional[str]
    display_name: Optional[str]
    status: Literal["open", "joined", "bot"]


@dataclass
class GameSettings:
    max_seats: int
    deck_seed: Optional[int] = None


@dataclass
class GameState:
    game_id: str
    host_id: str
    phase: Literal["lobby", "active", "finished", "aborted"]
    settings: GameSettings
    seats: List[Seat]
    deck: List[Card]
    discard_pile: List[Card]
    pawns: List[Pawn]
    turn_number: int
    current_seat_index: int
    winner_seat_index: Optional[int]
    result: Literal["active", "win", "aborted"]


def game_state_to_dict(state: GameState) -> Dict[str, Any]:
    return {
        "game_id": state.game_id,
        "host_id": state.host_id,
        "phase": state.phase,
        "settings": {
            "maxSeats": state.settings.max_seats,
            "deckSeed": state.settings.deck_seed,
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
            for s in state.seats
        ],
        "state": {
            "turnNumber": state.turn_number,
            "currentSeatIndex": state.current_seat_index,
            "deck": list(state.deck),
            "discardPile": list(state.discard_pile),
            "board": {
                "pawns": [
                    {
                        "pawnId": p.pawn_id,
                        "seatIndex": p.seat_index,
                        "position": {
                            "type": p.position.kind,
                            "index": p.position.index,
                        },
                    }
                    for p in state.pawns
                ]
            },
            "winnerSeatIndex": state.winner_seat_index,
            "result": state.result,
        },
    }
