const http = require("http");
const express = require("express");
const cors = require("cors");
const { Server } = require("colyseus");
const { GameRoom } = require("./GameRoom");

const PORT = Number(process.env.PORT || 2567);

const app = express();
app.use(cors());
app.use(express.json());

app.get("/", (_req, res) => {
  res.json({ ok: true, service: "MLN Chase Colyseus Server" });
});

const httpServer = http.createServer(app);
const gameServer = new Server({ server: httpServer });

gameServer.define("game_room", GameRoom);

gameServer.listen(PORT);

console.log(`MLN Chase server is running on ws://localhost:${PORT}`);
