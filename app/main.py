import logging
import os
from pathlib import Path
from typing import Optional

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from dotenv import load_dotenv

from losiento_game.persistence import InMemoryPersistence, FirestorePersistence

load_dotenv(dotenv_path=Path(".env.local"))

API_BASE = "/api/losiento"


def choose_persistence():
    use_inmem = os.getenv("USE_INMEMORY", "1").lower() in ("1", "true", "yes")
    if use_inmem:
        return InMemoryPersistence()
    try:
        return FirestorePersistence()
    except Exception:
        return InMemoryPersistence()


class HostGameBody(BaseModel):
    max_seats: int = Field(..., ge=2, le=4)
    display_name: Optional[str] = None


class JoinGameBody(BaseModel):
    game_id: str
    display_name: Optional[str] = None


class LeaveGameBody(BaseModel):
    game_id: str


class KickPlayerBody(BaseModel):
    game_id: str
    seat_index: int = Field(..., ge=0, le=3)


class ConfigureSeatBody(BaseModel):
    game_id: str
    seat_index: int = Field(..., ge=0, le=3)
    is_bot: bool


class StartGameBody(BaseModel):
    game_id: str


class PlayMoveBody(BaseModel):
    game_id: str
    payload: dict


def create_app(persistence=None) -> FastAPI:
    app = FastAPI(title="Lo Siento Service", version="0.1.0")

    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    app.state.persistence = persistence or choose_persistence()

    @app.on_event("startup")
    async def _log_persistence():
        try:
            klass = app.state.persistence.__class__.__name__
        except Exception:
            klass = str(type(app.state.persistence))
        use_inmem = os.getenv("USE_INMEMORY", "1").lower() in ("1", "true", "yes")
        emulator = os.getenv("FIRESTORE_EMULATOR_HOST")
        project = os.getenv("GOOGLE_CLOUD_PROJECT")
        logging.getLogger("uvicorn.error").info(
            f"[losiento] Persistence={klass} USE_INMEMORY={int(use_inmem)} FIRESTORE_EMULATOR_HOST={emulator or '-'} GOOGLE_CLOUD_PROJECT={project or '-'}"
        )

    def get_user_id(req: Request) -> str:
        is_cloud_run = bool(os.getenv("K_SERVICE") or os.getenv("K_REVISION") or os.getenv("K_CONFIGURATION"))
        trust_x_user_id = os.getenv("TRUST_X_USER_ID", "0" if is_cloud_run else "1").lower() in ("1", "true", "yes")
        allow_anon = os.getenv("ALLOW_ANON", "0" if is_cloud_run else "1").lower() in ("1", "true", "yes")
        default_uid = os.getenv("DEFAULT_USER_ID", "local-user")
        logger = logging.getLogger("uvicorn.error")

        iap_email = (
            req.headers.get("X-Goog-Authenticated-User-Email")
            or req.headers.get("X-Authenticated-User-Email")
            or req.headers.get("X-Forwarded-Email")
        )
        if iap_email:
            if ":" in iap_email:
                iap_email = iap_email.split(":", 1)[1]
            logger.info(
                f"[losiento] get_user_id via=iap_email user_id={iap_email} "
                f"is_cloud_run={int(is_cloud_run)} trust_x_user_id={int(trust_x_user_id)} allow_anon={int(allow_anon)}"
            )
            return iap_email
        forwarded_user = req.headers.get("X-Forwarded-User")
        if forwarded_user:
            logger.info(
                f"[losiento] get_user_id via=forwarded_user user_id={forwarded_user} "
                f"is_cloud_run={int(is_cloud_run)} trust_x_user_id={int(trust_x_user_id)} allow_anon={int(allow_anon)}"
            )
            return forwarded_user

        uid = req.headers.get("X-User-Id")
        if uid and trust_x_user_id:
            logger.info(
                f"[losiento] get_user_id via=x-user-id user_id={uid} "
                f"is_cloud_run={int(is_cloud_run)} trust_x_user_id={int(trust_x_user_id)} allow_anon={int(allow_anon)}"
            )
            return uid

        if allow_anon:
            logger.info(
                f"[losiento] get_user_id via=anon-fallback user_id={default_uid} "
                f"is_cloud_run={int(is_cloud_run)} trust_x_user_id={int(trust_x_user_id)} allow_anon={int(allow_anon)}"
            )
            return default_uid

        logger.warning(
            f"[losiento] get_user_id missing user id is_cloud_run={int(is_cloud_run)} "
            f"trust_x_user_id={int(trust_x_user_id)} allow_anon={int(allow_anon)}"
        )
        raise HTTPException(status_code=401, detail="missing user id")

    @app.post(f"{API_BASE}/host")
    def host_game(body: HostGameBody, user_id: str = Depends(get_user_id)):
        try:
            doc = app.state.persistence.host_game(user_id, body.max_seats, body.display_name)
        except ValueError as e:
            if str(e) == "active_game_exists":
                raise HTTPException(status_code=409, detail="active game exists")
            raise HTTPException(status_code=400, detail=str(e))
        return app.state.persistence.to_client(doc, user_id)

    @app.get(f"{API_BASE}/joinable")
    def list_joinable_games(user_id: str = Depends(get_user_id)):
        games = app.state.persistence.list_joinable_games(user_id)
        return {"games": games}

    @app.post(f"{API_BASE}/join")
    def join_game(body: JoinGameBody, user_id: str = Depends(get_user_id)):
        try:
            doc = app.state.persistence.join_game(body.game_id, user_id, body.display_name)
        except ValueError as e:
            msg = str(e)
            if msg in {"game_not_found", "not_lobby", "no_open_seat", "active_game_exists"}:
                code = 404 if msg == "game_not_found" else 409
                raise HTTPException(status_code=code, detail=msg)
            raise HTTPException(status_code=400, detail=msg)
        return app.state.persistence.to_client(doc, user_id)

    @app.post(f"{API_BASE}/leave")
    def leave_game(body: LeaveGameBody, user_id: str = Depends(get_user_id)):
        try:
            doc = app.state.persistence.leave_game(body.game_id, user_id)
        except ValueError as e:
            msg = str(e)
            if msg == "game_not_found":
                raise HTTPException(status_code=404, detail=msg)
            raise HTTPException(status_code=400, detail=msg)
        return app.state.persistence.to_client(doc, user_id)

    @app.post(f"{API_BASE}/kick")
    def kick_player(body: KickPlayerBody, user_id: str = Depends(get_user_id)):
        try:
            doc = app.state.persistence.kick_player(body.game_id, user_id, body.seat_index)
        except ValueError as e:
            msg = str(e)
            if msg == "game_not_found":
                raise HTTPException(status_code=404, detail=msg)
            raise HTTPException(status_code=400, detail=msg)
        return app.state.persistence.to_client(doc, user_id)

    @app.post(f"{API_BASE}/configure-seat")
    def configure_seat(body: ConfigureSeatBody, user_id: str = Depends(get_user_id)):
        try:
            doc = app.state.persistence.configure_seat(body.game_id, user_id, body.seat_index, body.is_bot)
        except ValueError as e:
            msg = str(e)
            if msg == "game_not_found":
                raise HTTPException(status_code=404, detail=msg)
            raise HTTPException(status_code=400, detail=msg)
        return app.state.persistence.to_client(doc, user_id)

    @app.post(f"{API_BASE}/start")
    def start_game(body: StartGameBody, user_id: str = Depends(get_user_id)):
        try:
            doc = app.state.persistence.start_game(body.game_id, user_id)
        except ValueError as e:
            msg = str(e)
            if msg == "game_not_found":
                raise HTTPException(status_code=404, detail=msg)
            raise HTTPException(status_code=400, detail=msg)
        return app.state.persistence.to_client(doc, user_id)

    @app.get(f"{API_BASE}/state")
    def get_state(user_id: str = Depends(get_user_id)):
        doc = app.state.persistence.get_active_game_for_user(user_id)
        if not doc:
            raise HTTPException(status_code=404, detail="no game")
        return app.state.persistence.to_client(doc, user_id)

    @app.get(f"{API_BASE}/legal-movers")
    def get_legal_movers(game_id: str, user_id: str = Depends(get_user_id)):
        """Return pawnIds for the caller's legal moves for the next card.

        This uses the persistence preview_legal_movers helper, which simulates a
        draw on a copied GameState and computes legal moves via the rules
        engine without mutating the authoritative game state.
        """

        try:
            return app.state.persistence.preview_legal_movers(game_id, user_id)
        except ValueError as e:
            msg = str(e)
            if msg == "game_not_found":
                raise HTTPException(status_code=404, detail=msg)
            raise HTTPException(status_code=400, detail=msg)

    @app.post(f"{API_BASE}/play")
    def play_move(body: PlayMoveBody, user_id: str = Depends(get_user_id)):
        try:
            doc = app.state.persistence.play_move(body.game_id, user_id, body.payload)
        except NotImplementedError:
            raise HTTPException(status_code=501, detail="play_move not implemented yet")
        except ValueError as e:
            msg = str(e)
            if msg == "game_not_found":
                raise HTTPException(status_code=404, detail=msg)
            raise HTTPException(status_code=400, detail=msg)
        return app.state.persistence.to_client(doc, user_id)

    @app.post(f"{API_BASE}/bot-step")
    def bot_step(game_id: str, user_id: str = Depends(get_user_id)):
        try:
            doc = app.state.persistence.bot_step(game_id)
        except NotImplementedError:
            raise HTTPException(status_code=501, detail="bot_step not implemented yet")
        except ValueError as e:
            msg = str(e)
            if msg == "game_not_found":
                raise HTTPException(status_code=404, detail=msg)
            raise HTTPException(status_code=400, detail=msg)
        return app.state.persistence.to_client(doc, user_id)

    frontend_dir = Path(__file__).resolve().parent.parent / "frontend"
    if frontend_dir.exists():
        app.mount("/", StaticFiles(directory=str(frontend_dir), html=True), name="frontend")

    return app


app = create_app()
