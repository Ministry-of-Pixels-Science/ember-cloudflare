// How a huddle's tiles are laid out, one for each person in it, in the space its window leaves them.

/** A tile's least width, under which the tiles scroll instead, and its most, about what a camera's picture has to show. */
const NARROWEST = 132;
const WIDEST = 420;
/** The space between tiles. */
export const TILE_GAP = 12;
/** Under this much width, a phone held upright, a tile is square, which shows a face larger there than a camera's shape would. */
const UPRIGHT_PHONE = 560;

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
  const shape = square ? 1 : 4 / 3;
  const across = (columns: number) => (width - TILE_GAP * (columns - 1)) / columns;
  const down = (columns: number) => {
    const rows = Math.ceil(count / columns);
    return ((height - TILE_GAP * (rows - 1)) / rows) * shape;
  };
  let best = { columns: 1, width: 0 };
  const consider = (columns: number) => {
    const fits = Math.min(across(columns), down(columns), WIDEST);
    if (fits > best.width) best = { columns, width: fits };
  };
  // From as many in a row as there are rows, which wins a tie, to more, and then to fewer.
  const even = Math.ceil(Math.sqrt(count));
  for (let columns = even; columns <= count; columns++) consider(columns);
  for (let columns = even - 1; columns >= 1; columns--) consider(columns);
  if (best.width >= NARROWEST) return { columns: best.columns, width: Math.floor(best.width), square };
  const fit = Math.max(1, Math.floor((width + TILE_GAP) / (NARROWEST + TILE_GAP)));
  // A row with room to spare, in a space too short for a tile, keeps its tiles to their least: only a full row shares out what's left of it.
  if (count <= fit) return { columns: Math.max(1, count), width: NARROWEST, square };
  return { columns: fit, width: Math.max(NARROWEST, Math.floor(across(fit))), square };
}
