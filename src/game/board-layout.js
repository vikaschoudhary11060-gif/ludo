/* ============================================================
   Khelbro — board geometry

   A standard 15x15 Ludo cross. Everything here is static data:
   no state, no rules. `rules.js` never imports this — the rules
   work purely on step counts, and this file only exists to turn
   a step count into a grid cell for rendering.

   Grid coordinates are [row, col], 0-indexed from the top-left.
   ============================================================ */

export const SIZE = 15;
export const COLOURS = ['red', 'green', 'yellow', 'blue'];

/* The 52-square shared track, clockwise, starting at red's start square.
   Index 0 is red's start; green, yellow and blue start 13 apart. */
export const RING = [
  [6,1],[6,2],[6,3],[6,4],[6,5],                       //  0- 4  red start, heading right
  [5,6],[4,6],[3,6],[2,6],[1,6],[0,6],                 //  5-10  up the left arm
  [0,7],                                                //    11  top corner
  [0,8],[1,8],[2,8],[3,8],[4,8],[5,8],                 // 12-17  down, green start at 13
  [6,9],[6,10],[6,11],[6,12],[6,13],[6,14],            // 18-23  right along the top arm
  [7,14],                                               //    24  right corner
  [8,14],[8,13],[8,12],[8,11],[8,10],[8,9],            // 25-30  back left, yellow start at 26
  [9,8],[10,8],[11,8],[12,8],[13,8],[14,8],            // 31-36  down the right arm
  [14,7],                                               //    37  bottom corner
  [14,6],[13,6],[12,6],[11,6],[10,6],[9,6],            // 38-43  up, blue start at 39
  [8,5],[8,4],[8,3],[8,2],[8,1],[8,0],                 // 44-49  left along the bottom arm
  [7,0],                                                //    50  left corner
  [6,0],                                                //    51  last square before red's start
];

/* Where each colour joins the ring. */
export const START = { red: 0, green: 13, yellow: 26, blue: 39 };

/* Eight starred squares: the four starts, plus one 8 ahead of each.
   No capture may happen on these. */
export const SAFE = new Set([0, 8, 13, 21, 26, 34, 39, 47]);

/* The six private squares each colour climbs to reach the middle. */
export const HOME_COLUMN = {
  red:    [[7,1],[7,2],[7,3],[7,4],[7,5],[7,6]],
  green:  [[1,7],[2,7],[3,7],[4,7],[5,7],[6,7]],
  yellow: [[7,13],[7,12],[7,11],[7,10],[7,9],[7,8]],
  blue:   [[13,7],[12,7],[11,7],[10,7],[9,7],[8,7]],
};

/* The four resting spots inside each base. */
export const BASE_SLOTS = {
  red:    [[1,1],[1,4],[4,1],[4,4]],
  green:  [[1,10],[1,13],[4,10],[4,13]],
  yellow: [[10,10],[10,13],[13,10],[13,13]],
  blue:   [[10,1],[10,4],[13,1],[13,4]],
};

/* The centre triangle. */
export const HOME_CELL = [7, 7];

/* Which 6x6 block belongs to which colour, for painting the board. */
export const BASE_BLOCK = {
  red:    { row: 0, col: 0 },
  green:  { row: 0, col: 9 },
  yellow: { row: 9, col: 9 },
  blue:   { row: 9, col: 0 },
};

/**
 * Grid cell for a token, given its colour, step count and index in base.
 * steps 0        -> its base slot
 * steps 1..51    -> a square on the shared ring
 * steps 52..56   -> its own home column
 * steps 57       -> the centre
 */
export function cellFor(colour, steps, tokenIndex = 0) {
  if (steps === 0) return BASE_SLOTS[colour][tokenIndex];
  if (steps <= 51) return RING[ringIndex(colour, steps)];
  if (steps < 57)  return HOME_COLUMN[colour][steps - 52];
  return HOME_CELL;
}

/** Ring index for a token that is on the shared track (steps 1..51). */
export function ringIndex(colour, steps) {
  return (START[colour] + steps - 1) % RING.length;
}

/** Which colours sit opposite each other — used for 2-player games. */
export const OPPOSITE = { red: 'yellow', yellow: 'red', green: 'blue', blue: 'green' };
