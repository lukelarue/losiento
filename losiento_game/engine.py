from __future__ import annotations

from dataclasses import dataclass
from typing import List, Dict, Optional
import random
import copy

from .models import GameSettings, GameState, Seat, Pawn, PawnPosition, Card


@dataclass
class Move:
    card: Card
    seat_index: int
    pawn_id: str
    # "forward" / "backward" for simple numeric cards; None for non-directional moves like Sorry!
    direction: Optional[str] = None
    # Step count for numeric cards; None for cards like Sorry!
    steps: Optional[int] = None
    # Target pawn for Sorry! (and future switch behavior for 11); None for simple moves.
    target_pawn_id: Optional[str] = None
    secondary_pawn_id: Optional[str] = None
    secondary_direction: Optional[str] = None
    secondary_steps: Optional[int] = None


COLORS = ["red", "blue", "yellow", "green"]

# Board geometry (see rules.md §5.7)
NUM_COLORS = 4
TRACK_SEGMENT_LEN = 15  # per color: first slide (4) + 5 normal -> second slide (5) + 1
TRACK_LEN = NUM_COLORS * TRACK_SEGMENT_LEN  # 60
SAFE_ZONE_LEN = 5
FIRST_SLIDE_LEN = 4
SECOND_SLIDE_LEN = 5


def segment_offset(seat_index: int) -> int:
    """Return the starting track index for the given seat's color segment.

    Seat indices are assumed to be 0..3 and map directly to COLORS order.
    """

    return (seat_index % NUM_COLORS) * TRACK_SEGMENT_LEN


def first_slide_indices(seat_index: int) -> List[int]:
    off = segment_offset(seat_index)
    start = (off + 1) % TRACK_LEN
    return [(start + i) % TRACK_LEN for i in range(FIRST_SLIDE_LEN)]


def second_slide_indices(seat_index: int) -> List[int]:
    fs = first_slide_indices(seat_index)
    # From rules: 4 (first slide) + 5 normal -> second slide start after 5 normal spaces
    start = (fs[-1] + 1 + 5) % TRACK_LEN
    return [(start + i) % TRACK_LEN for i in range(SECOND_SLIDE_LEN)]


def safe_entry_index(seat_index: int) -> int:
    """Track index where this seat's Safety Zone is entered.

    From rules: entry coincides with the last square of that color's first slide
    on the outer track.
    """

    fs = first_slide_indices(seat_index)
    return fs[1]


def build_slides() -> Dict[int, Dict[str, object]]:
    """Construct a mapping from slide start index -> slide metadata.

    Each slide record contains:
      - owner_seat: seat index that "owns" the segment (for slide-into-safety rule)
      - indices: ordered list of track indices along the slide (including start)
      - is_near_safety: True only for the first slide of each color
    """

    slides: Dict[int, Dict[str, object]] = {}
    for seat in range(NUM_COLORS):
        fs = first_slide_indices(seat)
        ss = second_slide_indices(seat)
        slides[fs[0]] = {
            "owner_seat": seat,
            "indices": fs,
            "is_near_safety": True,
        }
        slides[ss[0]] = {
            "owner_seat": seat,
            "indices": ss,
            "is_near_safety": False,
        }
    return slides


SLIDES = build_slides()


def _find_pawn_on_track(state: GameState, track_index: int) -> Optional[Pawn]:
    for p in state.pawns:
        pos = p.position
        if pos.kind == "track" and pos.index == track_index:
            return p
    return None


def _find_pawn_in_safety(state: GameState, seat_index: int, safety_index: int) -> Optional[Pawn]:
    for p in state.pawns:
        pos = p.position
        if pos.kind == "safety" and p.seat_index == seat_index and pos.index == safety_index:
            return p
    return None


def _pawns_for_seat(state: GameState, seat_index: int) -> List[Pawn]:
    return [p for p in state.pawns if p.seat_index == seat_index]


def _advance_track(index: int, steps: int) -> int:
    return (index + steps) % TRACK_LEN


def _retreat_track(index: int, steps: int) -> int:
    return (index - steps) % TRACK_LEN


def _apply_slides_and_safety(
    state: GameState,
    pawn: Pawn,
    track_index: int,
    *,
    forward: bool,
) -> tuple[PawnPosition, Optional[List[int]]]:
    slide = SLIDES.get(track_index)
    slide_indices: Optional[List[int]] = None
    if slide is not None:
        slide_indices = list(slide["indices"])  # type: ignore[assignment]
        end_idx = slide_indices[-1]
        owner_seat = int(slide["owner_seat"])  # type: ignore[arg-type]
        is_near_safety = bool(slide["is_near_safety"])  # type: ignore[arg-type]
        if forward and is_near_safety and owner_seat == pawn.seat_index:
            return PawnPosition(kind="safety", index=0), slide_indices
        track_index = end_idx

    return PawnPosition(kind="track", index=track_index), slide_indices


def _bump_pawns_on_indices(state: GameState, indices: List[int], moving_pawn: Pawn) -> None:
    for p in state.pawns:
        if p is moving_pawn:
            continue
        pos = p.position
        if pos.kind == "track" and pos.index in indices:
            p.position = PawnPosition(kind="start", index=None)


def _apply_single_forward(state: GameState, pawn: Pawn, steps: int) -> bool:
    pos = pawn.position
    if pos.kind == "home":
        return False
    if pos.kind == "start":
        fs = first_slide_indices(pawn.seat_index)
        start_idx = fs[-1]
        if steps < 1:
            return False
        track_index = start_idx
        remaining = steps - 1
        if remaining > 0:
            track_index = _advance_track(track_index, remaining)
        final_pos, slide_indices = _apply_slides_and_safety(state, pawn, track_index, forward=True)
    elif pos.kind == "track":
        cur = pos.index or 0
        entry_idx = safe_entry_index(pawn.seat_index)
        dist_to_entry = (entry_idx - cur) % TRACK_LEN
        if steps <= dist_to_entry:
            track_index = _advance_track(cur, steps)
            final_pos, slide_indices = _apply_slides_and_safety(state, pawn, track_index, forward=True)
        else:
            steps_into_safety = steps - dist_to_entry
            remaining_in_safety = steps_into_safety - 1
            if remaining_in_safety < 0:
                return False
            if remaining_in_safety < SAFE_ZONE_LEN:
                final_pos, slide_indices = PawnPosition(kind="safety", index=remaining_in_safety), None
            elif remaining_in_safety == SAFE_ZONE_LEN:
                final_pos, slide_indices = PawnPosition(kind="home", index=None), None
            else:
                return False
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

    if final_pos.kind == "track":
        target = _find_pawn_on_track(state, final_pos.index or 0)
        if target is not None and target.seat_index == pawn.seat_index:
            return False
        if target is not None:
            target.position = PawnPosition(kind="start", index=None)

    if final_pos.kind == "safety":
        target = _find_pawn_in_safety(state, pawn.seat_index, final_pos.index or 0)
        if target is not None:
            return False

    if slide_indices:
        _bump_pawns_on_indices(state, slide_indices, pawn)

    pawn.position = final_pos
    return True


def _apply_single_backward(state: GameState, pawn: Pawn, steps: int) -> bool:
    pos = pawn.position
    if pos.kind in ("start", "home"):
        return False
    if pos.kind == "track":
        track_index = _retreat_track(pos.index or 0, steps)
        final_pos, slide_indices = _apply_slides_and_safety(state, pawn, track_index, forward=False)
    else:
        cur = pos.index or 0
        if steps <= cur:
            final_pos, slide_indices = PawnPosition(kind="safety", index=cur - steps), None
        else:
            remaining = steps - (cur + 1)
            from_entry = safe_entry_index(pawn.seat_index)
            track_index = _retreat_track(from_entry, remaining)
            final_pos, slide_indices = _apply_slides_and_safety(state, pawn, track_index, forward=False)

    if final_pos.kind == "track":
        target = _find_pawn_on_track(state, final_pos.index or 0)
        if target is not None and target.seat_index == pawn.seat_index:
            return False
        if target is not None:
            target.position = PawnPosition(kind="start", index=None)

    if final_pos.kind == "safety":
        target = _find_pawn_in_safety(state, pawn.seat_index, final_pos.index or 0)
        if target is not None:
            return False

    if slide_indices:
        _bump_pawns_on_indices(state, slide_indices, pawn)

    pawn.position = final_pos
    return True


def build_deck() -> List[Card]:
    deck: List[Card] = []
    deck.extend(["1"] * 5)
    for card in ["Sorry!", "2", "3", "4", "5", "7", "8", "10", "11", "12"]:
        deck.extend([card] * 4)
    return deck


def shuffle_deck(seed: int | None) -> List[Card]:
    deck = build_deck()
    rng = random.Random(seed)
    rng.shuffle(deck)
    return deck


def initial_pawns(game_id: str, seats: List[Seat]) -> List[Pawn]:
    pawns: List[Pawn] = []
    for seat in seats:
        for i in range(4):
            pawn_id = f"{game_id}_s{seat.index}_p{i}"
            pawns.append(
                Pawn(
                    pawn_id=pawn_id,
                    seat_index=seat.index,
                    position=PawnPosition(kind="start"),
                )
            )
    return pawns


def initialize_game(game_id: str, host_id: str, settings: GameSettings, seats: List[Seat]) -> GameState:
    deck = shuffle_deck(settings.deck_seed)
    pawns = initial_pawns(game_id, seats)
    return GameState(
        game_id=game_id,
        host_id=host_id,
        phase="active",
        settings=settings,
        seats=seats,
        deck=deck,
        discard_pile=[],
        pawns=pawns,
        turn_number=0,
        current_seat_index=0,
        winner_seat_index=None,
        result="active",
    )


def get_legal_moves(state: GameState, seat_index: int, card: Card) -> List[Move]:
    """Enumerate legal moves for the given seat and card.

    This implementation mirrors the current behavior in InMemoryPersistence:
    - No 7-split; 7 is a single forward-7 move.
    - 11 supports either forward-11 or switch with an opponent pawn on the track.
    - 10 prefers forward-10; only uses backward-1 if no forward moves exist.
    - Sorry! from Start to an opponent pawn on the track, with slide rules applied.
    """

    moves: List[Move] = []
    pawns = _pawns_for_seat(state, seat_index)

    def collect_forward(target_list: List[Move], steps: int, allow_from_start: bool) -> None:
        for pawn in pawns:
            pos_kind = pawn.position.kind
            if pos_kind == "start" and not allow_from_start:
                continue
            if pos_kind not in ("start", "track", "safety"):
                continue
            tmp_state = copy.deepcopy(state)
            tmp_pawn = next(p for p in tmp_state.pawns if p.pawn_id == pawn.pawn_id)
            if _apply_single_forward(tmp_state, tmp_pawn, steps):
                target_list.append(
                    Move(
                        card=card,
                        seat_index=seat_index,
                        pawn_id=pawn.pawn_id,
                        direction="forward",
                        steps=steps,
                    )
                )

    def collect_backward(target_list: List[Move], steps: int) -> None:
        for pawn in pawns:
            pos_kind = pawn.position.kind
            if pos_kind not in ("track", "safety"):
                continue
            tmp_state = copy.deepcopy(state)
            tmp_pawn = next(p for p in tmp_state.pawns if p.pawn_id == pawn.pawn_id)
            if _apply_single_backward(tmp_state, tmp_pawn, steps):
                target_list.append(
                    Move(
                        card=card,
                        seat_index=seat_index,
                        pawn_id=pawn.pawn_id,
                        direction="backward",
                        steps=steps,
                    )
                )

    if card == "1":
        collect_forward(moves, 1, allow_from_start=True)
    elif card == "2":
        collect_forward(moves, 2, allow_from_start=True)
    elif card == "3":
        collect_forward(moves, 3, allow_from_start=False)
    elif card == "4":
        collect_backward(moves, 4)
    elif card == "5":
        collect_forward(moves, 5, allow_from_start=False)
    elif card == "7":
        # For now, treat 7 as a single forward-7 move (no split behavior).
        collect_forward(moves, 7, allow_from_start=False)

        for first_steps in range(1, 7):
            second_steps = 7 - first_steps
            if second_steps <= 0:
                continue
            for pawn1 in pawns:
                if pawn1.position.kind not in ("track", "safety"):
                    continue
                tmp_state1 = copy.deepcopy(state)
                tmp_pawn1 = next(p for p in tmp_state1.pawns if p.pawn_id == pawn1.pawn_id)
                if not _apply_single_forward(tmp_state1, tmp_pawn1, first_steps):
                    continue
                for pawn2 in pawns:
                    if pawn2.pawn_id == pawn1.pawn_id:
                        continue
                    if pawn2.position.kind not in ("track", "safety"):
                        continue
                    tmp_state2 = copy.deepcopy(tmp_state1)
                    tmp_pawn2 = next(p for p in tmp_state2.pawns if p.pawn_id == pawn2.pawn_id)
                    if tmp_pawn2.position.kind == "start":
                        continue
                    if not _apply_single_forward(tmp_state2, tmp_pawn2, second_steps):
                        continue
                    moves.append(
                        Move(
                            card=card,
                            seat_index=seat_index,
                            pawn_id=pawn1.pawn_id,
                            direction="forward",
                            steps=first_steps,
                            target_pawn_id=None,
                            secondary_pawn_id=pawn2.pawn_id,
                            secondary_direction="forward",
                            secondary_steps=second_steps,
                        )
                    )
    elif card == "8":
        collect_forward(moves, 8, allow_from_start=False)
    elif card == "10":
        # Prefer forward-10; if no such moves exist, allow backward-1 moves.
        forward_moves: List[Move] = []
        collect_forward(forward_moves, 10, allow_from_start=False)
        if forward_moves:
            moves.extend(forward_moves)
        else:
            backward_moves: List[Move] = []
            collect_backward(backward_moves, 1)
            moves.extend(backward_moves)
    elif card == "11":
        # Support both forward-11 and switch-with-opponent behavior.
        # First, collect standard forward-11 moves.
        collect_forward(moves, 11, allow_from_start=False)

        # Then, add switch moves: swap positions with an opponent pawn on the track.
        for pawn in pawns:
            if pawn.position.kind != "track":
                continue
            for target in state.pawns:
                if target.seat_index == seat_index:
                    continue
                if target.position.kind != "track":
                    continue
                moves.append(
                    Move(
                        card=card,
                        seat_index=seat_index,
                        pawn_id=pawn.pawn_id,
                        direction=None,
                        steps=None,
                        target_pawn_id=target.pawn_id,
                    )
                )
    elif card == "12":
        collect_forward(moves, 12, allow_from_start=False)
    elif card == "Sorry!":
        # From Start to an opponent pawn on the track, applying slide rules.
        start_pawn = next((p for p in pawns if p.position.kind == "start"), None)
        if start_pawn is None:
            return moves
        for target in state.pawns:
            if target.seat_index == seat_index:
                continue
            if target.position.kind != "track":
                continue
            tmp_state = copy.deepcopy(state)
            tmp_start = next(p for p in tmp_state.pawns if p.pawn_id == start_pawn.pawn_id)
            tmp_target = next(p for p in tmp_state.pawns if p.pawn_id == target.pawn_id)
            target_idx = tmp_target.position.index or 0
            final_pos, slide_indices = _apply_slides_and_safety(tmp_state, tmp_start, target_idx, forward=True)
            if final_pos.kind == "track":
                # Bump the target pawn (and any pawns on slide).
                tmp_target.position = PawnPosition(kind="start", index=None)
                if slide_indices:
                    _bump_pawns_on_indices(tmp_state, slide_indices, tmp_start)
                tmp_start.position = final_pos
                moves.append(
                    Move(
                        card=card,
                        seat_index=seat_index,
                        pawn_id=start_pawn.pawn_id,
                        direction="forward",
                        steps=None,
                        target_pawn_id=target.pawn_id,
                    )
                )
            # If final_pos.kind == "safety", Sorry! cannot enter Safety Zone; skip.

    return moves


def apply_move(state: GameState, move: Move) -> GameState:
    """Apply a Move produced by get_legal_moves to a copy of state and return new state.

    This function assumes the move was validated/generated by get_legal_moves and
    preserves the same simplified semantics (no 7-split, etc.).
    """

    new_state = copy.deepcopy(state)

    # Locate the moving pawn in the copied state
    pawn = next(
        (p for p in new_state.pawns if p.pawn_id == move.pawn_id and p.seat_index == move.seat_index),
        None,
    )
    if pawn is None:
        raise ValueError("invalid_move_pawn_not_found")

    # Sorry! is special: move from Start to an opponent pawn on the track, applying slides/bumps
    if move.card == "Sorry!":
        if move.target_pawn_id is None:
            raise ValueError("invalid_move_missing_target")
        if pawn.position.kind != "start":
            raise ValueError("invalid_move_sorry_requires_start")
        target = next((p for p in new_state.pawns if p.pawn_id == move.target_pawn_id), None)
        if target is None:
            raise ValueError("invalid_move_target_not_found")
        if target.position.kind != "track":
            raise ValueError("invalid_move_target_not_on_track")
        target_idx = target.position.index or 0
        final_pos, slide_indices = _apply_slides_and_safety(new_state, pawn, target_idx, forward=True)
        if final_pos.kind != "track":
            # Sorry! cannot enter Safety or Home; such a move should not be produced by get_legal_moves
            raise ValueError("invalid_move_sorry_cannot_enter_safety_or_home")
        # Bump the target pawn (and any pawns on slide indices)
        target.position = PawnPosition(kind="start", index=None)
        if slide_indices:
            _bump_pawns_on_indices(new_state, slide_indices, pawn)
        pawn.position = final_pos
        return new_state

    # 11-switch: swap places with an opponent pawn on the track.
    if move.card == "11" and move.target_pawn_id is not None:
        target = next((p for p in new_state.pawns if p.pawn_id == move.target_pawn_id), None)
        if target is None:
            raise ValueError("invalid_move_target_not_found")
        if pawn.position.kind != "track" or target.position.kind != "track":
            raise ValueError("invalid_move_11_switch_requires_track")
        pawn.position, target.position = target.position, pawn.position
        return new_state

    if move.card == "7" and move.secondary_pawn_id is not None:
        if move.direction != "forward" or move.steps is None:
            raise ValueError("invalid_move_7_split_missing_primary")
        if move.secondary_direction != "forward" or move.secondary_steps is None:
            raise ValueError("invalid_move_7_split_missing_secondary")
        ok_first = _apply_single_forward(new_state, pawn, move.steps)
        if not ok_first:
            raise ValueError("invalid_move_7_split_primary_illegal")
        second_pawn = next(
            (
                p
                for p in new_state.pawns
                if p.pawn_id == move.secondary_pawn_id and p.seat_index == move.seat_index
            ),
            None,
        )
        if second_pawn is None:
            raise ValueError("invalid_move_7_split_secondary_not_found")
        ok_second = _apply_single_forward(new_state, second_pawn, move.secondary_steps)
        if not ok_second:
            raise ValueError("invalid_move_7_split_secondary_illegal")
        return new_state

    # All other cards are numeric movement using direction + steps
    if move.steps is None or move.direction is None:
        raise ValueError("invalid_move_missing_steps_or_direction")

    if move.direction == "forward":
        ok = _apply_single_forward(new_state, pawn, move.steps)
    elif move.direction == "backward":
        ok = _apply_single_backward(new_state, pawn, move.steps)
    else:
        raise ValueError("invalid_move_direction")

    if not ok:
        # Should not happen if move came from get_legal_moves, but guard anyway
        raise ValueError("invalid_move_illegal_destination")

    return new_state
