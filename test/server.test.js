"use strict";
/*
  Word Chain: automated tests
  Run:  npm test        (needs: npm i -D socket.io-client)

  Each suite starts its own copy of server.js on a random port with
  DISABLE_PERSISTENCE=1, so nothing is ever written to Firebase or data/.
*/
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const path = require("node:path");
const { io } = require("socket.io-client");
const words = require("an-array-of-english-words");

/* ------------------------------------------------------------ helpers */
let nextPort = 4300 + Math.floor(Math.random() * 500);
let seq = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startServer(extraEnv = {}) {
  const port = nextPort++;
  const env = {
    ...process.env,
    PORT: String(port),
    DISABLE_PERSISTENCE: "1",
    COUNTDOWN_SECONDS: "1",
    ...extraEnv,
  };
  const child = spawn(process.execPath, ["server.js"], {
    cwd: path.join(__dirname, ".."),
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("server did not start:\n" + output)),
      10000,
    );
    const onData = (d) => {
      output += d;
      if (output.includes("Server running")) {
        clearTimeout(timer);
        resolve({
          url: `http://localhost:${port}`,
          alive: () => child.exitCode === null,
          logs: () => output,
          stop: () => child.kill(),
        });
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", (d) => (output += d));
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited (${code}):\n${output}`));
    });
  });
}

// Wraps a socket and remembers every event so tests can wait for "the next X".
class Client {
  constructor(url) {
    this.log = [];
    this.waiters = [];
    this.socket = io(url, { forceNew: true, transports: ["websocket"] });
    this.socket.onAny((ev, payload) => {
      this.log.push({ ev, payload, used: false });
      this.flush();
    });
    this.connected = new Promise((r) => this.socket.on("connect", r));
  }
  get id() {
    return this.socket.id;
  }
  emit(ev, payload) {
    this.socket.emit(ev, payload);
  }
  close() {
    this.socket.close();
  }
  flush() {
    for (const w of [...this.waiters]) {
      const item = this.log.find(
        (i) => !i.used && i.ev === w.ev && w.filter(i.payload),
      );
      if (item) {
        item.used = true;
        clearTimeout(w.timer);
        this.waiters.splice(this.waiters.indexOf(w), 1);
        w.resolve(item.payload);
      }
    }
  }
  next(ev, filter = () => true, timeout = 4000) {
    return new Promise((resolve, reject) => {
      const w = { ev, filter, resolve };
      w.timer = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(w), 1);
        reject(new Error(`timed out waiting for "${ev}"`));
      }, timeout);
      this.waiters.push(w);
      this.flush();
    });
  }
  // true if the event does NOT arrive within `ms`
  async never(ev, ms = 500, filter = () => true) {
    try {
      await this.next(ev, filter, ms);
      return false;
    } catch {
      return true;
    }
  }
  last(ev) {
    return [...this.log].reverse().find((i) => i.ev === ev)?.payload;
  }
  count(ev) {
    return this.log.filter((i) => i.ev === ev).length;
  }
}

async function connect(url) {
  const c = new Client(url);
  await c.connected;
  return c;
}
const keyOf = (name) => `key_${name}_0123456789abcdef`; // like the browser's private key (16+ chars)
async function createRoom(host, room, name, country = "India") {
  host.emit("create_room", { room, name, country, key: keyOf(name) });
  await host.next("join_success");
}
async function joinRoom(host, guest, room, name, country = "India") {
  guest.emit("request_join", { room, name, country, key: keyOf(name) });
  const req = await host.next(
    "join_request_received",
    (r) => r.targetName === name,
  );
  host.emit("accept_request", { targetId: req.targetId });
  await guest.next("join_success");
}
// Creates a room with `n` players, readies everyone and returns the first turn.
async function startMatch(url, n) {
  const id = ++seq;
  const room = `R${id}`;
  const clients = [];
  const names = Array.from({ length: n }, (_, i) => `P${id}_${i}`);
  for (let i = 0; i < n; i++) clients.push(await connect(url));
  await createRoom(clients[0], room, names[0]);
  for (let i = 1; i < n; i++)
    await joinRoom(clients[0], clients[i], room, names[i]);
  clients.forEach((c) => c.emit("toggle_ready"));
  await Promise.all(
    clients.map((c) => c.next("game_started", () => true, 6000)),
  );
  const turn = await clients[0].next("new_turn");
  return {
    room,
    clients,
    names,
    turn,
    byId: (pid) => clients.find((c) => c.id === pid),
  };
}

const used = new Set();
// find a real dictionary word that starts with `letter`, has the wanted length, and was not used
function findWord(letter, test = () => true) {
  const w = words.find(
    (x) => x[0] === letter && x.length >= 3 && test(x) && !used.has(x),
  );
  assert.ok(w, `no dictionary word found for "${letter}"`);
  used.add(w);
  return w;
}
const lastLetter = (w) => w[w.length - 1];

/* ================================================================ suites */
describe("rooms and joining", () => {
  let srv;
  const clients = [];
  const conn = async () => {
    const c = await connect(srv.url);
    clients.push(c);
    return c;
  };
  before(async () => {
    srv = await startServer();
  });
  after(() => {
    clients.forEach((c) => c.close());
    srv.stop();
  });

  test("health endpoint answers OK", async () => {
    const res = await fetch(`${srv.url}/health`);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "OK");
  });

  test("creating a room needs a nickname and a room ID", async () => {
    const c = await conn();
    c.emit("create_room", { room: "", name: "", country: "India" });
    assert.match(await c.next("join_error"), /nickname and a room ID/i);
  });

  test("a room ID can only be used once", async () => {
    const id = ++seq;
    const a = await conn(),
      b = await conn();
    await createRoom(a, `DUP${id}`, `Host${id}`);
    b.emit("create_room", {
      room: `dup${id}`,
      name: `Other${id}`,
      country: "India",
    });
    assert.match(await b.next("join_error"), /room ID is taken/i);
  });

  test("same nickname + same country is blocked everywhere (ignores case and spaces)", async () => {
    const id = ++seq;
    const a = await conn(),
      b = await conn();
    await createRoom(a, `U${id}A`, `Nm${id}`);
    b.emit("create_room", {
      room: `U${id}B`,
      name: `nm ${id}`,
      country: "India",
    });
    assert.match(await b.next("join_error"), /already in use in India/i);
  });

  test("same nickname is fine in a different country", async () => {
    const id = ++seq;
    const a = await conn(),
      b = await conn();
    await createRoom(a, `C${id}A`, `Same${id}`, "India");
    b.emit("create_room", {
      room: `C${id}B`,
      name: `Same${id}`,
      country: "USA",
    });
    assert.equal(await b.next("join_success"), `C${id}B`);
  });

  test("a waiting request reserves its nickname", async () => {
    const id = ++seq;
    const host = await conn(),
      g1 = await conn(),
      g2 = await conn();
    await createRoom(host, `W${id}`, `Host${id}`);
    g1.emit("request_join", {
      room: `W${id}`,
      name: `Dup${id}`,
      country: "India",
    });
    await g1.next("waiting_for_host");
    g2.emit("request_join", {
      room: `W${id}`,
      name: `dup${id}`,
      country: "India",
    });
    assert.match(await g2.next("join_error"), /already in use/i);
  });

  test("host can decline, and a guest can cancel their own request", async () => {
    const id = ++seq;
    const host = await conn(),
      g1 = await conn(),
      g2 = await conn();
    await createRoom(host, `D${id}`, `Host${id}`);
    g1.emit("request_join", {
      room: `D${id}`,
      name: `Guest1_${id}`,
      country: "India",
    });
    const r1 = await host.next("join_request_received");
    host.emit("reject_request", { targetId: r1.targetId });
    assert.match(await g1.next("join_error"), /declined/i);

    g2.emit("request_join", {
      room: `D${id}`,
      name: `Guest2_${id}`,
      country: "India",
    });
    const r2 = await host.next(
      "join_request_received",
      (r) => r.targetName === `Guest2_${id}`,
    );
    g2.emit("cancel_request");
    assert.equal((await host.next("request_cancelled")).targetId, r2.targetId);
  });

  test("a room holds at most 8 players", async () => {
    const id = ++seq;
    const host = await conn();
    await createRoom(host, `F${id}`, `Host${id}`);
    for (let i = 1; i < 8; i++)
      await joinRoom(host, await conn(), `F${id}`, `Pl${id}_${i}`);
    const ninth = await conn();
    ninth.emit("request_join", {
      room: `F${id}`,
      name: `Late${id}`,
      country: "India",
    });
    assert.match(await ninth.next("join_error"), /full/i);
  });

  test("when the host leaves, the next player becomes host", async () => {
    const id = ++seq;
    const host = await conn(),
      guest = await conn();
    await createRoom(host, `H${id}`, `Host${id}`);
    await joinRoom(host, guest, `H${id}`, `Guest${id}`);
    host.emit("quit_game");
    const update = await guest.next(
      "update_players",
      (u) => u.players.length === 1,
    );
    assert.equal(update.hostId, guest.id);
    assert.equal(update.players[0].isHost, true);
  });

  test("nicknames are cleaned of HTML characters", async () => {
    const id = ++seq;
    const c = await conn();
    c.emit("create_room", {
      room: `X${id}`,
      name: `<b>hi${id}</b>`,
      country: "India",
    });
    await c.next("join_success");
    const { players } = await c.next("update_players");
    assert.doesNotMatch(players[0].name, /[<>&"'`]/);
  });
});

describe("ready check and countdown", () => {
  let srv;
  const clients = [];
  before(async () => {
    srv = await startServer();
  });
  after(() => {
    clients.forEach((c) => c.close());
    srv.stop();
  });

  test("one ready player alone does not start a match", async () => {
    const id = ++seq;
    const a = await connect(srv.url);
    clients.push(a);
    await createRoom(a, `S${id}`, `Solo${id}`);
    a.emit("toggle_ready");
    assert.ok(await a.never("match_countdown", 600));
  });

  test("un-readying during the countdown cancels the start", async () => {
    const id = ++seq;
    const a = await connect(srv.url),
      b = await connect(srv.url);
    clients.push(a, b);
    await createRoom(a, `K${id}`, `A${id}`);
    await joinRoom(a, b, `K${id}`, `B${id}`);
    a.emit("toggle_ready");
    b.emit("toggle_ready");
    await a.next("match_countdown");
    b.emit("toggle_ready"); // un-ready straight away
    await a.next("match_countdown_cancelled");
    assert.ok(await a.never("game_started", 1500));
  });

  test("a match starts when everyone is ready, and everyone gets 3 lives and 2 pauses", async () => {
    const { clients: cs, turn } = await startMatch(srv.url, 3);
    clients.push(...cs);
    assert.equal(turn.players.length, 3);
    assert.ok(
      turn.players.every(
        (p) => p.lives === 3 && p.score === 0 && p.pausesLeft === 2,
      ),
    );
    assert.match(turn.currentWord, /^[a-z]+$/);
  });

  test("nobody can join once the match has started", async () => {
    const { clients: cs, room } = await startMatch(srv.url, 2);
    const late = await connect(srv.url);
    clients.push(...cs, late);
    late.emit("request_join", { room, name: `Late${++seq}`, country: "India" });
    assert.match(await late.next("join_error"), /already started/i);
  });
});

describe("gameplay rules", () => {
  let srv;
  const clients = [];
  before(async () => {
    srv = await startServer();
  });
  after(() => {
    clients.forEach((c) => c.close());
    srv.stop();
  });

  test("only the active player can answer, and every invalid word gets a clear error", async () => {
    const { clients: cs, turn, byId } = await startMatch(srv.url, 2);
    clients.push(...cs);
    const active = byId(turn.activePlayerId);
    const other = cs.find((c) => c !== active);
    const need = lastLetter(turn.currentWord);

    other.emit("submit_word", { word: findWord(need, (w) => w.length === 5) });
    assert.ok(await active.never("new_turn", 400), "turn must not change");

    active.emit("submit_word", { word: need + "x" });
    assert.match(await active.next("word_error"), /at least 3/i);
    const wrongStart = need === "b" ? "cat" : "bat";
    active.emit("submit_word", { word: wrongStart });
    assert.match(await active.next("word_error"), /must start with/i);
    active.emit("submit_word", { word: `${need}1x` });
    assert.match(await active.next("word_error"), /letters only/i);
    active.emit("submit_word", { word: `${need}qzxvjk` });
    assert.match(await active.next("word_error"), /not a valid english word/i);
    active.emit("submit_word", { word: "hello world" });
    assert.match(await active.next("word_error"), /letters only/i);
  });

  test("scoring: 1-3 letters = 1, 4 = 2, 5+ = 4; the turn passes on and the chain grows", async () => {
    const { clients: cs, turn, byId } = await startMatch(srv.url, 2);
    clients.push(...cs);
    const first = byId(turn.activePlayerId);
    const second = cs.find((c) => c !== first);

    let need = lastLetter(turn.currentWord);
    const w1 = findWord(need, (w) => w.length === 3);
    first.emit("submit_word", { word: w1 });
    let t = await second.next("new_turn", (x) => x.currentWord === w1);
    assert.equal(t.players.find((p) => p.id === first.id).score, 1);
    assert.equal(t.activePlayerId, second.id);
    assert.ok(t.chain.includes(turn.currentWord));

    need = lastLetter(w1);
    const w2 = findWord(need, (w) => w.length === 4);
    second.emit("submit_word", { word: w2 });
    t = await first.next("new_turn", (x) => x.currentWord === w2);
    assert.equal(t.players.find((p) => p.id === second.id).score, 2);

    need = lastLetter(w2);
    const w3 = findWord(need, (w) => w.length >= 5);
    first.emit("submit_word", { word: w3 });
    t = await second.next("new_turn", (x) => x.currentWord === w3);
    assert.equal(t.players.find((p) => p.id === first.id).score, 5); // 1 + 4
  });

  test("a word cannot be used twice in the same match", async () => {
    const { clients: cs, turn, byId } = await startMatch(srv.url, 2);
    clients.push(...cs);
    const first = byId(turn.activePlayerId);
    const second = cs.find((c) => c !== first);
    const need = lastLetter(turn.currentWord);
    // a word that starts and ends with the same letter can be answered with itself
    const loop = words.find(
      (w) => w[0] === need && lastLetter(w) === need && w.length >= 4,
    );
    assert.ok(loop, "needs a start==end word");
    first.emit("submit_word", { word: loop });
    await second.next("new_turn", (x) => x.currentWord === loop);
    second.emit("submit_word", { word: loop });
    assert.match(await second.next("word_error"), /already used/i);
  });
});

describe("timer, lives and draws", () => {
  let srv;
  const clients = [];
  before(async () => {
    srv = await startServer({ TURN_SECONDS: "2" });
  });
  after(() => {
    clients.forEach((c) => c.close());
    srv.stop();
  });

  test("running out of time costs a life, restarts the chain and passes the turn", async () => {
    const { clients: cs, turn } = await startMatch(srv.url, 2);
    clients.push(...cs);
    const timeout = await cs[0].next("turn_timeout", () => true, 5000);
    const loser = turn.players.find((p) => p.name === timeout.name);
    assert.ok(loser);
    const t = await cs[0].next(
      "new_turn",
      (x) => x.activePlayerId !== turn.activePlayerId,
      3000,
    );
    assert.equal(t.players.find((p) => p.id === loser.id).lives, 2);
    assert.deepEqual(t.chain, []);
  });

  test("a 5+ letter word wins back a lost life", async () => {
    const { clients: cs, turn, byId } = await startMatch(srv.url, 2);
    clients.push(...cs);
    const x = byId(turn.activePlayerId); // will time out
    const y = cs.find((c) => c !== x);
    await x.next("turn_timeout", () => true, 5000);
    let t = await y.next("new_turn", (n) => n.activePlayerId === y.id, 3000);
    const wy = findWord(lastLetter(t.currentWord), (w) => w.length === 3);
    y.emit("submit_word", { word: wy });
    t = await x.next(
      "new_turn",
      (n) => n.activePlayerId === x.id && n.currentWord === wy,
      3000,
    );
    assert.equal(t.players.find((p) => p.id === x.id).lives, 2);
    const wx = findWord(lastLetter(wy), (w) => w.length >= 5);
    x.emit("submit_word", { word: wx });
    t = await y.next("new_turn", (n) => n.currentWord === wx, 3000);
    assert.equal(
      t.players.find((p) => p.id === x.id).lives,
      3,
      "life should be restored",
    );
  });

  test("equal top scores end the match as a draw", async () => {
    const { clients: cs } = await startMatch(srv.url, 2);
    clients.push(...cs);
    const over = await cs[0].next("game_over", () => true, 20000);
    assert.equal(over.reason, "draw");
    assert.equal(over.winnerName, "DRAW");
    assert.equal(over.winnerId, null);
  });
});

describe("pause and resume", () => {
  let srv;
  const clients = [];
  before(async () => {
    srv = await startServer();
  });
  after(() => {
    clients.forEach((c) => c.close());
    srv.stop();
  });

  test("each player can pause twice; the third try is denied; limits are per player", async () => {
    const { clients: cs } = await startMatch(srv.url, 2);
    clients.push(...cs);
    const [a, b] = cs;

    a.emit("request_pause");
    assert.equal((await b.next("game_paused")).pausesLeft, 1);
    a.emit("request_resume");
    await a.next("game_resumed");

    a.emit("request_pause");
    assert.equal((await b.next("game_paused")).pausesLeft, 0);
    a.emit("request_resume");
    await a.next("game_resumed", () => true, 4000);

    a.emit("request_pause");
    assert.match(await a.next("pause_denied"), /limit over/i);

    b.emit("request_pause"); // B still has both of its pauses
    assert.equal(
      (await a.next("game_paused", (p) => p.initiatorId === b.id)).pausesLeft,
      1,
    );
  });

  test("only the player who paused can resume, and the clock is frozen meanwhile", async () => {
    const { clients: cs } = await startMatch(srv.url, 2);
    clients.push(...cs);
    const [a, b] = cs;
    a.emit("request_pause");
    await b.next("game_paused");
    await sleep(250);
    const ticksBefore = b.count("timer_tick");
    b.emit("request_resume"); // not the initiator
    assert.ok(await b.never("resume_countdown", 400));
    await sleep(1200);
    assert.equal(b.count("timer_tick"), ticksBefore, "no ticks while paused");
    a.emit("request_resume");
    assert.ok(await b.next("resume_countdown"));
    await b.next("game_resumed", () => true, 4000);
    await b.next("timer_tick", () => true, 2500); // clock runs again
  });

  test("if the player who paused leaves, another player gets to resume", async () => {
    const { clients: cs } = await startMatch(srv.url, 3);
    clients.push(...cs);
    const [a, b, c] = cs;
    a.emit("request_pause");
    await b.next("game_paused");
    a.emit("quit_game");
    const p = await b.next("game_paused", (x) => x.initiatorId !== a.id);
    const resumer = [b, c].find((x) => x.id === p.initiatorId);
    resumer.emit("request_resume");
    await b.next("game_resumed", () => true, 4000);
  });
});

describe("leaving and finishing a match", () => {
  let srv;
  const clients = [];
  before(async () => {
    srv = await startServer();
  });
  after(() => {
    clients.forEach((c) => c.close());
    srv.stop();
  });

  test("when everyone else quits, the last player wins", async () => {
    const { clients: cs } = await startMatch(srv.url, 2);
    clients.push(...cs);
    const [a, b] = cs;
    b.emit("quit_game");
    const over = await a.next("game_over");
    assert.equal(over.reason, "quit");
    assert.equal(over.winnerId, a.id);
    assert.ok(over.quitName);
  });

  test("if the active player leaves a 3-player match, play continues without a crash", async () => {
    const { clients: cs, turn, byId } = await startMatch(srv.url, 3);
    clients.push(...cs);
    const active = byId(turn.activePlayerId);
    const stayers = cs.filter((c) => c !== active);
    active.emit("quit_game");
    const t = await stayers[0].next(
      "new_turn",
      (x) => x.players.length === 2,
      3000,
    );
    assert.notEqual(t.activePlayerId, active.id);
    assert.ok(srv.alive());
  });

  test("a finished match counts for the public top-players list, but its details stay private", async () => {
    const { clients: cs, turn, byId } = await startMatch(srv.url, 2);
    clients.push(...cs);
    const winner = byId(turn.activePlayerId);
    const loser = cs.find((c) => c !== winner);
    const w = findWord(lastLetter(turn.currentWord), (x) => x.length >= 5);
    winner.emit("submit_word", { word: w });
    await loser.next("new_turn", (x) => x.currentWord === w);
    loser.emit("quit_game");
    const over = await winner.next("game_over");
    winner.emit("get_global_leaderboard");
    const board = await winner.next("global_leaderboard_data");
    assert.equal(
      board.matches,
      undefined,
      "the public payload must not contain any match history",
    );
    const name = over.players.find((p) => p.id === winner.id).name;
    assert.ok(board.players.some((p) => p.name === name && p.wins >= 1));
  });
});

describe("private match history", () => {
  let srv;
  const clients = [];
  before(async () => {
    srv = await startServer();
  });
  after(() => {
    clients.forEach((c) => c.close());
    srv.stop();
  });

  async function playScoredMatch() {
    const m = await startMatch(srv.url, 2);
    clients.push(...m.clients);
    const winner = m.byId(m.turn.activePlayerId);
    const loser = m.clients.find((c) => c !== winner);
    const w = findWord(lastLetter(m.turn.currentWord), (x) => x.length >= 5);
    winner.emit("submit_word", { word: w });
    await loser.next("new_turn", (x) => x.currentWord === w);
    loser.emit("quit_game");
    const over = await winner.next("game_over");
    const key = (c) => keyOf(m.names[m.clients.indexOf(c)]);
    return { winner, loser, over, key };
  }
  const history = async (client, key) => {
    client.emit("get_my_history", { key });
    return (await client.next("my_history_data")).matches;
  };

  test("only the players of a match can see it; everyone else gets an empty list", async () => {
    const { winner, loser, over, key } = await playScoredMatch();

    const won = await history(winner, key(winner));
    assert.equal(won[0]?.matchId, over.matchId);
    assert.equal(won[0].result, "won");
    assert.equal(won[0].players.filter((p) => p.isYou).length, 1);

    const lost = await history(loser, key(loser)); // the player who quit keeps the match too
    assert.equal(lost[0]?.matchId, over.matchId);
    assert.equal(lost[0].result, "lost");
    assert.ok(lost[0].players.some((p) => p.isYou && p.left));

    const stranger = await connect(srv.url);
    clients.push(stranger);
    assert.deepEqual(await history(stranger, keyOf(`Stranger${++seq}`)), []);
    assert.deepEqual(await history(stranger, undefined), []);
    assert.deepEqual(await history(stranger, "short"), []);
  });

  test("history never leaks key hashes or other internals", async () => {
    const { winner, key } = await playScoredMatch();
    const text = JSON.stringify(await history(winner, key(winner)));
    assert.doesNotMatch(text, /"h"\s*:/);
    assert.doesNotMatch(text, /[0-9a-f]{64}/);
  });

  test("a new player starts with an empty history", async () => {
    const fresh = await connect(srv.url);
    clients.push(fresh);
    assert.deepEqual(await history(fresh, keyOf(`Fresh${++seq}`)), []);
  });
});

describe("robustness", () => {
  let srv;
  const clients = [];
  before(async () => {
    srv = await startServer();
  });
  after(() => {
    clients.forEach((c) => c.close());
    srv.stop();
  });

  test("malformed messages (null, numbers, text, arrays) never crash the server", async () => {
    const c = await connect(srv.url);
    clients.push(c);
    const events = [
      "create_room",
      "request_join",
      "cancel_request",
      "accept_request",
      "reject_request",
      "toggle_ready",
      "request_pause",
      "request_resume",
      "submit_word",
      "quit_game",
      "get_global_leaderboard",
    ];
    for (const ev of events)
      for (const bad of [
        null,
        42,
        "text",
        [],
        {},
        { word: 5 },
        { room: {}, name: [] },
      ])
        c.emit(ev, bad);
    await sleep(500);
    assert.ok(
      srv.alive(),
      "server process must still be running\n" + srv.logs(),
    );
    assert.equal((await fetch(`${srv.url}/health`)).status, 200);
    const id = ++seq; // and it still works normally afterwards
    await createRoom(c, `OK${id}`, `Fine${id}`);
  });

  test("players outside a room cannot control one", async () => {
    const { clients: cs, room } = await startMatch(srv.url, 2);
    const stranger = await connect(srv.url);
    clients.push(...cs, stranger);
    stranger.emit("request_pause", { room });
    stranger.emit("submit_word", { room, word: "hello" });
    stranger.emit("toggle_ready", room);
    stranger.emit("accept_request", { room, targetId: stranger.id });
    assert.ok(await cs[0].never("game_paused", 500));
    assert.ok(srv.alive());
  });
});
