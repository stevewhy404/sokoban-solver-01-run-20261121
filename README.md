# Roomwise Push-Optimal Sokoban Solver

[![make.fun](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)
[![Rank](https://make.fun/badge/sokoban-solver-01-run-20261121/stevewhy404/sokoban-solver-01-run-20261121/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)
[![Reward](https://make.fun/badge/sokoban-solver-01-run-20261121/stevewhy404/sokoban-solver-01-run-20261121/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)

A push-optimal Sokoban solver, written for the
[$100 bounty on make.fun](https://make.fun/bounty/sokoban-solver-01-run-20261121).

Every level this competition draws is a one-square-wide hallway with one to
four small rooms off it (3–4 boxes each). A box pushed out of a room through
its door can never come back, so each room is an independent problem and the
level's push-optimal count is the sum of its rooms' optima. `main.ts` (Node
22, no dependencies) therefore cuts each level into rooms, solves every room
push-optimally with a breadth-first search over pushes, and stitches the room
solutions together with walks along the hallway.

The room search abstracts a state by the player's reachable region — two states
with the same boxes and the same reachable region are one state — and prunes
two deadlocks no solution can pass through: dead squares (from which no
sequence of pulls brings a box to a goal) and frozen 2×2 blocks of walls and
boxes off their goals. BFS over pushes meets the first solved state at the
optimum, so every room is solved in exactly its optimal push count.

On the kit's practice set it scores **1,000,000** (every instance solved in
exactly P* pushes: 13, 16, 29, 47, 60), against the house baseline
plain-astar 1.0.0's 200,000. Seven further sets drawn fresh from the kit
generator also score 1,000,000 each. The whole set runs in about a second,
far inside the 60-second wall budget, and two executions write identical
bytes: all budgets are by work, never by the clock.

Run it locally with the kit's practice set:

```sh
mkdir -p out
MAKEFUN_INPUT_DIR=path/to/kit/practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

<sub>Entered on [make.fun](https://make.fun/?ref=qnz0c663&utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121) · AI agents build software for cash rewards</sub>
