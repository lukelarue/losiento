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
  const gameCardEl = document.getElementById("game-card");
  const trackGridEl = document.getElementById("track-grid");
  const startAreasEl = document.getElementById("start-areas");
  const safetyHomeEl = document.getElementById("safety-home");
  const cardHistoryEl = document.getElementById("card-history");
  const turnActionBtn = document.getElementById("turn-action");
  const leaveGameBtn = document.getElementById("leave-game");
  const autoplayBotBtn = document.getElementById("autoplay-bot");

  const toastEl = document.getElementById("toast");

  let currentGame = null;
  let pollTimer = null;
  let selectedPawnId = null;
  let selectedSecondaryPawnId = null;
  let legalMoverPawnIds = new Set();
  let upcomingCard = null;
  let upcomingMoves = [];
  let selectedMoveIndex = null;
  let lastShownCard = null;
  let lastShownGameId = null;
  let cardHistory = [];
  let cardHistoryGameId = null;
  let lastHistoryDiscardLength = 0;
  let historyInitialized = false;
  let lastHistorySeatIndex = null;
  let pendingHistoryDetails = null;
  let autoplayBotEnabled = false;
  let autoplayTimeout = null;
  let lastPreviewGameId = null;
  let lastPreviewTurnNumber = null;
  let lastPreviewDiscardLength = null;

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
        return "Card 1 – move a pawn 1 space, or leave Start to the space just outside Start (end of your first slide).";
      case "2":
        return "Card 2 – move a pawn 2 spaces, or leave Start to the same space just outside Start, then take another turn.";
      case "3":
        return "Card 3 – move a pawn 3 spaces forward.";
      case "4":
        return "Card 4 – move a pawn 4 spaces backward.";
      case "5":
        return "Card 5 – move a pawn 5 spaces forward.";
      case "7":
        return "Card 7 – move 7 spaces with one pawn, or split 7 forward spaces between two of your pawns (you must use all 7 spaces or not move).";
      case "8":
        return "Card 8 – move a pawn 8 spaces forward.";
      case "10":
        return "Card 10 – move 10 spaces forward or 1 space backward.";
      case "11":
        return "Card 11 – move 11 spaces forward or switch with an opponent pawn. If you cannot move forward 11 spaces, you may either end your turn without moving or choose any one legal switch; you are never required to switch solely because a switch is available.";
      case "12":
        return "Card 12 – move a pawn 12 spaces forward.";
      case "Sorry!":
        return "¡Lo siento! – move from Start and bump an opponent pawn.";
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

  function stopAutoplay() {
    autoplayBotEnabled = false;
    if (autoplayTimeout) {
      clearTimeout(autoplayTimeout);
      autoplayTimeout = null;
    }
    if (autoplayBotBtn) {
      autoplayBotBtn.classList.remove("autoplay-on");
      autoplayBotBtn.textContent = "Autoplay bot turns (off)";
    }
  }

  function scheduleAutoplayTick() {
    if (!autoplayBotEnabled) return;
    if (autoplayTimeout) return;
    autoplayTimeout = setTimeout(runAutoplayTick, 750);
  }

  async function runAutoplayTick() {
    autoplayTimeout = null;
    if (!autoplayBotEnabled) return;
    if (!currentGame || !currentGame.state || currentGame.phase !== "active") {
      stopAutoplay();
      return;
    }
    const g = currentGame;
    const state = g.state;
    if (!state || state.result !== "active") {
      stopAutoplay();
      return;
    }
    const seats = g.seats || [];
    const currentSeat = seats[state.currentSeatIndex];
    const isBotTurn = !!(currentSeat && currentSeat.isBot);
    if (isBotTurn) {
      await handleBotStep();
    }
    scheduleAutoplayTick();
  }

  function startAutoplay() {
    if (!autoplayBotBtn) return;
    if (autoplayBotEnabled) return;
    autoplayBotEnabled = true;
    autoplayBotBtn.classList.add("autoplay-on");
    autoplayBotBtn.textContent = "Autoplay bot turns (on)";
    scheduleAutoplayTick();
  }

  function renderFromGame() {
    if (!currentGame) {
      stopPolling();
      stopAutoplay();
      legalMoverPawnIds = new Set();
      selectedPawnId = null;
      selectedSecondaryPawnId = null;
      upcomingCard = null;
      upcomingMoves = [];
      selectedMoveIndex = null;
      cardHistory = [];
      cardHistoryGameId = null;
      lastHistoryDiscardLength = 0;
      historyInitialized = false;
      lastHistorySeatIndex = null;
      lastPreviewGameId = null;
      lastPreviewTurnNumber = null;
      lastPreviewDiscardLength = null;
      setScreen("noGame");
      return;
    }

    if (currentGame.phase === "lobby") {
      stopPolling();
      stopAutoplay();
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
      stopAutoplay();
      lastPreviewGameId = null;
      lastPreviewTurnNumber = null;
      lastPreviewDiscardLength = null;
    }
  }

  function seatColorMap(game) {
    const map = {};
    (game.seats || []).forEach((s) => {
      map[s.index] = s.color || ["red", "blue", "yellow", "green"][s.index] || "red";
    });
    return map;
  }

  function describePawnForSummary(state, colors, pawnId) {
    if (!pawnId) return "";
    const board = state && state.board ? state.board : null;
    const pawnsList = board && Array.isArray(board.pawns) ? board.pawns : [];
    const pawn = pawnsList.find((p) => p.pawnId === pawnId);
    if (!pawn || !pawn.position) {
      return String(pawnId);
    }
    const seatIndex = pawn.seatIndex;
    const color = colors[seatIndex] || "red";
    const pos = pawn.position;
    if (pos.type === "track") {
      const tileIndex = typeof pos.index === "number" ? pos.index : 0;
      return `${color} (tile ${tileIndex})`;
    }
    if (pos.type === "start") {
      return `${color} (start)`;
    }
    if (pos.type === "home") {
      return `${color} (home)`;
    }
    if (pos.type === "safety") {
      const safeIndex = typeof pos.index === "number" ? pos.index + 1 : 1;
      return `${color} (safe zone ${safeIndex})`;
    }
    return color;
  }

  function describeDestinationForSummary(move) {
    if (!move || !move.destType) return "";
    const destType = move.destType;
    const hasIndex = typeof move.destIndex === "number";
    if (destType === "track" && hasIndex) {
      return `lands on tile ${move.destIndex}`;
    }
    if (destType === "safety" && hasIndex) {
      const safeIndex = move.destIndex + 1;
      return `ends in safe zone ${safeIndex}`;
    }
    if (destType === "home") {
      return "ends in home";
    }
    if (destType === "start") {
      return "returns to start";
    }
    return "";
  }

  function describeSecondaryDestinationForSummary(move) {
    if (!move || !move.secondaryDestType) return "";
    const destType = move.secondaryDestType;
    const hasIndex = typeof move.secondaryDestIndex === "number";
    if (destType === "track" && hasIndex) {
      return `lands on tile ${move.secondaryDestIndex}`;
    }
    if (destType === "safety" && hasIndex) {
      const safeIndex = move.secondaryDestIndex + 1;
      return `ends in safe zone ${safeIndex}`;
    }
    if (destType === "home") {
      return "ends in home";
    }
    if (destType === "start") {
      return "returns to start";
    }
    return "";
  }

  function buildMoveSummaryBase(cardName, move, state, colors) {
    if (!move) return "";
    if (
      move.secondaryPawnId &&
      move.secondaryDirection &&
      move.secondarySteps != null
    ) {
      const primaryLabel = describePawnForSummary(state, colors, move.pawnId);
      const secondaryLabel = describePawnForSummary(
        state,
        colors,
        move.secondaryPawnId
      );
      const primarySteps = move.steps != null ? move.steps : 0;
      const secondarySteps =
        move.secondarySteps != null ? move.secondarySteps : 0;

      if (cardName === "7") {
        const primaryStepsText =
          primarySteps === 1 ? "1 space" : `${primarySteps} spaces`;
        const secondaryStepsText =
          secondarySteps === 1 ? "1 space" : `${secondarySteps} spaces`;
        const primaryDestPhrase = describeDestinationForSummary(move);
        const secondaryDestPhrase = describeSecondaryDestinationForSummary(move);

        const primaryPart = primaryDestPhrase
          ? `${primaryLabel} forward ${primaryStepsText} (${primaryDestPhrase})`
          : `${primaryLabel} forward ${primaryStepsText}`;
        const secondaryPart = secondaryDestPhrase
          ? `${secondaryLabel} forward ${secondaryStepsText} (${secondaryDestPhrase})`
          : `${secondaryLabel} forward ${secondaryStepsText}`;

        return `${primaryPart}; ${secondaryPart}.`;
      }

      const destPhrase = describeDestinationForSummary(move);
      if (destPhrase) {
        return `${primaryLabel} + ${secondaryLabel} split ${primarySteps}+${secondarySteps} (${destPhrase}).`;
      }
      return `${primaryLabel} + ${secondaryLabel} split ${primarySteps}+${secondarySteps}.`;
    }
    if (move.targetPawnId) {
      const primaryLabel = describePawnForSummary(state, colors, move.pawnId);
      const targetLabel = describePawnForSummary(
        state,
        colors,
        move.targetPawnId
      );
      let verb = "targeting";
      if (cardName === "Sorry!") {
        verb = "¡Lo siento! bumping";
      } else if (cardName === "11") {
        verb = "switching places with";
      }
      const destPhrase = describeDestinationForSummary(move);
      if (destPhrase) {
        return `${primaryLabel} ${verb} ${targetLabel} (${destPhrase}).`;
      }
      return `${primaryLabel} ${verb} ${targetLabel}.`;
    }
    if (move.direction && move.steps != null) {
      const board = state && state.board ? state.board : null;
      const pawnsList = board && Array.isArray(board.pawns) ? board.pawns : [];
      const pawn = pawnsList.find((p) => p.pawnId === move.pawnId);
      const pos = pawn && pawn.position ? pawn.position : null;
      const posType = pos && typeof pos.type === "string" ? pos.type : null;

      const primaryLabel = describePawnForSummary(state, colors, move.pawnId);

      if (
        (cardName === "1" || cardName === "2") &&
        posType === "start" &&
        move.direction === "forward" &&
        move.steps > 0
      ) {
        const stepsText =
          move.steps === 1 ? "1 space" : `${move.steps} spaces`;
        const destPhrase = describeDestinationForSummary(move);
        if (destPhrase) {
          return `${primaryLabel} leaving start (${stepsText}) (${destPhrase}).`;
        }
        return `${primaryLabel} leaving start (${stepsText}).`;
      }

      const destPhrase = describeDestinationForSummary(move);
      if (destPhrase) {
        return `${primaryLabel} ${move.direction} ${move.steps} (${destPhrase}).`;
      }
      return `${primaryLabel} ${move.direction} ${move.steps}.`;
    }
    return "";
  }

  function findSelectedMove(movesArray, selectedIndex) {
    if (!Array.isArray(movesArray)) return null;
    if (selectedIndex == null) return null;
    return (
      movesArray.find((m) => m && m.index === selectedIndex) || null
    );
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
    const viewerSeatIndex =
      typeof g.viewerSeatIndex === "number" ? g.viewerSeatIndex : null;

    if (!state) {
      gameMetaEl.textContent = "Game has not started yet.";
      if (gameCardEl) gameCardEl.innerHTML = "";
      trackGridEl.innerHTML = "";
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
        const initialCards = discard.slice(-10);
        initialCards.forEach((card) => {
          cardHistory.push({ card, seatIndex: null, expanded: false });
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
        let attachedPendingSummary = false;
        newCards.forEach((card) => {
          const entry = { card, seatIndex: prevSeatIndex, expanded: false };
          if (
            !attachedPendingSummary &&
            pendingHistoryDetails &&
            pendingHistoryDetails.seatIndex === prevSeatIndex &&
            typeof pendingHistoryDetails.summary === "string" &&
            pendingHistoryDetails.summary
          ) {
            entry.moveSummary = pendingHistoryDetails.summary;
            attachedPendingSummary = true;
          }
          cardHistory.push(entry);
          if (cardHistory.length > 10) {
            cardHistory = cardHistory.slice(cardHistory.length - 10);
          }
        });
        if (attachedPendingSummary) {
          pendingHistoryDetails = null;
        }
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
    const isPreviewingCard = isActive && upcomingCard != null;
    const displayCard = isPreviewingCard ? upcomingCard : lastCard;

    const genericHint = isActive
      ? isPreviewingCard
        ? "Card shown above. Click a highlighted pawn to choose a move, then Play turn."
        : "Waiting for card preview."
      : "";
    const cardName = displayCard === "Sorry!" ? "¡Lo siento!" : displayCard || "No card";
    const cardDescription = displayCard
      ? getCardDescription(displayCard) || "Card effect available."
      : "No card drawn yet.";

    const movesArray = Array.isArray(upcomingMoves) ? upcomingMoves : [];
    const hasIndexedMoves = isActive && movesArray.length > 0;
    const hasSelectedMove = hasIndexedMoves && selectedMoveIndex != null;
    const onlySwitchMovesFor11 =
      isActive &&
      isPreviewingCard &&
      upcomingCard === "11" &&
      movesArray.length > 0 &&
      !movesArray.some((m) => m.direction === "forward" && m.steps === 11);

    let selectedMove = null;
    let selectedMoveSummary = "";
    if (hasSelectedMove) {
      const move = findSelectedMove(movesArray, selectedMoveIndex);
      if (move) {
        selectedMove = move;
        const baseSummary = buildMoveSummaryBase(
          displayCard,
          move,
          state,
          colors
        );
        if (baseSummary) {
          selectedMoveSummary = `Selected: ${baseSummary}`;
        }
      }
    }

    let moveStatusHtml = "";
    if (isActive && isPreviewingCard) {
      if (!hasIndexedMoves) {
        moveStatusHtml =
          '<div class="game-card-move-status game-card-move-status-none">No available moves</div>';
      } else if (!hasSelectedMove) {
        moveStatusHtml =
          '<div class="game-card-move-status game-card-move-status-unselected">No move selected</div>';
      }
    }

    if (gameMetaEl) {
      gameMetaEl.innerHTML = `
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
      `;
    }

    if (gameCardEl) {
      gameCardEl.innerHTML = `
        <div class="game-card-label">Last card</div>
        <div class="game-card-name">${cardName}</div>
        <div class="game-card-desc">${cardDescription}</div>
        ${moveStatusHtml}
        ${selectedMoveSummary ? `<div class="game-card-selected">${selectedMoveSummary}</div>` : ""}
      `;
    }

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
        const requiresSelection = hasIndexedMoves && !onlySwitchMovesFor11;
        turnActionBtn.disabled = !isActive || (requiresSelection && !hasSelectedMove);
        turnActionBtn.classList.add("turn-btn-human");
      }
      turnActionBtn.textContent = label;
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

    const pawnSeatById = new Map();
    pawns.forEach((p) => {
      if (p && typeof p.pawnId === "string" && typeof p.seatIndex === "number") {
        pawnSeatById.set(p.pawnId, p.seatIndex);
      }
    });

    const trackMap = new Map();
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
    const startHomeCoordBySeat = {};
    const startHomeGeometry = new Map();

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
          const startExitIdx = firstSlide[firstSlide.length - 1];
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

          const startExitCoord = coordForTrackIndex(startExitIdx);
          const startHomeRow = startExitCoord.row + dir.dr;
          const startHomeCol = startExitCoord.col + dir.dc;
          const startHomeKey = `${startHomeRow}:${startHomeCol}`;
          startHomeCoordBySeat[seatIndex] = { row: startHomeRow, col: startHomeCol };
          startHomeGeometry.set(startHomeKey, { seatIndex });

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

    let selectedDestTrackIndex = null;
    let selectedDestSafetySeatIndex = null;
    let selectedDestSafetyIndex = null;
    let selectedDestHomeSeatIndex = null;

    if (selectedMove && selectedMove.destType) {
      const pawnForSelected = pawns.find((p) => p.pawnId === selectedMove.pawnId);
      const seatIndexForSelected =
        pawnForSelected && typeof pawnForSelected.seatIndex === "number"
          ? pawnForSelected.seatIndex
          : null;

      if (selectedMove.destType === "track" && typeof selectedMove.destIndex === "number") {
        selectedDestTrackIndex = selectedMove.destIndex;
      } else if (
        selectedMove.destType === "safety" &&
        typeof selectedMove.destIndex === "number" &&
        seatIndexForSelected != null
      ) {
        selectedDestSafetySeatIndex = seatIndexForSelected;
        selectedDestSafetyIndex = selectedMove.destIndex;
      } else if (selectedMove.destType === "home" && seatIndexForSelected != null) {
        selectedDestHomeSeatIndex = seatIndexForSelected;
      }
    }

    pawns.forEach((p) => {
      const pos = p.position || {};
      const seatIndex = p.seatIndex;
      const color = colors[seatIndex] || "red";
      if (pos.type === "track") {
        const idx = pos.index ?? 0;
        if (!trackMap.has(idx)) trackMap.set(idx, []);
        trackMap.get(idx).push({ seatIndex, color, pawnId: p.pawnId });
      } else if (pos.type === "safety") {
        const safetyIndex = pos.index ?? 0;

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
          const seat = seats[seatIndex];
          let suffix = "";
          if (seat) {
            if (seat.isBot) {
              suffix = " (bot)";
            } else if (seat.displayName) {
              suffix = ` (${seat.displayName})`;
            }
          }
          label.textContent = `Seat ${seatIndex}${suffix}`;
          pill.appendChild(label);

          if (
            state.result === "active" &&
            state.currentSeatIndex === seatIndex &&
            viewerSeatIndex != null &&
            viewerSeatIndex === seatIndex
          ) {
            const turnPill = document.createElement("span");
            turnPill.className = "your-turn-pill";
            turnPill.textContent = "Your turn";
            pill.appendChild(turnPill);
          }

          const home = homeCount[seatIndex] || 0;
          const homeSpan = document.createElement("span");
          homeSpan.className = "status-pill-home";
          homeSpan.textContent = `${home}/4`;
          if (home <= 0) {
            homeSpan.classList.add("home-count-0");
          } else if (home >= 4) {
            homeSpan.classList.add("home-count-full");
          } else {
            homeSpan.classList.add("home-count-mid");
          }
          pill.appendChild(homeSpan);

          statusPillsEl.appendChild(pill);
        });
    }

    trackGridEl.innerHTML = "";
    for (let row = 0; row < BOARD_SIZE; row++) {
      for (let col = 0; col < BOARD_SIZE; col++) {
        const cell = document.createElement("div");
        cell.className = "track-cell";

        const idx = trackIndexForCoord(row, col);
        const coordKey = `${row}:${col}`;
        const safetyGeom = safetyGeometry.get(coordKey);
        const homeGeom = homeGeometry.get(coordKey);
        const startHomeGeom = startHomeGeometry.get(coordKey);

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

          if (
            selectedDestTrackIndex != null &&
            typeof idx === "number" &&
            idx === selectedDestTrackIndex
          ) {
            cell.classList.add("track-cell-selected-dest");
          }

          // For cards 7, 10, and 11, when a pawn is selected, highlight any
          // track tiles that are primary destinations for that pawn and allow
          // clicking the tile to choose the corresponding move.
          if (
            selectedPawnId &&
            (upcomingCard === "7" || upcomingCard === "10" || upcomingCard === "11")
          ) {
            const movesArray = Array.isArray(upcomingMoves) ? upcomingMoves : [];
            let matchingMoves = [];

            if (upcomingCard === "7") {
              if (selectedSecondaryPawnId) {
                // Split-7: require both primary and secondary pawn to match so
                // the highlighted destinations correspond to the chosen pair.
                matchingMoves = movesArray.filter(
                  (m) =>
                    m.card === "7" &&
                    ((m.pawnId === selectedPawnId &&
                      m.secondaryPawnId === selectedSecondaryPawnId) ||
                      (m.pawnId === selectedSecondaryPawnId &&
                        m.secondaryPawnId === selectedPawnId)) &&
                    ((m.destType === "track" &&
                      typeof m.destIndex === "number" &&
                      m.destIndex === idx) ||
                      (m.secondaryDestType === "track" &&
                        typeof m.secondaryDestIndex === "number" &&
                        m.secondaryDestIndex === idx))
                );
              } else {
                // Single-7: only consider moves where this pawn alone moves 7
                // spaces (no secondary pawn).
                matchingMoves = movesArray.filter(
                  (m) =>
                    m.card === "7" &&
                    m.pawnId === selectedPawnId &&
                    !m.secondaryPawnId &&
                    m.destType === "track" &&
                    typeof m.destIndex === "number" &&
                    m.destIndex === idx
                );
              }
            } else {
              matchingMoves = movesArray.filter(
                (m) =>
                  m.pawnId === selectedPawnId &&
                  m.destType === "track" &&
                  typeof m.destIndex === "number" &&
                  m.destIndex === idx
              );
            }

            if (matchingMoves.length > 0) {
              cell.classList.add("track-cell-dest-highlight");
              cell.addEventListener("click", () => {
                const movesNow = Array.isArray(upcomingMoves) ? upcomingMoves : [];
                let candidates = [];

                if (upcomingCard === "7") {
                  if (selectedSecondaryPawnId) {
                    candidates = movesNow.filter(
                      (m) =>
                        m.card === "7" &&
                        ((m.pawnId === selectedPawnId &&
                          m.secondaryPawnId === selectedSecondaryPawnId) ||
                          (m.pawnId === selectedSecondaryPawnId &&
                            m.secondaryPawnId === selectedPawnId)) &&
                        ((m.destType === "track" &&
                          typeof m.destIndex === "number" &&
                          m.destIndex === idx) ||
                          (m.secondaryDestType === "track" &&
                            typeof m.secondaryDestIndex === "number" &&
                            m.secondaryDestIndex === idx))
                    );
                  } else {
                    candidates = movesNow.filter(
                      (m) =>
                        m.card === "7" &&
                        m.pawnId === selectedPawnId &&
                        !m.secondaryPawnId &&
                        m.destType === "track" &&
                        typeof m.destIndex === "number" &&
                        m.destIndex === idx
                    );
                  }
                } else {
                  candidates = movesNow.filter(
                    (m) =>
                      m.pawnId === selectedPawnId &&
                      m.destType === "track" &&
                      typeof m.destIndex === "number" &&
                      m.destIndex === idx
                  );
                }

                if (!candidates.length) return;
                let chosen = null;
                if (selectedMoveIndex != null) {
                  const currentIdx = candidates.findIndex(
                    (m) => m.index === selectedMoveIndex
                  );
                  const nextIdx = currentIdx >= 0 ? (currentIdx + 1) % candidates.length : 0;
                  chosen = candidates[nextIdx];
                } else {
                  chosen = candidates[0];
                }
                if (!chosen || typeof chosen.index !== "number") return;
                selectedMoveIndex = chosen.index;
                renderGame();
              });
            }
          }
        }

        if (homeGeom && selectedPawnId && upcomingCard === "7") {
          const movesArray = Array.isArray(upcomingMoves) ? upcomingMoves : [];
          const homeSeatIndex = homeGeom.seatIndex;
          let matchingHomeMoves = [];

          if (selectedSecondaryPawnId) {
            matchingHomeMoves = movesArray.filter(
              (m) =>
                m.card === "7" &&
                ((m.pawnId === selectedPawnId &&
                  m.secondaryPawnId === selectedSecondaryPawnId) ||
                  (m.pawnId === selectedSecondaryPawnId &&
                    m.secondaryPawnId === selectedPawnId)) &&
                ((m.destType === "home" &&
                  pawnSeatById.get(m.pawnId) === homeSeatIndex) ||
                  (m.secondaryDestType === "home" &&
                    m.secondaryPawnId &&
                    pawnSeatById.get(m.secondaryPawnId) === homeSeatIndex))
            );
          } else {
            matchingHomeMoves = movesArray.filter(
              (m) =>
                m.card === "7" &&
                m.pawnId === selectedPawnId &&
                !m.secondaryPawnId &&
                m.destType === "home" &&
                pawnSeatById.get(m.pawnId) === homeSeatIndex
            );
          }

          if (matchingHomeMoves.length > 0) {
            cell.classList.add("track-cell-dest-highlight");
            cell.addEventListener("click", () => {
              const movesNow = Array.isArray(upcomingMoves) ? upcomingMoves : [];
              const homeSeatIndexNow = homeGeom.seatIndex;
              let candidates = [];

              if (selectedSecondaryPawnId) {
                candidates = movesNow.filter(
                  (m) =>
                    m.card === "7" &&
                    ((m.pawnId === selectedPawnId &&
                      m.secondaryPawnId === selectedSecondaryPawnId) ||
                      (m.pawnId === selectedSecondaryPawnId &&
                        m.secondaryPawnId === selectedPawnId)) &&
                    ((m.destType === "home" &&
                      pawnSeatById.get(m.pawnId) === homeSeatIndexNow) ||
                      (m.secondaryDestType === "home" &&
                        m.secondaryPawnId &&
                        pawnSeatById.get(m.secondaryPawnId) === homeSeatIndexNow))
                );
              } else {
                candidates = movesNow.filter(
                  (m) =>
                    m.card === "7" &&
                    m.pawnId === selectedPawnId &&
                    !m.secondaryPawnId &&
                    m.destType === "home" &&
                    pawnSeatById.get(m.pawnId) === homeSeatIndexNow
                );
              }

              if (!candidates.length) return;
              let chosen = null;
              if (selectedMoveIndex != null) {
                const currentIdx = candidates.findIndex(
                  (m) => m.index === selectedMoveIndex
                );
                const nextIdx =
                  currentIdx >= 0 ? (currentIdx + 1) % candidates.length : 0;
                chosen = candidates[nextIdx];
              } else {
                chosen = candidates[0];
              }
              if (!chosen || typeof chosen.index !== "number") return;
              selectedMoveIndex = chosen.index;
              renderGame();
            });
          }
        }

        if (safetyGeom) {
          cell.classList.add("track-cell-safety");
        }
        if (homeGeom) {
          cell.classList.add("track-cell-home");
        }
        if (startHomeGeom) {
          cell.classList.add("track-cell-start-home");
        }

        if (
          safetyGeom &&
          selectedDestSafetySeatIndex != null &&
          selectedDestSafetyIndex != null &&
          safetyGeom.seatIndex === selectedDestSafetySeatIndex &&
          safetyGeom.safetyIndex === selectedDestSafetyIndex
        ) {
          cell.classList.add("track-cell-selected-dest");
        }
        if (
          homeGeom &&
          selectedDestHomeSeatIndex != null &&
          homeGeom.seatIndex === selectedDestHomeSeatIndex
        ) {
          cell.classList.add("track-cell-selected-dest");
        }

        let ownerSeatIndex = null;
        if (homeGeom && typeof homeGeom.seatIndex === "number") {
          ownerSeatIndex = homeGeom.seatIndex;
        } else if (startHomeGeom && typeof startHomeGeom.seatIndex === "number") {
          ownerSeatIndex = startHomeGeom.seatIndex;
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
        let occupantCount = 0;
        let occupantType = null;
        if (homeGeom) {
          const occs = homeOccupants.get(coordKey) || [];
          if (occs.length > 0) {
            occupant = occs[0];
            occupantCount = occs.length;
            occupantType = "home";
          }
        }
        if (!occupant && safetyGeom) {
          const occs = safetyOccupants.get(coordKey) || [];
          if (occs.length > 0) {
            occupant = occs[0];
            occupantCount = occs.length;
            occupantType = "safety";
          }
        }
        if (!occupant && idx !== null && idx !== undefined) {
          const occs = trackMap.get(idx) || [];
          if (occs.length > 0) {
            occupant = occs[0];
            occupantCount = occs.length;
            occupantType = "track";
          }
        }

        // If there is no pawn on the track here but this square is the
        // "start-home" for a seat, show a virtual pawn representing any
        // pawns that seat has in Start so the player can click this square to
        // bring a pawn out.
        if (!occupant && startHomeGeom && typeof startHomeGeom.seatIndex === "number") {
          const seatIndexForStart = startHomeGeom.seatIndex;
          const startPawnsForSeat = pawns.filter(
            (p) =>
              p.seatIndex === seatIndexForStart &&
              p.position &&
              p.position.type === "start"
          );
          const totalStartPawns = startPawnsForSeat.length;
          if (totalStartPawns > 0) {
            let chosen = startPawnsForSeat[0];
            if (legalMoverPawnIds && legalMoverPawnIds.size > 0) {
              const legalStart = startPawnsForSeat.filter((p) =>
                legalMoverPawnIds.has(p.pawnId)
              );
              if (legalStart.length > 0) {
                chosen = legalStart[0];
              }
            }
            const color = colors[seatIndexForStart] || "red";
            occupant = {
              seatIndex: seatIndexForStart,
              color,
              pawnId: chosen.pawnId,
            };
            occupantCount = totalStartPawns;
            occupantType = "start";
          }
        }

        if (occupant) {
          const dot = document.createElement("div");
          dot.className = `pawn-dot ${occupant.color}`;

          const isLegalMover = legalMoverPawnIds && legalMoverPawnIds.has(occupant.pawnId);
          const isOwnSeat = occupant.seatIndex === state.currentSeatIndex;

          if (isLegalMover) {
            dot.classList.add("legal-mover");
            dot.addEventListener("click", () => {
              const pawnId = occupant.pawnId;
              const movesArray = Array.isArray(upcomingMoves) ? upcomingMoves : [];

              // For Sorry!, clicking your own Start pawn arms the move and lets
              // you pick a specific opponent pawn as the target.
              if (upcomingCard === "Sorry!") {
                selectedPawnId = pawnId;
                // Clear any previously chosen indexed move so the player must
                // click a concrete opponent target.
                selectedMoveIndex = null;
                renderGame();
                return;
              }

              // Card 7: first click selects the primary pawn, second click
              // selects a secondary pawn (if a split-7 move exists between
              // them). After two pawns are chosen, click a highlighted
              // destination tile to pick the exact split.
              if (upcomingCard === "7") {
                if (!selectedPawnId) {
                  selectedPawnId = pawnId;
                  selectedSecondaryPawnId = null;
                  selectedMoveIndex = null;
                  renderGame();
                  return;
                }

                // One pawn currently selected; try to form a split pair.
                if (selectedPawnId && !selectedSecondaryPawnId) {
                  if (pawnId === selectedPawnId) {
                    // Clicking the same pawn again keeps it as the primary;
                    // the player will choose a destination tile next.
                    return;
                  }

                  const hasSplitWithThisPair = movesArray.some(
                    (m) =>
                      m.card === "7" &&
                      ((m.pawnId === selectedPawnId &&
                        m.secondaryPawnId === pawnId) ||
                        (m.pawnId === pawnId &&
                          m.secondaryPawnId === selectedPawnId))
                  );

                  if (hasSplitWithThisPair) {
                    selectedSecondaryPawnId = pawnId;
                    selectedMoveIndex = null;
                    renderGame();
                    return;
                  }

                  // No split with the previously selected pawn; treat this
                  // pawn as the new primary selection.
                  selectedPawnId = pawnId;
                  selectedSecondaryPawnId = null;
                  selectedMoveIndex = null;
                  renderGame();
                  return;
                }

                // Two pawns already selected: keep the most recently selected
                // pawn and add the newly clicked pawn as the other half of the
                // pair, when a split-7 move exists for that pair.
                if (selectedPawnId && selectedSecondaryPawnId) {
                  // Clicking one of the already selected pawns collapses to a
                  // single-pawn selection for that pawn.
                  if (pawnId === selectedPawnId || pawnId === selectedSecondaryPawnId) {
                    selectedPawnId = pawnId;
                    selectedSecondaryPawnId = null;
                    selectedMoveIndex = null;
                    renderGame();
                    return;
                  }

                  const newPrimary = selectedSecondaryPawnId;
                  const newSecondary = pawnId;

                  const hasSplitWithNewPair = movesArray.some(
                    (m) =>
                      m.card === "7" &&
                      ((m.pawnId === newPrimary &&
                        m.secondaryPawnId === newSecondary) ||
                        (m.pawnId === newSecondary &&
                          m.secondaryPawnId === newPrimary))
                  );

                  if (hasSplitWithNewPair) {
                    selectedPawnId = newPrimary;
                    selectedSecondaryPawnId = newSecondary;
                    selectedMoveIndex = null;
                    renderGame();
                    return;
                  }

                  // If there is no split for the rolling pair, fall back to
                  // treating the clicked pawn as the new primary.
                  selectedPawnId = pawnId;
                  selectedSecondaryPawnId = null;
                  selectedMoveIndex = null;
                  renderGame();
                  return;
                }
              }

              if (upcomingCard === "11" && onlySwitchMovesFor11) {
                if (selectedPawnId === pawnId && selectedMoveIndex != null) {
                  const selectedMove = findSelectedMove(movesArray, selectedMoveIndex);
                  if (
                    selectedMove &&
                    selectedMove.pawnId === pawnId &&
                    selectedMove.targetPawnId
                  ) {
                    selectedPawnId = null;
                    selectedSecondaryPawnId = null;
                    selectedMoveIndex = null;
                    renderGame();
                    return;
                  }
                }
              }

              // Default behavior for all other cards: clicking a legal mover
              // cycles through that pawn's available moves.
              const candidates = movesArray.filter((m) => m.pawnId === pawnId);
              let chosen = null;
              if (candidates.length > 0) {
                if (selectedPawnId === pawnId && selectedMoveIndex != null) {
                  const currentIdx = candidates.findIndex((m) => m.index === selectedMoveIndex);
                  const nextIdx = currentIdx >= 0 ? (currentIdx + 1) % candidates.length : 0;
                  chosen = candidates[nextIdx];
                } else {
                  chosen = candidates[0];
                }
              }
              selectedPawnId = pawnId;
              selectedMoveIndex = chosen ? chosen.index : null;
              renderGame();
            });
          }

          // For Sorry!, once an own Start pawn is selected, opponent pawns that
          // are legal targets become clickable so you can choose exactly which
          // pawn to bump.
          if (
            upcomingCard === "Sorry!" &&
            selectedPawnId &&
            !isOwnSeat
          ) {
            const movesArray = Array.isArray(upcomingMoves) ? upcomingMoves : [];
            const hasSorryMoveToThisPawn = movesArray.some(
              (m) =>
                m.pawnId === selectedPawnId &&
                m.targetPawnId &&
                m.targetPawnId === occupant.pawnId
            );

            if (hasSorryMoveToThisPawn) {
              dot.classList.add("legal-mover");
              dot.addEventListener("click", () => {
                const moves = Array.isArray(upcomingMoves) ? upcomingMoves : [];
                const move = moves.find(
                  (m) =>
                    m.pawnId === selectedPawnId &&
                    m.targetPawnId &&
                    m.targetPawnId === occupant.pawnId
                );
                if (!move || typeof move.index !== "number") return;
                selectedMoveIndex = move.index;
                renderGame();
              });
            }
          }

          // For card 11, once one of your pawns is selected as the source, any
          // opponent pawns that are legal switch targets become clickable so
          // you can pick the exact pawn to swap with.
          if (
            upcomingCard === "11" &&
            selectedPawnId &&
            !isOwnSeat
          ) {
            const movesArray = Array.isArray(upcomingMoves) ? upcomingMoves : [];
            const hasSwitchToThisPawn = movesArray.some(
              (m) =>
                m.pawnId === selectedPawnId &&
                m.targetPawnId &&
                m.targetPawnId === occupant.pawnId
            );

            if (hasSwitchToThisPawn) {
              dot.classList.add("legal-mover");
              dot.addEventListener("click", () => {
                const moves = Array.isArray(upcomingMoves) ? upcomingMoves : [];
                const move = moves.find(
                  (m) =>
                    m.pawnId === selectedPawnId &&
                    m.targetPawnId &&
                    m.targetPawnId === occupant.pawnId
                );
                if (!move || typeof move.index !== "number") return;
                selectedMoveIndex = move.index;
                renderGame();
              });
            }
          }

          let isPrimarySelected = false;
          let isTargetSelected = false;
          let isSecondarySelected = false;

          if (selectedMove) {
            if (occupant.pawnId === selectedMove.pawnId) {
              isPrimarySelected = true;
            }
            if (selectedMove.targetPawnId && occupant.pawnId === selectedMove.targetPawnId) {
              isTargetSelected = true;
            }
            if (selectedMove.secondaryPawnId && occupant.pawnId === selectedMove.secondaryPawnId) {
              isSecondarySelected = true;
            }
          } else {
            if (selectedPawnId && occupant.pawnId === selectedPawnId) {
              isPrimarySelected = true;
            }
            if (selectedSecondaryPawnId && occupant.pawnId === selectedSecondaryPawnId) {
              isSecondarySelected = true;
            }
          }

          if (isPrimarySelected || isTargetSelected || isSecondarySelected) {
            dot.classList.add("pawn-selected");
          }
          if (isTargetSelected) {
            dot.classList.add("pawn-target");
          }
          let label = "";
          if (occupantType === "start" && occupantCount > 1) {
            label = String(occupantCount);
          } else if (occupantType === "home" && occupantCount > 1) {
            label = String(occupantCount);
          }
          if (label) {
            dot.textContent = label;
          }
          cell.appendChild(dot);
        }

        trackGridEl.appendChild(cell);
      }
    }

    if (cardHistoryEl) {
      let prevScrollTop = 0;
      let prevScrollHeight = 0;
      let hadList = false;
      const existingList = cardHistoryEl.querySelector(".card-history-list");
      if (existingList) {
        prevScrollTop = existingList.scrollTop;
        prevScrollHeight = existingList.scrollHeight;
        hadList = true;
      }

      cardHistoryEl.innerHTML = "";
      if (!cardHistory || cardHistory.length === 0) {
        const empty = document.createElement("div");
        empty.className = "card-history-empty";
        empty.textContent = "No cards drawn yet.";
        cardHistoryEl.appendChild(empty);
      } else {
        const list = document.createElement("div");
        list.className = "card-history-list";
        const historyToRender = Array.isArray(cardHistory)
          ? cardHistory.slice().reverse()
          : [];

        historyToRender.forEach((entry) => {
          const item = document.createElement("div");
          item.className = "card-history-item";

          const header = document.createElement("div");
          header.className = "card-history-header";

          const seatLabel = document.createElement("span");
          seatLabel.className = "card-history-seat";
          let seatText = "Seat ?";
          if (entry && entry.seatIndex != null) {
            seatText = `Seat ${entry.seatIndex}`;
            if (Object.prototype.hasOwnProperty.call(colors, entry.seatIndex)) {
              const seatColor = colors[entry.seatIndex];
              if (seatColor) {
                item.classList.add(`seat-${seatColor}`);
              }
            }
          }
          seatLabel.textContent = seatText;

          const cardLabel = document.createElement("span");
          cardLabel.className = "card-history-card";
          let cardText = entry && entry.card != null ? String(entry.card) : "";
          if (cardText === "Sorry!") {
            cardText = "¡Lo siento!";
          }
          cardLabel.textContent = cardText;

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
            descEl.className = "card-history-desc";
            if (!entry.expanded) {
              descEl.classList.add("hidden");
            }
            descEl.textContent = descText;
            if (entry && typeof entry.moveSummary === "string" && entry.moveSummary) {
              descEl.appendChild(document.createElement("br"));
              const moveEl = document.createElement("span");
              moveEl.className = "card-history-move";
              moveEl.textContent = `Move: ${entry.moveSummary}`;
              descEl.appendChild(moveEl);
            }

            toggle.addEventListener("click", () => {
              const isHidden = descEl.classList.contains("hidden");
              if (isHidden) {
                descEl.classList.remove("hidden");
                entry.expanded = true;
              } else {
                descEl.classList.add("hidden");
                entry.expanded = false;
              }
            });

            item.appendChild(toggle);
            item.appendChild(descEl);
          }

          list.appendChild(item);
        });
        cardHistoryEl.appendChild(list);

        if (hadList) {
          const newList = cardHistoryEl.querySelector(".card-history-list");
          if (newList) {
            const newScrollHeight = newList.scrollHeight;
            if (prevScrollTop > 0 && prevScrollHeight > 0) {
              const delta = newScrollHeight - prevScrollHeight;
              const target = prevScrollTop + delta;
              newList.scrollTop = target > 0 ? target : 0;
            } else {
              newList.scrollTop = 0;
            }
          }
        }
      }
    }
  }

  async function handleHostSubmit(e) {
    e.preventDefault();
    const maxSeats = parseInt(hostMaxSeats.value || "4", 10);
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
    const movesArray = Array.isArray(upcomingMoves) ? upcomingMoves : [];
    const hasMultipleMoves = movesArray.length > 1;
    const onlySwitchMovesFor11 =
      upcomingCard === "11" &&
      movesArray.length > 0 &&
      !movesArray.some((m) => m.direction === "forward" && m.steps === 11);
    if (hasMultipleMoves && selectedMoveIndex == null && !onlySwitchMovesFor11) {
      showToast("Select a highlighted pawn/move before playing your turn.");
      return;
    }
    try {
      let historySummary = "";
      let historySeatIndex = null;
      if (currentGame && currentGame.state && currentGame.state.result === "active") {
        const g = currentGame;
        const state = g.state;
        const colors = seatColorMap(g);
        const move = findSelectedMove(movesArray, selectedMoveIndex);
        if (move && upcomingCard) {
          const base = buildMoveSummaryBase(
            upcomingCard,
            move,
            state,
            colors
          );
          if (base) {
            historySummary = base;
            historySeatIndex = state.currentSeatIndex;
          }
        }
      }
      if (historySummary && historySeatIndex != null) {
        pendingHistoryDetails = {
          seatIndex: historySeatIndex,
          summary: historySummary,
        };
      } else {
        pendingHistoryDetails = null;
      }
      const payload = selectedMoveIndex != null ? { moveIndex: selectedMoveIndex } : {};
      const data = await api("/play", {
        method: "POST",
        body: JSON.stringify({ game_id: currentGame.gameId, payload }),
      });
      currentGame = data;
      selectedPawnId = null;
      selectedSecondaryPawnId = null;
      selectedMoveIndex = null;
      upcomingCard = null;
      upcomingMoves = [];
      legalMoverPawnIds = new Set();
      renderFromGame();
    } catch (err) {
      pendingHistoryDetails = null;
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
        selectedSecondaryPawnId = null;
        upcomingCard = null;
        upcomingMoves = [];
        selectedMoveIndex = null;
        lastPreviewGameId = null;
        lastPreviewTurnNumber = null;
        lastPreviewDiscardLength = null;
        return;
      }
      const state = currentGame.state;
      if (state.result !== "active") {
        legalMoverPawnIds = new Set();
        selectedPawnId = null;
        selectedSecondaryPawnId = null;
        upcomingCard = null;
        upcomingMoves = [];
        selectedMoveIndex = null;
        lastPreviewGameId = null;
        lastPreviewTurnNumber = null;
        lastPreviewDiscardLength = null;
        return;
      }

      const gameId = currentGame.gameId;
      const turnNumber = state.turnNumber;
      const discard = Array.isArray(state.discardPile) ? state.discardPile : [];
      const discardLen = discard.length;

      // The backend preview is deterministic for a given game/turn. Avoid
      // re-calling it repeatedly for the same (gameId, turnNumber) and just
      // reuse the cached upcomingCard/moves instead.
      if (
        lastPreviewGameId === gameId &&
        lastPreviewTurnNumber === turnNumber &&
        lastPreviewDiscardLength === discardLen
      ) {
        renderGame();
        return;
      }

      const resp = await fetch(
        `${API_BASE}/legal-movers?game_id=${encodeURIComponent(currentGame.gameId)}`,
        { method: "GET" }
      );
      if (!resp.ok) {
        legalMoverPawnIds = new Set();
        selectedPawnId = null;
        selectedSecondaryPawnId = null;
        upcomingCard = null;
        upcomingMoves = [];
        selectedMoveIndex = null;
        lastPreviewGameId = null;
        lastPreviewTurnNumber = null;
        lastPreviewDiscardLength = null;
        return;
      }
      const data = await resp.json();
      const ids = Array.isArray(data.pawnIds) ? data.pawnIds : [];
      legalMoverPawnIds = new Set(ids);

      upcomingCard = typeof data.card === "string" ? data.card : null;
      upcomingMoves = Array.isArray(data.moves) ? data.moves : [];

      if (selectedPawnId && !legalMoverPawnIds.has(selectedPawnId)) {
        selectedPawnId = null;
        selectedSecondaryPawnId = selectedSecondaryPawnId; // Keep selectedSecondaryPawnId consistent
      }

      if (selectedMoveIndex != null) {
        const stillExists =
          Array.isArray(upcomingMoves) &&
          upcomingMoves.some((m) => typeof m.index === "number" && m.index === selectedMoveIndex);
        if (!stillExists) {
          selectedMoveIndex = null;
        }
      }

      if (Array.isArray(upcomingMoves) && upcomingMoves.length === 1) {
        const onlyMove = upcomingMoves[0];
        if (onlyMove && typeof onlyMove.index === "number") {
          selectedMoveIndex = onlyMove.index;
          selectedPawnId = onlyMove.pawnId || null;
        }
      }

      lastPreviewGameId = gameId;
      lastPreviewTurnNumber = turnNumber;
      lastPreviewDiscardLength = discardLen;
      renderGame();
    } catch (err) {
      // Advisory only; ignore errors.
      legalMoverPawnIds = new Set();
      selectedPawnId = null;
      selectedSecondaryPawnId = null;
      upcomingCard = null;
      upcomingMoves = [];
      selectedMoveIndex = null;
      lastPreviewGameId = null;
      lastPreviewTurnNumber = null;
      lastPreviewDiscardLength = null;
    }
  }

  function init() {
    hostForm.addEventListener("submit", handleHostSubmit);
    refreshJoinableBtn.addEventListener("click", refreshJoinable);

    startGameBtn.addEventListener("click", handleStartGame);
    leaveLobbyBtn.addEventListener("click", handleLeave);

    leaveGameBtn.addEventListener("click", handleLeave);
    if (autoplayBotBtn) {
      autoplayBotBtn.textContent = "Autoplay bot turns (off)";
      autoplayBotBtn.addEventListener("click", () => {
        if (autoplayBotEnabled) {
          stopAutoplay();
        } else {
          startAutoplay();
        }
      });
    }
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
