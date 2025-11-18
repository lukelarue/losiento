(() => {
  const API_BASE = "/api/losiento";

  const screens = {
    loading: document.getElementById("screen-loading"),
    noGame: document.getElementById("screen-no-game"),
    lobby: document.getElementById("screen-lobby"),
    game: document.getElementById("screen-game"),
  };

  const hostForm = document.getElementById("host-form");
  const hostDisplayName = document.getElementById("host-display-name");
  const hostMaxSeats = document.getElementById("host-max-seats");
  const joinableList = document.getElementById("joinable-list");
  const refreshJoinableBtn = document.getElementById("refresh-joinable");

  const lobbyMetaEl = document.getElementById("lobby-meta");
  const lobbySeatsEl = document.getElementById("lobby-seats");
  const startGameBtn = document.getElementById("start-game");
  const leaveLobbyBtn = document.getElementById("leave-lobby");

  const gameMetaEl = document.getElementById("game-meta");
  const trackGridEl = document.getElementById("track-grid");
  const startAreasEl = document.getElementById("start-areas");
  const safetyHomeEl = document.getElementById("safety-home");
  const playMoveBtn = document.getElementById("play-move");
  const botStepBtn = document.getElementById("bot-step-btn");
  const leaveGameBtn = document.getElementById("leave-game");

  const toastEl = document.getElementById("toast");

  let currentGame = null;
  let pollTimer = null;
  let selectedPawnId = null;
  let legalMoverPawnIds = new Set();
  let lastShownCard = null;
  let lastShownGameId = null;

  function showToast(message, millis = 2500) {
    toastEl.textContent = message;
    toastEl.classList.remove("hidden");
    clearTimeout(toastEl._timer);
    toastEl._timer = setTimeout(() => {
      toastEl.classList.add("hidden");
    }, millis);
  }

  function getCardDescription(card) {
    if (!card) return null;
    switch (card) {
      case "1":
        return "Card 1 – move a pawn 1 space or leave Start.";
      case "2":
        return "Card 2 – move a pawn 2 spaces and draw again.";
      case "3":
        return "Card 3 – move a pawn 3 spaces forward.";
      case "4":
        return "Card 4 – move a pawn 4 spaces backward.";
      case "5":
        return "Card 5 – move a pawn 5 spaces forward.";
      case "7":
        return "Card 7 – move 7 spaces or split between two pawns.";
      case "8":
        return "Card 8 – move a pawn 8 spaces forward.";
      case "10":
        return "Card 10 – move 10 spaces forward or 1 space backward.";
      case "11":
        return "Card 11 – move 11 spaces forward or switch with an opponent pawn.";
      case "12":
        return "Card 12 – move a pawn 12 spaces forward.";
      case "Sorry!":
        return "Sorry! – move from Start and bump an opponent pawn.";
      default:
        return `Card ${card}`;
    }
  }

  function setScreen(name) {
    Object.values(screens).forEach((el) => el.classList.add("hidden"));
    const el = screens[name];
    if (el) el.classList.remove("hidden");
  }

  async function api(path, options = {}) {
    const resp = await fetch(`${API_BASE}${path}`, {
      headers: {
        "Content-Type": "application/json",
      },
      ...options,
    });
    let data = null;
    try {
      data = await resp.json();
    } catch {
      data = null;
    }
    if (!resp.ok) {
      const detail = data && data.detail ? data.detail : resp.statusText;
      const err = new Error(detail);
      err.status = resp.status;
      throw err;
    }
    return data;
  }

  async function fetchState() {
    try {
      const data = await api("/state", { method: "GET" });
      currentGame = data;
      renderFromGame();
    } catch (err) {
      if (err.status === 404) {
        currentGame = null;
        renderFromGame();
      } else {
        console.error("state error", err);
        showToast(`Error loading state: ${err.message}`);
        setScreen("noGame");
      }
    }
  }

  function startPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(() => {
      if (!currentGame || !currentGame.state) return;
      if (currentGame.phase !== "active") return;
      fetchState();
    }, 2000);
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function renderFromGame() {
    if (!currentGame) {
      stopPolling();
      legalMoverPawnIds = new Set();
      selectedPawnId = null;
      setScreen("noGame");
      return;
    }

    if (currentGame.phase === "lobby") {
      stopPolling();
      renderLobby();
      setScreen("lobby");
    } else if (currentGame.phase === "active") {
      renderGame();
      setScreen("game");
      startPolling();
      refreshLegalMovers();
    } else {
      // finished or aborted
      renderGame();
      setScreen("game");
      stopPolling();
    }
  }

  function seatColorMap(game) {
    const map = {};
    (game.seats || []).forEach((s) => {
      map[s.index] = s.color || ["red", "blue", "yellow", "green"][s.index] || "red";
    });
    return map;
  }

  function renderLobby() {
    const g = currentGame;
    lobbyMetaEl.textContent = `Game ${g.gameId} · Phase: ${g.phase}`;

    const seats = g.seats || [];
    lobbySeatsEl.innerHTML = "";
    const colors = seatColorMap(g);

    seats.forEach((s) => {
      const seatEl = document.createElement("div");
      seatEl.className = "lobby-seat";

      const header = document.createElement("div");
      header.className = "lobby-seat-header";
      const label = document.createElement("span");
      label.textContent = `Seat ${s.index} (${s.color})`;

      const pill = document.createElement("span");
      pill.classList.add("pill");
      if (s.status === "joined" && !s.isBot) {
        pill.classList.add("pill-human");
        pill.textContent = "Human";
      } else if (s.isBot) {
        pill.classList.add("pill-bot");
        pill.textContent = "Bot";
      } else {
        pill.classList.add("pill-open");
        pill.textContent = "Open";
      }

      header.appendChild(label);
      header.appendChild(pill);
      seatEl.appendChild(header);

      const body = document.createElement("div");
      body.textContent = s.displayName || (s.isBot ? "Bot" : "(empty)");
      seatEl.appendChild(body);

      if (s.index !== 0 && g.phase === "lobby") {
        const controls = document.createElement("div");
        const toBot = document.createElement("button");
        toBot.textContent = s.isBot ? "Make human" : "Make bot";
        toBot.addEventListener("click", async () => {
          try {
            const updated = await api("/configure-seat", {
              method: "POST",
              body: JSON.stringify({
                game_id: g.gameId,
                seat_index: s.index,
                is_bot: !s.isBot,
              }),
            });
            currentGame = updated;
            renderFromGame();
          } catch (err) {
            showToast(`Configure seat failed: ${err.message}`);
          }
        });
        controls.appendChild(toBot);
        seatEl.appendChild(controls);
      }

      lobbySeatsEl.appendChild(seatEl);
    });
  }

  function renderGame() {
    const g = currentGame;
    const state = g.state;
    const colors = seatColorMap(g);

    if (!state) {
      gameMetaEl.textContent = "Game has not started yet.";
      trackGridEl.innerHTML = "";
      startAreasEl.innerHTML = "";
      safetyHomeEl.innerHTML = "";
      return;
    }

    if (g.gameId !== lastShownGameId) {
      lastShownGameId = g.gameId;
      lastShownCard = null;
    }

    const discard = Array.isArray(state.discardPile) ? state.discardPile : [];
    const lastCard = discard.length ? discard[discard.length - 1] : null;

    if (lastCard && lastCard !== lastShownCard) {
      const desc = getCardDescription(lastCard);
      if (desc) {
        showToast(desc, 3000);
      }
      lastShownCard = lastCard;
    }

    const resultText =
      state.result === "active"
        ? "In progress"
        : state.result === "win"
        ? `Won by seat ${state.winnerSeatIndex}`
        : state.result;

    const cardPart = lastCard ? ` · Last card: ${lastCard}` : "";
    const isActive = state.result === "active";
    const instruction = isActive ? " · Click a highlighted pawn, then Play Move." : "";
    gameMetaEl.textContent =
      `Game ${g.gameId} · Turn ${state.turnNumber} · Current seat: ${state.currentSeatIndex}` +
      cardPart +
      ` · ${resultText}` +
      instruction;

    const hasLegalMoves = isActive && legalMoverPawnIds && legalMoverPawnIds.size > 0;
    const hasSelectedLegalPawn =
      hasLegalMoves && selectedPawnId != null && legalMoverPawnIds.has(selectedPawnId);
    playMoveBtn.disabled = !isActive || (hasLegalMoves && !hasSelectedLegalPawn);
    botStepBtn.disabled = !isActive;

    // Track grid 0-59
    const TRACK_LEN = 60;
    const COLS = 15;
    const ROWS = TRACK_LEN / COLS;

    const pawns = (state.board && state.board.pawns) || [];

    const trackMap = new Map();
    const startCount = {};
    const safetyCount = {};
    const homeCount = {};

    pawns.forEach((p) => {
      const pos = p.position || {};
      const seatIndex = p.seatIndex;
      const color = colors[seatIndex] || "red";
      if (pos.type === "track") {
        const idx = pos.index ?? 0;
        const key = idx;
        if (!trackMap.has(key)) trackMap.set(key, []);
        trackMap.get(key).push({ seatIndex, color, pawnId: p.pawnId });
      } else if (pos.type === "start") {
        startCount[seatIndex] = (startCount[seatIndex] || 0) + 1;
      } else if (pos.type === "safety") {
        const key = `${seatIndex}:${pos.index ?? 0}`;
        safetyCount[key] = (safetyCount[key] || 0) + 1;
      } else if (pos.type === "home") {
        homeCount[seatIndex] = (homeCount[seatIndex] || 0) + 1;
      }
    });

    trackGridEl.innerHTML = "";
    for (let row = 0; row < ROWS; row++) {
      for (let col = 0; col < COLS; col++) {
        const idx = row * COLS + col;
        const cell = document.createElement("div");
        cell.className = "track-cell";
        const indexLabel = document.createElement("span");
        indexLabel.className = "track-cell-index";
        indexLabel.textContent = String(idx);
        cell.appendChild(indexLabel);

        const occupants = trackMap.get(idx) || [];
        if (occupants.length > 0) {
          const occ = occupants[0];
          const dot = document.createElement("div");
          dot.className = `pawn-dot ${occ.color}`;
          const isLegalMover = legalMoverPawnIds && legalMoverPawnIds.has(occ.pawnId);
          if (isLegalMover) {
            dot.classList.add("legal-mover");
            dot.addEventListener("click", () => {
              selectedPawnId = occ.pawnId;
              renderGame();
            });
          }
          if (selectedPawnId && occ.pawnId === selectedPawnId) {
            dot.classList.add("pawn-selected");
          }
          dot.textContent = String(occ.seatIndex);
          cell.appendChild(dot);
        }

        trackGridEl.appendChild(cell);
      }
    }

    const currentSeat = state.currentSeatIndex;

    // Start areas
    startAreasEl.innerHTML = "";
    Object.keys(colors)
      .map((k) => parseInt(k, 10))
      .sort((a, b) => a - b)
      .forEach((seatIndex) => {
        const row = document.createElement("div");
        row.className = "start-row";
        if (seatIndex === currentSeat) {
          row.classList.add("current-seat");
        }
        const label = document.createElement("span");
        label.className = "start-row-label";
        label.textContent = `Seat ${seatIndex}`;

        const badge = document.createElement("span");
        badge.className = `badge ${colors[seatIndex]}`;
        badge.textContent = String(startCount[seatIndex] || 0);

        row.appendChild(label);
        row.appendChild(badge);
        startAreasEl.appendChild(row);
      });

    // Safety/Home overview
    safetyHomeEl.innerHTML = "";
    Object.keys(colors)
      .map((k) => parseInt(k, 10))
      .sort((a, b) => a - b)
      .forEach((seatIndex) => {
        const row = document.createElement("div");
        row.className = "safety-row";
        if (seatIndex === currentSeat) {
          row.classList.add("current-seat");
        }
        const label = document.createElement("span");
        label.className = "safety-row-label";
        label.textContent = `Seat ${seatIndex}`;

        const safetyCountForSeat = Object.keys(safetyCount)
          .filter((k) => k.startsWith(`${seatIndex}:`))
          .reduce((acc, key) => acc + safetyCount[key], 0);
        const home = homeCount[seatIndex] || 0;

        const badge = document.createElement("span");
        badge.className = `badge ${colors[seatIndex]}`;
        badge.textContent = `${safetyCountForSeat} / ${home}`;

        row.appendChild(label);
        row.appendChild(badge);
        safetyHomeEl.appendChild(row);
      });
  }

  async function handleHostSubmit(e) {
    e.preventDefault();
    const maxSeats = parseInt(hostMaxSeats.value || "2", 10);
    const displayName = hostDisplayName.value || null;

    try {
      const data = await api("/host", {
        method: "POST",
        body: JSON.stringify({ max_seats: maxSeats, display_name: displayName }),
      });
      currentGame = data;
      renderFromGame();
      showToast("Game hosted. You are in the lobby.");
    } catch (err) {
      showToast(`Host failed: ${err.message}`);
    }
  }

  async function refreshJoinable() {
    try {
      const data = await api("/joinable", { method: "GET" });
      const games = data.games || [];
      joinableList.innerHTML = "";
      if (games.length === 0) {
        const li = document.createElement("li");
        li.textContent = "No joinable games.";
        joinableList.appendChild(li);
        return;
      }
      games.forEach((g) => {
        const li = document.createElement("li");
        const label = document.createElement("span");
        label.textContent = `${g.hostName || "Game"} · ${g.currentPlayers}/${g.maxSeats}`;
        const btn = document.createElement("button");
        btn.textContent = "Join";
        btn.addEventListener("click", async () => {
          try {
            const joined = await api("/join", {
              method: "POST",
              body: JSON.stringify({ game_id: g.gameId, display_name: hostDisplayName.value || null }),
            });
            currentGame = joined;
            renderFromGame();
          } catch (err) {
            showToast(`Join failed: ${err.message}`);
          }
        });
        li.appendChild(label);
        li.appendChild(btn);
        joinableList.appendChild(li);
      });
    } catch (err) {
      showToast(`Error loading games: ${err.message}`);
    }
  }

  async function handleStartGame() {
    if (!currentGame) return;
    try {
      const data = await api("/start", {
        method: "POST",
        body: JSON.stringify({ game_id: currentGame.gameId }),
      });
      currentGame = data;
      renderFromGame();
      showToast("Game started.");
    } catch (err) {
      showToast(`Start failed: ${err.message}`);
    }
  }

  async function handleLeave() {
    if (!currentGame) return;
    try {
      await api("/leave", {
        method: "POST",
        body: JSON.stringify({ game_id: currentGame.gameId }),
      });
      currentGame = null;
      stopPolling();
      renderFromGame();
      showToast("You left the game.");
    } catch (err) {
      showToast(`Leave failed: ${err.message}`);
    }
  }

  async function handlePlayMove() {
    if (!currentGame) return;
    const hasLegalMoves = legalMoverPawnIds && legalMoverPawnIds.size > 0;
    if (hasLegalMoves && selectedPawnId == null) {
      showToast("Select a highlighted pawn before playing your move.");
      return;
    }
    try {
      const payload = hasLegalMoves ? { move: { pawnId: selectedPawnId } } : {};
      const data = await api("/play", {
        method: "POST",
        body: JSON.stringify({ game_id: currentGame.gameId, payload }),
      });
      currentGame = data;
      selectedPawnId = null;
      legalMoverPawnIds = new Set();
      renderFromGame();
    } catch (err) {
      showToast(`Move failed: ${err.message}`);
    }
  }

  async function handleBotStep() {
    if (!currentGame) return;
    try {
      const resp = await fetch(`${API_BASE}/bot-step?game_id=${encodeURIComponent(currentGame.gameId)}`, {
        method: "POST",
      });
      if (!resp.ok) {
        let msg = resp.statusText;
        try {
          const data = await resp.json();
          if (data && data.detail) msg = data.detail;
        } catch {
          // ignore
        }
        throw new Error(msg);
      }
      const data = await resp.json();
      currentGame = data;
      renderFromGame();
    } catch (err) {
      showToast(`Bot step failed: ${err.message}`);
    }
  }

  async function refreshLegalMovers() {
    try {
      if (!currentGame || !currentGame.state || currentGame.phase !== "active") {
        legalMoverPawnIds = new Set();
        selectedPawnId = null;
        return;
      }
      const state = currentGame.state;
      if (state.result !== "active") {
        legalMoverPawnIds = new Set();
        selectedPawnId = null;
        return;
      }

      const resp = await fetch(
        `${API_BASE}/legal-movers?game_id=${encodeURIComponent(currentGame.gameId)}`,
        { method: "GET" }
      );
      if (!resp.ok) {
        legalMoverPawnIds = new Set();
        selectedPawnId = null;
        return;
      }
      const data = await resp.json();
      const ids = Array.isArray(data.pawnIds) ? data.pawnIds : [];
      legalMoverPawnIds = new Set(ids);
      if (selectedPawnId && !legalMoverPawnIds.has(selectedPawnId)) {
        selectedPawnId = null;
      }
      if (!selectedPawnId && ids.length === 1) {
        selectedPawnId = ids[0];
      }
      renderGame();
    } catch (err) {
      // Advisory only; ignore errors.
      legalMoverPawnIds = new Set();
    }
  }

  function init() {
    hostForm.addEventListener("submit", handleHostSubmit);
    refreshJoinableBtn.addEventListener("click", refreshJoinable);

    startGameBtn.addEventListener("click", handleStartGame);
    leaveLobbyBtn.addEventListener("click", handleLeave);

    leaveGameBtn.addEventListener("click", handleLeave);
    playMoveBtn.addEventListener("click", handlePlayMove);
    botStepBtn.addEventListener("click", handleBotStep);

    setScreen("loading");
    fetchState().then(() => {
      if (!currentGame) {
        setScreen("noGame");
        refreshJoinable();
      }
    });
  }

  window.addEventListener("DOMContentLoaded", init);
})();
