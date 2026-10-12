"use strict";

const socket = io();
const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );

let turnSeconds = 10; // updated from the server at the start of every turn
const state = {
  id: "",
  room: "",
  mode: "create",
  active: false,
  myTurn: false,
};

const store = {
  get: (k) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k, v) => {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* storage unavailable */
    }
  },
};

const screens = {
  hero: $("screen-hero"),
  lobby: $("screen-lobby"),
  game: $("screen-game"),
};
const wordInput = $("word-input");
const submitBtn = $("submit-btn");
const timerBar = $("timer-bar");
const drawer = $("drawer");

socket.on("connect", () => (state.id = socket.id));
socket.on("disconnect", () => {
  if (state.room) {
    showToast("Connection lost. Returning to the start screen.", "error");
    goHome();
  }
});

/* ------------------------------------------------------------------ ui */
let toastTimer;
function showToast(msg, kind = "") {
  const t = $("toast");
  t.textContent = msg;
  t.className = "toast show " + kind;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 3200);
}

function switchScreen(name) {
  Object.entries(screens).forEach(([k, el]) =>
    el.classList.toggle("active", k === name),
  );
  document.body.dataset.screen = name;
  window.scrollTo(0, 0);
}

function openModal(id) {
  $(id).classList.remove("hidden");
  if (id === "board-modal") socket.emit("get_global_leaderboard");
}
const closeModal = (id) => $(id).classList.add("hidden");

function setTab(tab) {
  document
    .querySelectorAll("[data-tab]")
    .forEach((b) => b.classList.toggle("is-on", b.dataset.tab === tab));
  document
    .querySelectorAll("[data-panel]")
    .forEach((p) => p.classList.toggle("hidden", p.dataset.panel !== tab));
}

function setMode(mode) {
  state.mode = mode;
  document
    .querySelectorAll("[data-mode]")
    .forEach((b) => b.classList.toggle("is-on", b.dataset.mode === mode));
  const create = mode === "create";
  $("room-label").textContent = create ? "New room ID" : "Host's room ID";
  $("room-input").placeholder = create ? "Pick a short code" : "Enter the code";
  $("hero-cta").textContent = create ? "Create room" : "Request to join";
}

document.addEventListener("click", (e) => {
  if (drawer.classList.contains("open")) {
    const path = e.composedPath();
    if (!path.includes(drawer) && !path.includes($("host-bell")))
      drawer.classList.remove("open");
  }
  const open = e.target.closest("[data-open]");
  if (open) return openModal(open.dataset.open);
  const close = e.target.closest("[data-close]");
  if (close) return closeModal(close.dataset.close);
  const tab = e.target.closest("[data-tab]");
  if (tab) return setTab(tab.dataset.tab);
  const mode = e.target.closest("[data-mode]");
  if (mode) return setMode(mode.dataset.mode);
  if (e.target.classList.contains("dismissible")) closeModal(e.target.id);
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    document
      .querySelectorAll(".overlay.dismissible:not(.hidden)")
      .forEach((o) => closeModal(o.id));
    drawer.classList.remove("open");
    return;
  }
  // Start typing anywhere on your turn
  if (
    state.active &&
    state.myTurn &&
    !e.ctrlKey &&
    !e.metaKey &&
    !e.altKey &&
    document.activeElement !== wordInput &&
    e.key.length === 1
  ) {
    wordInput.focus();
  }
});

const RESULT_SECONDS = 5;
let resultTimer = null;
const stopResultTimer = () => {
  clearInterval(resultTimer);
  resultTimer = null;
};

// After a match: hide Pause/Quit, show "Back to lobby" (and the reverse for a new match)
function setEndedUI(ended) {
  $("pause-btn").classList.toggle("hidden", ended);
  $("quit-btn").classList.toggle("hidden", ended);
  $("lobby-btn").classList.toggle("hidden", !ended);
}

function paintPause(left) {
  if (typeof left !== "number") return;
  const btn = $("pause-btn");
  btn.textContent = `Pause (${left})`;
  btn.disabled = left <= 0;
  btn.title = left <= 0 ? "Pause limit over" : "";
}

function toLobby() {
  stopResultTimer();
  $("result-overlay").classList.add("hidden");
  setEndedUI(false);
  switchScreen("lobby");
}

function startResultCountdown(seconds) {
  stopResultTimer();
  const bar = $("result-bar");
  let left = seconds;
  $("result-timer-wrap").classList.remove("hidden");
  $("result-timer").textContent = `Returning to lobby in ${left}s`;
  bar.style.transition = "none";
  bar.style.transform = "scaleX(1)";
  void bar.offsetWidth;
  bar.style.transition = `transform ${seconds}s linear`;
  bar.style.transform = "scaleX(0)";
  resultTimer = setInterval(() => {
    left--;
    if (left <= 0) return toLobby();
    $("result-timer").textContent = `Returning to lobby in ${left}s`;
  }, 1000);
}

function goHome() {
  stopResultTimer();
  setEndedUI(false);
  state.room = "";
  state.active = false;
  state.myTurn = false;
  [
    "pause-overlay",
    "result-overlay",
    "confirm-modal",
    "join-status",
    "host-bell",
  ].forEach((id) => $(id).classList.add("hidden"));
  drawer.classList.remove("open");
  $("req-list").innerHTML = "";
  refreshRequests();
  $("countdown-msg").textContent = "";
  switchScreen("hero");
}

/* ---------------------------------------------------------------- hero */
$("name-input").value = store.get("wc_name") || "";
if (store.get("wc_country"))
  $("country-select").value = store.get("wc_country");
const invite = new URLSearchParams(location.search).get("room");
if (invite) {
  setMode("join");
  $("room-input").value = invite.toUpperCase().slice(0, 10);
}

$("hero-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const name = $("name-input").value.trim();
  const country = $("country-select").value;
  const room = $("room-input").value.trim().toUpperCase();
  if (!name || !room)
    return showToast("Enter your nickname and a room ID.", "error");
  store.set("wc_name", name);
  store.set("wc_country", country);
  socket.emit(state.mode === "create" ? "create_room" : "request_join", {
    room,
    name,
    country,
  });
});

socket.on("waiting_for_host", (msg) => {
  $("join-status-text").textContent = msg;
  $("join-status").classList.remove("hidden");
});
$("join-cancel").addEventListener("click", () => {
  socket.emit("cancel_request");
  $("join-status").classList.add("hidden");
});
socket.on("join_error", (msg) => {
  $("join-status").classList.add("hidden");
  showToast(msg, "error");
});
socket.on("join_success", (room) => {
  state.room = room;
  $("display-room").textContent = room;
  $("join-status").classList.add("hidden");
  switchScreen("lobby");
});

/* -------------------------------------------------------- join requests */
function refreshRequests() {
  const n = $("req-list").children.length;
  $("no-req").classList.toggle("hidden", n > 0);
  $("req-count").textContent = n;
  $("req-count").classList.toggle("hidden", n === 0);
}

$("host-bell").addEventListener("click", () => drawer.classList.toggle("open"));
$("drawer-close").addEventListener("click", () =>
  drawer.classList.remove("open"),
);

socket.on(
  "join_request_received",
  ({ targetId, targetName, targetCountry }) => {
    if ($("req-list").querySelector(`[data-id="${CSS.escape(targetId)}"]`))
      return;
    const el = document.createElement("div");
    el.className = "req";
    el.dataset.id = targetId;
    el.innerHTML = `
    <div class="req-who"><b>${esc(targetName)}</b><span class="cc">${esc(targetCountry)}</span></div>
    <div class="req-actions">
      <button class="btn btn-primary btn-sm" data-act="accept">Accept</button>
      <button class="btn btn-ghost btn-sm" data-act="reject">Decline</button>
    </div>`;
    $("req-list").appendChild(el);
    refreshRequests();
    showToast(`${targetName} wants to join`);
  },
);

$("req-list").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-act]");
  if (!btn) return;
  const item = btn.closest(".req");
  socket.emit(
    btn.dataset.act === "accept" ? "accept_request" : "reject_request",
    { targetId: item.dataset.id },
  );
  item.remove();
  refreshRequests();
  if (!$("req-list").children.length) drawer.classList.remove("open");
});

socket.on("request_cancelled", ({ targetId }) => {
  $("req-list")
    .querySelector(`[data-id="${CSS.escape(targetId)}"]`)
    ?.remove();
  refreshRequests();
  if (!$("req-list").children.length) drawer.classList.remove("open");
});

/* --------------------------------------------------------------- lobby */
const hearts = (n) =>
  Array.from(
    { length: 3 },
    (_, i) => `<i class="${i < n ? "on" : ""}">&#9829;</i>`,
  ).join("");
const player = (p, sub, right = "") => `
  <li class="pl ${p.id === state.id ? "is-me" : ""}">
    <span class="avatar">${esc(p.name.charAt(0).toUpperCase())}</span>
    <div class="pl-main">
      <b class="pl-name">${esc(p.name)}${p.id === state.id ? " (you)" : ""}</b>
      <span class="pl-sub">${sub}</span>
    </div>${right}
  </li>`;

socket.on("update_players", ({ players }) => {
  const me = players.find((p) => p.id === state.id);
  if (me) {
    $("host-bell").classList.toggle("hidden", !me.isHost);
    $("ready-btn").textContent = me.isReady ? "Cancel ready" : "I'm ready";
    $("ready-btn").className =
      "btn " + (me.isReady ? "btn-ghost" : "btn-primary");
  }
  const ready = players.filter((p) => p.isReady).length;
  $("seat-count").textContent = `${players.length}/8 players`;
  $("lobby-hint").textContent =
    players.length < 2
      ? "Waiting for another player"
      : `${ready} of ${players.length} ready`;
  $("lobby-players").innerHTML = players
    .map((p) =>
      player(
        p,
        `<span class="cc">${esc(p.country || "India")}</span>` +
          (p.isHost ? '<span class="badge host">Host</span>' : "") +
          (p.isReady ? '<span class="badge ready">Ready</span>' : ""),
      ),
    )
    .join("");
});

$("ready-btn").addEventListener("click", () => socket.emit("toggle_ready"));
$("leave-btn").addEventListener("click", () => {
  socket.emit("quit_game");
  goHome();
});
$("copy-room").addEventListener("click", async () => {
  const link = `${location.origin}/?room=${encodeURIComponent(state.room)}`;
  try {
    await navigator.clipboard.writeText(link);
    showToast("Invite link copied");
  } catch {
    showToast(link);
  }
});

socket.on(
  "match_countdown",
  (n) => ($("countdown-msg").textContent = `Match starts in ${n}`),
);
socket.on(
  "match_countdown_cancelled",
  () => ($("countdown-msg").textContent = ""),
);
socket.on("game_started", () => {
  state.active = true;
  drawer.classList.remove("open");
  $("req-list").innerHTML = "";
  refreshRequests();
  $("countdown-msg").textContent = "";
  stopResultTimer();
  setEndedUI(false);
  paintPause(2);
  $("result-overlay").classList.add("hidden");
  switchScreen("game");
});

/* ---------------------------------------------------------------- game */
function renderTarget(word) {
  const w = word.toUpperCase();
  const el = $("current-word");
  el.dataset.len = w.length > 12 ? "xl" : w.length > 8 ? "l" : "";
  el.setAttribute("aria-label", w);
  el.innerHTML = [...w]
    .map(
      (ch, i) =>
        `<span class="tile${i === w.length - 1 ? " link" : ""}">${esc(ch)}</span>`,
    )
    .join("");
  $("required-letter").textContent = w.slice(-1);
  wordInput.dataset.req = w.slice(-1).toLowerCase();
}

function renderChain(chain) {
  const el = $("word-history");
  el.innerHTML = chain.length
    ? chain
        .map((w) => `<span class="chip">${esc(w.toUpperCase())}</span>`)
        .join('<span class="arrow">&rarr;</span>') +
      '<span class="arrow">&rarr;</span>'
    : '<span class="chain-empty">The chain starts here</span>';
  el.scrollTop = el.scrollHeight; // keep the latest word in view
}

function renderRoster(players, activeId) {
  $("game-players").innerHTML = [...players]
    .sort((a, b) => b.score - a.score)
    .map((p) => {
      const li = player(
        p,
        `<span class="cc">${esc(p.country || "India")}</span><span class="hearts">${hearts(p.lives)}</span>`,
        `<span class="pl-score">${p.score}</span>`,
      );
      const cls =
        (p.id === activeId ? " is-active" : "") +
        (p.lives <= 0 ? " is-out" : "");
      return li.replace('class="pl ', `class="pl${cls} `);
    })
    .join("");
}

function paintTimer(t) {
  $("timer-num").textContent = Math.max(t, 0);
  timerBar.style.transform = `scaleX(${Math.max(t - 1, 0) / turnSeconds})`;
  timerBar.classList.toggle("danger", t <= 3);
  timerBar.classList.toggle("warn", t > 3 && t <= 6);
}
function resetTimer(t) {
  timerBar.style.transition = "none";
  timerBar.style.transform = "scaleX(1)";
  void timerBar.offsetWidth;
  timerBar.style.transition = "";
  paintTimer(t);
}

socket.on(
  "new_turn",
  ({
    activePlayerId,
    activePlayerName,
    currentWord,
    chain,
    players,
    timeLeft,
  }) => {
    renderTarget(currentWord);
    renderChain(chain);
    renderRoster(players, activePlayerId);
    turnSeconds = timeLeft; // a new turn always starts with a full clock
    resetTimer(timeLeft);
    paintPause(players.find((p) => p.id === state.id)?.pausesLeft);

    wordInput.value = "";
    wordInput.classList.remove("invalid");
    $("error-msg").textContent = "";

    state.myTurn = activePlayerId === state.id;
    $("turn-banner").classList.toggle("is-me", state.myTurn);
    $("turn-text").textContent = state.myTurn
      ? "Your turn"
      : `${activePlayerName}'s turn`;
    wordInput.disabled = submitBtn.disabled = !state.myTurn;
    wordInput.placeholder = state.myTurn
      ? `Starts with ${currentWord.slice(-1).toUpperCase()}`
      : "Wait for your turn";
    if (state.myTurn)
      setTimeout(() => wordInput.focus({ preventScroll: true }), 80);
  },
);

socket.on("timer_tick", paintTimer);
socket.on("turn_timeout", ({ name }) => showToast(`${name} ran out of time`));
socket.on("player_left", ({ name }) => showToast(`${name} left the match`));

wordInput.addEventListener("input", () => {
  wordInput.value = wordInput.value.replace(/[^a-zA-Z]/g, "");
  const v = wordInput.value.toLowerCase();
  wordInput.classList.toggle(
    "invalid",
    v.length > 0 && v[0] !== wordInput.dataset.req,
  );
  $("error-msg").textContent = "";
});

$("word-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const word = wordInput.value.trim();
  if (state.myTurn && word) socket.emit("submit_word", { word });
});

socket.on("word_error", (msg) => {
  $("error-msg").textContent = msg;
  const form = $("word-form");
  form.classList.remove("shake");
  void form.offsetWidth;
  form.classList.add("shake");
  wordInput.select();
});

/* -------------------------------------------------------- pause / quit */
$("pause-btn").addEventListener("click", () => socket.emit("request_pause"));
$("quit-btn").addEventListener("click", () => openModal("confirm-modal"));
$("pause-quit").addEventListener("click", () => openModal("confirm-modal"));
$("confirm-no").addEventListener("click", () => closeModal("confirm-modal"));
$("confirm-yes").addEventListener("click", () => {
  socket.emit("quit_game");
  goHome();
});

socket.on("pause_denied", (msg) => showToast(msg, "error"));

socket.on("game_paused", ({ initiatorId, initiatorName, pausesLeft }) => {
  const mine = initiatorId === state.id;
  if (mine) paintPause(pausesLeft);
  $("pause-text").textContent = mine
    ? "You paused the match."
    : `${initiatorName} paused the match.`;
  $("pause-count").classList.add("hidden");
  $("pause-resume").classList.toggle("hidden", !mine);
  $("pause-resume").disabled = false;
  $("pause-wait").classList.toggle("hidden", mine);
  $("pause-wait").textContent = `Waiting for ${initiatorName} to resume.`;
  $("pause-overlay").classList.remove("hidden");
});

$("pause-resume").addEventListener("click", () => {
  $("pause-resume").disabled = true;
  socket.emit("request_resume");
});

socket.on("resume_countdown", (n) => {
  $("pause-text").textContent = "Resuming in";
  $("pause-resume").classList.add("hidden");
  $("pause-wait").classList.add("hidden");
  $("pause-count").textContent = n;
  $("pause-count").classList.remove("hidden");
});

socket.on("game_resumed", () => {
  $("pause-overlay").classList.add("hidden");
  if (state.myTurn) wordInput.focus({ preventScroll: true });
});

/* ---------------------------------------------------------- game over */
socket.on(
  "game_over",
  ({ winnerName, winnerId, reason, quitName, matchId, players }) => {
    state.active = false;
    state.myTurn = false;
    ["pause-overlay", "confirm-modal"].forEach((id) =>
      $(id).classList.add("hidden"),
    );

    const draw = reason === "draw" || !winnerId;
    const won = winnerId === state.id;
    $("result-card").dataset.outcome = draw ? "draw" : won ? "win" : "lose";
    $("result-title").textContent = draw
      ? "It's a draw"
      : won
        ? "You won"
        : "Match over";
    $("result-name").textContent = draw
      ? "Top scores are level"
      : won
        ? "Nicely chained."
        : `${winnerName} wins`;
    $("result-sub").textContent =
      (reason === "quit" && quitName ? `${quitName} left the match. ` : "") +
      `Match ${matchId}`;

    $("final-scoreboard").innerHTML = [...players]
      .sort((a, b) => b.score - a.score)
      .map(
        (p, i) => `
      <li class="rank-row ${p.id === winnerId ? "is-winner" : ""}">
        <span class="rank-n">${i + 1}</span>
        <div class="rank-who"><b>${esc(p.name)}</b><span class="cc">${esc(p.country || "India")}</span></div>
        <div class="rank-stats"><b>${p.score}</b><small>points</small></div>
      </li>`,
      )
      .join("");
    renderRoster(players, null); // final scores stay visible behind the popup
    wordInput.disabled = submitBtn.disabled = true;
    wordInput.value = "";
    wordInput.placeholder = "Match finished";
    $("turn-text").textContent = "Match finished";
    $("turn-banner").classList.remove("is-me");
    setEndedUI(true);
    $("result-overlay").classList.remove("hidden");
    startResultCountdown(RESULT_SECONDS);
  },
);

$("result-back").addEventListener("click", toLobby);
$("lobby-btn").addEventListener("click", toLobby);
// Cross button: close the popup, cancel the auto-return and stay on the scores
$("result-close").addEventListener("click", () => {
  stopResultTimer();
  $("result-overlay").classList.add("hidden");
});

/* -------------------------------------------------------- leaderboard */
const empty = (msg) => `<li class="empty">${msg}</li>`;

socket.on("global_leaderboard_data", ({ players, matches }) => {
  $("rank-list").innerHTML = players.length
    ? players
        .map(
          (p, i) => `
        <li class="rank-row">
          <span class="rank-n">${i + 1}</span>
          <div class="rank-who"><b>${esc(p.name)}</b><span class="cc">${esc(p.country)}</span></div>
          <div class="rank-stats"><b>${p.wins}</b><small>wins</small></div>
          <div class="rank-stats"><b>${p.best}</b><small>best</small></div>
        </li>`,
        )
        .join("")
    : empty("No matches yet. Finish a game to take the first spot.");

  $("history-list").innerHTML = matches.length
    ? matches
        .map((m) => {
          const d = new Date(m.timestamp);
          const when = isNaN(d)
            ? ""
            : d.toLocaleDateString(undefined, {
                day: "numeric",
                month: "short",
                year: "numeric",
              });
          const who = m.players
            .map((p) => `${esc(p.name)} ${p.score}`)
            .join(" &middot; ");
          return `
        <li class="match">
          <div class="match-top"><b>${m.winner ? esc(m.winner.name) + " won" : "Draw"}</b><span class="muted">${when}</span></div>
          <p class="muted">${who}</p>
        </li>`;
        })
        .join("")
    : empty("No matches played yet.");
});

/* -------------------------------------------- ambient letter background */
(function ambientLetters() {
  const canvas = $("bg-canvas");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  let w, h;
  function size() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = window.innerWidth;
    h = window.innerHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  size();
  window.addEventListener("resize", size);

  // Each of the 26 letters appears exactly once, in random order
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
    .split("")
    .sort(() => Math.random() - 0.5)
    .map((char) => ({
      char,
      x: Math.random() * w,
      y: Math.random() * h,
      vx: (Math.random() - 0.5) * 0.35,
      vy: (Math.random() - 0.5) * 0.35,
      size: 20 + Math.random() * 28,
    }));

  function draw() {
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "rgba(236, 238, 248, 0.05)";
    for (const l of letters) {
      l.x += l.vx;
      l.y += l.vy;
      if (l.x < 0 || l.x > w) l.vx *= -1;
      if (l.y < 0 || l.y > h) l.vy *= -1;
      ctx.font = `800 ${l.size}px "Bricolage Grotesque", sans-serif`;
      ctx.fillText(l.char, l.x, l.y);
    }
  }

  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches)
    return draw();
  let raf;
  const loop = () => {
    draw();
    raf = requestAnimationFrame(loop);
  };
  loop();
  document.addEventListener("visibilitychange", () => {
    cancelAnimationFrame(raf);
    if (!document.hidden) loop();
  });
})();
