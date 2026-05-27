const { Room } = require("colyseus");
const { Schema, MapSchema, type } = require("@colyseus/schema");
const questions = require("./questions.json");

const MAP_WIDTH = 3000;
const MAP_HEIGHT = 2000;
const PLAYER_RADIUS = 16;
const MAX_PLAYERS = 12;
const ROLE_DURATION = 30;
const TICK_RATE = 20;
const NORMAL_SPEED = 190;
const TIRED_SPEED = 55;
const MANA_MAX = 100;
const MANA_DRAIN_PER_SECOND = 8;
const TAG_DISTANCE = 34;
const RESPAWN_SECONDS = 3;
const QUESTION_COOLDOWN_SECONDS = 3;

const SPAWNS = {
  A: { x: 220, y: 220 },
  B: { x: MAP_WIDTH - 220, y: MAP_HEIGHT - 220 },
};

const OBSTACLES = [
  { id: "o1", x: 520, y: 300, width: 360, height: 80 },
  { id: "o2", x: 1050, y: 520, width: 100, height: 420 },
  { id: "o3", x: 1600, y: 260, width: 520, height: 90 },
  { id: "o4", x: 2220, y: 520, width: 130, height: 520 },
  { id: "o5", x: 360, y: 1120, width: 520, height: 120 },
  { id: "o6", x: 1280, y: 1250, width: 130, height: 460 },
  { id: "o7", x: 1860, y: 1120, width: 540, height: 100 },
  { id: "o8", x: 2480, y: 1450, width: 140, height: 360 },
  { id: "o9", x: 920, y: 1660, width: 480, height: 90 },
];

class Player extends Schema {
  constructor() {
    super();
    this.x = SPAWNS.A.x;
    this.y = SPAWNS.A.y;
    this.name = "Player";
    this.team = "";
    this.role = "";
    this.mana = MANA_MAX;
    this.alive = true;
    this.respawnLeft = 0;
    this.score = 0;
    this.isHost = false;
    this.color = "#4aa3ff";
  }
}

type("number")(Player.prototype, "x");
type("number")(Player.prototype, "y");
type("string")(Player.prototype, "name");
type("string")(Player.prototype, "team");
type("string")(Player.prototype, "role");
type("number")(Player.prototype, "mana");
type("boolean")(Player.prototype, "alive");
type("number")(Player.prototype, "respawnLeft");
type("number")(Player.prototype, "score");
type("boolean")(Player.prototype, "isHost");
type("string")(Player.prototype, "color");

class Obstacle extends Schema {
  constructor(data = {}) {
    super();
    this.x = data.x || 0;
    this.y = data.y || 0;
    this.width = data.width || 0;
    this.height = data.height || 0;
  }
}

type("number")(Obstacle.prototype, "x");
type("number")(Obstacle.prototype, "y");
type("number")(Obstacle.prototype, "width");
type("number")(Obstacle.prototype, "height");

class GameState extends Schema {
  constructor() {
    super();
    this.players = new MapSchema();
    this.obstacles = new MapSchema();
    this.phase = "lobby";
    this.roomCode = "";
    this.hostId = "";
    this.playerCount = 0;
    this.mapWidth = MAP_WIDTH;
    this.mapHeight = MAP_HEIGHT;
    this.teamARole = "Chaser";
    this.teamBRole = "Runner";
    this.roleTimer = ROLE_DURATION;
  }
}

type({ map: Player })(GameState.prototype, "players");
type({ map: Obstacle })(GameState.prototype, "obstacles");
type("string")(GameState.prototype, "phase");
type("string")(GameState.prototype, "roomCode");
type("string")(GameState.prototype, "hostId");
type("number")(GameState.prototype, "playerCount");
type("number")(GameState.prototype, "mapWidth");
type("number")(GameState.prototype, "mapHeight");
type("string")(GameState.prototype, "teamARole");
type("string")(GameState.prototype, "teamBRole");
type("number")(GameState.prototype, "roleTimer");

class GameRoom extends Room {
  onCreate() {
    this.maxClients = MAX_PLAYERS;
    this.roomId = createRoomCode();
    this.setState(new GameState());
    this.state.roomCode = this.roomId;

    this.inputs = new Map();
    this.currentQuestions = new Map();
    this.questionCooldownUntil = new Map();
    this.roleElapsed = 0;

    for (const obstacle of OBSTACLES) {
      this.state.obstacles.set(obstacle.id, new Obstacle(obstacle));
    }

    this.onMessage("input", (client, input) => {
      this.inputs.set(client.sessionId, {
        up: !!input.up,
        down: !!input.down,
        left: !!input.left,
        right: !!input.right,
      });
    });

    this.onMessage("start_game", (client) => {
      if (client.sessionId !== this.state.hostId || this.state.phase !== "lobby") return;
      this.startGame();
    });

    this.onMessage("request_question", (client) => {
      this.sendQuestion(client);
    });

    this.onMessage("answer_question", (client, data) => {
      this.checkAnswer(client, data);
    });

    this.setSimulationInterval((deltaTime) => this.update(deltaTime / 1000), 1000 / TICK_RATE);
  }

  onJoin(client, options) {
    if (this.clients.length > MAX_PLAYERS) {
      client.leave();
      return;
    }

    const isHost = this.state.players.size === 0;
    const player = new Player();
    player.name = cleanName(options.name || "Player");
    player.isHost = isHost;
    player.color = isHost ? "#ffd166" : "#4aa3ff";

    if (isHost) {
      this.state.hostId = client.sessionId;
    }

    this.state.players.set(client.sessionId, player);
    this.state.playerCount = this.state.players.size;
    this.inputs.set(client.sessionId, { up: false, down: false, left: false, right: false });

    client.send("room_info", {
      roomCode: this.state.roomCode,
      isHost,
    });
  }

  onLeave(client) {
    const wasHost = client.sessionId === this.state.hostId;
    this.state.players.delete(client.sessionId);
    this.inputs.delete(client.sessionId);
    this.currentQuestions.delete(client.sessionId);
    this.questionCooldownUntil.delete(client.sessionId);
    this.state.playerCount = this.state.players.size;

    if (wasHost) {
      const next = this.clients[0];
      this.state.hostId = next ? next.sessionId : "";
      if (next) {
        const nextPlayer = this.state.players.get(next.sessionId);
        if (nextPlayer) nextPlayer.isHost = true;
        next.send("room_info", { roomCode: this.state.roomCode, isHost: true });
      }
    }
  }

  startGame() {
    const players = Array.from(this.state.players.entries());

    players.forEach(([sessionId, player], index) => {
      const team = index % 2 === 0 ? "A" : "B";
      const spawn = SPAWNS[team];
      player.team = team;
      player.role = team === "A" ? "Chaser" : "Runner";
      player.color = team === "A" ? "#4aa3ff" : "#ff6b6b";
      player.x = spawn.x + Math.random() * 80 - 40;
      player.y = spawn.y + Math.random() * 80 - 40;
      player.mana = MANA_MAX;
      player.alive = true;
      player.respawnLeft = 0;
      this.inputs.set(sessionId, { up: false, down: false, left: false, right: false });
    });

    this.state.phase = "playing";
    this.state.teamARole = "Chaser";
    this.state.teamBRole = "Runner";
    this.state.roleTimer = ROLE_DURATION;
    this.roleElapsed = 0;
  }

  update(dt) {
    if (this.state.phase !== "playing") return;

    this.roleElapsed += dt;
    this.state.roleTimer = Math.max(0, ROLE_DURATION - this.roleElapsed);
    if (this.roleElapsed >= ROLE_DURATION) {
      this.swapRoles();
    }

    this.state.players.forEach((player, sessionId) => {
      if (!player.alive) {
        player.respawnLeft = Math.max(0, player.respawnLeft - dt);
        if (player.respawnLeft <= 0) this.respawn(player);
        return;
      }

      const input = this.inputs.get(sessionId) || {};
      this.movePlayer(player, input, dt);
    });

    this.handleTags();
  }

  swapRoles() {
    this.roleElapsed = 0;
    this.state.roleTimer = ROLE_DURATION;
    this.state.teamARole = this.state.teamARole === "Chaser" ? "Runner" : "Chaser";
    this.state.teamBRole = this.state.teamBRole === "Chaser" ? "Runner" : "Chaser";

    this.state.players.forEach((player) => {
      player.role = player.team === "A" ? this.state.teamARole : this.state.teamBRole;
    });
  }

  movePlayer(player, input, dt) {
    let dx = 0;
    let dy = 0;
    if (input.up) dy -= 1;
    if (input.down) dy += 1;
    if (input.left) dx -= 1;
    if (input.right) dx += 1;

    if (dx === 0 && dy === 0) return;

    const length = Math.hypot(dx, dy);
    dx /= length;
    dy /= length;

    const speed = player.mana > 0 ? NORMAL_SPEED : TIRED_SPEED;
    const distance = speed * dt;

    if (player.mana > 0) {
      player.mana = Math.max(0, player.mana - MANA_DRAIN_PER_SECOND * dt);
    }

    this.tryMoveAxis(player, dx * distance, 0);
    this.tryMoveAxis(player, 0, dy * distance);
  }

  tryMoveAxis(player, dx, dy) {
    const oldX = player.x;
    const oldY = player.y;
    player.x = clamp(player.x + dx, PLAYER_RADIUS, MAP_WIDTH - PLAYER_RADIUS);
    player.y = clamp(player.y + dy, PLAYER_RADIUS, MAP_HEIGHT - PLAYER_RADIUS);

    for (const obstacle of OBSTACLES) {
      if (circleRectHit(player.x, player.y, PLAYER_RADIUS, obstacle)) {
        player.x = oldX;
        player.y = oldY;
        return;
      }
    }
  }

  handleTags() {
    const players = Array.from(this.state.players.values());
    const chasers = players.filter((player) => player.alive && player.role === "Chaser");
    const runners = players.filter((player) => player.alive && player.role === "Runner");

    for (const chaser of chasers) {
      for (const runner of runners) {
        if (chaser.team === runner.team) continue;
        if (distance(chaser, runner) <= TAG_DISTANCE) {
          runner.alive = false;
          runner.respawnLeft = RESPAWN_SECONDS;
          chaser.score += 1;
        }
      }
    }
  }

  respawn(player) {
    const spawn = SPAWNS[player.team || "A"];
    player.x = spawn.x + Math.random() * 90 - 45;
    player.y = spawn.y + Math.random() * 90 - 45;
    player.alive = true;
    player.respawnLeft = 0;
    player.mana = Math.max(player.mana, 40);
  }

  sendQuestion(client) {
    const now = Date.now();
    const cooldownUntil = this.questionCooldownUntil.get(client.sessionId) || 0;
    if (now < cooldownUntil) {
      client.send("question_cooldown", { seconds: Math.ceil((cooldownUntil - now) / 1000) });
      return;
    }

    const question = questions[Math.floor(Math.random() * questions.length)];
    this.currentQuestions.set(client.sessionId, question.id);
    client.send("question", {
      id: question.id,
      question: question.question,
      options: question.options,
    });
  }

  checkAnswer(client, data) {
    const questionId = this.currentQuestions.get(client.sessionId);
    const question = questions.find((item) => item.id === questionId);
    const player = this.state.players.get(client.sessionId);
    if (!question || !player) return;

    const selectedIndex = Number(data.selectedIndex);
    const correct = selectedIndex === question.correctIndex;
    if (correct) {
      player.mana = Math.min(MANA_MAX, player.mana + question.rewardMana);
    } else {
      this.questionCooldownUntil.set(client.sessionId, Date.now() + QUESTION_COOLDOWN_SECONDS * 1000);
    }

    this.currentQuestions.delete(client.sessionId);
    client.send("question_result", {
      correct,
      rewardMana: correct ? question.rewardMana : 0,
      cooldown: correct ? 0 : QUESTION_COOLDOWN_SECONDS,
    });
  }
}

function createRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 6; i += 1) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function cleanName(name) {
  return String(name).trim().slice(0, 16) || "Player";
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function circleRectHit(cx, cy, radius, rect) {
  const nearestX = clamp(cx, rect.x, rect.x + rect.width);
  const nearestY = clamp(cy, rect.y, rect.y + rect.height);
  return Math.hypot(cx - nearestX, cy - nearestY) < radius;
}

module.exports = { GameRoom };
