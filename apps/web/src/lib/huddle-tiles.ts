// How a huddle's tiles are laid out, one for each person in it, in the space its window leaves them,
// and how they share that space with a screen the huddle shows large.

/** A tile's least width, under which the tiles scroll instead, and its most, about what a camera's picture has to show. */
const NARROWEST = 132;
const WIDEST = 420;
/** The space between tiles. */
export const TILE_GAP = 12;
/** Under this much width, a phone held upright, a tile is square, which shows a face larger there than a camera's shape would. */
const UPRIGHT_PHONE = 560;
/** What the line over a shared screen, which says whose it is, takes of the height, with the space under it. */
export const SCREEN_CAPTION = 28;
/** The shape of a screen before its picture says its own: as wide for its height as most are. */
export const SCREEN_SHAPE = 16 / 9;
/** The most a shared screen gives of the width to the tiles beside it, and the widest those get. */
const STRIP_SHARE = 0.22;
const STRIP_WIDEST = 220;
/** The most a shared screen takes of the height, its caption included, with the tiles under it. */
const SCREEN_SHARE = 0.6;
/** How tall the smaller of the two sizes a camera is sent in is: half as tall as a camera's picture. */
const SMALL_PICTURE = 180;

export interface TilesLayout {
  /** How many tiles go in a row. */
  columns: number;
  /** How wide each is, in whole pixels. */
  width: number;
  /** Whether each is square, rather than 4 by 3. */
  square: boolean;
}

/**
 * How `count` tiles show largest in a space `width` by `height`, all of them at once: how many go in a
 * row, and how wide each is. Where several ways show them as large, the rows are as near as wide as
 * there are rows, so two people sit side by side and four in a square. Once the tiles would be narrower
 * than a tile gets, they keep to that width, as many in a row as fit, and scroll.
 */
export function tilesLayout(count: number, width: number, height: number): TilesLayout {
  const square = width < UPRIGHT_PHONE;
  return { ...largest(count, width, height, { shape: square ? 1 : 4 / 3, widest: WIDEST, tied: Math.ceil(Math.sqrt(count)) }), square };
}

/** Whether tiles laid out so are no taller than the smaller of the sizes a camera is sent in, which is then all they show of one. */
export const showsCamerasSmall = ({ width, square }: Pick<TilesLayout, "width" | "square">) => (square ? width : (width * 3) / 4) <= SMALL_PICTURE;

interface Tiles {
  /** How wide a tile is for its height, and the widest it gets. */
  shape: number;
  widest: number;
  /** How many go in a row where several ways show the tiles as large. */
  tied: number;
}

/** How many of `count` such tiles go in a row, and how wide each is, to show largest in a space `width` by `height`, all of them at once, or else at a tile's least width, scrolling. */
function largest(count: number, width: number, height: number, { shape, widest, tied }: Tiles): Pick<TilesLayout, "columns" | "width"> {
  const across = (columns: number) => (width - TILE_GAP * (columns - 1)) / columns;
  const down = (columns: number) => {
    const rows = Math.ceil(count / columns);
    return ((height - TILE_GAP * (rows - 1)) / rows) * shape;
  };
  let best = { columns: 1, width: 0 };
  const consider = (columns: number) => {
    const fits = Math.min(across(columns), down(columns), widest);
    if (fits > best.width) best = { columns, width: fits };
  };
  // From the number in a row that wins a tie, to more, and then to fewer.
  for (let columns = tied; columns <= count; columns++) consider(columns);
  for (let columns = tied - 1; columns >= 1; columns--) consider(columns);
  if (best.width >= NARROWEST) return { columns: best.columns, width: Math.floor(best.width) };
  const fit = Math.max(1, Math.floor((width + TILE_GAP) / (NARROWEST + TILE_GAP)));
  // A row with room to spare, in a space too short for a tile, keeps its tiles to their least: only a full row shares out what's left of it.
  if (count <= fit) return { columns: Math.max(1, count), width: NARROWEST };
  return { columns: fit, width: Math.max(NARROWEST, Math.floor(across(fit))) };
}

export interface StageLayout {
  /** Whether the tiles are beside the screen, rather than under it. */
  beside: boolean;
  /** How wide the screen shows, in whole pixels, which with its shape says how tall. */
  screen: number;
  /** The tiles, in what the screen leaves them. */
  tiles: TilesLayout;
}

/**
 * How a huddle shows a shared screen large, `shape` times as wide as it's tall, with its `count` tiles,
 * in a space `width` by `height`: the tiles go beside the screen or under it, whichever shows the
 * screen larger, which is beside it in a window wider than it's tall, and under it on a phone held
 * upright. Beside it the screen gives them a strip of the width, a tile wide, and takes what it can
 * of the rest: the tiles are 4 by 3, as large as shows them all in what the screen leaves, which is
 * one to a row unless that's more than the strip, as on a phone held on its side. Under it they're
 * laid out as tiles are by themselves, in what the screen leaves of the height, which is two fifths
 * of it at least. Either way they scroll once they're as narrow as a tile gets.
 */
export function stageLayout(count: number, shape: number, width: number, height: number): StageLayout {
  const beside = Math.min(width - stripTile(count, width, height) - TILE_GAP, (height - SCREEN_CAPTION) * shape);
  const over = Math.min(width, (height * SCREEN_SHARE - SCREEN_CAPTION) * shape);
  const screen = Math.max(0, Math.floor(Math.max(beside, over)));
  if (beside >= over) return { beside: true, screen, tiles: { ...largest(count, width - screen - TILE_GAP, height, { shape: 4 / 3, widest: STRIP_WIDEST, tied: 1 }), square: false } };
  return { beside: false, screen, tiles: tilesLayout(count, width, height - SCREEN_CAPTION - screen / shape - TILE_GAP) };
}

/** How wide the strip is that a screen gives the tiles beside it: as wide as shows `count` of them, one above another, in a space `width` by `height`, between a tile's least width and the strip's most. */
function stripTile(count: number, width: number, height: number): number {
  const rows = Math.max(1, count);
  const showsAll = ((height - TILE_GAP * (rows - 1)) / rows) * (4 / 3);
  return Math.max(NARROWEST, Math.floor(Math.min(showsAll, width * STRIP_SHARE, STRIP_WIDEST)));
}
