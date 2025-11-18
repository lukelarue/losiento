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
  const cardHistoryEl = document.getElementById("card-history");
  const turnActionBtn = document.getElementById("turn-action");
  const leaveGameBtn = document.getElementById("leave-game");

  const toastEl = document.getElementById("toast");

  let currentGame = null;
  let pollTimer = null;
  let selectedPawnId = null;
  let legalMoverPawnIds = new Set();
  let lastShownCard = null;
  let lastShownGameId = null;
  let cardHistory = [];
  let cardHistoryGameId = null;
  let lastHistoryDiscardLength = 0;
  let historyInitialized = false;
  let lastHistorySeatIndex = null;

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
      cardHistory = [];
      cardHistoryGameId = null;
      lastHistoryDiscardLength = 0;
      historyInitialized = false;
      lastHistorySeatIndex = null;
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

  function trackIndexForCoord(row, col) {
    const max = 15;
    if (row === 0 && col >= 0 && col <= max) {
      // Top edge, left to right (16 cells)
      return col;
    }
    if (col === max && row >= 1 && row <= max - 1) {
      // Right edge, top to bottom (excluding corners)
      return 16 + (row - 1);
    }
    if (row === max && col >= 0 && col <= max) {
      // Bottom edge, right to left (16 cells)
      return 30 + (max - col);
    }
    if (col === 0 && row >= 1 && row <= max - 1) {
      // Left edge, bottom to top (excluding corners)
      return 46 + (max - 1 - row);
    }
    return null;
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

    if (g.gameId !== cardHistoryGameId) {
      cardHistoryGameId = g.gameId;
      cardHistory = [];
      lastHistoryDiscardLength = 0;
      historyInitialized = false;
      lastHistorySeatIndex = null;
    }

    if (!historyInitialized) {
      if (discard.length > 0) {
        discard.forEach((card) => {
          cardHistory.push({ card, seatIndex: null });
        });
      }
      lastHistoryDiscardLength = discard.length;
      lastHistorySeatIndex = state.currentSeatIndex;
      historyInitialized = true;
    } else {
      if (discard.length < lastHistoryDiscardLength) {
        cardHistory = [];
        lastHistoryDiscardLength = discard.length;
        lastHistorySeatIndex = state.currentSeatIndex;
      } else if (discard.length > lastHistoryDiscardLength) {
        const prevSeatIndex =
          lastHistorySeatIndex != null ? lastHistorySeatIndex : state.currentSeatIndex;
        const newCards = discard.slice(lastHistoryDiscardLength);
        newCards.forEach((card) => {
          cardHistory.push({ card, seatIndex: prevSeatIndex });
          if (cardHistory.length > 50) {
            cardHistory = cardHistory.slice(cardHistory.length - 50);
          }
        });
        lastHistoryDiscardLength = discard.length;
        lastHistorySeatIndex = state.currentSeatIndex;
      } else {
        lastHistorySeatIndex = state.currentSeatIndex;
      }
    }

    const resultText =
      state.result === "active"
        ? "In progress"
        : state.result === "win"
        ? `Won by seat ${state.winnerSeatIndex}`
        : state.result;

    const isActive = state.result === "active";
    const genericHint = isActive ? "Click a highlighted pawn, then Play Move." : "";
    const cardName = lastCard || "No card";
    const cardDescription = lastCard
      ? getCardDescription(lastCard) || "Card effect available."
      : "No card drawn yet.";

    const hasLegalMoves = isActive && legalMoverPawnIds && legalMoverPawnIds.size > 0;
    const hasSelectedLegalPawn =
      hasLegalMoves && selectedPawnId != null && legalMoverPawnIds.has(selectedPawnId);

    gameMetaEl.innerHTML = `
      <div class="game-meta-grid">
        <div class="game-info-card">
          <div class="game-info-title">Game info</div>
          <div class="game-info-rows">
            <div class="game-info-row">
              <span class="game-info-label">Game</span>
              <span class="game-info-value">#${g.gameId}</span>
            </div>
            <div class="game-info-row">
              <span class="game-info-label">Turn</span>
              <span class="game-info-value">${state.turnNumber}</span>
            </div>
            <div class="game-info-row">
              <span class="game-info-label">Current seat</span>
              <span class="game-info-value">Seat ${state.currentSeatIndex}</span>
            </div>
            <div class="game-info-row">
              <span class="game-info-label">Status</span>
              <span class="game-info-value game-status-pill game-status-${state.result}">${resultText}</span>
            </div>
          </div>
          ${genericHint ? `<div class="game-info-hint">${genericHint}</div>` : ""}
        </div>
        <div class="game-card-panel">
          <div class="game-card-surface">
            <div class="game-card-label">Last card</div>
            <div class="game-card-name">${cardName}</div>
            <div class="game-card-desc">${cardDescription}</div>
          </div>
        </div>
      </div>
    `;

    const seats = g.seats || [];
    const currentSeatSeat = seats[state.currentSeatIndex];
    const isBotTurn = !!(currentSeatSeat && currentSeatSeat.isBot);

    if (turnActionBtn) {
      let label = "";
      turnActionBtn.classList.remove("turn-btn-human", "turn-btn-bot");
      if (!isActive) {
        label = "No turn";
        turnActionBtn.disabled = true;
      } else if (isBotTurn) {
        label = "Bot turn";
        turnActionBtn.disabled = false;
        turnActionBtn.classList.add("turn-btn-bot");
      } else {
        label = "Play turn";
        turnActionBtn.disabled = !isActive || (hasLegalMoves && !hasSelectedLegalPawn);
        turnActionBtn.classList.add("turn-btn-human");
      }
      turnActionBtn.textContent = label;
    }

    const statusPillsEl = document.getElementById("game-status-pills");
    if (statusPillsEl) {
      statusPillsEl.innerHTML = "";
      Object.keys(colors)
        .map((k) => parseInt(k, 10))
        .sort((a, b) => a - b)
        .forEach((seatIndex) => {
          const pill = document.createElement("div");
          pill.className = "status-pill";

          if (state.result === "win" && state.winnerSeatIndex === seatIndex) {
            pill.classList.add("status-pill-winner");
          } else if (state.result === "active" && state.currentSeatIndex === seatIndex) {
            pill.classList.add("status-pill-current");
          }

          const label = document.createElement("span");
          label.className = "status-pill-label";
          label.textContent = `Seat ${seatIndex}`;

          const value = document.createElement("span");
          value.className = "status-pill-value";
          if (state.result === "win" && state.winnerSeatIndex === seatIndex) {
            value.textContent = "Winner";
          } else if (state.result === "active" && state.currentSeatIndex === seatIndex) {
            value.textContent = "Current turn";
          } else if (state.result === "active") {
            value.textContent = "Waiting";
          } else {
            value.textContent = "Idle";
          }

          pill.appendChild(label);
          pill.appendChild(value);
          statusPillsEl.appendChild(pill);
        });
    }

    // Track grid 0-59 laid out on a 16x16 outer ring
    const TRACK_LEN = 60;
    const BOARD_SIZE = 16;

    function coordForTrackIndex(idx) {
      const max = 15;
      if (idx >= 0 && idx <= max) {
        return { row: 0, col: idx };
      }
      if (idx >= 16 && idx <= 29) {
        return { row: 1 + (idx - 16), col: max };
      }
      if (idx >= 30 && idx <= 45) {
        return { row: max, col: max - (idx - 30) };
      }
      if (idx >= 46 && idx <= 59) {
        return { row: max - 1 - (idx - 46), col: 0 };
      }
      return { row: 0, col: 0 };
    }

    const pawns = (state.board && state.board.pawns) || [];

    const trackMap = new Map();
    const startCount = {};
    const safetyCount = {};
    const homeCount = {};

    const safetyOccupants = new Map();
    const homeOccupants = new Map();

    const TRACK_SEGMENT_LEN = 15;
    const FIRST_SLIDE_LEN = 4;
    const SECOND_SLIDE_LEN = 5;
    const SAFE_ZONE_LEN = 5;

    function firstSlideIndicesForSeat(seatIndex) {
      const offset = (seatIndex % 4) * TRACK_SEGMENT_LEN;
      const start = (offset + 1) % TRACK_LEN;
      const indices = [];
      for (let i = 0; i < FIRST_SLIDE_LEN; i++) {
        indices.push((start + i) % TRACK_LEN);
      }
      return indices;
    }

    function secondSlideIndicesForSeat(seatIndex) {
      const firstSlide = firstSlideIndicesForSeat(seatIndex);
      const lastFirst = firstSlide[firstSlide.length - 1];
      const start = (lastFirst + 1 + 5) % TRACK_LEN;
      const indices = [];
      for (let i = 0; i < SECOND_SLIDE_LEN; i++) {
        indices.push((start + i) % TRACK_LEN);
      }
      return indices;
    }

    function safetyDirectionForSeat(seatIndex) {
      const normalized = seatIndex % 4;
      if (normalized === 0) return { dr: 1, dc: 0 };
      if (normalized === 1) return { dr: 0, dc: -1 };
      if (normalized === 2) return { dr: -1, dc: 0 };
      return { dr: 0, dc: 1 };
    }

    const slideIndices = new Set();
    const slideStartIndices = new Set();
    const safeEntryIndices = new Set();
    const startExitIndices = new Set();
    const slideMarkerMap = new Map();

    const slideSeatByIndex = new Map();
    const safeEntrySeatByIndex = new Map();
    const startExitSeatByIndex = new Map();

    const slideSegments = [];

    const safetyCoordsBySeat = {};
    const homeCoordBySeat = {};
    const safetyGeometry = new Map();
    const homeGeometry = new Map();

    Object.keys(colors)
      .map((k) => parseInt(k, 10))
      .filter((k) => !Number.isNaN(k))
      .sort((a, b) => a - b)
      .forEach((seatIndex) => {
        const firstSlide = firstSlideIndicesForSeat(seatIndex);
        const secondSlide = secondSlideIndicesForSeat(seatIndex);

        if (firstSlide.length) {
          firstSlide.forEach((idx) => {
            slideIndices.add(idx);
            slideSeatByIndex.set(idx, seatIndex);
          });
          slideStartIndices.add(firstSlide[0]);
          const entryIdx = firstSlide[1];
          safeEntryIndices.add(entryIdx);
          safeEntrySeatByIndex.set(entryIdx, seatIndex);
          const startExitIdx = (firstSlide[0] - 1 + TRACK_LEN) % TRACK_LEN;
          startExitIndices.add(startExitIdx);
          startExitSeatByIndex.set(startExitIdx, seatIndex);
          slideSegments.push(firstSlide);

          const entryCoord = coordForTrackIndex(entryIdx);
          const dir = safetyDirectionForSeat(seatIndex);
          const coords = [];
          for (let i = 0; i < SAFE_ZONE_LEN; i++) {
            const row = entryCoord.row + dir.dr * (i + 1);
            const col = entryCoord.col + dir.dc * (i + 1);
            const key = `${row}:${col}`;
            coords.push({ row, col });
            safetyGeometry.set(key, { seatIndex, safetyIndex: i });
          }
          safetyCoordsBySeat[seatIndex] = coords;

          const homeRow = entryCoord.row + dir.dr * (SAFE_ZONE_LEN + 1);
          const homeCol = entryCoord.col + dir.dc * (SAFE_ZONE_LEN + 1);
          const homeKey = `${homeRow}:${homeCol}`;
          homeCoordBySeat[seatIndex] = { row: homeRow, col: homeCol };
          homeGeometry.set(homeKey, { seatIndex });
        }

        if (secondSlide.length) {
          secondSlide.forEach((idx) => {
            slideIndices.add(idx);
            slideSeatByIndex.set(idx, seatIndex);
          });
          slideStartIndices.add(secondSlide[0]);
          slideSegments.push(secondSlide);
        }
      });

    slideSegments.forEach((segment) => {
      if (!segment || segment.length === 0) return;
      const firstIdx = segment[0];
      const secondIdx = segment.length > 1 ? segment[1] : segment[0];
      const a = coordForTrackIndex(firstIdx);
      const b = coordForTrackIndex(secondIdx);
      let arrow = "→";
      if (a.row === b.row && b.col > a.col) {
        arrow = "→";
      } else if (a.row === b.row && b.col < a.col) {
        arrow = "←";
      } else if (a.col === b.col && b.row > a.row) {
        arrow = "↓";
      } else if (a.col === b.col && b.row < a.row) {
        arrow = "↑";
      }

      segment.forEach((idx, i) => {
        if (i === 0) {
          slideMarkerMap.set(idx, "X");
        } else if (i === segment.length - 1) {
          slideMarkerMap.set(idx, "O");
        } else {
          slideMarkerMap.set(idx, arrow);
        }
      });
    });

    pawns.forEach((p) => {
      const pos = p.position || {};
      const seatIndex = p.seatIndex;
      const color = colors[seatIndex] || "red";
      if (pos.type === "track") {
        const idx = pos.index ?? 0;
        if (!trackMap.has(idx)) trackMap.set(idx, []);
        trackMap.get(idx).push({ seatIndex, color, pawnId: p.pawnId });
      } else if (pos.type === "start") {
        startCount[seatIndex] = (startCount[seatIndex] || 0) + 1;
      } else if (pos.type === "safety") {
        const safetyIndex = pos.index ?? 0;
        const keyCount = `${seatIndex}:${safetyIndex}`;
        safetyCount[keyCount] = (safetyCount[keyCount] || 0) + 1;

        const coordsForSeat = safetyCoordsBySeat[seatIndex];
        if (coordsForSeat && coordsForSeat[safetyIndex]) {
          const coord = coordsForSeat[safetyIndex];
          const key = `${coord.row}:${coord.col}`;
          if (!safetyOccupants.has(key)) safetyOccupants.set(key, []);
          safetyOccupants.get(key).push({ seatIndex, color, pawnId: p.pawnId });
        }
      } else if (pos.type === "home") {
        homeCount[seatIndex] = (homeCount[seatIndex] || 0) + 1;

        const homeCoord = homeCoordBySeat[seatIndex];
        if (homeCoord) {
          const key = `${homeCoord.row}:${homeCoord.col}`;
          if (!homeOccupants.has(key)) homeOccupants.set(key, []);
          homeOccupants.get(key).push({ seatIndex, color, pawnId: p.pawnId });
        }
      }
    });

    trackGridEl.innerHTML = "";
    for (let row = 0; row < BOARD_SIZE; row++) {
      for (let col = 0; col < BOARD_SIZE; col++) {
        const cell = document.createElement("div");
        cell.className = "track-cell";

        const idx = trackIndexForCoord(row, col);
        const coordKey = `${row}:${col}`;
        const safetyGeom = safetyGeometry.get(coordKey);
        const homeGeom = homeGeometry.get(coordKey);

        if (idx !== null && idx !== undefined) {
          cell.classList.add("track-cell-track");
          if (slideIndices.has(idx)) {
            cell.classList.add("track-cell-slide");
          }
          if (slideStartIndices.has(idx)) {
            cell.classList.add("track-cell-slide-start");
          }
          if (safeEntryIndices.has(idx)) {
            cell.classList.add("track-cell-safe-entry");
          }
          if (startExitIndices.has(idx)) {
            cell.classList.add("track-cell-start-exit");
          }
          const indexLabel = document.createElement("span");
          indexLabel.className = "track-cell-index";
          indexLabel.textContent = String(idx);
          cell.appendChild(indexLabel);

          const markerChar = slideMarkerMap.get(idx);
          if (markerChar) {
            const markerEl = document.createElement("span");
            markerEl.className = "track-cell-slide-marker";
            markerEl.textContent = markerChar;
            cell.appendChild(markerEl);
          }
        }

        if (safetyGeom) {
          cell.classList.add("track-cell-safety");
        }
        if (homeGeom) {
          cell.classList.add("track-cell-home");
        }

        let ownerSeatIndex = null;
        if (homeGeom && typeof homeGeom.seatIndex === "number") {
          ownerSeatIndex = homeGeom.seatIndex;
        } else if (safetyGeom && typeof safetyGeom.seatIndex === "number") {
          ownerSeatIndex = safetyGeom.seatIndex;
        } else if (idx !== null && idx !== undefined) {
          const slideSeat = slideSeatByIndex.get(idx);
          const safeEntrySeat = safeEntrySeatByIndex.get(idx);
          const startExitSeat = startExitSeatByIndex.get(idx);
          if (typeof slideSeat === "number") {
            ownerSeatIndex = slideSeat;
          } else if (typeof safeEntrySeat === "number") {
            ownerSeatIndex = safeEntrySeat;
          } else if (typeof startExitSeat === "number") {
            ownerSeatIndex = startExitSeat;
          }
        }

        if (ownerSeatIndex != null && Object.prototype.hasOwnProperty.call(colors, ownerSeatIndex)) {
          const seatColor = colors[ownerSeatIndex];
          if (seatColor) {
            cell.classList.add(`seat-${seatColor}`);
          }
        }

        let occupant = null;
        if (homeGeom) {
          const occs = homeOccupants.get(coordKey) || [];
          if (occs.length > 0) occupant = occs[0];
        }
        if (!occupant && safetyGeom) {
          const occs = safetyOccupants.get(coordKey) || [];
          if (occs.length > 0) occupant = occs[0];
        }
        if (!occupant && idx !== null && idx !== undefined) {
          const occs = trackMap.get(idx) || [];
          if (occs.length > 0) occupant = occs[0];
        }

        if (occupant) {
          const dot = document.createElement("div");
          dot.className = `pawn-dot ${occupant.color}`;
          const isLegalMover = legalMoverPawnIds && legalMoverPawnIds.has(occupant.pawnId);
          if (isLegalMover) {
            dot.classList.add("legal-mover");
            dot.addEventListener("click", () => {
              selectedPawnId = occupant.pawnId;
              renderGame();
            });
          }
          if (selectedPawnId && occupant.pawnId === selectedPawnId) {
            dot.classList.add("pawn-selected");
          }
          dot.textContent = String(occupant.seatIndex);
          cell.appendChild(dot);
        }

        trackGridEl.appendChild(cell);
      }
    }

    const currentSeatIndex = state.currentSeatIndex;

    // Start areas
    startAreasEl.innerHTML = "";
    Object.keys(colors)
      .map((k) => parseInt(k, 10))
      .sort((a, b) => a - b)
      .forEach((seatIndex) => {
        const row = document.createElement("div");
        row.className = "start-row";
        if (seatIndex === currentSeatIndex) {
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

        const pawnsInStartForSeat = pawns.filter(
          (p) => p.seatIndex === seatIndex && p.position && p.position.type === "start"
        );
        const legalStartPawns =
          legalMoverPawnIds && pawnsInStartForSeat.length
            ? pawnsInStartForSeat.filter((p) => legalMoverPawnIds.has(p.pawnId))
            : [];

        if (seatIndex === currentSeatIndex && legalStartPawns.length > 0) {
          const startPawnsRow = document.createElement("div");
          startPawnsRow.className = "start-row-pawns";
          legalStartPawns.forEach((p) => {
            const dot = document.createElement("div");
            dot.className = `pawn-dot ${colors[seatIndex]}`;
            dot.textContent = String(seatIndex);
            dot.classList.add("legal-mover");
            dot.addEventListener("click", () => {
              selectedPawnId = p.pawnId;
              renderGame();
            });
            if (selectedPawnId && p.pawnId === selectedPawnId) {
              dot.classList.add("pawn-selected");
            }
            startPawnsRow.appendChild(dot);
          });
          row.appendChild(startPawnsRow);
        }

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
        if (seatIndex === currentSeatIndex) {
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
        badge.textContent = `Safe: ${safetyCountForSeat} · Home: ${home}`;

        row.appendChild(label);
        row.appendChild(badge);
        safetyHomeEl.appendChild(row);
      });

    if (cardHistoryEl) {
      cardHistoryEl.innerHTML = "";
      if (!cardHistory || cardHistory.length === 0) {
        const empty = document.createElement("div");
        empty.className = "card-history-empty";
        empty.textContent = "No cards drawn yet.";
        cardHistoryEl.appendChild(empty);
      } else {
        const list = document.createElement("div");
        list.className = "card-history-list";
        cardHistory.forEach((entry) => {
          const item = document.createElement("div");
          item.className = "card-history-item";

          const header = document.createElement("div");
          header.className = "card-history-header";

          const seatLabel = document.createElement("span");
          seatLabel.className = "card-history-seat";
          if (entry && entry.seatIndex != null) {
            seatLabel.textContent = `Seat ${entry.seatIndex}`;
          } else {
            seatLabel.textContent = "Seat ?";
          }

          const cardLabel = document.createElement("span");
          cardLabel.className = "card-history-card";
          cardLabel.textContent = entry && entry.card != null ? String(entry.card) : "";

          header.appendChild(seatLabel);
          header.appendChild(cardLabel);

          item.appendChild(header);

          const descText = getCardDescription(entry.card);
          if (descText) {
            const toggle = document.createElement("button");
            toggle.type = "button";
            toggle.className = "card-history-toggle";
            toggle.textContent = "Details";

            const descEl = document.createElement("div");
            descEl.className = "card-history-desc hidden";
            descEl.textContent = descText;

            toggle.addEventListener("click", () => {
              const isHidden = descEl.classList.contains("hidden");
              if (isHidden) {
                descEl.classList.remove("hidden");
              } else {
                descEl.classList.add("hidden");
              }
            });

            item.appendChild(toggle);
            item.appendChild(descEl);
          }

          list.appendChild(item);
        });
        cardHistoryEl.appendChild(list);
      }
    }
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

  async function handleTurnAction() {
    if (!currentGame || !currentGame.state) return;
    const g = currentGame;
    const state = g.state;
    if (state.result !== "active") return;
    const seats = g.seats || [];
    const currentSeat = seats[state.currentSeatIndex];
    const isBotTurn = !!(currentSeat && currentSeat.isBot);
    if (isBotTurn) {
      await handleBotStep();
    } else {
      await handlePlayMove();
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
    if (turnActionBtn) {
      turnActionBtn.addEventListener("click", handleTurnAction);
    }

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
