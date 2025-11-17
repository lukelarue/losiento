import unittest

from losiento_game.engine import (
    build_deck,
    initialize_game,
    get_legal_moves,
    apply_move,
    first_slide_indices,
    TRACK_LEN,
    Move,
)
from losiento_game.models import GameSettings, Seat, PawnPosition
from losiento_game.persistence import _select_move


class EngineBasicTests(unittest.TestCase):
    def _make_basic_state(self) -> tuple:
        seats = [
            Seat(index=0, color="red", is_bot=False, player_id="p0", display_name="p0", status="joined"),
            Seat(index=1, color="blue", is_bot=False, player_id="p1", display_name="p1", status="joined"),
        ]
        settings = GameSettings(max_seats=2, deck_seed=123)
        state = initialize_game("g1", "p0", settings, seats)
        return state, seats, settings

    def test_build_deck_counts(self) -> None:
        deck = build_deck()
        self.assertEqual(len(deck), 45)
        self.assertEqual(deck.count("1"), 5)
        for card in ["Sorry!", "2", "3", "4", "5", "7", "8", "10", "11", "12"]:
            self.assertEqual(deck.count(card), 4, msg=f"wrong count for card {card}")

    def test_initialize_game_pawns_start(self) -> None:
        state, seats, _ = self._make_basic_state()
        # 4 pawns per seat, all in start
        self.assertEqual(len(state.pawns), 4 * len(seats))
        for pawn in state.pawns:
            self.assertEqual(pawn.position.kind, "start")

    def test_card1_leaves_start(self) -> None:
        state, _, _ = self._make_basic_state()
        moves = get_legal_moves(state, seat_index=0, card="1")
        self.assertTrue(moves, "expected at least one legal move for card 1")
        new_state = apply_move(state, moves[0])
        pawns0 = [p for p in new_state.pawns if p.seat_index == 0]
        self.assertTrue(any(p.position.kind != "start" for p in pawns0), "card 1 should move a pawn out of start")

    def test_card4_moves_backward(self) -> None:
        # First, move a pawn for seat 0 out of start with card 1
        state, _, _ = self._make_basic_state()
        moves1 = get_legal_moves(state, seat_index=0, card="1")
        self.assertTrue(moves1)
        state = apply_move(state, moves1[0])
        # Now try a backward 4
        moves4 = get_legal_moves(state, seat_index=0, card="4")
        self.assertTrue(moves4, "expected at least one legal move for card 4")
        before_positions = {p.pawn_id: (p.position.kind, p.position.index) for p in state.pawns if p.seat_index == 0}
        state2 = apply_move(state, moves4[0])
        after_positions = {p.pawn_id: (p.position.kind, p.position.index) for p in state2.pawns if p.seat_index == 0}
        # At least one pawn for seat 0 should have changed position
        self.assertNotEqual(before_positions, after_positions)

    def test_card10_uses_backward_when_forward_impossible(self) -> None:
        state, _, _ = self._make_basic_state()

        # Place a pawn for seat 0 in Safety Zone index 0. From here, a forward-10
        # move would overshoot Home and be illegal, but a backward-1 move is
        # allowed (card 10's fallback).
        pawns0 = [p for p in state.pawns if p.seat_index == 0]
        pawn = pawns0[0]
        pawn.position = PawnPosition(kind="safety", index=0)

        moves = get_legal_moves(state, seat_index=0, card="10")
        self.assertTrue(moves, "expected at least one legal move for card 10")

        forward_moves = [m for m in moves if m.direction == "forward"]
        backward_moves = [m for m in moves if m.direction == "backward" and m.steps == 1]
        self.assertFalse(forward_moves, "no forward-10 move should be legal from safety index 0")
        self.assertTrue(backward_moves, "expected a backward-1 move when forward-10 is impossible")

        before_pos = (pawn.position.kind, pawn.position.index)
        new_state = apply_move(state, backward_moves[0])
        pawn_new = next(p for p in new_state.pawns if p.pawn_id == pawn.pawn_id)
        after_pos = (pawn_new.position.kind, pawn_new.position.index)
        self.assertNotEqual(before_pos, after_pos)

    def test_slide_into_safety_bumps_other_pawn(self) -> None:
        state, _, _ = self._make_basic_state()

        # Compute the start index of seat 0's first slide and place a pawn one
        # step before it, so that a card 1 will land on the slide start.
        slide_start = first_slide_indices(0)[0]
        before_idx = (slide_start - 1) % TRACK_LEN

        pawns0 = [p for p in state.pawns if p.seat_index == 0]
        mover = pawns0[0]
        mover.position = PawnPosition(kind="track", index=before_idx)

        # Place an opponent pawn on the slide start so that it will be bumped
        # when the mover slides into Safety.
        pawns1 = [p for p in state.pawns if p.seat_index == 1]
        blocker = pawns1[0]
        blocker.position = PawnPosition(kind="track", index=slide_start)

        moves = get_legal_moves(state, seat_index=0, card="1")
        self.assertTrue(moves, "expected a legal move landing on slide start")

        new_state = apply_move(state, moves[0])

        mover_new = next(p for p in new_state.pawns if p.pawn_id == mover.pawn_id)
        blocker_new = next(p for p in new_state.pawns if p.pawn_id == blocker.pawn_id)

        # Seat 0's first slide should send the mover directly into its Safety
        # Zone at index 0, and any pawn on the slide path should be bumped to
        # Start.
        self.assertEqual(mover_new.position.kind, "safety")
        self.assertEqual(mover_new.position.index, 0)
        self.assertEqual(blocker_new.position.kind, "start")

    def test_self_bump_moves_are_not_generated(self) -> None:
        state, _, _ = self._make_basic_state()

        pawns0 = [p for p in state.pawns if p.seat_index == 0]
        pawn_a = pawns0[0]
        pawn_b = pawns0[1]

        pawn_a.position = PawnPosition(kind="track", index=3)
        pawn_b.position = PawnPosition(kind="track", index=4)

        moves = get_legal_moves(state, seat_index=0, card="1")
        moving_pawns = {m.pawn_id for m in moves}

        self.assertNotIn(pawn_a.pawn_id, moving_pawns, "moves that would land on own pawn should be excluded")

    def test_safety_to_home_exact_count(self) -> None:
        state, _, _ = self._make_basic_state()

        pawns0 = [p for p in state.pawns if p.seat_index == 0]
        pawn = pawns0[0]
        # Place pawn in Safety Zone index 3; card 2 should move it exactly
        # into Home (index 5 == SAFE_ZONE_LEN).
        pawn.position = PawnPosition(kind="safety", index=3)

        moves = get_legal_moves(state, seat_index=0, card="2")
        self.assertTrue(moves, "expected a legal move from safety index 3 with card 2")

        new_state = apply_move(state, moves[0])
        pawn_new = next(p for p in new_state.pawns if p.pawn_id == pawn.pawn_id)
        self.assertEqual(pawn_new.position.kind, "home")

    def test_slide_on_other_color_still_applies_and_bumps(self) -> None:
        state, _, _ = self._make_basic_state()

        slide_start = first_slide_indices(1)[0]
        before_idx = (slide_start - 1) % TRACK_LEN

        pawns0 = [p for p in state.pawns if p.seat_index == 0]
        pawns1 = [p for p in state.pawns if p.seat_index == 1]

        mover = pawns0[0]
        mover.position = PawnPosition(kind="track", index=before_idx)

        blocker = pawns1[0]
        blocker.position = PawnPosition(kind="track", index=slide_start)

        moves = get_legal_moves(state, seat_index=0, card="1")
        self.assertTrue(moves, "expected a legal move landing on other color's slide start")

        new_state = apply_move(state, moves[0])
        mover_new = next(p for p in new_state.pawns if p.pawn_id == mover.pawn_id)
        blocker_new = next(p for p in new_state.pawns if p.pawn_id == blocker.pawn_id)

        other_slide_indices = first_slide_indices(1)
        slide_end = other_slide_indices[-1]

        self.assertEqual(mover_new.position.kind, "track")
        self.assertEqual(mover_new.position.index, slide_end)
        self.assertEqual(blocker_new.position.kind, "start")

    def test_card11_forward_and_switch(self) -> None:
        state, seats, _ = self._make_basic_state()

        # Place one pawn for seat 0 and one pawn for seat 1 on the track.
        pawns0 = [p for p in state.pawns if p.seat_index == 0]
        pawns1 = [p for p in state.pawns if p.seat_index == 1]
        mover = pawns0[0]
        target = pawns1[0]
        mover.position = PawnPosition(kind="track", index=0)
        target.position = PawnPosition(kind="track", index=10)

        # First, ensure we still get at least one forward-11 move.
        moves = get_legal_moves(state, seat_index=0, card="11")
        forward_moves = [m for m in moves if m.direction == "forward" and m.steps == 11]
        self.assertTrue(forward_moves, "expected at least one forward-11 move")

        # Then, ensure that a switch-with-opponent move is available and works.
        switch_moves = [m for m in moves if m.card == "11" and m.target_pawn_id == target.pawn_id]
        self.assertTrue(switch_moves, "expected at least one 11-switch move targeting opponent pawn")

        switch_move = switch_moves[0]
        new_state = apply_move(state, switch_move)

        mover_new = next(p for p in new_state.pawns if p.pawn_id == mover.pawn_id)
        target_new = next(p for p in new_state.pawns if p.pawn_id == target.pawn_id)

        self.assertEqual(mover_new.position.kind, "track")
        self.assertEqual(target_new.position.kind, "track")
        self.assertEqual(mover_new.position.index, 10, "mover should take target's original index")
        self.assertEqual(target_new.position.index, 0, "target should take mover's original index")

    def test_card7_cannot_leave_start(self) -> None:
        state, _, _ = self._make_basic_state()

        moves = get_legal_moves(state, seat_index=0, card="7")
        self.assertFalse(moves, "card 7 should not provide moves when all pawns are in start")

    def test_card7_split_two_pawns_uses_seven_total(self) -> None:
        state, _, _ = self._make_basic_state()

        pawns0 = [p for p in state.pawns if p.seat_index == 0]
        pawn_a = pawns0[0]
        pawn_b = pawns0[1]
        pawn_a.position = PawnPosition(kind="track", index=4)
        pawn_b.position = PawnPosition(kind="track", index=10)

        moves = get_legal_moves(state, seat_index=0, card="7")
        split_moves = [
            m
            for m in moves
            if m.secondary_pawn_id is not None and m.secondary_direction == "forward"
        ]
        self.assertTrue(split_moves, "expected at least one 7-split move")

        move = split_moves[0]
        total_steps = (move.steps or 0) + (move.secondary_steps or 0)
        self.assertEqual(total_steps, 7, "7-split move must use all 7 spaces in total")

        new_state = apply_move(state, move)
        pawn_a_new = next(p for p in new_state.pawns if p.pawn_id == pawn_a.pawn_id)
        pawn_b_new = next(p for p in new_state.pawns if p.pawn_id == pawn_b.pawn_id)

        self.assertNotEqual(
            (pawn_a_new.position.kind, pawn_a_new.position.index),
            (pawn_a.position.kind, pawn_a.position.index),
        )
        self.assertNotEqual(
            (pawn_b_new.position.kind, pawn_b_new.position.index),
            (pawn_b.position.kind, pawn_b.position.index),
        )

    def test_card11_cannot_leave_start(self) -> None:
        state, _, _ = self._make_basic_state()

        moves = get_legal_moves(state, seat_index=0, card="11")
        self.assertFalse(moves, "card 11 should not provide moves when all pawns are in start")

    def test_card11_cannot_switch_with_safety_or_home(self) -> None:
        state, _, _ = self._make_basic_state()

        pawns0 = [p for p in state.pawns if p.seat_index == 0]
        pawns1 = [p for p in state.pawns if p.seat_index == 1]

        mover = pawns0[0]
        mover.position = PawnPosition(kind="track", index=0)

        track_pawn = pawns1[0]
        safety_pawn = pawns1[1]
        home_pawn = pawns1[2]

        track_pawn.position = PawnPosition(kind="track", index=5)
        safety_pawn.position = PawnPosition(kind="safety", index=0)
        home_pawn.position = PawnPosition(kind="home", index=None)

        moves = get_legal_moves(state, seat_index=0, card="11")
        targets = {m.target_pawn_id for m in moves if m.target_pawn_id is not None}

        self.assertIn(track_pawn.pawn_id, targets)
        self.assertNotIn(safety_pawn.pawn_id, targets)
        self.assertNotIn(home_pawn.pawn_id, targets)

    def test_sorry_basic_bump_from_start(self) -> None:
        state, _, _ = self._make_basic_state()

        pawns0 = [p for p in state.pawns if p.seat_index == 0]
        pawns1 = [p for p in state.pawns if p.seat_index == 1]

        start_pawn = pawns0[0]
        target = pawns1[0]
        target.position = PawnPosition(kind="track", index=5)

        moves = get_legal_moves(state, seat_index=0, card="Sorry!")
        sorry_moves = [m for m in moves if m.target_pawn_id == target.pawn_id]
        self.assertTrue(sorry_moves, "expected at least one Sorry! move targeting the opponent pawn")

        new_state = apply_move(state, sorry_moves[0])
        start_new = next(p for p in new_state.pawns if p.pawn_id == start_pawn.pawn_id)
        target_new = next(p for p in new_state.pawns if p.pawn_id == target.pawn_id)

        self.assertEqual(start_new.position.kind, "track")
        self.assertEqual(start_new.position.index, 5)
        self.assertEqual(target_new.position.kind, "start")

    def test_sorry_requires_pawn_in_start(self) -> None:
        state, _, _ = self._make_basic_state()

        pawns0 = [p for p in state.pawns if p.seat_index == 0]
        pawns1 = [p for p in state.pawns if p.seat_index == 1]

        for i, pawn in enumerate(pawns0):
            pawn.position = PawnPosition(kind="track", index=i)

        opp = pawns1[0]
        opp.position = PawnPosition(kind="track", index=10)

        moves = get_legal_moves(state, seat_index=0, card="Sorry!")
        self.assertFalse(moves, "expected no Sorry! move when no pawn is in start")

    def test_sorry_cannot_target_safety_or_home(self) -> None:
        state, _, _ = self._make_basic_state()

        pawns0 = [p for p in state.pawns if p.seat_index == 0]
        pawns1 = [p for p in state.pawns if p.seat_index == 1]

        track_pawn = pawns1[0]
        safety_pawn = pawns1[1]
        home_pawn = pawns1[2]

        track_pawn.position = PawnPosition(kind="track", index=5)
        safety_pawn.position = PawnPosition(kind="safety", index=0)
        home_pawn.position = PawnPosition(kind="home", index=None)

        moves = get_legal_moves(state, seat_index=0, card="Sorry!")
        targets = {m.target_pawn_id for m in moves if m.target_pawn_id is not None}

        self.assertIn(track_pawn.pawn_id, targets)
        self.assertNotIn(safety_pawn.pawn_id, targets)
        self.assertNotIn(home_pawn.pawn_id, targets)


class MoveSelectionTests(unittest.TestCase):
    def _make_moves(self) -> list[Move]:
        return [
            Move(card="1", seat_index=0, pawn_id="p1", direction="forward", steps=1),
            Move(card="1", seat_index=0, pawn_id="p2", direction="forward", steps=1),
        ]

    def test_select_move_single_without_payload(self) -> None:
        moves = [Move(card="1", seat_index=0, pawn_id="p1", direction="forward", steps=1)]
        selected = _select_move(moves, {})
        self.assertIs(selected, moves[0])

    def test_select_move_requires_payload_for_multiple(self) -> None:
        moves = self._make_moves()
        with self.assertRaises(ValueError):
            _ = _select_move(moves, {})

    def test_select_move_by_index(self) -> None:
        moves = self._make_moves()
        selected = _select_move(moves, {"moveIndex": 1})
        self.assertIs(selected, moves[1])

    def test_select_move_by_descriptor(self) -> None:
        moves = self._make_moves()
        payload = {"move": {"pawnId": "p2"}}
        selected = _select_move(moves, payload)
        self.assertIs(selected, moves[1])

    def test_select_move_descriptor_no_match_raises(self) -> None:
        moves = self._make_moves()
        with self.assertRaises(ValueError):
            _ = _select_move(moves, {"move": {"pawnId": "missing"}})


if __name__ == "__main__":
    unittest.main()
