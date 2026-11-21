// Roomwise Sokoban solver — a push-optimal solver for hallway-and-rooms levels.
//
// Strategy: every level this competition draws is a one-square-wide hallway with
// one to four small rooms off it (3-4 boxes each). A box pushed out of a room
// through its door can never come back, so each room is an independent problem
// and the level's push-optimal count is the sum of its rooms' optima. This
// program therefore cuts the level into rooms, solves each room push-optimally
// with a breadth-first search over pushes, and stitches the room solutions
// together with walks along the hallway.
//
// The room search is a BFS over pushes (the first solved state met is
// push-optimal). States are abstracted by the player's reachable region: two
// states with the same boxes and the same reachable region are the same state,
// whatever square the player stands on. Two prunings keep the search small:
// a box on a "dead" square (one from which no sequence of pulls brings a box
// to a goal) can never be solved, and a box frozen in a 2x2 block of walls
// and boxes off their goals can never move again. Neither pruning removes a
// solvable state, so the optimum stands.
//
// Everything is budgeted by work, never by the clock: the search caps the
// number of states it keeps per room, and every tie is broken by a fixed
// order, so two executions write the same bytes.
//
// Local run: mkdir -p out && MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** The most states one room search keeps before it gives up (work, never the clock). */
const MAX_STATES_PER_ROOM = 400_000;
/** A larger second budget for a room the first budget could not finish. */
const MAX_STATES_RETRY = 2_000_000;

/** The four moves: [dx, dy, step letter, push letter]. */
const DIRS: readonly (readonly [number, number, string, string])[] = [
  [0, -1, 'u', 'U'],
  [0, 1, 'd', 'D'],
  [-1, 0, 'l', 'L'],
  [1, 0, 'r', 'R'],
];

interface Board {
  w: number;
  h: number;
  /** 1 where a wall stands (short rows and the outer frame count as walls). */
  wall: Uint8Array;
  goals: number[];
  boxes: number[];
  player: number;
}

/** Parse an XSB level into a board. */
function parseLevel(text: string): Board {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
    }
  }
  boxes.sort((a, b) => a - b);
  return { w, h, wall, goals, boxes, player };
}

/**
 * The squares a box can stand on and still be pulled back onto some goal.
 * Pulls run backwards from the goals: a square y one step away from a live
 * square x (in direction -d) is live when y is open and the square the
 * player would step onto to make that pull (y - d) is open too.
 */
function liveSquares(board: Board): Uint8Array {
  const { w, wall, goals } = board;
  const live = new Uint8Array(wall.length);
  const queue: number[] = [...goals];
  for (const g of goals) live[g] = 1;
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi]!;
    for (const [dx, dy] of DIRS) {
      const d = dy * w + dx;
      const y = x - d;
      if (y < 0 || y >= wall.length) continue;
      if (!wall[y] && !wall[y - d] && !live[y]) {
        live[y] = 1;
        queue.push(y);
      }
    }
  }
  return live;
}

/**
 * The squares the player can reach from `from`, walking around walls and the
 * squares in `occupied`. Marks them in `seen` with `stamp` and returns the
 * lowest reached square (the region's name). `stack` is scratch space.
 */
function floodRegion(
  board: Board,
  occupied: Uint8Array,
  from: number,
  seen: Int32Array,
  stamp: number,
  stack: Int32Array,
): number {
  const { w, wall } = board;
  let low = from;
  let n = 0;
  stack[n++] = from;
  seen[from] = stamp;
  while (n > 0) {
    const p = stack[--n]!;
    if (p < low) low = p;
    // Up, down, left, right — fixed order, so the region is deterministic.
    if (p - w >= 0 && wall[p - w] === 0 && occupied[p - w] === 0 && seen[p - w] !== stamp) {
      seen[p - w] = stamp;
      stack[n++] = p - w;
    }
    if (p + w < wall.length && wall[p + w] === 0 && occupied[p + w] === 0 && seen[p + w] !== stamp) {
      seen[p + w] = stamp;
      stack[n++] = p + w;
    }
    if (wall[p - 1] === 0 && occupied[p - 1] === 0 && seen[p - 1] !== stamp) {
      seen[p - 1] = stamp;
      stack[n++] = p - 1;
    }
    if (wall[p + 1] === 0 && occupied[p + 1] === 0 && seen[p + 1] !== stamp) {
      seen[p + 1] = stamp;
      stack[n++] = p + 1;
    }
  }
  return low;
}

/**
 * Whether the box just pushed onto `t` sits frozen in a 2x2 block: four
 * squares of walls and boxes, at least one box of them off its goal. A frozen
 * box can never move again, so a state holding one is dead.
 */
function isFrozen(board: Board, occupied: Uint8Array, goal: Uint8Array, t: number): boolean {
  const { w, wall } = board;
  for (const a of [t, t - 1, t - w, t - w - 1]) {
    const b = a + 1;
    const c = a + w;
    const d = c + 1;
    if (a < 0 || d >= wall.length) continue;
    const blocked =
      (wall[a] || occupied[a]) &&
      (wall[b] || occupied[b]) &&
      (wall[c] || occupied[c]) &&
      (wall[d] || occupied[d]);
    if (!blocked) continue;
    if (
      (occupied[a] && !goal[a]) ||
      (occupied[b] && !goal[b]) ||
      (occupied[c] && !goal[c]) ||
      (occupied[d] && !goal[d])
    ) {
      return true;
    }
  }
  return false;
}

/**
 * The shortest walk from `from` to `to` around walls and boxes, as lower-case
 * step letters. Directions are tried up, down, left, right, so ties break the
 * same way on every run. Throws when `to` is out of reach.
 */
function walkTo(board: Board, occupied: Uint8Array, from: number, to: number): string {
  const { w, wall } = board;
  if (from === to) return '';
  const prev = new Int32Array(wall.length).fill(-1);
  const how = new Array<string>(wall.length);
  const queue: number[] = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi]!;
    if (p === to) break;
    for (const [dx, dy, letter] of DIRS) {
      const q = p + dy * w + dx;
      if (wall[q] || occupied[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = letter;
      queue.push(q);
    }
  }
  if (prev[to] === -1) throw new Error('walkTo: the push square is out of reach');
  let s = '';
  for (let p = to; p !== from; p = prev[p]!) s = how[p]! + s;
  return s;
}

/** The square the player ends on after playing `moves` from `from`. */
function endOf(w: number, from: number, moves: string): number {
  let p = from;
  for (const ch of moves.toLowerCase()) {
    p += ch === 'u' ? -w : ch === 'd' ? w : ch === 'l' ? -1 : 1;
  }
  return p;
}

interface PushSolution {
  pushes: number;
  moves: string;
}

/**
 * The push-optimal solution of a board, or null when the search gives up.
 * Breadth-first over pushes: states are visited in order of pushes made, so
 * the first solved state met is optimal. A state's key is its reachable
 * region's lowest square together with its boxes, so the player's exact
 * square never multiplies the state space. Dead squares and frozen blocks
 * prune states no solution can pass through.
 */
function solvePushOptimal(board: Board, maxStates: number): PushSolution | null {
  const { w, wall, goals } = board;
  const size = wall.length;
  const goal = new Uint8Array(size);
  for (const g of goals) goal[g] = 1;
  const live = liveSquares(board);
  if (board.boxes.some((b) => !live[b])) return null;

  const occupied = new Uint8Array(size);
  const seen = new Int32Array(size);
  const mark = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;

  const solved = (boxes: number[]): boolean => boxes.every((b) => goal[b]);
  const keyOf = (boxes: number[], low: number): number => {
    let k = low;
    for (const b of boxes) k = k * size + b;
    return k;
  };

  // The states, in the order found: their boxes, the square the player
  // stands on after the push that made them, their parent, and the push.
  const statesBoxes: number[][] = [board.boxes.slice()];
  const statesPlayer: number[] = [board.player];
  const parent: number[] = [-1];
  const pushFrom: number[] = [-1];
  const pushDir: number[] = [-1];
  const index = new Map<number, number>();
  for (const b of board.boxes) occupied[b] = 1;
  const startLow = floodRegion(board, occupied, board.player, seen, ++stamp, stack);
  for (const b of board.boxes) occupied[b] = 0;
  index.set(keyOf(board.boxes, startLow), 0);

  let found = solved(board.boxes) ? 0 : -1;
  for (let head = 0; found < 0 && head < statesBoxes.length; head++) {
    const boxes = statesBoxes[head]!;
    for (const b of boxes) occupied[b] = 1;
    floodRegion(board, occupied, statesPlayer[head]!, seen, ++stamp, stack);
    const here = stamp;
    for (let bi = 0; bi < boxes.length && found < 0; bi++) {
      const b = boxes[bi]!;
      for (let di = 0; di < 4; di++) {
        const [dx, dy] = DIRS[di]!;
        const d = dy * w + dx;
        const t = b + d;
        if (seen[b - d] !== here || wall[t] || occupied[t] || !live[t]) continue;
        occupied[b] = 0;
        occupied[t] = 1;
        const frozen = isFrozen(board, occupied, goal, t);
        let key = -1;
        let next: number[] | null = null;
        if (!frozen) {
          next = boxes.slice();
          next[bi] = t;
          next.sort((x, y) => x - y);
          key = keyOf(next, floodRegion(board, occupied, b, mark, ++stamp, stack));
        }
        occupied[t] = 0;
        occupied[b] = 1;
        if (frozen || index.has(key)) continue;
        if (statesBoxes.length >= maxStates) {
          for (const x of boxes) occupied[x] = 0;
          return null;
        }
        index.set(key, statesBoxes.length);
        statesBoxes.push(next!);
        statesPlayer.push(b);
        parent.push(head);
        pushFrom.push(b);
        pushDir.push(di);
        if (solved(next!)) {
          found = statesBoxes.length - 1;
          break;
        }
      }
    }
    for (const x of boxes) occupied[x] = 0;
  }
  if (found < 0) return null;

  // Walk the path of states back, then forward again as moves: for each
  // push, walk to the square behind the box, then push it.
  const path: number[] = [];
  for (let s = found; s > 0; s = parent[s]!) path.push(s);
  path.reverse();
  let moves = '';
  let player = board.player;
  let boxes = board.boxes.slice();
  for (const s of path) {
    const nextBoxes = statesBoxes[s]!;
    const from = boxes.find((b) => !nextBoxes.includes(b))!;
    const di = pushDir[s]!;
    const [dx, dy, , pushLetter] = DIRS[di]!;
    const d = dy * w + dx;
    for (const b of boxes) occupied[b] = 1;
    moves += walkTo(board, occupied, player, from - d);
    for (const b of boxes) occupied[b] = 0;
    moves += pushLetter;
    player = from;
    boxes = nextBoxes;
  }
  return { pushes: path.length, moves };
}

interface Room {
  squares: number[];
  boxes: number[];
  goals: number[];
  done: boolean;
}

/**
 * The level's rooms: cut the dead squares of the player's row (the hallway:
 * a box standing there reaches no goal) out of the floor, and each part left
 * that holds a box is a room, with its squares, boxes and goals. Null when
 * some part holds more or fewer boxes than goals, or a box starts in the
 * hallway — then the level is no set of rooms.
 */
function roomsOf(level: Board): Room[] | null {
  const { w, wall, goals, boxes, player } = level;
  const live = liveSquares(level);
  const row = Math.floor(player / w);
  const cut = new Uint8Array(wall.length);
  for (let i = row * w; i < (row + 1) * w; i++) {
    if (!wall[i] && !live[i]) cut[i] = 1;
  }
  if (boxes.some((b) => cut[b])) return null;
  const part = new Int32Array(wall.length).fill(-1);
  const rooms: Room[] = [];
  for (let s = 0; s < wall.length; s++) {
    if (wall[s] || cut[s] || part[s] >= 0) continue;
    const squares = [s];
    part[s] = rooms.length;
    for (let i = 0; i < squares.length; i++) {
      for (const [dx, dy] of DIRS) {
        const q = squares[i]! + dy * w + dx;
        if (!wall[q] && !cut[q] && part[q] < 0) {
          part[q] = rooms.length;
          squares.push(q);
        }
      }
    }
    rooms.push({ squares, boxes: [], goals: [], done: false });
  }
  for (const b of boxes) rooms[part[b]!]!.boxes.push(b);
  for (const g of goals) {
    if (part[g]! >= 0) rooms[part[g]!]!.goals.push(g);
  }
  if (goals.some((g) => part[g]! < 0)) return null;
  if (rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

/**
 * The level solved room by room: each room's push-optimal solution in turn,
 * the other rooms' boxes standing as walls (on their goals once their room
 * is done), the player walking on from where the last room left it. A box
 * never leaves its room, so the rooms' optima add up to the level's.
 * Falls back to a search over the whole level when the level is no set
 * of rooms.
 */
function solveByRooms(level: Board, maxStates: number): PushSolution | null {
  const rooms = roomsOf(level);
  if (rooms === null) return solvePushOptimal(level, maxStates);
  let player = level.player;
  let pushes = 0;
  let moves = '';
  for (const room of rooms) {
    const wall = level.wall.slice();
    for (const other of rooms) {
      if (other === room) continue;
      for (const b of other.done ? other.goals : other.boxes) wall[b] = 1;
    }
    const sub: Board = {
      w: level.w,
      h: level.h,
      wall,
      goals: room.goals.slice().sort((a, b) => a - b),
      boxes: room.boxes.slice().sort((a, b) => a - b),
      player,
    };
    const solved = solvePushOptimal(sub, maxStates);
    if (solved === null) return null;
    pushes += solved.pushes;
    moves += solved.moves;
    player = endOf(level.w, player, solved.moves);
    room.done = true;
  }
  return { pushes, moves };
}

/** The moves that solve a level, or '' when no search in budget solves it. */
function solveLevel(text: string): string {
  const level = parseLevel(text);
  let solved = solveByRooms(level, MAX_STATES_PER_ROOM);
  if (solved === null) solved = solveByRooms(level, MAX_STATES_RETRY);
  if (solved === null) solved = solvePushOptimal(level, MAX_STATES_RETRY);
  return solved === null ? '' : solved.moves;
}

for (const id of readdirSync(INPUT_DIR).sort()) {
  const moves = solveLevel(readFileSync(join(INPUT_DIR, id, 'level.txt'), 'utf8'));
  mkdirSync(join(OUTPUT_DIR, id), { recursive: true });
  writeFileSync(join(OUTPUT_DIR, id, 'solution.txt'), `${moves}\n`);
}
