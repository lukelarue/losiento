(() => {
  const API_BASE = "/api/losiento";
  const _params = new URLSearchParams(window.location.search || "");
  const EXTERNAL_USER_ID = _params.get("x-user-id");
  const EXTERNAL_USER_NAME = _params.get("x-user-name");
  let USER_ID = EXTERNAL_USER_ID || window.localStorage.getItem("losiento_user");
  if (!USER_ID) {
    const rnd = Math.random().toString(36).slice(2);
    const ts = Date.now().toString(36);
    USER_ID = `ls_${ts}_${rnd}`;
  }
  window.localStorage.setItem("losiento_user", USER_ID);
  const USER_NAME = EXTERNAL_USER_NAME || null;

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
  const turnBlurbEl = document.getElementById("turn-blurb");
  const startAreasEl = document.getElementById("start-areas");
  const safetyHomeEl = document.getElementById("safety-home");
  const cardHistoryEl = document.getElementById("card-history");
  const turnActionBtn = document.getElementById("turn-action");
  const leaveGameBtn = document.getElementById("leave-game");
  const autoplayOffBtn = document.getElementById("autoplay-off");
  const autoplaySlowBtn = document.getElementById("autoplay-slow");
  const autoplayFastBtn = document.getElementById("autoplay-fast");

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
  // Card history is now server-side, so we just track what game we're showing
  let cardHistoryGameId = null;
  // Track which card history entries have details expanded (by turn number)
  let cardHistoryExpandedTurns = new Set();
  let autoplayBotEnabled = false;
  let autoplayTimeout = null;
  let autoplaySpeed = 2; // 0=off, 1=slow, 2=fast (default: fast)
  const AUTOPLAY_DELAYS = { 0: 0, 1: 2500, 2: 750 };
  let lastPreviewGameId = null;
  let lastPreviewTurnNumber = null;
  let lastPreviewDiscardLength = null;

  // Interface mode: 'basic' or 'losiento'
  let interfaceMode = 'losiento';
  
  // Lo Siento mode DOM elements
  const losientoBoardWrapperEl = document.getElementById('losiento-board-wrapper');
  const losientoBoardEl = document.getElementById('losiento-board');
  const losientoHighlightsEl = document.getElementById('losiento-highlights');
  const losientoPawnsEl = document.getElementById('losiento-pawns');
  const modeBasicBtn = document.getElementById('mode-basic');
  const modeLoSientoBtn = document.getElementById('mode-losiento');

  // Calculate and apply scale factor for Lo Siento board
  function updateLoSientoBoardScale() {
    if (!losientoBoardWrapperEl || !losientoBoardEl) return;
    
    // Measure the parent container (game-middle column) for stable reference
    const parent = losientoBoardWrapperEl.parentElement;
    if (!parent) return;
    
    const parentRect = parent.getBoundingClientRect();
    const availableWidth = parentRect.width - 16; // Account for padding
    const availableHeight = window.innerHeight - 120; // Leave room for UI
    
    // The board is 800x800px, calculate scale to fit in available space
    const scaleX = availableWidth / 800;
    const scaleY = availableHeight / 800;
    // Scale up to fill space nicely
    const scale = Math.min(scaleX, scaleY) * 1.11;
    
    losientoBoardEl.style.setProperty('--ls-scale', scale);
    losientoBoardWrapperEl.style.width = `${800 * scale}px`;
    losientoBoardWrapperEl.style.height = `${800 * scale}px`;
  }
  
  // Throttled resize handler
  let resizeTimeout = null;
  function onWindowResize() {
    if (resizeTimeout) return;
    resizeTimeout = setTimeout(() => {
      resizeTimeout = null;
      updateLoSientoBoardScale();
    }, 50);
  }
  
  window.addEventListener('resize', onWindowResize);
  
  // Animation state for Lo Siento mode
  let lsAnimationQueue = [];
  let lsAnimating = false;
  
  // Track previous pawn positions for animation detection
  let lsPreviousPawnPositions = new Map(); // pawnId -> { type, index, seatIndex, x, y }
  let lsLastRenderedTurnNumber = null;
  let lsLastRenderedGameId = null;

  // Track grid constants and coordinate mapping (shared between basic and Lo Siento modes)
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
    
    // Update board scale when game screen is shown
    if (name === 'game') {
      requestAnimationFrame(() => {
        updateLoSientoBoardScale();
      });
    }
  }

  async function api(path, options = {}) {
    const resp = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        "X-User-Id": USER_ID,
        ...(USER_NAME ? { "X-User-Name": USER_NAME } : {}),
        ...(options.headers || {}),
      },
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
      if (!currentGame) return;
      // Poll in both lobby (for non-hosts to see game start) and active phases
      if (currentGame.phase !== "active" && currentGame.phase !== "lobby") return;
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
  }

  function setAutoplaySpeed(speed) {
    autoplaySpeed = speed;
    // Update button active states
    if (autoplayOffBtn) autoplayOffBtn.classList.toggle('autoplay-btn-active', speed === 0);
    if (autoplaySlowBtn) autoplaySlowBtn.classList.toggle('autoplay-btn-active', speed === 1);
    if (autoplayFastBtn) autoplayFastBtn.classList.toggle('autoplay-btn-active', speed === 2);
    
    if (speed === 0) {
      stopAutoplay();
    } else {
      startAutoplay();
    }
  }

  function scheduleAutoplayTick() {
    if (!autoplayBotEnabled) return;
    if (autoplayTimeout) return;
    autoplayTimeout = setTimeout(runAutoplayTick, AUTOPLAY_DELAYS[autoplaySpeed] || 750);
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
    if (autoplaySpeed === 0) return;
    if (autoplayBotEnabled) return;
    autoplayBotEnabled = true;
    scheduleAutoplayTick();
  }

  function isHost() {
    return currentGame && currentGame.hostId === USER_ID;
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
      cardHistoryGameId = null;
      cardHistoryExpandedTurns = new Set();
      lastPreviewGameId = null;
      lastPreviewTurnNumber = null;
      lastPreviewDiscardLength = null;
      setScreen("noGame");
      return;
    }

    if (currentGame.phase === "lobby") {
      stopAutoplay();
      renderLobby();
      setScreen("lobby");
      // Enable polling in lobby so non-hosts see when game starts
      startPolling();
    } else if (currentGame.phase === "active") {
      renderGame();
      setScreen("game");
      startPolling();
      refreshLegalMovers();
      // Only host can use autoplay - resume if speed is set
      if (isHost() && autoplaySpeed > 0 && !autoplayBotEnabled) {
        startAutoplay();
      }
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
    const amHost = isHost();
    const viewerSeatIndex = typeof g.viewerSeatIndex === "number" ? g.viewerSeatIndex : null;

    seats.forEach((s) => {
      const seatEl = document.createElement("div");
      seatEl.className = "lobby-seat";
      // Add colored background based on seat color
      seatEl.classList.add(`lobby-seat-${s.color}`);

      const header = document.createElement("div");
      header.className = "lobby-seat-header";
      const label = document.createElement("span");
      // Display seat numbers as 1-4 instead of 0-3
      label.textContent = `Seat ${s.index + 1} (${s.color})`;

      const pill = document.createElement("span");
      pill.classList.add("pill");
      if (s.status === "joined" && !s.isBot) {
        pill.classList.add("pill-human");
        pill.textContent = "Human";
      } else if (s.isBot) {
        pill.classList.add("pill-bot");
        pill.textContent = "Bot";
      } else if (s.status === "closed") {
        pill.classList.add("pill-closed");
        pill.textContent = "Closed";
      } else {
        pill.classList.add("pill-open");
        pill.textContent = "Open";
      }

      header.appendChild(label);
      header.appendChild(pill);
      seatEl.appendChild(header);

      const body = document.createElement("div");
      body.className = "lobby-seat-body";
      const nameSpan = document.createElement("span");
      nameSpan.textContent = s.displayName || (s.isBot ? "Bot" : s.status === "closed" ? "(closed)" : "(empty)");
      body.appendChild(nameSpan);
      seatEl.appendChild(body);

      // Controls row: dropdown on left (host only, not for own seat), swap button on far right
      if (g.phase === "lobby") {
        const controls = document.createElement("div");
        controls.className = "lobby-seat-controls";
        
        const leftSide = document.createElement("div");
        leftSide.className = "lobby-seat-controls-left";
        
        // Host-only dropdown for seat configuration (not for host's own seat)
        const isHostSeat = s.playerId === g.hostId;
        if (amHost && !isHostSeat) {
          const dropdown = document.createElement("select");
          dropdown.className = "seat-config-dropdown";
          
          const optHuman = document.createElement("option");
          optHuman.value = "open";
          optHuman.textContent = "Human";
          
          const optBot = document.createElement("option");
          optBot.value = "bot";
          optBot.textContent = "Bot";
          
          const optClosed = document.createElement("option");
          optClosed.value = "closed";
          optClosed.textContent = "Closed";
          
          dropdown.appendChild(optHuman);
          dropdown.appendChild(optBot);
          dropdown.appendChild(optClosed);
          
          // Set current value based on seat status
          if (s.isBot) {
            dropdown.value = "bot";
          } else if (s.status === "closed") {
            dropdown.value = "closed";
          } else {
            dropdown.value = "open";
          }

          // Pause polling while host is interacting with the dropdown so the
          // lobby UI doesn't get rebuilt underneath the open menu.
          dropdown.addEventListener("focus", () => {
            stopPolling();
          });

          dropdown.addEventListener("blur", () => {
            if (currentGame && currentGame.phase === "lobby") {
              startPolling();
            }
          });

          dropdown.addEventListener("change", async () => {
            const newStatus = dropdown.value;
            try {
              const updated = await api("/configure-seat", {
                method: "POST",
                body: JSON.stringify({
                  game_id: g.gameId,
                  seat_index: s.index,
                  status: newStatus,
                }),
              });
              currentGame = updated;
              renderFromGame();
              if (s.playerId && s.status === "joined") {
                showToast(`Player kicked from Seat ${s.index + 1}`);
              }
            } catch (err) {
              showToast(`Configure seat failed: ${err.message}`);
              // Reset dropdown to previous value
              if (s.isBot) {
                dropdown.value = "bot";
              } else if (s.status === "closed") {
                dropdown.value = "closed";
              } else {
                dropdown.value = "open";
              }
            }
          });
          
          leftSide.appendChild(dropdown);
        }
        
        controls.appendChild(leftSide);

        // Swap button on far right (for any player to swap with bot/closed seats, not own seat)
        const canSwap = viewerSeatIndex !== null && 
                        s.index !== viewerSeatIndex && 
                        (s.status === "bot" || s.status === "closed");
        if (canSwap) {
          const swapBtn = document.createElement("button");
          swapBtn.className = "swap-seat-btn";
          swapBtn.textContent = "⇄";
          swapBtn.title = `Swap to Seat ${s.index + 1}`;
          swapBtn.addEventListener("click", async () => {
            try {
              const updated = await api("/swap-seat", {
                method: "POST",
                body: JSON.stringify({
                  game_id: g.gameId,
                  target_seat_index: s.index,
                }),
              });
              currentGame = updated;
              renderFromGame();
              showToast(`Swapped to Seat ${s.index + 1}`);
            } catch (err) {
              showToast(`Swap failed: ${err.message}`);
            }
          });
          controls.appendChild(swapBtn);
        }

        seatEl.appendChild(controls);
      }

      lobbySeatsEl.appendChild(seatEl);
    });

    // Disable start button for non-hosts
    if (startGameBtn) {
      startGameBtn.disabled = !amHost;
      startGameBtn.title = amHost ? "" : "Only the host can start the game";
    }
  }

  function renderGame() {
    const g = currentGame;
    const state = g.state;
    const colors = seatColorMap(g);
    const viewerSeatIndex =
      typeof g.viewerSeatIndex === "number" ? g.viewerSeatIndex : null;

    if (!state) {
      if (turnBlurbEl) {
        turnBlurbEl.textContent = "Game has not started yet.";
      }
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

    // Use server-side card history for toast
    const serverCardHistory = Array.isArray(state.cardHistory) ? state.cardHistory : [];
    if (serverCardHistory.length > 0 && lastCard && lastCard !== lastShownCard) {
      const lastEntry = serverCardHistory[serverCardHistory.length - 1];
      let label = String(lastCard);
      if (label === "Sorry!") {
        label = "¡Lo siento!";
      }
      const cardSeatIndex = lastEntry.seatIndex;
      const displayName = lastEntry.displayName;
      // Use 1-indexed seat numbers
      const seatLabel = displayName
        ? `Seat ${cardSeatIndex + 1} (${displayName})`
        : `Seat ${cardSeatIndex + 1}`;
      const toastMessage = `${seatLabel} played a ${label}`;
      showToast(toastMessage, 3000);
      lastShownCard = lastCard;
    }

    if (g.gameId !== cardHistoryGameId) {
      cardHistoryGameId = g.gameId;
    }

    const resultText =
      state.result === "active"
        ? "In progress"
        : state.result === "win"
        ? `Won by Seat ${state.winnerSeatIndex + 1}`
        : state.result;

    const isActive = state.result === "active";
    const isPreviewingCard = isActive && upcomingCard != null;
    // Use server-side current card if available (shows what card is being contemplated by current player)
    const serverCurrentCard = state.currentCard || null;
    // For display: prefer local preview card (if we're the one playing), then server current card, then last discarded
    const displayCard = isPreviewingCard ? upcomingCard : (serverCurrentCard || lastCard);
    // Determine if we're showing a "current" card (being contemplated) vs "last" card (already played)
    const isShowingCurrentCard = isPreviewingCard || (serverCurrentCard != null);

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
        if (onlySwitchMovesFor11 && selectedPawnId) {
          // User has a pawn selected but chose "skip" for card 11
          moveStatusHtml =
            '<div class="game-card-move-status game-card-move-status-skip">Skip turn (click pawn to cycle moves)</div>';
        } else if (onlySwitchMovesFor11) {
          moveStatusHtml =
            '<div class="game-card-move-status game-card-move-status-unselected">No move selected (optional – click pawn to pick a switch or skip)</div>';
        } else {
          moveStatusHtml =
            '<div class="game-card-move-status game-card-move-status-unselected">No move selected</div>';
        }
      }
    }

    if (turnBlurbEl) {
      if (state && typeof state.turnNumber === "number") {
        if (state.result === "active") {
          turnBlurbEl.textContent = `Turn ${state.turnNumber}`;
        } else {
          turnBlurbEl.textContent = `Game over · Turn ${state.turnNumber}`;
        }
      } else {
        turnBlurbEl.textContent = "";
      }
    }

    if (gameCardEl) {
      // Show "Current Card" when someone is contemplating, "Last Card" otherwise
      const cardLabel = isShowingCurrentCard ? "Current card" : "Last card";
      gameCardEl.innerHTML = `
        <div class="game-card-label">${cardLabel}</div>
        <div class="game-card-name">${cardName}</div>
        <div class="game-card-desc">${cardDescription}</div>
        ${moveStatusHtml}
        ${selectedMoveSummary ? `<div class="game-card-selected">${selectedMoveSummary}</div>` : ""}
      `;
    }

    const seats = g.seats || [];
    const currentSeatSeat = seats[state.currentSeatIndex];
    const isBotTurn = !!(currentSeatSeat && currentSeatSeat.isBot);

    // Check if it's the viewer's turn
    const isViewersTurn = viewerSeatIndex != null && viewerSeatIndex === state.currentSeatIndex;
    const amHost = isHost();

    if (turnActionBtn) {
      let label = "";
      turnActionBtn.classList.remove("turn-btn-human", "turn-btn-bot");
      if (!isActive) {
        label = "No turn";
        turnActionBtn.disabled = true;
      } else if (isBotTurn) {
        label = "Bot turn";
        // Only host can trigger bot turns
        turnActionBtn.disabled = !amHost;
        turnActionBtn.classList.add("turn-btn-bot");
      } else {
        label = "Play turn";
        const requiresSelection = hasIndexedMoves && !onlySwitchMovesFor11;
        // Disable if not your turn OR if selection required but not made
        turnActionBtn.disabled = !isViewersTurn || (requiresSelection && !hasSelectedMove);
        turnActionBtn.classList.add("turn-btn-human");
      }
      turnActionBtn.textContent = label;
    }

    // Update autoplay buttons - only host can use them
    const autoplayTitle = amHost ? "" : "Only the host can control autoplay";
    if (autoplayOffBtn) {
      autoplayOffBtn.disabled = !amHost;
      autoplayOffBtn.title = autoplayTitle;
    }
    if (autoplaySlowBtn) {
      autoplaySlowBtn.disabled = !amHost;
      autoplaySlowBtn.title = autoplayTitle;
    }
    if (autoplayFastBtn) {
      autoplayFastBtn.disabled = !amHost;
      autoplayFastBtn.title = autoplayTitle;
    }

    // Track grid 0-59 laid out on a 16x16 outer ring (constants defined at module scope)

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
      // Map seats to board positions (rotated by 2):
      // Seat 0 (Red) -> segment 30, Seat 1 (Blue) -> segment 45,
      // Seat 2 (Yellow) -> segment 0, Seat 3 (Green) -> segment 15
      const offset = ((seatIndex + 2) % 4) * TRACK_SEGMENT_LEN;
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
      // Map seat index to board position (rotated by 2)
      // Seat 0 (Red) -> bottom-right (up), Seat 1 (Blue) -> bottom-left (right)
      // Seat 2 (Yellow) -> top-left (down), Seat 3 (Green) -> top-right (left)
      const rotated = (seatIndex + 2) % 4;
      if (rotated === 0) return { dr: 1, dc: 0 };   // top-left goes down
      if (rotated === 1) return { dr: 0, dc: -1 };  // top-right goes left
      if (rotated === 2) return { dr: -1, dc: 0 };  // bottom-right goes up
      return { dr: 0, dc: 1 };                       // bottom-left goes right
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
    const slideEndToStart = new Map();

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

      const endIdx = segment[segment.length - 1];
      slideEndToStart.set(endIdx, firstIdx);

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

      if (selectedMove.logicalDestType === "track" && typeof selectedMove.logicalDestIndex === "number") {
        // Highlight the logical track square where the pawn lands before any
        // slide effects (the beginning of the slide, not the end).
        selectedDestTrackIndex = selectedMove.logicalDestIndex;
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

          // Add seat color class for colored background
          const seatColor = colors[seatIndex];
          if (seatColor) {
            pill.classList.add(`status-pill-${seatColor}`);
          }

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
          // Use 1-indexed seat numbers
          label.textContent = `Seat ${seatIndex + 1}${suffix}`;
          pill.appendChild(label);

          const isViewerTurn =
            state.result === "active" &&
            state.currentSeatIndex === seatIndex &&
            viewerSeatIndex != null &&
            viewerSeatIndex === seatIndex;

          const turnPill = document.createElement("span");
          turnPill.className = "your-turn-pill";
          if (!isViewerTurn) {
            turnPill.classList.add("your-turn-pill-inactive");
          }
          turnPill.textContent = "Your turn";
          pill.appendChild(turnPill);

          // Add kick button for host (only for non-host human players - can't kick yourself)
          if (amHost && seat && !seat.isBot && seat.playerId && seat.playerId !== g.hostId && isActive) {
            const kickBtn = document.createElement("button");
            kickBtn.className = "kick-player-btn";
            kickBtn.textContent = "Kick";
            kickBtn.addEventListener("click", async () => {
              if (!confirm(`Kick player from Seat ${seatIndex + 1}? They will be replaced by a bot.`)) {
                return;
              }
              try {
                const updated = await api("/kick", {
                  method: "POST",
                  body: JSON.stringify({
                    game_id: g.gameId,
                    seat_index: seatIndex,
                  }),
                });
                currentGame = updated;
                renderFromGame();
                showToast(`Player kicked from Seat ${seatIndex + 1}`);
              } catch (err) {
                showToast(`Kick failed: ${err.message}`);
              }
            });
            pill.appendChild(kickBtn);
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
          // track tiles that are destinations for that pawn and allow clicking
          // the tile to choose the corresponding move.
          if (
            selectedPawnId &&
            (upcomingCard === "7" || upcomingCard === "10" || upcomingCard === "11")
          ) {
            const movesArray = Array.isArray(upcomingMoves) ? upcomingMoves : [];
            let matchingMoves = [];

            if (upcomingCard === "7") {
              if (selectedSecondaryPawnId) {
                // Split-7 with an explicit pair: only consider moves whose
                // primary/secondary pawns match the chosen pair, and where
                // either pawn lands on this track index (using logical dest,
                // i.e. pre-slide position, so players click where they choose
                // to land, not where slides take them).
                matchingMoves = movesArray.filter(
                  (m) =>
                    ((m.pawnId === selectedPawnId &&
                      m.secondaryPawnId === selectedSecondaryPawnId) ||
                      (m.pawnId === selectedSecondaryPawnId &&
                        m.secondaryPawnId === selectedPawnId)) &&
                    ((m.logicalDestType === "track" &&
                      typeof m.logicalDestIndex === "number" &&
                      m.logicalDestIndex === idx) ||
                      (m.secondaryLogicalDestType === "track" &&
                        typeof m.secondaryLogicalDestIndex === "number" &&
                        m.secondaryLogicalDestIndex === idx))
                );
              } else {
                // 7 with a single pawn selected: highlight all legal 7 moves
                // that involve this pawn, whether they are single-7 moves or
                // 7-split moves with any partner, as long as this track index
                // is the landing spot for the selected pawn (pre-slide).
                matchingMoves = movesArray.filter(
                  (m) =>
                    (m.pawnId === selectedPawnId &&
                      m.logicalDestType === "track" &&
                      typeof m.logicalDestIndex === "number" &&
                      m.logicalDestIndex === idx) ||
                    (m.secondaryPawnId === selectedPawnId &&
                      m.secondaryLogicalDestType === "track" &&
                      typeof m.secondaryLogicalDestIndex === "number" &&
                      m.secondaryLogicalDestIndex === idx)
                );
              }
            } else {
              // Cards 10 and 11: highlight simple forward/track destinations
              // (using logical dest, pre-slide position).
              matchingMoves = movesArray.filter(
                (m) =>
                  m.pawnId === selectedPawnId &&
                  m.logicalDestType === "track" &&
                  typeof m.logicalDestIndex === "number" &&
                  m.logicalDestIndex === idx
              );
            }

            if (matchingMoves.length > 0) {
              cell.classList.add("track-cell-dest-highlight");
              cell.addEventListener("click", () => {
                const movesNow = Array.isArray(upcomingMoves) ? upcomingMoves : [];
                let candidates = [];

                if (upcomingCard === "7") {
                  if (selectedSecondaryPawnId) {
                    // Explicit 7-split pair: only use moves for that pair and
                    // this track destination (for either pawn, using logical/pre-slide dest).
                    candidates = movesNow.filter(
                      (m) =>
                        ((m.pawnId === selectedPawnId &&
                          m.secondaryPawnId === selectedSecondaryPawnId) ||
                          (m.pawnId === selectedSecondaryPawnId &&
                            m.secondaryPawnId === selectedPawnId)) &&
                        ((m.logicalDestType === "track" &&
                          typeof m.logicalDestIndex === "number" &&
                          m.logicalDestIndex === idx) ||
                          (m.secondaryLogicalDestType === "track" &&
                            typeof m.secondaryLogicalDestIndex === "number" &&
                            m.secondaryLogicalDestIndex === idx))
                    );
                  } else {
                    // Single pawn selected: allow both single-7 and split-7
                    // moves involving this pawn where this track index is the
                    // landing square for the selected pawn (logical/pre-slide).
                    candidates = movesNow.filter(
                      (m) =>
                        (m.pawnId === selectedPawnId &&
                          m.logicalDestType === "track" &&
                          typeof m.logicalDestIndex === "number" &&
                          m.logicalDestIndex === idx) ||
                        (m.secondaryPawnId === selectedPawnId &&
                          m.secondaryLogicalDestType === "track" &&
                          typeof m.secondaryLogicalDestIndex === "number" &&
                          m.secondaryLogicalDestIndex === idx)
                    );
                  }
                } else {
                  candidates = movesNow.filter(
                    (m) =>
                      m.pawnId === selectedPawnId &&
                      m.logicalDestType === "track" &&
                      typeof m.logicalDestIndex === "number" &&
                      m.logicalDestIndex === idx
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
        }

        // Home zone doesn't have slides, so logical and final dest are the same.
        if (homeGeom && selectedPawnId && upcomingCard === "7") {
          const movesArray = Array.isArray(upcomingMoves) ? upcomingMoves : [];
          const homeSeatIndex = homeGeom.seatIndex;
          let matchingHomeMoves = [];

          if (selectedSecondaryPawnId) {
            matchingHomeMoves = movesArray.filter(
              (m) =>
                ((m.pawnId === selectedPawnId &&
                  m.secondaryPawnId === selectedSecondaryPawnId) ||
                  (m.pawnId === selectedSecondaryPawnId &&
                    m.secondaryPawnId === selectedPawnId)) &&
                ((m.logicalDestType === "home" &&
                  pawnSeatById.get(m.pawnId) === homeSeatIndex) ||
                  (m.secondaryLogicalDestType === "home" &&
                    m.secondaryPawnId &&
                    pawnSeatById.get(m.secondaryPawnId) === homeSeatIndex))
            );
          } else {
            matchingHomeMoves = movesArray.filter(
              (m) =>
                (m.pawnId === selectedPawnId &&
                  m.logicalDestType === "home" &&
                  pawnSeatById.get(m.pawnId) === homeSeatIndex) ||
                (m.secondaryPawnId === selectedPawnId &&
                  m.secondaryLogicalDestType === "home" &&
                  m.secondaryPawnId &&
                  pawnSeatById.get(m.secondaryPawnId) === homeSeatIndex)
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
                    ((m.pawnId === selectedPawnId &&
                      m.secondaryPawnId === selectedSecondaryPawnId) ||
                      (m.pawnId === selectedSecondaryPawnId &&
                        m.secondaryPawnId === selectedPawnId)) &&
                    ((m.logicalDestType === "home" &&
                      pawnSeatById.get(m.pawnId) === homeSeatIndexNow) ||
                      (m.secondaryLogicalDestType === "home" &&
                        m.secondaryPawnId &&
                        pawnSeatById.get(m.secondaryPawnId) === homeSeatIndexNow))
                );
              } else {
                candidates = movesNow.filter(
                  (m) =>
                    (m.pawnId === selectedPawnId &&
                      m.logicalDestType === "home" &&
                      pawnSeatById.get(m.pawnId) === homeSeatIndexNow) ||
                    (m.secondaryPawnId === selectedPawnId &&
                      m.secondaryLogicalDestType === "home" &&
                      m.secondaryPawnId &&
                      pawnSeatById.get(m.secondaryPawnId) === homeSeatIndexNow)
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

        // Card 7: allow selecting moves that end in a Safety Zone cell by
        // clicking that safety tile, for both single-7 and split-7 moves.
        // Safety zones don't have slides, so logical and final dest are the same.
        if (safetyGeom && selectedPawnId && upcomingCard === "7") {
          const movesArray = Array.isArray(upcomingMoves) ? upcomingMoves : [];
          const safetySeatIndex = safetyGeom.seatIndex;
          const safetyIndex = safetyGeom.safetyIndex;
          let matchingSafetyMoves = [];

          if (selectedSecondaryPawnId) {
            matchingSafetyMoves = movesArray.filter(
              (m) =>
                ((m.pawnId === selectedPawnId &&
                  m.secondaryPawnId === selectedSecondaryPawnId) ||
                  (m.pawnId === selectedSecondaryPawnId &&
                    m.secondaryPawnId === selectedPawnId)) &&
                ((m.logicalDestType === "safety" &&
                  pawnSeatById.get(m.pawnId) === safetySeatIndex &&
                  typeof m.logicalDestIndex === "number" &&
                  m.logicalDestIndex === safetyIndex) ||
                  (m.secondaryLogicalDestType === "safety" &&
                    m.secondaryPawnId &&
                    pawnSeatById.get(m.secondaryPawnId) === safetySeatIndex &&
                    typeof m.secondaryLogicalDestIndex === "number" &&
                    m.secondaryLogicalDestIndex === safetyIndex))
            );
          } else {
            matchingSafetyMoves = movesArray.filter(
              (m) =>
                (m.pawnId === selectedPawnId &&
                  m.logicalDestType === "safety" &&
                  pawnSeatById.get(m.pawnId) === safetySeatIndex &&
                  typeof m.logicalDestIndex === "number" &&
                  m.logicalDestIndex === safetyIndex) ||
                (m.secondaryPawnId === selectedPawnId &&
                  m.secondaryLogicalDestType === "safety" &&
                  m.secondaryPawnId &&
                  pawnSeatById.get(m.secondaryPawnId) === safetySeatIndex &&
                  typeof m.secondaryLogicalDestIndex === "number" &&
                  m.secondaryLogicalDestIndex === safetyIndex)
            );
          }

          if (matchingSafetyMoves.length > 0) {
            cell.classList.add("track-cell-dest-highlight");
            cell.addEventListener("click", () => {
              const movesNow = Array.isArray(upcomingMoves) ? upcomingMoves : [];
              const safetySeatIndexNow = safetyGeom.seatIndex;
              const safetyIndexNow = safetyGeom.safetyIndex;
              let candidates = [];

              if (selectedSecondaryPawnId) {
                candidates = movesNow.filter(
                  (m) =>
                    ((m.pawnId === selectedPawnId &&
                      m.secondaryPawnId === selectedSecondaryPawnId) ||
                      (m.pawnId === selectedSecondaryPawnId &&
                        m.secondaryPawnId === selectedPawnId)) &&
                    ((m.logicalDestType === "safety" &&
                      pawnSeatById.get(m.pawnId) === safetySeatIndexNow &&
                      typeof m.logicalDestIndex === "number" &&
                      m.logicalDestIndex === safetyIndexNow) ||
                      (m.secondaryLogicalDestType === "safety" &&
                        m.secondaryPawnId &&
                        pawnSeatById.get(m.secondaryPawnId) === safetySeatIndexNow &&
                        typeof m.secondaryLogicalDestIndex === "number" &&
                        m.secondaryLogicalDestIndex === safetyIndexNow))
                );
              } else {
                candidates = movesNow.filter(
                  (m) =>
                    (m.pawnId === selectedPawnId &&
                      m.logicalDestType === "safety" &&
                      pawnSeatById.get(m.pawnId) === safetySeatIndexNow &&
                      typeof m.logicalDestIndex === "number" &&
                      m.logicalDestIndex === safetyIndexNow) ||
                    (m.secondaryPawnId === selectedPawnId &&
                      m.secondaryLogicalDestType === "safety" &&
                      m.secondaryPawnId &&
                      pawnSeatById.get(m.secondaryPawnId) === safetySeatIndexNow &&
                      typeof m.secondaryLogicalDestIndex === "number" &&
                      m.secondaryLogicalDestIndex === safetyIndexNow)
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

              // Card 7 UI behavior:
              // - You may select one or two of your own pawns.
              // - With a single pawn selected, all legal 7 moves that involve
              //   that pawn (single-7 or split-7 with any partner) are
              //   highlighted; clicking a highlighted destination tile chooses
              //   the full move, including any implied second pawn.
              // - With two pawns selected, only split-7 moves that use that
              //   exact pair are highlighted; clicking a destination tile
              //   cycles between alternative splits for that tile when more
              //   than one exists.
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
                      (m.pawnId === selectedPawnId &&
                        m.secondaryPawnId === pawnId) ||
                      (m.pawnId === pawnId &&
                        m.secondaryPawnId === selectedPawnId)
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
                      (m.pawnId === newPrimary &&
                        m.secondaryPawnId === newSecondary) ||
                      (m.pawnId === newSecondary &&
                        m.secondaryPawnId === newPrimary)
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

              // Default behavior for all cards: clicking a legal mover
              // cycles through that pawn's available moves.
              // For card 11 with only switch moves, include a "no move" option in the cycle.
              const candidates = movesArray.filter((m) => m.pawnId === pawnId);
              let chosen = null;
              if (candidates.length > 0) {
                if (selectedPawnId === pawnId) {
                  if (selectedMoveIndex != null) {
                    const currentIdx = candidates.findIndex((m) => m.index === selectedMoveIndex);
                    if (currentIdx >= 0 && currentIdx === candidates.length - 1 && onlySwitchMovesFor11) {
                      // At the last move, cycle to "no move" for card 11 switch-only
                      chosen = null;
                    } else {
                      const nextIdx = currentIdx >= 0 ? (currentIdx + 1) % candidates.length : 0;
                      chosen = candidates[nextIdx];
                    }
                  } else {
                    // Currently at "no move", cycle to first move
                    chosen = candidates[0];
                  }
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

    // Render Lo Siento mode if active
    if (interfaceMode === 'losiento') {
      renderLoSientoBoard(state, colors, viewerSeatIndex, safetyCoordsBySeat, homeCoordBySeat, startHomeCoordBySeat);
    }

    // Use server-side card history
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
      if (!serverCardHistory || serverCardHistory.length === 0) {
        const empty = document.createElement("div");
        empty.className = "card-history-empty";
        empty.textContent = "No cards drawn yet.";
        cardHistoryEl.appendChild(empty);
      } else {
        const list = document.createElement("div");
        list.className = "card-history-list";
        // Show most recent first
        const historyToRender = serverCardHistory.slice().reverse();

        historyToRender.forEach((entry) => {
          const item = document.createElement("div");
          item.className = "card-history-item";

          const header = document.createElement("div");
          header.className = "card-history-header";

          const seatLabel = document.createElement("span");
          seatLabel.className = "card-history-seat";
          let seatText = "Seat ?";
          if (entry && entry.seatIndex != null) {
            // Use 1-indexed seat numbers
            const displayName = entry.displayName;
            seatText = displayName
              ? `Seat ${entry.seatIndex + 1} (${displayName})`
              : `Seat ${entry.seatIndex + 1}`;
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
            const turnKey = entry.turnNumber != null ? entry.turnNumber : null;
            const toggle = document.createElement("button");
            toggle.type = "button";
            toggle.className = "card-history-toggle";
            toggle.textContent = "Details";

            const descEl = document.createElement("div");
            // Restore expanded state from the Set
            const isExpanded = turnKey != null && cardHistoryExpandedTurns.has(turnKey);
            descEl.className = isExpanded ? "card-history-desc" : "card-history-desc hidden";
            descEl.textContent = descText;

            toggle.addEventListener("click", () => {
              const isHidden = descEl.classList.contains("hidden");
              if (isHidden) {
                descEl.classList.remove("hidden");
                if (turnKey != null) cardHistoryExpandedTurns.add(turnKey);
              } else {
                descEl.classList.add("hidden");
                if (turnKey != null) cardHistoryExpandedTurns.delete(turnKey);
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
      showToast(`Move failed: ${err.message}`);
    }
  }

  async function handleBotStep() {
    if (!currentGame) return;
    try {
      const data = await api(`/bot-step?game_id=${encodeURIComponent(currentGame.gameId)}`, {
        method: "POST",
      });
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

      const data = await api(
        `/legal-movers?game_id=${encodeURIComponent(currentGame.gameId)}`,
        { method: "GET" }
      );
      const ids = Array.isArray(data.pawnIds) ? data.pawnIds : [];
      legalMoverPawnIds = new Set(ids);

      upcomingCard = typeof data.card === "string" ? data.card : null;
      upcomingMoves = Array.isArray(data.moves) ? data.moves : [];

      if (upcomingCard === "7") {
        console.log("[LoSiento][7-preview]", {
          gameId,
          turnNumber,
          discardLen,
          pawnIds: ids,
          moves: upcomingMoves,
        });
      }

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

  // ============================================
  // ¡Lo Siento! Visual Mode Renderer
  // ============================================

  const LS_TILE_SIZE = 50;
  const LS_PAWN_SIZE = 40;
  const LS_BOARD_SIZE = 800;
  
  // Pawn visual offset to compensate for hat (move up and left)
  const LS_PAWN_HAT_OFFSET_X = -3;
  const LS_PAWN_HAT_OFFSET_Y = -5;

  // Special positions for start circles and home stars (centers, in pixels)
  // Board layout: Yellow=top-left, Green=top-right, Red=bottom-right, Blue=bottom-left
  // Seat mapping: Seat 0=Red, Seat 1=Blue, Seat 2=Yellow, Seat 3=Green
  // Start circles: 90px offset from start exit tile center (toward corner)
  // Home stars: 125px offset from final safety tile center (toward center of board)
  const LS_START_CENTERS = {
    0: { x: 575, y: 705 },  // Red (seat 0)
    1: { x: 95, y: 575 },   // Blue (seat 1)
    2: { x: 225, y: 95 },   // Yellow (seat 2)
    3: { x: 705, y: 225 },  // Green (seat 3)
  };

  const LS_HOME_CENTERS = {
    0: { x: 675, y: 450 },  // Red home
    1: { x: 350, y: 675 },  // Blue home
    2: { x: 125, y: 350 },  // Yellow home
    3: { x: 450, y: 125 },  // Green home
  };

  // Pawn spread offset for multiple pawns at start/home
  // Distance from center for spread formations
  const LS_SPREAD_OFFSET = 22;

  // Get formation offsets for pawns based on count and seat position
  // Formations rotate based on seat: 0=Red(bottom-right), 1=Blue(bottom-left), 2=Yellow(top-left), 3=Green(top-right)
  function lsGetFormationOffsets(count, seatIndex) {
    // Base formations (from Red's perspective - bottom-right corner)
    // Triangle: 2 on top, 1 below
    const d = LS_SPREAD_OFFSET;
    
    // Rotation angles: Red=0°, Blue=90°, Yellow=180°, Green=270°
    const rotations = [0, Math.PI / 2, Math.PI, 3 * Math.PI / 2];
    const rotation = rotations[seatIndex] || 0;
    
    const rotate = (x, y) => {
      const cos = Math.cos(rotation);
      const sin = Math.sin(rotation);
      return {
        x: Math.round(x * cos - y * sin),
        y: Math.round(x * sin + y * cos)
      };
    };
    
    if (count === 1) {
      return [{ x: 0, y: 0 }];
    }
    
    if (count === 2) {
      // Line: horizontal from Red's view
      return [
        rotate(-d * 0.7, 0),
        rotate(d * 0.7, 0)
      ];
    }
    
    if (count === 3) {
      // Triangle: 2 on top, 1 below (from Red's view: 2 above, 1 below)
      return [
        rotate(-d * 0.7, -d * 0.5),  // top-left
        rotate(d * 0.7, -d * 0.5),   // top-right
        rotate(0, d * 0.7)           // bottom center
      ];
    }
    
    if (count === 4) {
      // Square formation
      return [
        rotate(-d * 0.6, -d * 0.6),  // top-left
        rotate(d * 0.6, -d * 0.6),   // top-right
        rotate(-d * 0.6, d * 0.6),   // bottom-left
        rotate(d * 0.6, d * 0.6)     // bottom-right
      ];
    }
    
    // Fallback: stack at center
    return Array(count).fill({ x: 0, y: 0 });
  }

  // Convert track index to pixel position (top-left of tile)
  function lsTrackIndexToPixel(trackIndex) {
    const coord = coordForTrackIndex(trackIndex);
    if (!coord) return { x: 0, y: 0 };
    return {
      x: coord.col * LS_TILE_SIZE,
      y: coord.row * LS_TILE_SIZE
    };
  }

  // Convert safety zone position to pixel position
  function lsSafetyToPixel(seatIndex, safetyIndex, safetyCoordsBySeat) {
    const coords = safetyCoordsBySeat[seatIndex];
    if (!coords || !coords[safetyIndex]) return { x: 0, y: 0 };
    const coord = coords[safetyIndex];
    return {
      x: coord.col * LS_TILE_SIZE,
      y: coord.row * LS_TILE_SIZE
    };
  }

  // Get center position for a pawn given its position type
  // Includes hat offset to visually center the pawn body (not the hat)
  function lsGetPawnCenter(position, seatIndex, safetyCoordsBySeat, homeCoordBySeat, startHomeCoordBySeat) {
    if (!position) return { x: 0, y: 0 };
    
    const pawnOffset = (LS_TILE_SIZE - LS_PAWN_SIZE) / 2;
    const hatX = LS_PAWN_HAT_OFFSET_X;
    const hatY = LS_PAWN_HAT_OFFSET_Y;
    
    if (position.type === 'start') {
      // Use the larger start circle center
      const center = LS_START_CENTERS[seatIndex];
      if (center) {
        return { x: center.x - LS_PAWN_SIZE / 2 + hatX, y: center.y - LS_PAWN_SIZE / 2 + hatY };
      }
      // Fallback to start home coord
      const startHome = startHomeCoordBySeat[seatIndex];
      if (startHome) {
        return {
          x: startHome.col * LS_TILE_SIZE + pawnOffset + hatX,
          y: startHome.row * LS_TILE_SIZE + pawnOffset + hatY
        };
      }
    }
    
    if (position.type === 'home') {
      // Use the larger home star center
      const center = LS_HOME_CENTERS[seatIndex];
      if (center) {
        return { x: center.x - LS_PAWN_SIZE / 2 + hatX, y: center.y - LS_PAWN_SIZE / 2 + hatY };
      }
      // Fallback to home coord
      const home = homeCoordBySeat[seatIndex];
      if (home) {
        return {
          x: home.col * LS_TILE_SIZE + pawnOffset + hatX,
          y: home.row * LS_TILE_SIZE + pawnOffset + hatY
        };
      }
    }
    
    if (position.type === 'track') {
      const pixel = lsTrackIndexToPixel(position.index || 0);
      return {
        x: pixel.x + pawnOffset + hatX,
        y: pixel.y + pawnOffset + hatY
      };
    }
    
    if (position.type === 'safety') {
      const pixel = lsSafetyToPixel(seatIndex, position.index || 0, safetyCoordsBySeat);
      return {
        x: pixel.x + pawnOffset + hatX,
        y: pixel.y + pawnOffset + hatY
      };
    }
    
    return { x: 0, y: 0 };
  }

  // Get pawn image source based on color
  function lsGetPawnImage(color) {
    const colorMap = {
      red: 'assets/pawn-red.png',
      blue: 'assets/pawn-blue.png',
      yellow: 'assets/pawn-yellow.png',
      green: 'assets/pawn-green.png'
    };
    return colorMap[color] || colorMap.red;
  }

  // Slide tile detection - returns true if track index is part of a slide
  function lsIsSlideTrackIndex(trackIndex) {
    // Slides per seat (4-tile and 5-tile slides)
    // First slide: starts at (seat_offset + 1), length 4
    // Second slide: starts at (seat_offset + 10), length 5
    const TRACK_SEGMENT_LEN = 15;
    for (let seat = 0; seat < 4; seat++) {
      const offset = ((seat + 2) % 4) * TRACK_SEGMENT_LEN;
      // First slide (4 tiles)
      const slide1Start = (offset + 1) % TRACK_LEN;
      for (let i = 0; i < 4; i++) {
        if ((slide1Start + i) % TRACK_LEN === trackIndex) return true;
      }
      // Second slide (5 tiles)
      const slide2Start = (offset + 10) % TRACK_LEN;
      for (let i = 0; i < 5; i++) {
        if ((slide2Start + i) % TRACK_LEN === trackIndex) return true;
      }
    }
    return false;
  }

  // Get slide end index if starting a slide
  function lsGetSlideEnd(trackIndex) {
    const TRACK_SEGMENT_LEN = 15;
    for (let seat = 0; seat < 4; seat++) {
      const offset = ((seat + 2) % 4) * TRACK_SEGMENT_LEN;
      // First slide (4 tiles) - starts at offset+1
      const slide1Start = (offset + 1) % TRACK_LEN;
      if (trackIndex === slide1Start) {
        return (slide1Start + 3) % TRACK_LEN; // End of 4-tile slide
      }
      // Second slide (5 tiles) - starts at offset+10
      const slide2Start = (offset + 10) % TRACK_LEN;
      if (trackIndex === slide2Start) {
        return (slide2Start + 4) % TRACK_LEN; // End of 5-tile slide
      }
    }
    return null;
  }

  // Get the owner seat of a slide if trackIndex is a slide START
  // Returns seat index (0-3) or null if not a slide start
  function lsGetSlideOwner(trackIndex) {
    const TRACK_SEGMENT_LEN = 15;
    for (let seat = 0; seat < 4; seat++) {
      const offset = ((seat + 2) % 4) * TRACK_SEGMENT_LEN;
      const slide1Start = (offset + 1) % TRACK_LEN;
      const slide2Start = (offset + 10) % TRACK_LEN;
      if (trackIndex === slide1Start || trackIndex === slide2Start) {
        return seat;
      }
    }
    return null;
  }

  // Get slide info if a track index is a slide END (and not owned by pawnSeatIndex)
  // Returns { start, end, ownerSeat } or null
  function lsGetSlideForEnd(trackIndex, pawnSeatIndex) {
    const TRACK_SEGMENT_LEN = 15;
    for (let seat = 0; seat < 4; seat++) {
      // Skip pawn's own slides - can't slide on your own color
      if (seat === pawnSeatIndex) continue;
      
      const offset = ((seat + 2) % 4) * TRACK_SEGMENT_LEN;
      // First slide (4 tiles)
      const slide1Start = (offset + 1) % TRACK_LEN;
      const slide1End = (slide1Start + 3) % TRACK_LEN;
      if (trackIndex === slide1End) {
        return { start: slide1Start, end: slide1End, ownerSeat: seat };
      }
      // Second slide (5 tiles)
      const slide2Start = (offset + 10) % TRACK_LEN;
      const slide2End = (slide2Start + 4) % TRACK_LEN;
      if (trackIndex === slide2End) {
        return { start: slide2Start, end: slide2End, ownerSeat: seat };
      }
    }
    return null;
  }

  // Get slide info if landing on a slide END after backward movement
  // (meaning we walked backward onto the slide START and slid forward)
  // Returns { start, end, ownerSeat } or null
  function lsGetSlideForBackwardLanding(trackIndex, pawnSeatIndex) {
    const TRACK_SEGMENT_LEN = 15;
    for (let seat = 0; seat < 4; seat++) {
      // Skip pawn's own slides - can't slide on your own color
      if (seat === pawnSeatIndex) continue;
      
      const offset = ((seat + 2) % 4) * TRACK_SEGMENT_LEN;
      // First slide (4 tiles)
      const slide1Start = (offset + 1) % TRACK_LEN;
      const slide1End = (slide1Start + 3) % TRACK_LEN;
      if (trackIndex === slide1End) {
        return { start: slide1Start, end: slide1End, ownerSeat: seat };
      }
      // Second slide (5 tiles)
      const slide2Start = (offset + 10) % TRACK_LEN;
      const slide2End = (slide2Start + 4) % TRACK_LEN;
      if (trackIndex === slide2End) {
        return { start: slide2Start, end: slide2End, ownerSeat: seat };
      }
    }
    return null;
  }

  // Animate a pawn element with arching motion between positions
  // Arc curves toward board center for a more natural look
  async function lsAnimateArch(pawnEl, startX, startY, endX, endY, duration = 260) {
    const midX = (startX + endX) / 2;
    const midY = (startY + endY) / 2;
    
    // Calculate arc direction toward board center (400, 400)
    const boardCenterX = 400;
    const boardCenterY = 400;
    const arcAmount = 18; // How far to arc
    
    // Direction from midpoint toward board center
    const toCenterX = boardCenterX - midX;
    const toCenterY = boardCenterY - midY;
    const dist = Math.sqrt(toCenterX * toCenterX + toCenterY * toCenterY);
    
    // Normalize and apply arc amount
    const arcX = dist > 0 ? midX + (toCenterX / dist) * arcAmount : midX;
    const arcY = dist > 0 ? midY + (toCenterY / dist) * arcAmount - 8 : midY - 20; // Also lift slightly
    
    const animation = pawnEl.animate([
      { transform: `translate(${startX}px, ${startY}px)` },
      { transform: `translate(${arcX}px, ${arcY}px)` },
      { transform: `translate(${endX}px, ${endY}px)` }
    ], {
      duration: duration,
      easing: 'ease-in-out',
      fill: 'forwards'
    });
    
    await animation.finished;
    pawnEl.style.transform = `translate(${endX}px, ${endY}px)`;
  }

  // Animate a pawn element with sliding motion along a slide
  // Uses ease-out for a natural deceleration at the end
  async function lsAnimateSlide(pawnEl, startX, startY, endX, endY, duration = 600) {
    // Raise the pawn slightly during the slide for visual feedback
    pawnEl.style.zIndex = '15';
    
    const animation = pawnEl.animate([
      { transform: `translate(${startX}px, ${startY}px)`, offset: 0 },
      { transform: `translate(${endX}px, ${endY}px)`, offset: 1 }
    ], {
      duration: duration,
      easing: 'ease-out',
      fill: 'forwards'
    });
    
    await animation.finished;
    pawnEl.style.transform = `translate(${endX}px, ${endY}px)`;
    pawnEl.style.zIndex = '';
  }

  // Animate a pawn with knockout spin (720° rotation back to start)
  async function lsAnimateKnockout(pawnEl, startX, startY, endX, endY, duration = 600) {
    pawnEl.style.zIndex = '20';
    
    const animation = pawnEl.animate([
      { transform: `translate(${startX}px, ${startY}px) rotate(0deg)` },
      { transform: `translate(${endX}px, ${endY}px) rotate(720deg)` }
    ], {
      duration: duration,
      easing: 'ease-in-out',
      fill: 'forwards'
    });
    
    await animation.finished;
    pawnEl.style.transform = `translate(${endX}px, ${endY}px)`;
    pawnEl.style.zIndex = '';
  }

  // Animate a pawn through multiple tiles with arching motion
  async function lsAnimateMultiHop(pawnEl, positions, hopDuration = 120) {
    for (let i = 0; i < positions.length - 1; i++) {
      const start = positions[i];
      const end = positions[i + 1];
      await lsAnimateArch(pawnEl, start.x, start.y, end.x, end.y, hopDuration);
    }
  }

  // Build the animation path for a move, detecting slides
  function lsBuildMovePath(oldPos, newPos, seatIndex, safetyCoordsBySeat, homeCoordBySeat) {
    const path = [];
    const pawnOffset = (LS_TILE_SIZE - LS_PAWN_SIZE) / 2;
    const hatX = LS_PAWN_HAT_OFFSET_X;
    const hatY = LS_PAWN_HAT_OFFSET_Y;
    
    // Helper to add a track position to path
    const addTrackPos = (trackIdx) => {
      const pixel = lsTrackIndexToPixel(trackIdx);
      path.push({
        x: pixel.x + pawnOffset + hatX,
        y: pixel.y + pawnOffset + hatY,
        trackIndex: trackIdx
      });
    };
    
    // Helper to add a safety position
    const addSafetyPos = (safetyIdx) => {
      const pixel = lsSafetyToPixel(seatIndex, safetyIdx, safetyCoordsBySeat);
      path.push({
        x: pixel.x + pawnOffset + hatX,
        y: pixel.y + pawnOffset + hatY,
        type: 'safety',
        index: safetyIdx
      });
    };
    
    // Helper to add home position
    const addHomePos = () => {
      const center = LS_HOME_CENTERS[seatIndex];
      if (center) {
        path.push({
          x: center.x - LS_PAWN_SIZE / 2 + hatX,
          y: center.y - LS_PAWN_SIZE / 2 + hatY,
          type: 'home'
        });
      }
    };
    
    // Track to track movement
    if (oldPos.type === 'track' && newPos.type === 'track') {
      const fromIdx = oldPos.index;
      const toIdx = newPos.index;
      
      // Determine direction (forward or backward)
      // Forward: increasing index (wrapping at 60)
      // Calculate forward distance
      let forwardDist = (toIdx - fromIdx + TRACK_LEN) % TRACK_LEN;
      let backwardDist = (fromIdx - toIdx + TRACK_LEN) % TRACK_LEN;
      
      // Check if this is a slide: if forward distance is large but actual movement
      // would have landed on a slide start
      let slideStartIdx = null;
      let slideEndIdx = null;
      
      // Try to detect slide: walk forward from old position
      // If we hit a slide start before reaching destination, and destination is slide end
      // Note: forwardDist can exceed 12 if a slide was triggered (max 12 card + 4 slide = 16)
      if (forwardDist > 0 && forwardDist <= 17) {
        // Walking forward
        let current = fromIdx;
        addTrackPos(current);
        
        // Safety limit to prevent infinite loops
        let steps = 0;
        const maxSteps = TRACK_LEN + 10;
        while (current !== toIdx && steps < maxSteps) {
          steps++;
          current = (current + 1) % TRACK_LEN;
          
          // Check if this is a slide start (for opponent's slide only - can't slide on your own)
          const slideEnd = lsGetSlideEnd(current);
          const slideOwner = lsGetSlideOwner(current);
          if (slideEnd !== null && slideEnd === toIdx && slideOwner !== seatIndex) {
            // This is a slide on an opponent's slide! Mark it
            slideStartIdx = path.length; // Index in path array
            addTrackPos(current);
            // Add the slide END position to the path so detection works
            addTrackPos(toIdx);
            path.slideInfo = { slideStartPathIdx: slideStartIdx, slideEndPathIdx: path.length - 1 };
            // Don't add intermediate slide positions, we'll animate the slide
            break;
          }
          
          addTrackPos(current);
        }
      } else if (backwardDist > 0 && backwardDist <= 17) {
        // Walking backward (e.g., card 4 or backward 10)
        // Backward can also trigger slides if landing on a slide start
        // Note: threshold increased to 17 to account for potential slide effects
        let current = fromIdx;
        addTrackPos(current);
        
        // Safety limit to prevent infinite loops
        let steps = 0;
        const maxSteps = TRACK_LEN + 10;
        while (current !== toIdx && steps < maxSteps) {
          steps++;
          current = (current - 1 + TRACK_LEN) % TRACK_LEN;
          
          // Check if this is a slide start (for opponent's slide only - can't slide on your own)
          const slideEnd = lsGetSlideEnd(current);
          const slideOwner = lsGetSlideOwner(current);
          if (slideEnd !== null && slideEnd === toIdx && slideOwner !== seatIndex) {
            // Backward movement landed on a slide start and slid forward
            const slideStartIdx = path.length;
            addTrackPos(current);
            addTrackPos(toIdx);
            path.slideInfo = { slideStartPathIdx: slideStartIdx, slideEndPathIdx: path.length - 1 };
            break;
          }
          
          addTrackPos(current);
        }
      } else {
        // Unknown direction, just add start and end
        addTrackPos(fromIdx);
        addTrackPos(toIdx);
      }
    }
    // Track to safety - animate through track tiles to safety entry, then safety tiles
    else if (oldPos.type === 'track' && newPos.type === 'safety') {
      const fromIdx = oldPos.index;
      const safetyEntryIdx = lsGetSafetyEntryTrackIndex(seatIndex);
      
      // Walk through track tiles from start to safety entry point
      let current = fromIdx;
      addTrackPos(current);
      
      // Safety limit to prevent infinite loops
      let steps = 0;
      const maxSteps = TRACK_LEN + 10;
      while (current !== safetyEntryIdx && steps < maxSteps) {
        steps++;
        current = (current + 1) % TRACK_LEN;
        addTrackPos(current);
      }
      
      // Walk through safety zone from entry (index 0) to destination
      for (let i = 0; i <= newPos.index; i++) {
        addSafetyPos(i);
      }
    }
    // Track to home - animate through track tiles to safety entry, then safety zone, then home
    else if (oldPos.type === 'track' && newPos.type === 'home') {
      const fromIdx = oldPos.index;
      const safetyEntryIdx = lsGetSafetyEntryTrackIndex(seatIndex);
      
      // Walk through track tiles from start to safety entry point
      let current = fromIdx;
      addTrackPos(current);
      
      // Safety limit to prevent infinite loops
      let steps = 0;
      const maxSteps = TRACK_LEN + 10;
      while (current !== safetyEntryIdx && steps < maxSteps) {
        steps++;
        current = (current + 1) % TRACK_LEN;
        addTrackPos(current);
      }
      
      // Walk through entire safety zone (5 tiles) then home
      for (let i = 0; i < 5; i++) {
        addSafetyPos(i);
      }
      addHomePos();
    }
    // Safety to home or further in safety
    else if (oldPos.type === 'safety') {
      // Add current safety position
      addSafetyPos(oldPos.index);
      
      if (newPos.type === 'safety') {
        // Walking through safety
        for (let i = oldPos.index + 1; i <= newPos.index; i++) {
          addSafetyPos(i);
        }
      } else if (newPos.type === 'home') {
        // Walk to end of safety then home
        for (let i = oldPos.index + 1; i < 5; i++) {
          addSafetyPos(i);
        }
        addHomePos();
      }
    }
    // Fallback: just start and end
    else {
      path.push({ x: oldPos.x, y: oldPos.y });
      path.push({ x: newPos.x, y: newPos.y });
    }
    
    return path;
  }

  // Detect if a path includes a slide - returns the index in path where slide starts, or null
  // pawnSeatIndex is needed because pawns cannot slide on their own color's slides
  function lsDetectSlideInPath(path, pawnSeatIndex) {
    // Quick check: if path building already detected a slide, use that info
    if (path.slideInfo && typeof path.slideInfo.slideStartPathIdx === 'number') {
      console.log('[LS Slide] Using embedded slide info:', path.slideInfo);
      return path.slideInfo.slideStartPathIdx;
    }
    
    // A slide occurred if:
    // 1. We have track positions in the path
    // 2. There's a position that's a slide START (of an opponent's slide)
    // 3. The final position is the corresponding slide END
    
    // Find the last track position in the path
    let lastTrackIdx = -1;
    let lastTrackIndex = null;
    
    for (let i = path.length - 1; i >= 0; i--) {
      if (typeof path[i].trackIndex === 'number') {
        lastTrackIdx = i;
        lastTrackIndex = path[i].trackIndex;
        break;
      }
    }
    
    if (lastTrackIdx < 0 || lastTrackIndex === null) return null;
    
    // Check if the final track position is a slide END
    // If so, find the corresponding slide START in the path
    const TRACK_SEGMENT_LEN = 15;
    
    // All slide positions on the board, with their owning seat
    const slides = [];
    for (let seat = 0; seat < 4; seat++) {
      const offset = ((seat + 2) % 4) * TRACK_SEGMENT_LEN;
      slides.push({ start: (offset + 1) % TRACK_LEN, end: (offset + 4) % TRACK_LEN, length: 4, ownerSeat: seat });
      slides.push({ start: (offset + 10) % TRACK_LEN, end: (offset + 14) % TRACK_LEN, length: 5, ownerSeat: seat });
    }
    
    console.log('[LS Slide] Last track position:', lastTrackIndex, 'at path index', lastTrackIdx, 'pawn seat:', pawnSeatIndex);
    console.log('[LS Slide] Known slide ends:', slides.map(s => `${s.end}(seat${s.ownerSeat})`));
    
    for (const slide of slides) {
      if (lastTrackIndex === slide.end) {
        // Skip if this is the pawn's own slide - you can't slide on your own color
        if (slide.ownerSeat === pawnSeatIndex) {
          console.log('[LS Slide] Destination matches slide end', slide.end, 'but it belongs to pawn seat', pawnSeatIndex, '- no slide');
          continue;
        }
        
        console.log('[LS Slide] Destination matches slide end', slide.end, '(seat', slide.ownerSeat, ') - looking for start', slide.start);
        // Check if slide start is in the path
        for (let i = 0; i < lastTrackIdx; i++) {
          if (path[i].trackIndex === slide.start) {
            console.log('[LS Slide] Found slide start at path index', i);
            return i; // Return index of slide start in path
          }
        }
        console.log('[LS Slide] Slide start', slide.start, 'NOT found in path');
      }
    }
    
    return null;
  }

  // Get the track index where a player enters their safety zone
  function lsGetSafetyEntryTrackIndex(seatIndex) {
    // Safety entry is at firstSlide[1] for each seat
    // offset = ((seatIndex + 2) % 4) * 15
    // slide starts at (offset + 1), entry is slide start + 1
    // Seat 0 (Red): offset=30, slide=[31,32,33,34], entry=32
    // Seat 1 (Blue): offset=45, slide=[46,47,48,49], entry=47
    // Seat 2 (Yellow): offset=0, slide=[1,2,3,4], entry=2
    // Seat 3 (Green): offset=15, slide=[16,17,18,19], entry=17
    const entries = [32, 47, 2, 17];
    return entries[seatIndex] || 0;
  }

  // Calculate intermediate positions for multi-tile movement on track
  function lsGetTrackPath(fromIndex, toIndex, direction, seatIndex, safetyCoordsBySeat, homeCoordBySeat, startHomeCoordBySeat, destType, destIndex) {
    const positions = [];
    const pawnOffset = (LS_TILE_SIZE - LS_PAWN_SIZE) / 2;
    const hatX = LS_PAWN_HAT_OFFSET_X;
    const hatY = LS_PAWN_HAT_OFFSET_Y;
    
    if (direction === 'forward') {
      let current = fromIndex;
      positions.push({
        x: lsTrackIndexToPixel(current).x + pawnOffset + hatX,
        y: lsTrackIndexToPixel(current).y + pawnOffset + hatY
      });
      
      while (current !== toIndex) {
        current = (current + 1) % TRACK_LEN;
        positions.push({
          x: lsTrackIndexToPixel(current).x + pawnOffset + hatX,
          y: lsTrackIndexToPixel(current).y + pawnOffset + hatY
        });
      }
    } else if (direction === 'backward') {
      let current = fromIndex;
      positions.push({
        x: lsTrackIndexToPixel(current).x + pawnOffset + hatX,
        y: lsTrackIndexToPixel(current).y + pawnOffset + hatY
      });
      
      while (current !== toIndex) {
        current = (current - 1 + TRACK_LEN) % TRACK_LEN;
        positions.push({
          x: lsTrackIndexToPixel(current).x + pawnOffset + hatX,
          y: lsTrackIndexToPixel(current).y + pawnOffset + hatY
        });
      }
    }
    
    // If destination is safety or home, add final position
    if (destType === 'safety' && typeof destIndex === 'number') {
      const pixel = lsSafetyToPixel(seatIndex, destIndex, safetyCoordsBySeat);
      positions.push({
        x: pixel.x + pawnOffset + hatX,
        y: pixel.y + pawnOffset + hatY
      });
    } else if (destType === 'home') {
      const center = LS_HOME_CENTERS[seatIndex];
      if (center) {
        positions.push({
          x: center.x - LS_PAWN_SIZE / 2 + hatX,
          y: center.y - LS_PAWN_SIZE / 2 + hatY
        });
      }
    }
    
    return positions;
  }

  // Toggle interface mode
  function setInterfaceMode(mode) {
    interfaceMode = mode;
    
    if (mode === 'basic') {
      trackGridEl.classList.remove('hidden');
      if (losientoBoardWrapperEl) losientoBoardWrapperEl.classList.add('hidden');
      if (modeBasicBtn) modeBasicBtn.classList.add('mode-btn-active');
      if (modeLoSientoBtn) modeLoSientoBtn.classList.remove('mode-btn-active');
    } else {
      trackGridEl.classList.add('hidden');
      if (losientoBoardWrapperEl) losientoBoardWrapperEl.classList.remove('hidden');
      if (modeBasicBtn) modeBasicBtn.classList.remove('mode-btn-active');
      if (modeLoSientoBtn) modeLoSientoBtn.classList.add('mode-btn-active');
      // Update scale when switching to Lo Siento mode
      requestAnimationFrame(() => {
        updateLoSientoBoardScale();
      });
    }
    
    // Re-render the game in the new mode
    if (currentGame && currentGame.phase === 'active') {
      renderGame();
    }
  }

  // Render the Lo Siento board
  function renderLoSientoBoard(gameState, colors, viewerSeatIndex, safetyCoordsBySeat, homeCoordBySeat, startHomeCoordBySeat) {
    if (!losientoPawnsEl || !losientoHighlightsEl) return;
    
    if (!gameState || !gameState.board) return;
    
    const pawns = gameState.board.pawns || [];
    const seats = currentGame.seats || [];
    const isActive = gameState.result === 'active';
    const gameId = currentGame.gameId;
    const turnNumber = gameState.turnNumber;
    
    // Detect if this is a turn change (a move was played)
    const isTurnChange = gameId === lsLastRenderedGameId && 
                         lsLastRenderedTurnNumber !== null && 
                         turnNumber !== lsLastRenderedTurnNumber;
    
    // Build current pawn positions map
    const currentPawnPositions = new Map();
    pawns.forEach(pawn => {
      if (!pawn.position) return;
      const pos = lsGetPawnCenter(pawn.position, pawn.seatIndex, safetyCoordsBySeat, homeCoordBySeat, startHomeCoordBySeat);
      currentPawnPositions.set(pawn.pawnId, {
        type: pawn.position.type,
        index: pawn.position.index,
        seatIndex: pawn.seatIndex,
        x: pos.x,
        y: pos.y
      });
    });
    
    // Also detect position changes directly (handles card 2 where turn number may not change)
    let hasPositionChanges = false;
    if (gameId === lsLastRenderedGameId && lsPreviousPawnPositions.size > 0) {
      currentPawnPositions.forEach((newPos, pawnId) => {
        const oldPos = lsPreviousPawnPositions.get(pawnId);
        if (oldPos && (oldPos.x !== newPos.x || oldPos.y !== newPos.y)) {
          hasPositionChanges = true;
        }
      });
    }
    
    // Trigger animation on turn change OR position change (for card 2 extra turns)
    const shouldAnimate = (isTurnChange || hasPositionChanges) && lsPreviousPawnPositions.size > 0;
    
    // Debug turn tracking
    console.log('[LS Animation] Turn check:', { gameId, turnNumber, lastTurn: lsLastRenderedTurnNumber, isTurnChange, hasPositionChanges, shouldAnimate, prevPosCount: lsPreviousPawnPositions.size });
    
    // Find pawns that moved
    const movedPawns = [];
    const knockedOutPawns = [];
    const slideAroundPawns = []; // Special case: pawn at slide END moved backward to START and slid back
    
    // Determine which player just moved (the one before currentSeat)
    // Only check slide-around for that player's pawns to avoid false animations
    const currentSeat = gameState.currentSeat;
    const numPlayers = seats.filter(s => s).length || 4;
    // For card 2 (same player continues), previousSeat calculation may be off, but it's only used for slide-around detection
    const previousSeat = typeof currentSeat === 'number' ? (currentSeat - 1 + numPlayers) % numPlayers : null;
    
    if (shouldAnimate) {
      currentPawnPositions.forEach((newPos, pawnId) => {
        const oldPos = lsPreviousPawnPositions.get(pawnId);
        if (!oldPos) return;
        
        if (oldPos.x !== newPos.x || oldPos.y !== newPos.y) {
          // Pawn moved to a different position
          // Check if pawn was knocked out (moved to start from track/safety)
          const wasOnTrackOrSafety = oldPos.type === 'track' || oldPos.type === 'safety';
          const isNowAtStart = newPos.type === 'start';
          
          if (wasOnTrackOrSafety && isNowAtStart) {
            knockedOutPawns.push({ pawnId, oldPos, newPos });
          } else {
            movedPawns.push({ pawnId, oldPos, newPos });
          }
        } else if (oldPos.type === 'track' && newPos.type === 'track' && oldPos.index === newPos.index) {
          // Same position - check for slide-around case
          // ONLY for the player who just moved to avoid false animations
          if (previousSeat !== null && newPos.seatIndex === previousSeat) {
            const slideInfo = lsGetSlideForEnd(newPos.index, newPos.seatIndex);
            if (slideInfo) {
              // Mark as potential slide-around (will verify after loop)
              slideAroundPawns.push({ pawnId, oldPos, newPos, slideInfo });
            }
          }
        }
      });
      
      // Filter slide-around: only keep if NO other pawns from the same player actually moved
      // (If another pawn moved, the "same position" pawn didn't move this turn)
      if (slideAroundPawns.length > 0) {
        const playersWithMovedPawns = new Set([
          ...movedPawns.map(p => p.newPos.seatIndex),
          ...knockedOutPawns.map(p => p.oldPos.seatIndex)
        ]);
        
        // Remove slide-around entries where that player had another pawn move
        for (let i = slideAroundPawns.length - 1; i >= 0; i--) {
          if (playersWithMovedPawns.has(slideAroundPawns[i].newPos.seatIndex)) {
            console.log('[LS Animation] Removing false slide-around - player had another pawn move');
            slideAroundPawns.splice(i, 1);
          }
        }
        
        if (slideAroundPawns.length > 0) {
          console.log('[LS Animation] Confirmed slide-around for', slideAroundPawns.length, 'pawns');
        }
      }
    }
    
    // If there are animations to play, handle them
    const hasAnimations = movedPawns.length > 0 || knockedOutPawns.length > 0 || slideAroundPawns.length > 0;
    
    // If animation is in progress, don't clear or re-render - let it finish
    if (lsAnimating) {
      console.log('[LS Animation] Skipping - animation in progress');
      return;
    }
    
    if (hasAnimations) {
      console.log('[LS Animation] Starting animations for', movedPawns.length, 'moved,', knockedOutPawns.length, 'knocked out,', slideAroundPawns.length, 'slide-around');
    }
    
    // Clear the pawn layer
    losientoPawnsEl.innerHTML = '';
    losientoHighlightsEl.innerHTML = '';
    
    // If we have animations, render pawns at their OLD positions first, then animate
    if (hasAnimations) {
      lsAnimating = true;
      
      // Render all non-moving pawns at their current positions
      const animatingPawnIds = new Set([
        ...movedPawns.map(p => p.pawnId), 
        ...knockedOutPawns.map(p => p.pawnId),
        ...slideAroundPawns.map(p => p.pawnId)
      ]);
      lsRenderStaticPawns(gameState, colors, safetyCoordsBySeat, homeCoordBySeat, startHomeCoordBySeat, animatingPawnIds);
      
      // Create and animate moving pawns
      (async () => {
        const animationPromises = [];
        
        // Animate regular moves
        for (const { pawnId, oldPos, newPos } of movedPawns) {
          const pawn = pawns.find(p => p.pawnId === pawnId);
          if (!pawn) continue;
          
          const color = colors[pawn.seatIndex] || 'red';
          const pawnEl = lsCreatePawnElement(pawnId, color, oldPos.x, oldPos.y);
          losientoPawnsEl.appendChild(pawnEl);
          
          // Build animation sequence
          const animateMove = async () => {
            // Track-to-track or track-to-safety/home: animate through each tile
            if (oldPos.type === 'track' && (newPos.type === 'track' || newPos.type === 'safety' || newPos.type === 'home')) {
              // Calculate path through tiles
              const path = lsBuildMovePath(oldPos, newPos, pawn.seatIndex, safetyCoordsBySeat, homeCoordBySeat);
              console.log('[LS Animation] Path for', oldPos.type, '->', newPos.type, ':', path.length, 'steps', path);
              
              if (path.length > 1) {
                // Check for slide: if destination is slide end and we passed through slide start
                // Note: pawns cannot slide on their own color's slides
                const slideStart = lsDetectSlideInPath(path, pawn.seatIndex);
                console.log('[LS Animation] Slide detection:', slideStart, 'path trackIndices:', path.map(p => p.trackIndex).filter(x => x !== undefined));
                
                if (slideStart !== null) {
                  console.log('[LS Animation] Slide detected! Start at path index', slideStart);
                  // Hop to slide start, then slide
                  const preSlide = path.slice(0, slideStart + 1);
                  if (preSlide.length > 1) {
                    await lsAnimateMultiHop(pawnEl, preSlide, 130);
                  }
                  // Slide from start to end
                  const slideStartPos = path[slideStart];
                  const slideEndPos = path[path.length - 1];
                  await lsAnimateSlide(pawnEl, slideStartPos.x, slideStartPos.y, slideEndPos.x, slideEndPos.y, 550);
                } else {
                  // Normal multi-hop animation through each tile
                  await lsAnimateMultiHop(pawnEl, path, 130);
                }
              } else {
                // Single hop
                await lsAnimateArch(pawnEl, oldPos.x, oldPos.y, newPos.x, newPos.y, 195);
              }
            } 
            // Start to track: hop out, check if we LANDED on a slide start (not end!)
            else if (oldPos.type === 'start' && newPos.type === 'track') {
              // For Lo Siento/Sorry!, we land where the bumped pawn was
              // Find if there was a knocked-out pawn to determine our ACTUAL landing spot
              const knockedOut = knockedOutPawns.find(ko => ko.oldPos.seatIndex !== pawn.seatIndex);
              const landingIndex = knockedOut ? knockedOut.oldPos.index : null;
              
              // A slide ONLY occurs if we landed ON a slide START (not end, not middle)
              // Check if our landing position (where we bumped from) was a slide START
              let slideTriggered = false;
              if (landingIndex !== null) {
                const slideEndFromLanding = lsGetSlideEnd(landingIndex);
                // If landing on a slide START leads to our destination, we slid
                if (slideEndFromLanding !== null && slideEndFromLanding === newPos.index) {
                  // Verify it's not our own slide
                  const slideOwner = lsGetSlideOwner(landingIndex);
                  if (slideOwner !== pawn.seatIndex) {
                    slideTriggered = true;
                    // Animate: hop to slide start (landing), then slide to end
                    const slideStartPixel = lsTrackIndexToPixel(landingIndex);
                    const pawnOffset = (LS_TILE_SIZE - LS_PAWN_SIZE) / 2;
                    const hatX = LS_PAWN_HAT_OFFSET_X;
                    const hatY = LS_PAWN_HAT_OFFSET_Y;
                    const slideStartX = slideStartPixel.x + pawnOffset + hatX;
                    const slideStartY = slideStartPixel.y + pawnOffset + hatY;
                    
                    await lsAnimateArch(pawnEl, oldPos.x, oldPos.y, slideStartX, slideStartY, 260);
                    await lsAnimateSlide(pawnEl, slideStartX, slideStartY, newPos.x, newPos.y, 550);
                  }
                }
              }
              
              if (!slideTriggered) {
                // No slide - just hop directly to destination
                await lsAnimateArch(pawnEl, oldPos.x, oldPos.y, newPos.x, newPos.y, 260);
              }
            }
            // Safety movement: hop through each safety tile
            else if (oldPos.type === 'safety' && (newPos.type === 'safety' || newPos.type === 'home')) {
              const path = lsBuildMovePath(oldPos, newPos, pawn.seatIndex, safetyCoordsBySeat, homeCoordBySeat);
              if (path.length > 1) {
                await lsAnimateMultiHop(pawnEl, path, 130);
              } else {
                await lsAnimateArch(pawnEl, oldPos.x, oldPos.y, newPos.x, newPos.y, 195);
              }
            }
            // Any other move: single hop
            else {
              await lsAnimateArch(pawnEl, oldPos.x, oldPos.y, newPos.x, newPos.y, 260);
            }
          };
          
          animationPromises.push(animateMove());
        }
        
        // Animate knockouts (simultaneous with regular moves for 7-split or Sorry!)
        for (const { pawnId, oldPos, newPos } of knockedOutPawns) {
          const pawn = pawns.find(p => p.pawnId === pawnId);
          if (!pawn) continue;
          
          const color = colors[pawn.seatIndex] || 'red';
          const pawnEl = lsCreatePawnElement(pawnId, color, oldPos.x, oldPos.y);
          losientoPawnsEl.appendChild(pawnEl);
          
          // Slower knockout spin (1.5 seconds)
          animationPromises.push(lsAnimateKnockout(pawnEl, oldPos.x, oldPos.y, newPos.x, newPos.y, 1500));
        }
        
        // Animate slide-around (pawn at slide END moved backward to START and slid back to END)
        for (const { pawnId, oldPos, newPos, slideInfo } of slideAroundPawns) {
          const pawn = pawns.find(p => p.pawnId === pawnId);
          if (!pawn) continue;
          
          const color = colors[pawn.seatIndex] || 'red';
          const pawnEl = lsCreatePawnElement(pawnId, color, oldPos.x, oldPos.y);
          losientoPawnsEl.appendChild(pawnEl);
          
          // Calculate slide start position (the pawn moved backward to here, then slid)
          const slideStartPixel = lsTrackIndexToPixel(slideInfo.start);
          const pawnOffset = (LS_TILE_SIZE - LS_PAWN_SIZE) / 2;
          const hatX = LS_PAWN_HAT_OFFSET_X;
          const hatY = LS_PAWN_HAT_OFFSET_Y;
          const slideStartX = slideStartPixel.x + pawnOffset + hatX;
          const slideStartY = slideStartPixel.y + pawnOffset + hatY;
          
          console.log('[LS Animation] Slide-around: END', oldPos.index, '-> START', slideInfo.start, '-> END', slideInfo.end);
          
          // Animate: hop to slide start, then slide to end
          const animateSlideAround = async () => {
            // First: hop from slide END to slide START (backward movement)
            await lsAnimateArch(pawnEl, oldPos.x, oldPos.y, slideStartX, slideStartY, 300);
            // Then: slide from START to END
            await lsAnimateSlide(pawnEl, slideStartX, slideStartY, newPos.x, newPos.y, 500);
          };
          
          animationPromises.push(animateSlideAround());
        }
        
        await Promise.all(animationPromises);
        
        // Animation complete - re-render at final positions
        lsAnimating = false;
        lsPreviousPawnPositions = currentPawnPositions;
        lsLastRenderedGameId = gameId;
        lsLastRenderedTurnNumber = turnNumber;
        
        // Re-render to show final state with proper interactivity
        losientoPawnsEl.innerHTML = '';
        losientoHighlightsEl.innerHTML = '';
        lsRenderAllPawns(gameState, colors, safetyCoordsBySeat, homeCoordBySeat, startHomeCoordBySeat);
        
        // Render highlights
        if (isActive && selectedPawnId) {
          renderLoSientoDestHighlights(gameState, colors, safetyCoordsBySeat, homeCoordBySeat);
        }
      })();
      
      return;
    }
    
    // No animations - render normally
    lsRenderAllPawns(gameState, colors, safetyCoordsBySeat, homeCoordBySeat, startHomeCoordBySeat);
    
    // Update tracking state
    lsPreviousPawnPositions = currentPawnPositions;
    lsLastRenderedGameId = gameId;
    lsLastRenderedTurnNumber = turnNumber;
    
    // Render destination highlights for selected pawn (all cards)
    if (isActive && selectedPawnId) {
      renderLoSientoDestHighlights(gameState, colors, safetyCoordsBySeat, homeCoordBySeat);
    }
  }

  // Create a pawn element for animation
  function lsCreatePawnElement(pawnId, color, x, y) {
    const pawnEl = document.createElement('div');
    pawnEl.className = 'ls-pawn';
    pawnEl.dataset.pawnId = pawnId;
    pawnEl.style.transform = `translate(${x}px, ${y}px)`;
    
    const img = document.createElement('img');
    img.src = lsGetPawnImage(color);
    img.alt = `${color} pawn`;
    img.draggable = false;
    pawnEl.appendChild(img);
    
    return pawnEl;
  }

  // Render pawns that are NOT animating
  function lsRenderStaticPawns(gameState, colors, safetyCoordsBySeat, homeCoordBySeat, startHomeCoordBySeat, excludePawnIds) {
    const pawns = gameState.board.pawns || [];
    
    // Group pawns by position for stacking
    const pawnsByPosition = new Map();
    
    pawns.forEach(pawn => {
      if (excludePawnIds.has(pawn.pawnId)) return;
      const pos = pawn.position;
      if (!pos) return;
      
      let key;
      if (pos.type === 'start') {
        key = `start-${pawn.seatIndex}`;
      } else if (pos.type === 'home') {
        key = `home-${pawn.seatIndex}`;
      } else if (pos.type === 'track') {
        key = `track-${pos.index}`;
      } else if (pos.type === 'safety') {
        key = `safety-${pawn.seatIndex}-${pos.index}`;
      } else {
        return;
      }
      
      if (!pawnsByPosition.has(key)) {
        pawnsByPosition.set(key, []);
      }
      pawnsByPosition.get(key).push(pawn);
    });
    
    // Render static pawns
    pawnsByPosition.forEach((pawnsAtPos, key) => {
      if (pawnsAtPos.length === 0) return;
      
      const firstPawn = pawnsAtPos[0];
      const seatIndex = firstPawn.seatIndex;
      const color = colors[seatIndex] || 'red';
      const pos = firstPawn.position;
      
      const baseCenter = lsGetPawnCenter(pos, seatIndex, safetyCoordsBySeat, homeCoordBySeat, startHomeCoordBySeat);
      const isStartOrHome = pos.type === 'start' || pos.type === 'home';
      
      if (isStartOrHome && pawnsAtPos.length > 1) {
        const offsets = lsGetFormationOffsets(pawnsAtPos.length, seatIndex);
        const pawnElements = pawnsAtPos.map((pawn, idx) => {
          const offset = offsets[idx] || { x: 0, y: 0 };
          const finalY = baseCenter.y + offset.y;
          const pawnEl = lsCreatePawnElement(pawn.pawnId, color, baseCenter.x + offset.x, finalY);
          return { el: pawnEl, y: finalY };
        });
        pawnElements.sort((a, b) => a.y - b.y);
        pawnElements.forEach(({ el }) => losientoPawnsEl.appendChild(el));
      } else {
        const pawnEl = lsCreatePawnElement(firstPawn.pawnId, color, baseCenter.x, baseCenter.y);
        losientoPawnsEl.appendChild(pawnEl);
      }
    });
  }

  // Render all pawns with full interactivity
  function lsRenderAllPawns(gameState, colors, safetyCoordsBySeat, homeCoordBySeat, startHomeCoordBySeat) {
    const pawns = gameState.board.pawns || [];
    const isActive = gameState.result === 'active';
    
    // Group pawns by position for stacking
    const pawnsByPosition = new Map();
    
    pawns.forEach(pawn => {
      const pos = pawn.position;
      if (!pos) return;
      
      let key;
      if (pos.type === 'start') {
        key = `start-${pawn.seatIndex}`;
      } else if (pos.type === 'home') {
        key = `home-${pawn.seatIndex}`;
      } else if (pos.type === 'track') {
        key = `track-${pos.index}`;
      } else if (pos.type === 'safety') {
        key = `safety-${pawn.seatIndex}-${pos.index}`;
      } else {
        return;
      }
      
      if (!pawnsByPosition.has(key)) {
        pawnsByPosition.set(key, []);
      }
      pawnsByPosition.get(key).push(pawn);
    });
    
    // Render pawns
    pawnsByPosition.forEach((pawnsAtPos, key) => {
      if (pawnsAtPos.length === 0) return;
      
      const firstPawn = pawnsAtPos[0];
      const seatIndex = firstPawn.seatIndex;
      const color = colors[seatIndex] || 'red';
      const pos = firstPawn.position;
      
      const baseCenter = lsGetPawnCenter(pos, seatIndex, safetyCoordsBySeat, homeCoordBySeat, startHomeCoordBySeat);
      
      // Check if this is a start or home position (spread out multiple pawns)
      const isStartOrHome = pos.type === 'start' || pos.type === 'home';
      
      if (isStartOrHome && pawnsAtPos.length > 1) {
        // Spread pawns in formation
        const offsets = lsGetFormationOffsets(pawnsAtPos.length, seatIndex);
        
        // Build pawn elements with their Y positions for sorting
        const pawnElements = pawnsAtPos.map((pawn, idx) => {
          const offset = offsets[idx] || { x: 0, y: 0 };
          const finalY = baseCenter.y + offset.y;
          
          const pawnEl = document.createElement('div');
          pawnEl.className = 'ls-pawn';
          pawnEl.dataset.pawnId = pawn.pawnId;
          pawnEl.style.transform = `translate(${baseCenter.x + offset.x}px, ${finalY}px)`;
          
          const img = document.createElement('img');
          img.src = lsGetPawnImage(color);
          img.alt = `${color} pawn`;
          img.draggable = false;
          pawnEl.appendChild(img);
          
          // Check if any pawn at this position is a legal mover (for start, any can be clicked)
          const anyLegalMover = pawnsAtPos.some(p => legalMoverPawnIds && legalMoverPawnIds.has(p.pawnId));
          const isSelected = pawnsAtPos.some(p => selectedPawnId === p.pawnId);
          
          if (anyLegalMover) {
            pawnEl.classList.add('ls-pawn-legal');
            pawnEl.classList.add('ls-pawn-interactive');
            // Click any pawn in formation to select one (use first legal mover)
            pawnEl.addEventListener('click', () => {
              const legalPawn = pawnsAtPos.find(p => legalMoverPawnIds && legalMoverPawnIds.has(p.pawnId)) || pawn;
              handleLoSientoPawnClick(legalPawn, pawnsAtPos, true, false);
            });
          }
          if (isSelected) {
            pawnEl.classList.add('ls-pawn-selected');
          }
          
          return { el: pawnEl, y: finalY };
        });
        
        // Sort by Y position (lower Y first, so higher Y renders last and appears on top)
        // This ensures bottom pawns' hats overlap top pawns
        pawnElements.sort((a, b) => a.y - b.y);
        pawnElements.forEach(({ el }) => losientoPawnsEl.appendChild(el));
        
        return; // Skip the single-pawn rendering below
      }
      
      // Single pawn or non-start/home position
      const center = baseCenter;
      const pawnEl = document.createElement('div');
      pawnEl.className = 'ls-pawn';
      pawnEl.dataset.pawnId = firstPawn.pawnId;
      pawnEl.style.transform = `translate(${center.x}px, ${center.y}px)`;
      
      const img = document.createElement('img');
      img.src = lsGetPawnImage(color);
      img.alt = `${color} pawn`;
      img.draggable = false;
      pawnEl.appendChild(img);
      
      // Check if this pawn is a legal mover
      const isLegalMover = legalMoverPawnIds && legalMoverPawnIds.has(firstPawn.pawnId);
      const isSelected = selectedPawnId === firstPawn.pawnId;
      const isSecondarySelected = selectedSecondaryPawnId === firstPawn.pawnId;
      
      // Check if this is a target pawn (for Sorry! or 11 switch)
      let isTarget = false;
      if (selectedMoveIndex != null && upcomingMoves) {
        const selectedMove = upcomingMoves.find(m => m.index === selectedMoveIndex);
        if (selectedMove && selectedMove.targetPawnId === firstPawn.pawnId) {
          isTarget = true;
        }
      }
      
      if (isLegalMover) {
        pawnEl.classList.add('ls-pawn-legal');
      }
      if (isSelected || isSecondarySelected) {
        pawnEl.classList.add('ls-pawn-selected');
      }
      if (isTarget) {
        pawnEl.classList.add('ls-pawn-target');
      }
      
      // Add click handler for legal movers
      if (isLegalMover || isTarget) {
        pawnEl.classList.add('ls-pawn-interactive');
        pawnEl.addEventListener('click', () => {
          handleLoSientoPawnClick(firstPawn, pawnsAtPos, isLegalMover, isTarget);
        });
      }
      
      // Also check if this is a Sorry!/11 target that hasn't been selected yet
      if (isActive && !isLegalMover && selectedPawnId && (upcomingCard === 'Sorry!' || upcomingCard === '11')) {
        const currentSeatIndex = gameState.currentSeatIndex;
        const isOpponentPawn = seatIndex !== currentSeatIndex;
        if (isOpponentPawn) {
          const movesArray = Array.isArray(upcomingMoves) ? upcomingMoves : [];
          const hasTargetMove = movesArray.some(m => 
            m.pawnId === selectedPawnId && m.targetPawnId === firstPawn.pawnId
          );
          if (hasTargetMove) {
            pawnEl.classList.add('ls-pawn-target-selectable');
            pawnEl.classList.add('ls-pawn-interactive');
            pawnEl.addEventListener('click', () => {
              const move = movesArray.find(m => 
                m.pawnId === selectedPawnId && m.targetPawnId === firstPawn.pawnId
              );
              if (move && typeof move.index === 'number') {
                selectedMoveIndex = move.index;
                renderGame();
              }
            });
          }
        }
      }
      
      losientoPawnsEl.appendChild(pawnEl);
    });
  }

  // Handle pawn click in Lo Siento mode
  function handleLoSientoPawnClick(pawn, pawnsAtPos, isLegalMover, isTarget) {
    const pawnId = pawn.pawnId;
    const movesArray = Array.isArray(upcomingMoves) ? upcomingMoves : [];
    
    // For target clicks (Sorry! or 11 switch)
    if (isTarget && selectedPawnId) {
      const move = movesArray.find(m => 
        m.pawnId === selectedPawnId && m.targetPawnId === pawnId
      );
      if (move && typeof move.index === 'number') {
        selectedMoveIndex = move.index;
        renderGame();
        return;
      }
    }
    
    // For Sorry!, clicking your own Start pawn arms the move
    if (upcomingCard === 'Sorry!') {
      selectedPawnId = pawnId;
      selectedMoveIndex = null;
      renderGame();
      return;
    }
    
    // Card 7 UI behavior
    if (upcomingCard === '7') {
      if (!selectedPawnId) {
        selectedPawnId = pawnId;
        selectedSecondaryPawnId = null;
        selectedMoveIndex = null;
        renderGame();
        return;
      }
      
      if (selectedPawnId && !selectedSecondaryPawnId) {
        if (pawnId === selectedPawnId) return;
        
        const hasSplitWithThisPair = movesArray.some(m =>
          (m.pawnId === selectedPawnId && m.secondaryPawnId === pawnId) ||
          (m.pawnId === pawnId && m.secondaryPawnId === selectedPawnId)
        );
        
        if (hasSplitWithThisPair) {
          selectedSecondaryPawnId = pawnId;
          selectedMoveIndex = null;
          renderGame();
          return;
        }
        
        selectedPawnId = pawnId;
        selectedSecondaryPawnId = null;
        selectedMoveIndex = null;
        renderGame();
        return;
      }
      
      if (selectedPawnId && selectedSecondaryPawnId) {
        if (pawnId === selectedPawnId || pawnId === selectedSecondaryPawnId) {
          selectedPawnId = pawnId;
          selectedSecondaryPawnId = null;
          selectedMoveIndex = null;
          renderGame();
          return;
        }
        
        const newPrimary = selectedSecondaryPawnId;
        const newSecondary = pawnId;
        
        const hasSplitWithNewPair = movesArray.some(m =>
          (m.pawnId === newPrimary && m.secondaryPawnId === newSecondary) ||
          (m.pawnId === newSecondary && m.secondaryPawnId === newPrimary)
        );
        
        if (hasSplitWithNewPair) {
          selectedPawnId = newPrimary;
          selectedSecondaryPawnId = newSecondary;
          selectedMoveIndex = null;
          renderGame();
          return;
        }
        
        selectedPawnId = pawnId;
        selectedSecondaryPawnId = null;
        selectedMoveIndex = null;
        renderGame();
        return;
      }
    }
    
    // Default behavior: cycle through pawn's available moves
    // For card 11 with only switch moves, include a "no move" option in the cycle.
    const onlySwitchMovesFor11 =
      upcomingCard === '11' &&
      movesArray.length > 0 &&
      !movesArray.some(m => m.direction === 'forward' && m.steps === 11);
    
    const candidates = movesArray.filter(m => m.pawnId === pawnId);
    let chosen = null;
    if (candidates.length > 0) {
      if (selectedPawnId === pawnId) {
        if (selectedMoveIndex != null) {
          const currentIdx = candidates.findIndex(m => m.index === selectedMoveIndex);
          if (currentIdx >= 0 && currentIdx === candidates.length - 1 && onlySwitchMovesFor11) {
            // At the last move, cycle to "no move" for card 11 switch-only
            chosen = null;
          } else {
            const nextIdx = currentIdx >= 0 ? (currentIdx + 1) % candidates.length : 0;
            chosen = candidates[nextIdx];
          }
        } else {
          // Currently at "no move", cycle to first move
          chosen = candidates[0];
        }
      } else {
        chosen = candidates[0];
      }
    }
    selectedPawnId = pawnId;
    selectedMoveIndex = chosen ? chosen.index : null;
    renderGame();
  }

  // Render destination highlights for card 7, 10, 11, Sorry!
  function renderLoSientoDestHighlights(gameState, colors, safetyCoordsBySeat, homeCoordBySeat) {
    if (!losientoHighlightsEl || !selectedPawnId) return;
    
    const movesArray = Array.isArray(upcomingMoves) ? upcomingMoves : [];
    const pawnOffset = (LS_TILE_SIZE - LS_PAWN_SIZE) / 2;
    
    // Get pawns from game state for looking up target pawn positions
    const pawns = (gameState.board && gameState.board.pawns) || [];
    const pawnById = new Map();
    pawns.forEach(p => {
      if (p && p.pawnId) pawnById.set(p.pawnId, p);
    });
    
    // Find all unique destination tiles for the selected pawn
    const destTiles = new Set();
    
    movesArray.forEach(move => {
      let matchesPawn = false;
      let destKey = null;
      
      if (upcomingCard === '7') {
        if (selectedSecondaryPawnId) {
          // Split-7 with explicit pair
          if ((move.pawnId === selectedPawnId && move.secondaryPawnId === selectedSecondaryPawnId) ||
              (move.pawnId === selectedSecondaryPawnId && move.secondaryPawnId === selectedPawnId)) {
            matchesPawn = true;
            // Add both destinations
            if (move.logicalDestType === 'track' && typeof move.logicalDestIndex === 'number') {
              destTiles.add(`track-${move.logicalDestIndex}`);
            }
            if (move.logicalDestType === 'safety' && typeof move.logicalDestIndex === 'number') {
              destTiles.add(`safety-${gameState.currentSeatIndex}-${move.logicalDestIndex}`);
            }
            if (move.logicalDestType === 'home') {
              destTiles.add(`home-${gameState.currentSeatIndex}`);
            }
            if (move.secondaryLogicalDestType === 'track' && typeof move.secondaryLogicalDestIndex === 'number') {
              destTiles.add(`track-${move.secondaryLogicalDestIndex}`);
            }
            if (move.secondaryLogicalDestType === 'safety' && typeof move.secondaryLogicalDestIndex === 'number') {
              destTiles.add(`safety-${gameState.currentSeatIndex}-${move.secondaryLogicalDestIndex}`);
            }
            if (move.secondaryLogicalDestType === 'home') {
              destTiles.add(`home-${gameState.currentSeatIndex}`);
            }
          }
        } else {
          // Single pawn selected for 7
          if (move.pawnId === selectedPawnId) {
            if (move.logicalDestType === 'track' && typeof move.logicalDestIndex === 'number') {
              destTiles.add(`track-${move.logicalDestIndex}`);
            }
            if (move.logicalDestType === 'safety' && typeof move.logicalDestIndex === 'number') {
              destTiles.add(`safety-${gameState.currentSeatIndex}-${move.logicalDestIndex}`);
            }
            if (move.logicalDestType === 'home') {
              destTiles.add(`home-${gameState.currentSeatIndex}`);
            }
          }
          if (move.secondaryPawnId === selectedPawnId) {
            if (move.secondaryLogicalDestType === 'track' && typeof move.secondaryLogicalDestIndex === 'number') {
              destTiles.add(`track-${move.secondaryLogicalDestIndex}`);
            }
            if (move.secondaryLogicalDestType === 'safety' && typeof move.secondaryLogicalDestIndex === 'number') {
              destTiles.add(`safety-${gameState.currentSeatIndex}-${move.secondaryLogicalDestIndex}`);
            }
            if (move.secondaryLogicalDestType === 'home') {
              destTiles.add(`home-${gameState.currentSeatIndex}`);
            }
          }
        }
      } else {
        // Cards 10, 11, and Sorry!
        if (move.pawnId === selectedPawnId) {
          if (move.logicalDestType === 'track' && typeof move.logicalDestIndex === 'number') {
            destTiles.add(`track-${move.logicalDestIndex}`);
          }
          if (move.logicalDestType === 'safety' && typeof move.logicalDestIndex === 'number') {
            destTiles.add(`safety-${gameState.currentSeatIndex}-${move.logicalDestIndex}`);
          }
          if (move.logicalDestType === 'home') {
            destTiles.add(`home-${gameState.currentSeatIndex}`);
          }
          
          // For card 11 switch or Sorry! bump, highlight the target pawn's current tile
          if (move.targetPawnId && (upcomingCard === '11' || upcomingCard === 'Sorry!')) {
            const targetPawn = pawnById.get(move.targetPawnId);
            if (targetPawn && targetPawn.position) {
              const pos = targetPawn.position;
              if (pos.type === 'track' && typeof pos.index === 'number') {
                destTiles.add(`target-track-${pos.index}-${move.targetPawnId}`);
              }
            }
          }
        }
      }
    });
    
    // Create highlight elements for each destination
    destTiles.forEach(destKey => {
      const parts = destKey.split('-');
      const type = parts[0];
      let x = 0, y = 0;
      
      if (type === 'track') {
        const trackIndex = parseInt(parts[1], 10);
        const pixel = lsTrackIndexToPixel(trackIndex);
        x = pixel.x;
        y = pixel.y;
      } else if (type === 'target') {
        // Target pawn tile for 11 switch or Sorry! bump: target-track-<index>-<pawnId>
        const trackIndex = parseInt(parts[2], 10);
        const pixel = lsTrackIndexToPixel(trackIndex);
        x = pixel.x;
        y = pixel.y;
      } else if (type === 'safety') {
        const seatIdx = parseInt(parts[1], 10);
        const safetyIdx = parseInt(parts[2], 10);
        const coords = safetyCoordsBySeat[seatIdx];
        if (coords && coords[safetyIdx]) {
          x = coords[safetyIdx].col * LS_TILE_SIZE;
          y = coords[safetyIdx].row * LS_TILE_SIZE;
        }
      } else if (type === 'home') {
        const seatIdx = parseInt(parts[1], 10);
        const homeCoord = homeCoordBySeat[seatIdx];
        if (homeCoord) {
          x = homeCoord.col * LS_TILE_SIZE;
          y = homeCoord.row * LS_TILE_SIZE;
        }
      }
      
      const highlight = document.createElement('div');
      highlight.className = 'ls-highlight';
      highlight.style.left = `${x}px`;
      highlight.style.top = `${y}px`;
      
      // Check if this is the selected destination
      if (selectedMoveIndex != null) {
        const selectedMove = movesArray.find(m => m.index === selectedMoveIndex);
        if (selectedMove) {
          let isSelectedDest = false;
          // Primary destination checks
          if (type === 'track' && selectedMove.logicalDestType === 'track' && 
              selectedMove.logicalDestIndex === parseInt(parts[1], 10)) {
            isSelectedDest = true;
          }
          if (type === 'target' && selectedMove.targetPawnId === parts[3]) {
            // Target pawn tile is selected if move's targetPawnId matches
            isSelectedDest = true;
          }
          if (type === 'safety' && selectedMove.logicalDestType === 'safety' &&
              selectedMove.logicalDestIndex === parseInt(parts[2], 10)) {
            isSelectedDest = true;
          }
          if (type === 'home' && selectedMove.logicalDestType === 'home') {
            isSelectedDest = true;
          }
          // Secondary destination checks for card 7 split moves
          if (type === 'track' && selectedMove.secondaryLogicalDestType === 'track' &&
              selectedMove.secondaryLogicalDestIndex === parseInt(parts[1], 10)) {
            isSelectedDest = true;
          }
          if (type === 'safety' && selectedMove.secondaryLogicalDestType === 'safety' &&
              selectedMove.secondaryLogicalDestIndex === parseInt(parts[2], 10)) {
            isSelectedDest = true;
          }
          if (type === 'home' && selectedMove.secondaryLogicalDestType === 'home') {
            isSelectedDest = true;
          }
          if (isSelectedDest) {
            highlight.classList.add('ls-highlight-selected');
          }
        }
      }
      
      // Add click handler
      highlight.addEventListener('click', () => {
        handleLoSientoDestClick(destKey, movesArray, gameState);
      });
      
      losientoHighlightsEl.appendChild(highlight);
    });
  }

  // Handle destination tile click in Lo Siento mode
  function handleLoSientoDestClick(destKey, movesArray, gameState) {
    const parts = destKey.split('-');
    const type = parts[0];
    
    let candidates = [];
    
    if (upcomingCard === '7') {
      if (selectedSecondaryPawnId) {
        // Split-7 with explicit pair
        candidates = movesArray.filter(m => {
          const isPair = (m.pawnId === selectedPawnId && m.secondaryPawnId === selectedSecondaryPawnId) ||
                        (m.pawnId === selectedSecondaryPawnId && m.secondaryPawnId === selectedPawnId);
          if (!isPair) return false;
          
          if (type === 'track') {
            const idx = parseInt(parts[1], 10);
            return (m.logicalDestType === 'track' && m.logicalDestIndex === idx) ||
                   (m.secondaryLogicalDestType === 'track' && m.secondaryLogicalDestIndex === idx);
          }
          if (type === 'safety') {
            const safetyIdx = parseInt(parts[2], 10);
            return (m.logicalDestType === 'safety' && m.logicalDestIndex === safetyIdx) ||
                   (m.secondaryLogicalDestType === 'safety' && m.secondaryLogicalDestIndex === safetyIdx);
          }
          if (type === 'home') {
            return m.logicalDestType === 'home' || m.secondaryLogicalDestType === 'home';
          }
          return false;
        });
      } else {
        // Single pawn for 7
        candidates = movesArray.filter(m => {
          const involvesPawn = m.pawnId === selectedPawnId || m.secondaryPawnId === selectedPawnId;
          if (!involvesPawn) return false;
          
          if (type === 'track') {
            const idx = parseInt(parts[1], 10);
            if (m.pawnId === selectedPawnId && m.logicalDestType === 'track' && m.logicalDestIndex === idx) return true;
            if (m.secondaryPawnId === selectedPawnId && m.secondaryLogicalDestType === 'track' && m.secondaryLogicalDestIndex === idx) return true;
          }
          if (type === 'safety') {
            const safetyIdx = parseInt(parts[2], 10);
            if (m.pawnId === selectedPawnId && m.logicalDestType === 'safety' && m.logicalDestIndex === safetyIdx) return true;
            if (m.secondaryPawnId === selectedPawnId && m.secondaryLogicalDestType === 'safety' && m.secondaryLogicalDestIndex === safetyIdx) return true;
          }
          if (type === 'home') {
            if (m.pawnId === selectedPawnId && m.logicalDestType === 'home') return true;
            if (m.secondaryPawnId === selectedPawnId && m.secondaryLogicalDestType === 'home') return true;
          }
          return false;
        });
      }
    } else {
      // Cards 10, 11, and Sorry!
      candidates = movesArray.filter(m => {
        if (m.pawnId !== selectedPawnId) return false;
        
        if (type === 'track') {
          const idx = parseInt(parts[1], 10);
          return m.logicalDestType === 'track' && m.logicalDestIndex === idx;
        }
        if (type === 'target') {
          // Click on target pawn tile for 11 switch or Sorry! bump
          const targetPawnId = parts[3];
          return m.targetPawnId === targetPawnId;
        }
        if (type === 'safety') {
          const safetyIdx = parseInt(parts[2], 10);
          return m.logicalDestType === 'safety' && m.logicalDestIndex === safetyIdx;
        }
        if (type === 'home') {
          return m.logicalDestType === 'home';
        }
        return false;
      });
    }
    
    if (candidates.length === 0) return;
    
    // Check if clicking the same destination tile as currently selected
    let clickingSameDestination = false;
    if (selectedMoveIndex != null) {
      const currentMove = movesArray.find(m => m.index === selectedMoveIndex);
      if (currentMove) {
        if (type === 'track' && currentMove.logicalDestType === 'track' && 
            currentMove.logicalDestIndex === parseInt(parts[1], 10)) {
          clickingSameDestination = true;
        }
        if (type === 'target' && currentMove.targetPawnId === parts[3]) {
          clickingSameDestination = true;
        }
        if (type === 'safety' && currentMove.logicalDestType === 'safety' &&
            currentMove.logicalDestIndex === parseInt(parts[2], 10)) {
          clickingSameDestination = true;
        }
        if (type === 'home' && currentMove.logicalDestType === 'home') {
          clickingSameDestination = true;
        }
      }
    }
    
    // Cycle through candidates only if clicking same destination tile
    let chosen = null;
    if (clickingSameDestination && candidates.length > 1) {
      const currentIdx = candidates.findIndex(m => m.index === selectedMoveIndex);
      const nextIdx = currentIdx >= 0 ? (currentIdx + 1) % candidates.length : 0;
      chosen = candidates[nextIdx];
    } else {
      // Different tile or first selection - just pick the first candidate
      chosen = candidates[0];
    }
    
    if (chosen && typeof chosen.index === 'number') {
      selectedMoveIndex = chosen.index;
      renderGame();
    }
  }

  function init() {
    hostForm.addEventListener("submit", handleHostSubmit);
    refreshJoinableBtn.addEventListener("click", refreshJoinable);
    
    // Interface mode toggle handlers
    if (modeBasicBtn) {
      modeBasicBtn.addEventListener('click', () => setInterfaceMode('basic'));
    }
    if (modeLoSientoBtn) {
      modeLoSientoBtn.addEventListener('click', () => setInterfaceMode('losiento'));
    }

    startGameBtn.addEventListener("click", handleStartGame);
    leaveLobbyBtn.addEventListener("click", handleLeave);

    leaveGameBtn.addEventListener("click", handleLeave);
    
    // Autoplay speed button handlers
    function handleAutoplayClick(speed) {
      if (!isHost()) {
        showToast("Only the host can control autoplay");
        return;
      }
      setAutoplaySpeed(speed);
    }
    if (autoplayOffBtn) {
      autoplayOffBtn.addEventListener("click", () => handleAutoplayClick(0));
    }
    if (autoplaySlowBtn) {
      autoplaySlowBtn.addEventListener("click", () => handleAutoplayClick(1));
    }
    if (autoplayFastBtn) {
      autoplayFastBtn.addEventListener("click", () => handleAutoplayClick(2));
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
