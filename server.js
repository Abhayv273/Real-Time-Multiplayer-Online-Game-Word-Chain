try {
  require("dotenv").config({ quiet: true }); // reads .env in local development
} catch {
  /* dotenv not installed: hosts such as Render inject env vars themselves */
}
const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const { Server } = require("socket.io");
const wordList = require("an-array-of-english-words");

const dictionary = new Set(wordList);
const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));
app.get("/health", (req, res) => res.status(200).send("OK"));

/* ---------------------------------------------------------------- config */
const TURN_SECONDS = Number(process.env.TURN_SECONDS) || 10;
const COUNTDOWN_SECONDS = Number(process.env.COUNTDOWN_SECONDS) || 3; // start + resume countdowns
const MAX_PLAYERS = 8;
const MAX_PAUSES = 2; // pauses each player may use per match
const START_LIVES = 3;
const MIN_WORD = 3;
const COUNTRIES = [
  "Other",
  "India",
  "USA",
  "UK",
  "China",
  "UAE",
  "Canada",
  "Australia",
  "Germany",
  "Japan",
  "France",
  "Russia",
  "Brazil",
  "Saudi Arabia",
  "South Korea",
  "Singapore",
  "Italy",
  "Spain",
  "South Africa",
  "Mexico",
  "Russia"
];
const startingWords = [
  "start",
  "game",
  "word",
  "chain"
  
];

/* ----------------------------------------------------------- persistence*/

const DATA_FILE = path.join(__dirname, "data", "matches.json");
let matches = [];
let db = null;
let fb = null;

// DISABLE_PERSISTENCE=1 is used by the automated tests so they never write real data
const PERSIST = process.env.DISABLE_PERSISTENCE !== "1";

if (
  PERSIST &&
  process.env.FIREBASE_PROJECT_ID &&
  process.env.FIREBASE_API_KEY &&
  process.env.FIREBASE_APP_ID
) {
  try {
    const { initializeApp } = require("firebase/app");
    fb = require("firebase/firestore");
    db = fb.getFirestore(
      initializeApp({
        apiKey: process.env.FIREBASE_API_KEY,
        authDomain: process.env.FIREBASE_AUTH_DOMAIN,
        projectId: process.env.FIREBASE_PROJECT_ID,
        storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
        messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
        appId: process.env.FIREBASE_APP_ID,
      }),
    );
    console.log("Storage: Firebase Firestore (collection: matches)");
  } catch (err) {
    console.error("Firebase init failed:", err.message);
    db = null;
  }
}
if (!PERSIST) console.log("Storage: disabled (test mode)");
else if (!db)
  console.log(
    "Storage: local file data/matches.json (not durable on most hosts)",
  );

const withTimeout = (promise, ms = 8000) =>
  Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("timed out")), ms),
    ),
  ]);

async function loadMatches() {
  if (!PERSIST) return;
  if (db) {
    try {
      const q = fb.query(
        fb.collection(db, "matches"),
        fb.orderBy("timestamp", "desc"),
        fb.limit(500),
      );
      const snap = await withTimeout(fb.getDocsFromServer(q)); // fails loudly if Firestore is unreachable
      const loaded = snap.docs.map((d) => d.data()).reverse(); // oldest first
      matches = [
        ...loaded,
        ...matches.filter((m) => !loaded.some((l) => l.matchId === m.matchId)),
      ];
      console.log(`Loaded ${loaded.length} matches from Firestore`);
    } catch (err) {
      console.error("Could not load matches from Firestore:", err.message);
    }
    return;
  }
  try {
    matches = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  } catch {
    /* first run, nothing saved yet */
  }
}

async function persistMatch(match) {
  if (!PERSIST) return;
  if (db) {
    try {
      // document id = timestamp + match id, so two matches can never overwrite each other
      await withTimeout(
        fb.setDoc(
          fb.doc(db, "matches", `${match.timestamp}-${match.matchId}`),
          match,
        ),
      );
    } catch (err) {
      console.error("Could not save match to Firestore:", err.message); // match stays in memory
    }
    return;
  }
  try {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(matches.slice(-500)));
  } catch (err) {
    console.error("Could not save matches:", err.message);
  }
}

// Players ranked by wins (then best score); matches listed newest first.
function buildLeaderboard() {
  const board = new Map();
  for (const m of matches) {
    for (const p of m.players) {
      const key = `${p.name.toLowerCase()}|${p.country}`;
      const row = board.get(key) || {
        name: p.name,
        country: p.country,
        wins: 0,
        games: 0,
        best: 0,
      };
      row.games++;
      row.best = Math.max(row.best, p.score);
      if (
        m.winner &&
        m.winner.name === p.name &&
        m.winner.country === p.country
      )
        row.wins++;
      board.set(key, row);
    }
  }
  const players = [...board.values()]
    .sort((a, b) => b.wins - a.wins || b.best - a.best || a.games - b.games)
    .slice(0, 20);
  return { players, matches: matches.slice(-15).reverse() };
}

/* --------------------------------------------------------------- helpers */
const rooms = {};

const clean = (value, max) =>
  String(value ?? "")
    .replace(/[<>&"'`]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
const normCountry = (c) => (COUNTRIES.includes(c) ? c : "Other");

// Same country + same nickname (ignoring case and spaces) is never allowed.
// Checked against every connected player and every waiting join request.
const normName = (n) => n.toLowerCase().replace(/\s+/g, "");
function nameTaken(name, country, exceptId) {
  const n = normName(name);
  for (const g of Object.values(rooms)) {
    if (
      g.players.some(
        (p) =>
          p.id !== exceptId && normName(p.name) === n && p.country === country,
      )
    )
      return true;
    for (const [id, r] of g.pending) {
      if (id !== exceptId && normName(r.name) === n && r.country === country)
        return true;
    }
  }
  return false;
}

function pickWord(exclude) {
  let w;
  do {
    w = startingWords[Math.floor(Math.random() * startingWords.length)];
  } while (w === exclude && startingWords.length > 1);
  return w;
}

function newRoom(hostId) {
  return {
    hostId,
    players: [],
    pending: new Map(), // socketId -> { name, country }
    currentTurn: 0,
    currentWord: "",
    chain: [], // words shown in the chain (resets after a timeout)
    usedWords: new Set(), // every word played this match (rule: no repeats)
    timer: null,
    timeLeft: TURN_SECONDS,
    inProgress: false,
    countdownTimer: null,
    paused: false,
    pausedBy: null,
    resumeTimer: null,
  };
}

function emitPlayers(room) {
  const g = rooms[room];
  if (g)
    io.to(room).emit("update_players", {
      players: g.players,
      hostId: g.hostId,
    });
}

function stopTimers(g) {
  clearInterval(g.timer);
  clearInterval(g.countdownTimer);
  clearInterval(g.resumeTimer);
  g.timer = g.countdownTimer = g.resumeTimer = null;
}

function addPlayer(socket, room, { name, country, isHost }) {
  socket.join(room);
  socket.data.room = room;
  rooms[room].players.push({
    id: socket.id,
    name,
    country,
    lives: START_LIVES,
    score: 0,
    isHost,
    isReady: false,
    pausesLeft: MAX_PAUSES,
  });
}

/* ------------------------------------------------------- ready + countdown */
function cancelCountdown(room) {
  const g = rooms[room];
  if (g && g.countdownTimer) {
    clearInterval(g.countdownTimer);
    g.countdownTimer = null;
    io.to(room).emit("match_countdown_cancelled");
  }
}

function checkReady(room) {
  const g = rooms[room];
  if (!g || g.inProgress) return;
  const ready = g.players.length >= 2 && g.players.every((p) => p.isReady);
  if (!ready) return cancelCountdown(room);
  if (g.countdownTimer) return;

  let count = COUNTDOWN_SECONDS;
  io.to(room).emit("match_countdown", count);
  g.countdownTimer = setInterval(() => {
    count--;
    if (count > 0) return io.to(room).emit("match_countdown", count);
    clearInterval(g.countdownTimer);
    g.countdownTimer = null;
    startGame(room);
  }, 1000);
}

/* ------------------------------------------------------------ game flow */
function startGame(room) {
  const g = rooms[room];
  if (!g) return;
  g.inProgress = true;
  g.paused = false;
  g.pausedBy = null;
  g.currentTurn = 0;
  g.chain = [];
  g.currentWord = pickWord();
  g.usedWords = new Set([g.currentWord]);
  g.players.forEach((p) => {
    p.lives = START_LIVES;
    p.score = 0;
    p.pausesLeft = MAX_PAUSES;
  });
  // anyone still waiting for approval is told the match has begun
  g.pending.forEach((_, id) => {
    const waiting = io.sockets.sockets.get(id);
    if (waiting) {
      waiting.data.pendingRoom = null;
      waiting.emit("join_error", "That match has already started.");
    }
  });
  g.pending.clear();
  io.to(room).emit("game_started");
  startNewTurn(room);
}

function emitTurn(room) {
  const g = rooms[room];
  const active = g.players[g.currentTurn];
  io.to(room).emit("new_turn", {
    activePlayerId: active.id,
    activePlayerName: active.name,
    currentWord: g.currentWord,
    chain: g.chain,
    players: g.players,
    timeLeft: g.timeLeft,
  });
}

function startNewTurn(room) {
  const g = rooms[room];
  if (!g || !g.inProgress) return;
  clearInterval(g.timer);
  if (g.players.filter((p) => p.lives > 0).length <= 1) return endGame(room);
  g.timeLeft = TURN_SECONDS;
  emitTurn(room);
  startTimer(room);
}

function startTimer(room) {
  const g = rooms[room];
  if (!g) return;
  clearInterval(g.timer);
  g.timer = setInterval(() => {
    g.timeLeft--;
    io.to(room).emit("timer_tick", g.timeLeft);
    if (g.timeLeft > 0) return;

    clearInterval(g.timer);
    const player = g.players[g.currentTurn];
    player.lives--;
    io.to(room).emit("turn_timeout", {
      name: player.name,
      lives: player.lives,
    });
    g.currentWord = pickWord(g.currentWord);
    g.usedWords.add(g.currentWord);
    g.chain = [];
    advanceTurn(g);
    startNewTurn(room);
  }, 1000);
}

// Move to the next player who still has lives (bounded, never loops forever).
function advanceTurn(g) {
  const n = g.players.length;
  for (let i = 1; i <= n; i++) {
    const idx = (g.currentTurn + i) % n;
    if (g.players[idx].lives > 0) {
      g.currentTurn = idx;
      return;
    }
  }
}

function endGame(room, reason = "normal", quitName = null) {
  const g = rooms[room];
  if (!g || !g.inProgress) return;
  stopTimers(g);
  g.inProgress = false;
  g.paused = false;
  g.pausedBy = null;

  const maxScore = Math.max(...g.players.map((p) => p.score));
  const top = g.players.filter((p) => p.score === maxScore);
  const isDraw = top.length > 1;
  const winner = isDraw ? null : top[0];
  const matchId = "MATCH-" + Math.floor(100000 + Math.random() * 900000);

  // Skip matches where nobody scored (e.g. everyone left straight away)
  if (maxScore > 0) {
    const record = {
      matchId,
      winner: winner ? { name: winner.name, country: winner.country } : null,
      winnerName: winner ? winner.name : "DRAW",
      maxScore,
      players: g.players.map((p) => ({
        name: p.name,
        country: p.country,
        score: p.score,
      })),
      timestamp: Date.now(),
    };
    matches.push(record);
    persistMatch(record); // runs in the background, never blocks the game
  }

  io.to(room).emit("game_over", {
    winnerName: winner ? winner.name : "DRAW",
    winnerId: winner ? winner.id : null,
    reason: isDraw ? "draw" : reason,
    quitName,
    matchId,
    players: g.players,
  });

  g.players.forEach((p) => (p.isReady = false));
  emitPlayers(room);
}

function handleLeave(socket) {
  // 1) A pending join request that never became a player
  const pendingRoom = socket.data.pendingRoom;
  if (pendingRoom && rooms[pendingRoom]) {
    rooms[pendingRoom].pending.delete(socket.id);
    io.to(rooms[pendingRoom].hostId).emit("request_cancelled", {
      targetId: socket.id,
    });
  }
  socket.data.pendingRoom = null;

  // 2) A player inside a room
  const room = socket.data.room;
  socket.data.room = null;
  const g = rooms[room];
  if (!g) return;
  socket.leave(room);

  const idx = g.players.findIndex((p) => p.id === socket.id);
  if (idx === -1) return;
  const [left] = g.players.splice(idx, 1);

  if (g.players.length === 0) {
    stopTimers(g);
    delete rooms[room];
    return;
  }

  if (g.hostId === socket.id) {
    g.hostId = g.players[0].id;
    g.players[0].isHost = true;
    // new host needs to see requests that are still waiting
    g.pending.forEach((v, id) =>
      io
        .to(g.hostId)
        .emit("join_request_received", {
          targetId: id,
          targetName: v.name,
          targetCountry: v.country,
        }),
    );
  }

  if (!g.inProgress) {
    emitPlayers(room);
    return checkReady(room);
  }

  io.to(room).emit("player_left", { name: left.name });
  if (
    g.players.length <= 1 ||
    g.players.filter((p) => p.lives > 0).length <= 1
  ) {
    return endGame(room, "quit", left.name);
  }

  // keep the turn pointer valid after the splice
  const wasActive = idx === g.currentTurn;
  if (idx < g.currentTurn) g.currentTurn--;
  if (g.currentTurn >= g.players.length) g.currentTurn = 0;

  if (g.paused && g.pausedBy === socket.id) {
    g.pausedBy = g.players[0].id;
    io.to(room).emit("game_paused", {
      initiatorId: g.pausedBy,
      initiatorName: g.players[0].name,
    });
  }

  if (wasActive) {
    if (g.players[g.currentTurn].lives <= 0) advanceTurn(g);
    g.timeLeft = TURN_SECONDS;
    emitTurn(room);
    if (!g.paused) startTimer(room);
  } else {
    emitPlayers(room);
  }
}

/* ---------------------------------------------------------------- sockets */
io.on("connection", (socket) => {
  // A malformed message (null, a number, ...) must never be able to crash the server.
  const on = (event, handler) =>
    socket.on(event, (payload) => {
      try {
        handler(payload && typeof payload === "object" ? payload : {});
      } catch (err) {
        console.error(`Error in "${event}":`, err);
      }
    });

  on("get_global_leaderboard", () => {
    socket.emit("global_leaderboard_data", buildLeaderboard());
  });

  on("create_room", ({ room, name, country } = {}) => {
    room = clean(room, 10).toUpperCase();
    name = clean(name, 15);
    if (!room || !name)
      return socket.emit("join_error", "Enter your nickname and a room ID.");
    if (socket.data.room || socket.data.pendingRoom)
      return socket.emit("join_error", "You are already in a room.");
    if (rooms[room])
      return socket.emit(
        "join_error",
        "That room ID is taken. Pick another one.",
      );

    country = normCountry(country);
    if (nameTaken(name, country, socket.id))
      return socket.emit(
        "join_error",
        `"${name}" is already in use in ${country}. Pick a different nickname or country.`,
      );

    rooms[room] = newRoom(socket.id);
    addPlayer(socket, room, { name, country, isHost: true });
    socket.emit("join_success", room);
    emitPlayers(room);
  });

  on("request_join", ({ room, name, country } = {}) => {
    room = clean(room, 10).toUpperCase();
    name = clean(name, 15);
    country = normCountry(country);
    if (!room || !name)
      return socket.emit(
        "join_error",
        "Enter your nickname and the host's room ID.",
      );
    if (socket.data.room || socket.data.pendingRoom)
      return socket.emit(
        "join_error",
        "You already have an active request or room.",
      );

    const g = rooms[room];
    if (!g) return socket.emit("join_error", "No active room with that ID.");
    if (g.inProgress)
      return socket.emit("join_error", "That match has already started.");
    if (g.players.length >= MAX_PLAYERS)
      return socket.emit("join_error", "That room is full.");

    if (nameTaken(name, country, socket.id))
      return socket.emit(
        "join_error",
        `"${name}" is already in use in ${country}. Pick a different nickname or country.`,
      );

    g.pending.set(socket.id, { name, country });
    socket.data.pendingRoom = room;
    socket.emit(
      "waiting_for_host",
      "Request sent. Waiting for the host to accept.",
    );
    io.to(g.hostId).emit("join_request_received", {
      targetId: socket.id,
      targetName: name,
      targetCountry: country,
    });
  });

  on("cancel_request", () => {
    const g = rooms[socket.data.pendingRoom];
    if (g) {
      g.pending.delete(socket.id);
      io.to(g.hostId).emit("request_cancelled", { targetId: socket.id });
    }
    socket.data.pendingRoom = null;
  });

  on("accept_request", ({ targetId } = {}) => {
    const room = socket.data.room;
    const g = rooms[room];
    if (!g || g.hostId !== socket.id || g.inProgress) return;
    const req = g.pending.get(targetId);
    const target = io.sockets.sockets.get(targetId);
    g.pending.delete(targetId);
    if (!req || !target) return;

    if (g.players.length >= MAX_PLAYERS) {
      target.data.pendingRoom = null;
      return target.emit("join_error", "That room is full.");
    }
    if (nameTaken(req.name, req.country, targetId)) {
      target.data.pendingRoom = null;
      return target.emit(
        "join_error",
        `"${req.name}" was just taken in ${req.country}. Pick a different nickname.`,
      );
    }

    target.data.pendingRoom = null;
    cancelCountdown(room); // a new, not-ready player joined
    addPlayer(target, room, {
      name: req.name,
      country: req.country,
      isHost: false,
    });
    target.emit("join_success", room);
    emitPlayers(room);
  });

  on("reject_request", ({ targetId } = {}) => {
    const g = rooms[socket.data.room];
    if (!g || g.hostId !== socket.id || !g.pending.has(targetId)) return;
    g.pending.delete(targetId);
    const target = io.sockets.sockets.get(targetId);
    if (target) {
      target.data.pendingRoom = null;
      target.emit("join_error", "The host declined your request.");
    }
  });

  on("toggle_ready", () => {
    const room = socket.data.room;
    const g = rooms[room];
    if (!g || g.inProgress) return;
    const player = g.players.find((p) => p.id === socket.id);
    if (!player) return;
    player.isReady = !player.isReady;
    emitPlayers(room);
    checkReady(room);
  });

  on("request_pause", () => {
    const room = socket.data.room;
    const g = rooms[room];
    if (!g || !g.inProgress || g.paused) return;
    const player = g.players.find((p) => p.id === socket.id);
    if (!player) return;
    if (player.pausesLeft <= 0)
      return socket.emit(
        "pause_denied",
        `Pause limit over (${MAX_PAUSES} per match).`,
      );
    player.pausesLeft--;
    g.paused = true;
    g.pausedBy = socket.id;
    clearInterval(g.timer);
    io.to(room).emit("game_paused", {
      initiatorId: socket.id,
      initiatorName: player.name,
      pausesLeft: player.pausesLeft,
    });
  });

  // Only the player who paused can resume. One 3-second countdown, then play continues.
  on("request_resume", () => {
    const room = socket.data.room;
    const g = rooms[room];
    if (!g || !g.paused || g.resumeTimer || g.pausedBy !== socket.id) return;
    let count = COUNTDOWN_SECONDS;
    io.to(room).emit("resume_countdown", count);
    g.resumeTimer = setInterval(() => {
      count--;
      if (count > 0) return io.to(room).emit("resume_countdown", count);
      clearInterval(g.resumeTimer);
      g.resumeTimer = null;
      g.paused = false;
      g.pausedBy = null;
      io.to(room).emit("game_resumed");
      startTimer(room);
    }, 1000);
  });

  on("submit_word", ({ word } = {}) => {
    const room = socket.data.room;
    const g = rooms[room];
    if (!g || !g.inProgress || g.paused) return;
    const active = g.players[g.currentTurn];
    if (!active || active.id !== socket.id) return;
    if (typeof word !== "string") return;

    word = word.trim().toLowerCase();
    if (word.length > 30 || !/^[a-z]+$/.test(word))
      return socket.emit("word_error", "Use letters only.");
    if (word.length < MIN_WORD)
      return socket.emit("word_error", "Use at least 3 letters.");

    const lastLetter = g.currentWord.slice(-1).toLowerCase();
    if (!word.startsWith(lastLetter))
      return socket.emit(
        "word_error",
        `Word must start with "${lastLetter.toUpperCase()}".`,
      );
    if (g.usedWords.has(word))
      return socket.emit("word_error", "That word was already used.");
    if (!dictionary.has(word))
      return socket.emit("word_error", "Not a valid English word.");

    const len = word.length;
    const points = len <= 3 ? 1 : len === 4 ? 2 : 4;
    if (len >= 5 && active.lives < START_LIVES) active.lives++;
    active.score += points;

    g.usedWords.add(word);
    g.chain.push(g.currentWord);
    g.currentWord = word;
    advanceTurn(g);
    startNewTurn(room);
  });

  on("quit_game", () => handleLeave(socket));
  on("disconnect", () => handleLeave(socket));
});

const PORT = process.env.PORT;


server.listen(PORT,() => {
  console.log(`Server running on http://${PORT}`);
  loadMatches();
});
