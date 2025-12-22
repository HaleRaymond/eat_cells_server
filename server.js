// Eat Cell / Agar.io-style multiplayer server
// Node.js + ws with HTTPS/WSS support

const WebSocket = require("ws");

/* ---------------- CONFIG ---------------- */

const PORT = process.env.PORT || 8080;  // Changed to standard HTTPS/WSS port
const TICK_RATE = 20;                 // ticks per second
const WORLD_SIZE = 6000;              // square world, center (0,0)
const BASE_SPEED = 400;               // base movement speed
const SPLIT_SPEED = 400;              // speed of split pieces
const MERGE_TIME = 10;                // seconds before cells can merge
const FOOD_COUNT = 60;
const FOOD_RADIUS = 15;
const VIRUS_COUNT = 20;
const VIRUS_RADIUS = 60;
const MAX_VIRUS_PIECES = 16;
const BOT_COUNT = 20;                 // how many bots to spawn
const TARGET_SPEED_MULTIPLIER = 1.0;  // How fast cells move to target

/* ---------------- STATE ---------------- */

let nextPlayerId = 1;
let nextFoodId = 1;
let nextVirusId = 1;
let nextBotId = 10_000;

const clients = new Map();  // ws -> playerId
const players = new Map();  // id -> player

let foods = [];
let viruses = [];

/* ---------------- HELPERS ---------------- */

const rand = (n) => Math.random() * n;
const randPos = () => (Math.random() - 0.5) * WORLD_SIZE;

function cellAreaFromRadius(r) {
  return Math.PI * r * r;
}
function radiusFromArea(a) {
  return Math.sqrt(a / Math.PI);
}

// Calculate score from total cell area
function calculateScoreFromCells(cells) {
  if (!cells || cells.length === 0) return 0;
  
  let totalArea = 0;
  for (const cell of cells) {
    totalArea += cellAreaFromRadius(cell.radius);
  }
  // Score = total area (adjust division factor if needed)
  return Math.floor(totalArea / 10);  // Divide by 10 to get reasonable scores
}

/* ---------------- QUADTREE ---------------- */

class QuadTree {
  constructor(boundary, capacity = 8, depth = 0, maxDepth = 8) {
    this.boundary = boundary; // {x,y,w,h}
    this.capacity = capacity;
    this.depth = depth;
    this.maxDepth = maxDepth;
    this.points = [];
    this.divided = false;
  }

  subdivide() {
    const { x, y, w, h } = this.boundary;
    const hw = w / 2;
    const hh = h / 2;

    this.nw = new QuadTree(
      { x: x - hw / 2, y: y - hh / 2, w: hw, h: hh },
      this.capacity,
      this.depth + 1,
      this.maxDepth
    );
    this.ne = new QuadTree(
      { x: x + hw / 2, y: y - hh / 2, w: hw, h: hh },
      this.capacity,
      this.depth + 1,
      this.maxDepth
    );
    this.sw = new QuadTree(
      { x: x - hw / 2, y: y + hh / 2, w: hw, h: hh },
      this.capacity,
      this.depth + 1,
      this.maxDepth
    );
    this.se = new QuadTree(
      { x: x + hw / 2, y: y + hh / 2, w: hw, h: hh },
      this.capacity,
      this.depth + 1,
      this.maxDepth
    );
    this.divided = true;
  }

  insert(obj) {
    const { x, y, w, h } = this.boundary;
    if (
      obj.x < x - w / 2 ||
      obj.x > x + w / 2 ||
      obj.y < y - h / 2 ||
      obj.y > y + h / 2
    ) {
      return false;
    }

    if (this.points.length < this.capacity || this.depth >= this.maxDepth) {
      this.points.push(obj);
      return true;
    }

    if (!this.divided) {
      this.subdivide();
    }

    return (
      this.nw.insert(obj) ||
      this.ne.insert(obj) ||
      this.sw.insert(obj) ||
      this.se.insert(obj)
    );
  }

  queryRange(range, found = []) {
    const { x, y, w, h } = this.boundary;
    if (
      range.x - range.w / 2 > x + w / 2 ||
      range.x + range.w / 2 < x - w / 2 ||
      range.y - range.h / 2 > y + h / 2 ||
      range.y + range.h / 2 < y - h / 2
    ) {
      return found;
    }

    for (const p of this.points) {
      if (
        p.x >= range.x - range.w / 2 &&
        p.x <= range.x + range.w / 2 &&
        p.y >= range.y - range.h / 2 &&
        p.y <= range.y + range.h / 2
      ) {
        found.push(p);
      }
    }

    if (this.divided) {
      this.nw.queryRange(range, found);
      this.ne.queryRange(range, found);
      this.sw.queryRange(range, found);
      this.se.queryRange(range, found);
    }

    return found;
  }
}

/* ---------------- WORLD GEN ---------------- */

function createFood(isEjected = false, x = randPos(), y = randPos(), vx = 0, vy = 0) {
  return {
    id: nextFoodId++,
    x,
    y,
    radius: FOOD_RADIUS,
    color: isEjected
      ? [1, 1, 1]
      : [Math.random(), Math.random(), Math.random()],
    vx,
    vy,
    isEjected
  };
}

function createVirus(x = randPos(), y = randPos()) {
  return {
    id: nextVirusId++,
    x,
    y,
    radius: VIRUS_RADIUS
  };
}

function initWorld() {
  foods = [];
  viruses = [];
  for (let i = 0; i < FOOD_COUNT; i++) {
    foods.push(createFood(false));
  }
  for (let i = 0; i < VIRUS_COUNT; i++) {
    viruses.push(createVirus());
  }
}

/* ---------------- PLAYERS / BOTS ---------------- */

function createPlayer(id, skin = -1) {
  return {
    id,
    name: "Player " + id,
    skin,
    color: [Math.random(), Math.random(), Math.random()],
    isBot: false,
    cells: [
      {
        x: randPos(),
        y: randPos(),
        radius: 40,
        vx: 0,
        vy: 0,
        mergeTimer: MERGE_TIME
      }
    ],
    inputDir: [0, 0],
    mouseX: 0,       // Mouse position X (from input message)
    mouseY: 0,       // Mouse position Y (from input message)
    hasMouseTarget: false, 
    // No score property - score will be calculated dynamically from cell size
  };
}

function createBot(id) {
  return {
    id,
    name: "Bot_" + id,
    skin: -1,
    color: [Math.random(), Math.random(), Math.random()],
    isBot: true,
    cells: [
      {
        x: randPos(),
        y: randPos(),
        radius: 40,
        vx: 0,
        vy: 0,
        mergeTimer: MERGE_TIME
      }
    ],
    inputDir: [0, 0],
    // No score property - score will be calculated dynamically from cell size
  };
}

function spawnBots() {
  for (let i = 0; i < BOT_COUNT; i++) {
    const id = nextBotId++;
    const bot = createBot(id);
    players.set(id, bot);
  }
}

/* ---------------- BOT AI ---------------- */

function botThink(bot) {
  if (!bot.cells.length) return;
  const my = bot.cells[0];
  let target = null;
  let flee = null;

  // nearest food
  for (const f of foods) {
    const dx = f.x - my.x;
    const dy = f.y - my.y;
    const dist2 = dx * dx + dy * dy;
    if (!target || dist2 < target.dist2) {
      target = { x: f.x, y: f.y, dist2 };
    }
  }

  // other players
  for (const p of players.values()) {
    if (p === bot) continue;
    for (const c of p.cells) {
      const dx = c.x - my.x;
      const dy = c.y - my.y;
      const dist2 = dx * dx + dy * dy;
      if (c.radius > my.radius * 1.2) {
        if (!flee || dist2 < flee.dist2) {
          flee = { x: c.x, y: c.y, dist2 };
        }
      } else if (c.radius < my.radius * 0.8) {
        if (!target || dist2 < target.dist2) {
          target = { x: c.x, y: c.y, dist2 };
        }
      }
    }
  }

  let vx = 0, vy = 0;
  if (flee) {
    vx = my.x - flee.x;
    vy = my.y - flee.y;
  } else if (target) {
    vx = target.x - my.x;
    vy = target.y - my.y;
  }

  const len = Math.hypot(vx, vy) || 1;
  bot.inputDir = [vx / len, vy / len];

  // occasional split when chasing
  if (target && Math.random() < 0.01) {
    splitPlayer(bot);
  }
}

/* ---------------- MESSAGE HANDLING ---------------- */

function handleMessage(ws, raw) {
  let text;

  if (typeof raw === "string") {
    text = raw;
  } else if (Buffer.isBuffer(raw)) {
    text = raw.toString("utf8");
  } else if (raw instanceof ArrayBuffer) {
    text = Buffer.from(raw).toString("utf8");
  } else {
    return;
  }

  let msg;
  try {
    msg = JSON.parse(text);
  } catch (e) {
    console.log("Bad JSON:", text);
    return;
  }

  const id = clients.get(ws);
  if (!id) return;
  const player = players.get(id);
  if (!player) return;

  switch (msg.type) {
    case "join":
      if (typeof msg.name === "string" && msg.name.length > 0) {
        player.name = msg.name.slice(0, 16);
      }
      if (typeof msg.skin === "number") {
        player.skin = msg.skin;
      }
      if (typeof msg.color === "object") {
        player.color = msg.color;
      }
      break;

    case "input":
      if (Array.isArray(msg.dir) && msg.dir.length === 2) {
        player.inputDir = msg.dir.map((v) => Number(v) || 0);
        
        // Check if this is a mouse position (when dir points to actual position)
        const dirLen = Math.sqrt(player.inputDir[0] ** 2 + player.inputDir[1] ** 2);
        
        if (dirLen > 0) {
          // This could be a mouse position relative to cell center
          if (player.cells.length > 0) {
            const firstCell = player.cells[0];
            const mouseDistance = 100; // Default distance for mouse position
            
            player.mouseX = firstCell.x + player.inputDir[0] * mouseDistance;
            player.mouseY = firstCell.y + player.inputDir[1] * mouseDistance;
            player.hasMouseTarget = true;
          }
        }
      }
      break;

    case "split":
      splitPlayer(player);
      break;

    case "eject":
      ejectMass(player);
      break;

    default:
      break;
  }
}

/* ---------------- GAME LOGIC ---------------- */

function splitPlayer(player) {
  const dir = player.inputDir;
  const dx = dir[0];
  const dy = dir[1];
  const len = Math.hypot(dx, dy) || 1;

  const newCells = [];
  for (const cell of player.cells) {
    if (cell.radius < 10) continue;

    const newRadius = cell.radius * 0.5;
    cell.radius = newRadius;
    cell.mergeTimer = MERGE_TIME;
    
    // Add spacing between split cells
    const spacing = newRadius * 2.5;
    
    // Original cell moves backward slightly
    cell.x -= (dx / len) * spacing * 0.3;
    cell.y -= (dy / len) * spacing * 0.3;

    // New cell moves forward
    newCells.push({
      x: cell.x + (dx / len) * spacing,
      y: cell.y + (dy / len) * spacing,
      radius: newRadius,
      vx: (dx / len) * SPLIT_SPEED,
      vy: (dy / len) * SPLIT_SPEED,
      mergeTimer: MERGE_TIME
    });
  }

  if (newCells.length > 0) {
    player.cells.push(...newCells);
  }
}

function ejectMass(player) {
  const dir = player.inputDir;
  const dx = dir[0];
  const dy = dir[1];
  const len = Math.hypot(dx, dy) || 1;
  if (len === 0) return;

  for (const cell of player.cells) {
    if (cell.radius < 35) continue;

    const area = cellAreaFromRadius(cell.radius);
    const ejectArea = cellAreaFromRadius(FOOD_RADIUS) * 2;
    const newArea = area - ejectArea;
    if (newArea <= 0) continue;

    cell.radius = radiusFromArea(newArea);

    const speed = 900;
    const fx = cell.x + (dx / len) * (cell.radius + FOOD_RADIUS + 2);
    const fy = cell.y + (dy / len) * (cell.radius + FOOD_RADIUS + 2);

    foods.push(
      createFood(
        true,
        fx,
        fy,
        (dx / len) * speed,
        (dy / len) * speed
      )
    );
  }
}

function explodeCellIntoMany(player, cell) {
  const totalArea = cellAreaFromRadius(cell.radius);
  const pieces = Math.min(MAX_VIRUS_PIECES, Math.max(8, Math.floor(totalArea / 2000)));
  const pieceArea = totalArea / pieces;
  const pieceRadius = radiusFromArea(pieceArea);

  // Calculate minimum distance between cells to avoid overlap
  const minDistance = pieceRadius * 3;
  
  const newCells = [];
  for (let i = 0; i < pieces; i++) {
    const angle = (2 * Math.PI * i) / pieces;
    const speed = 200;
    
    // Position cells in a circle with minimum distance
    const distance = minDistance * (0.8 + Math.random() * 0.4);
    const offsetX = Math.cos(angle) * distance;
    const offsetY = Math.sin(angle) * distance;
    
    newCells.push({
      x: cell.x + offsetX,
      y: cell.y + offsetY,
      radius: pieceRadius,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      mergeTimer: MERGE_TIME * 1.2
    });
  }

  player.cells = player.cells.filter((c) => c !== cell);
  player.cells.push(...newCells);
}

function getLeaderboard() {
  return [...players.values()]
    .map(p => ({
      player: p,
      score: calculateScoreFromCells(p.cells)
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 10)
    .map((item) => ({
      name: item.player.name,
      score: Math.round(item.score)
    }));
}

function update(dt) {
  // ---- BOT AI ----
  for (const p of players.values()) {
    if (p.isBot) {
      botThink(p);
    }
  }

  // move ejected food
  for (const f of foods) {
    if (f.isEjected) {
      f.x += f.vx * dt;
      f.y += f.vy * dt;
      f.vx *= 0.85;
      f.vy *= 0.85;
    }
  }

  // move players
  const worldHalf = WORLD_SIZE / 2;
  for (const p of players.values()) {
    for (const c of p.cells) {
      const sizeFactor = Math.sqrt(c.radius / 40);
      const speed = BASE_SPEED / sizeFactor;

      // If player has a mouse target, move all cells toward it
      if (p.hasMouseTarget) {
        const dx = p.mouseX - c.x;
        const dy = p.mouseY - c.y;
        const distToMouse = Math.sqrt(dx * dx + dy * dy);
        
        if (distToMouse > c.radius * 0.5) {
          const normX = dx / distToMouse;
          const normY = dy / distToMouse;
          
          // Move toward mouse position at boosted speed
          c.vx += normX * speed * dt * TARGET_SPEED_MULTIPLIER;
          c.vy += normY * speed * dt * TARGET_SPEED_MULTIPLIER;
        } else {
          // Slow down when near target
          c.vx *= 0.7;
          c.vy *= 0.7;
        }
      } else {
        // Fallback to original movement based on input direction
        const dir = p.inputDir;
        const dx = dir[0];
        const dy = dir[1];
        const dirLen = Math.hypot(dx, dy) || 1;
        
        c.vx += (dx / dirLen) * speed * dt;
        c.vy += (dy / dirLen) * speed * dt;
      }

      c.x += c.vx * dt;
      c.y += c.vy * dt;

      c.vx *= 0.86;
      c.vy *= 0.86;

      c.x = Math.max(-worldHalf + c.radius, Math.min(worldHalf - c.radius, c.x));
      c.y = Math.max(-worldHalf + c.radius, Math.min(worldHalf - c.radius, c.y));

      c.mergeTimer -= dt;
    }
  }

  // build quadtree for foods
  const qtFood = new QuadTree({ x: 0, y: 0, w: WORLD_SIZE, h: WORLD_SIZE }, 10, 0, 8);
  for (const f of foods) {
    qtFood.insert(f);
  }

  // eat food
  for (const p of players.values()) {
    for (const c of p.cells) {
      const range = { x: c.x, y: c.y, w: c.radius * 4, h: c.radius * 4 };
      const nearby = qtFood.queryRange(range);

      for (const f of nearby) {
        if (f.dead) continue;
        const dx = c.x - f.x;
        const dy = c.y - f.y;
        if (dx * dx + dy * dy < (c.radius + f.radius) ** 2) {
          const areaC = cellAreaFromRadius(c.radius);
          const areaF = cellAreaFromRadius(f.radius);
          c.radius = radiusFromArea(areaC + areaF);
          f.dead = true;
        }
      }
    }
  }
  foods = foods.filter((f) => !f.dead);
  while (foods.length < FOOD_COUNT) {
    foods.push(createFood(false));
  }

  // build quadtree for all cells
  const allCells = [];
  for (const p of players.values()) {
    for (const c of p.cells) {
      allCells.push({ player: p, cell: c, x: c.x, y: c.y, radius: c.radius });
    }
  }
  const qtCells = new QuadTree({ x: 0, y: 0, w: WORLD_SIZE, h: WORLD_SIZE }, 8, 0, 8);
  for (const pc of allCells) {
    qtCells.insert(pc);
  }

  // cell vs cell eating
  for (const item of allCells) {
    const pA = item.player;
    const cA = item.cell;
    const range = { x: cA.x, y: cA.y, w: cA.radius * 4, h: cA.radius * 4 };
    const nearby = qtCells.queryRange(range);

    for (const other of nearby) {
      if (other === item) continue;
      const pB = other.player;
      const cB = other.cell;
      if (pA === pB) continue;

      // Only eat if you're at least 15% larger
      if (cA.radius <= cB.radius * 1.15) continue;

      const dx = cA.x - cB.x;
      const dy = cA.y - cB.y;
      const dist2 = dx * dx + dy * dy;
      
      // Eating distance: big cell radius minus 25% of small cell radius
      const minDist = cA.radius - cB.radius * 0.25;
      
      if (dist2 < minDist * minDist) {
        // Calculate areas
        const areaA = cellAreaFromRadius(cA.radius);
        const areaB = cellAreaFromRadius(cB.radius);
        
        // Big cell absorbs small cell's entire area
        const newArea = areaA + areaB;
        cA.radius = radiusFromArea(newArea);
        
        // Remove eaten cell
        const cellIndex = pB.cells.indexOf(cB);
        if (cellIndex !== -1) {
          pB.cells.splice(cellIndex, 1);
        }
      }
    }
  }

  // viruses
  for (const p of players.values()) {
    for (const c of p.cells) {
      for (const v of viruses) {
        const dx = c.x - v.x;
        const dy = c.y - v.y;
        if (dx * dx + dy * dy < (c.radius + v.radius) ** 2) {
          if (c.radius > v.radius * 1.1) {
            explodeCellIntoMany(p, c);
            v.x = randPos();
            v.y = randPos();
          }
        }
      }
    }
  }

  // merging own cells
  for (const p of players.values()) {
    if (p.cells.length <= 1) continue;

    for (let i = 0; i < p.cells.length; i++) {
      for (let j = i + 1; j < p.cells.length; j++) {
        const a = p.cells[i];
        const b = p.cells[j];

        if (a.mergeTimer > 0 || b.mergeTimer > 0) continue;

        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const dist2 = dx * dx + dy * dy;
        if (dist2 < (a.radius + b.radius) ** 2) {
          const areaA = cellAreaFromRadius(a.radius);
          const areaB = cellAreaFromRadius(b.radius);
          a.radius = radiusFromArea(areaA + areaB);
          p.cells.splice(j, 1);
          j--;
        }
      }
    }
  }

  broadcastState();
}

function broadcastState() {
  const payload = {
    type: "state",
    foods,
    viruses,
    players: [...players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      skin: p.skin,
      color: p.color,
      score: calculateScoreFromCells(p.cells),
      cells: p.cells
    })),
    leaderboard: getLeaderboard()
  };

  const json = JSON.stringify(payload);
  for (const [ws] of clients.entries()) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(json);
    }
  }
}

/* ---------------- SERVER SETUP WITH WSS ---------------- */

initWorld();
const wss = new WebSocket.Server({ port: PORT });
function setupWebSocketServer(wss) {
  wss.on("connection", (ws, req) => {    
    const id = nextPlayerId++;
    const player = createPlayer(id);
    players.set(id, player);
    clients.set(ws, id);

    ws.send(
      JSON.stringify({
        type: "welcome",
        id,
        worldSize: WORLD_SIZE
      })
    );

    ws.on("message", (data) => handleMessage(ws, data));

    ws.on("close", (code, reason) => {
      clients.delete(ws);
      players.delete(id);
    });
    
    ws.on("error", (error) => {
      console.log("⚠️ WebSocket error from " + clientIp + ": " + error.message);
    });
  });
  
  wss.on("error", (error) => {
    console.error("❌ WebSocket Server error: " + error.message);
  });
}

function startGameLoop() {
  let lastTime = Date.now() / 1000;
  setInterval(() => {
    const now = Date.now() / 1000;
    const dt = now - lastTime;
    lastTime = now;
    update(dt);
  }, 1000 / TICK_RATE);
}

setupWebSocketServer(wss);
startGameLoop();
