import { describe, expect, it } from "vitest";
import { showsCamerasSmall, stageLayout, tilesLayout } from "./huddle-tiles";

/** How tall `count` tiles come to, laid out as `layout` has them. */
function heightOf(count: number, { columns, width, square }: ReturnType<typeof tilesLayout>): number {
  const rows = Math.ceil(count / columns);
  return rows * (square ? width : (width * 3) / 4) + 12 * (rows - 1);
}

describe("A huddle's tiles", () => {
  it("shows one person as wide as a tile gets, when there's room", () => {
    expect(tilesLayout(1, 1000, 700)).toEqual({ columns: 1, width: 420, square: false });
  });

  it("sits two people side by side, three and four two to a row, and five three to a row", () => {
    expect(tilesLayout(2, 1000, 700)).toEqual({ columns: 2, width: 420, square: false });
    expect(tilesLayout(3, 1000, 700).columns).toBe(2);
    expect(tilesLayout(4, 1000, 700)).toEqual({ columns: 2, width: 420, square: false });
    expect(tilesLayout(5, 1400, 1000).columns).toBe(3);
  });

  it("makes the tiles smaller so that all of them show in a window too short for them at their widest", () => {
    // Two rows, 4 by 3, in 500px: (500 - 12) / 2 high each.
    const layout = tilesLayout(4, 1000, 500);
    expect(layout).toEqual({ columns: 2, width: 325, square: false });
    expect(heightOf(4, layout)).toBeLessThanOrEqual(500);
  });

  it("puts more in a row where that shows them larger, as in a window much wider than it's tall", () => {
    expect(tilesLayout(4, 1200, 260)).toEqual({ columns: 4, width: 291, square: false });
    expect(tilesLayout(2, 300, 800).columns).toBe(1);
  });

  it("fits a full huddle's cameras in a large window", () => {
    const layout = tilesLayout(25, 1500, 900);
    expect(layout.columns).toBeGreaterThanOrEqual(5);
    expect(layout.width).toBeGreaterThanOrEqual(132);
    expect(heightOf(25, layout)).toBeLessThanOrEqual(900);
    expect(layout.columns * layout.width + 12 * (layout.columns - 1)).toBeLessThanOrEqual(1500);
  });

  it("shows square tiles on a phone held upright, one above another while that shows them larger, then two to a row", () => {
    expect(tilesLayout(2, 296, 500)).toEqual({ columns: 1, width: 244, square: true });
    expect(tilesLayout(3, 366, 620)).toEqual({ columns: 1, width: 198, square: true });
    expect(tilesLayout(4, 296, 500)).toEqual({ columns: 2, width: 142, square: true });
  });

  it("keeps tiles to their least width once they'd be narrower, as many in a row as fit, and scrolls", () => {
    const layout = tilesLayout(50, 600, 400);
    expect(layout).toEqual({ columns: 4, width: 141, square: false });
    expect(heightOf(50, layout)).toBeGreaterThan(400);
    // On a phone, two to a row.
    expect(tilesLayout(12, 296, 500)).toEqual({ columns: 2, width: 142, square: true });
  });

  it("keeps a few people's tiles to their least width in a space too short for one, rather than as wide as the space", () => {
    expect(tilesLayout(1, 1000, 90)).toEqual({ columns: 1, width: 132, square: false });
    expect(tilesLayout(3, 1000, 90)).toEqual({ columns: 3, width: 132, square: false });
    // As many as fit in a row stay in one, and one more than fit share out the row.
    expect(tilesLayout(6, 1000, 90)).toEqual({ columns: 6, width: 132, square: false });
    expect(tilesLayout(8, 1000, 90)).toEqual({ columns: 7, width: 132, square: false });
    expect(tilesLayout(8, 1040, 90)).toEqual({ columns: 7, width: 138, square: false });
  });

  it("has a tile's least width even before there's any space to measure, or anyone to show", () => {
    expect(tilesLayout(3, 0, 0)).toEqual({ columns: 1, width: 132, square: true });
    expect(tilesLayout(0, 1000, 700)).toEqual({ columns: 1, width: 132, square: false });
  });
});

describe("A huddle's tiles beside a shared screen, or under it", () => {
  const WIDE = 16 / 9;

  it("puts the tiles in a strip beside the screen in a window wider than it's tall, which leaves the screen the rest of the width", () => {
    // The strip takes 22% of the width, and the space between them 12px.
    expect(stageLayout(3, WIDE, 866, 560)).toEqual({ beside: true, screen: 664, tiles: { columns: 1, width: 190, square: false } });
    // And 220px at most, in a window as wide as they get.
    expect(stageLayout(2, WIDE, 1600, 900)).toEqual({ beside: true, screen: 1368, tiles: { columns: 1, width: 220, square: false } });
  });

  it("makes the strip's tiles narrower so that all of them show, down to a tile's least width, where they scroll", () => {
    const four = stageLayout(4, WIDE, 866, 560);
    expect(four).toEqual({ beside: true, screen: 680, tiles: { columns: 1, width: 174, square: false } });
    expect(heightOf(4, four.tiles)).toBeLessThanOrEqual(560);
    const eight = stageLayout(8, WIDE, 866, 560);
    expect(eight).toEqual({ beside: true, screen: 722, tiles: { columns: 1, width: 132, square: false } });
    expect(heightOf(8, eight.tiles)).toBeGreaterThan(560);
  });

  it("shows the screen as tall as the space has room for under its caption, where that's less than as wide, which leaves the tiles more than a strip", () => {
    // A window shared that's twice as tall as it's wide: the tiles beside it are as wide as they get there.
    expect(stageLayout(3, 0.5, 866, 560)).toEqual({ beside: true, screen: 266, tiles: { columns: 1, width: 220, square: false } });
    // One above another still, where they'd be as large side by side, as beside a screen in a window far wider than it's tall.
    expect(stageLayout(3, WIDE, 2232, 797)).toEqual({ beside: true, screen: 1367, tiles: { columns: 1, width: 220, square: false } });
  });

  it("puts the tiles beside the screen more than one to a row where that shows them larger, as on a phone held on its side", () => {
    // 172px of height under the caption, and 533px of width beside the screen: three side by side.
    expect(stageLayout(3, WIDE, 850, 200)).toEqual({ beside: true, screen: 305, tiles: { columns: 3, width: 169, square: false } });
    // Five in two rows, which all show in the 428px beside the screen.
    const five = stageLayout(5, WIDE, 820, 242);
    expect(five).toEqual({ beside: true, screen: 380, tiles: { columns: 3, width: 134, square: false } });
    expect(heightOf(5, five.tiles)).toBeLessThanOrEqual(242);
    expect(380 + 12 + 3 * 134 + 2 * 12).toBeLessThanOrEqual(820);
    // Nine are as many to a row as fit at a tile's least width, and scroll.
    const nine = stageLayout(9, WIDE, 820, 242);
    expect(nine).toEqual({ beside: true, screen: 380, tiles: { columns: 3, width: 134, square: false } });
    expect(heightOf(9, nine.tiles)).toBeGreaterThan(242);
  });

  it("puts the tiles under the screen where that shows it larger, as on a phone held upright, laid out in what it leaves them", () => {
    // The screen is as wide as the phone, and the tiles have the 444px under it: two to a row, square.
    const phone = stageLayout(4, WIDE, 366, 690);
    expect(phone).toEqual({ beside: false, screen: 366, tiles: { columns: 2, width: 177, square: true } });
    expect(28 + 366 / WIDE + 12 + heightOf(4, phone.tiles)).toBeLessThanOrEqual(690);
    // In a window about as tall as it's wide, too.
    expect(stageLayout(2, WIDE, 700, 650)).toEqual({ beside: false, screen: 643, tiles: { columns: 2, width: 331, square: false } });
  });

  it("keeps a screen with the tiles under it to three fifths of the height, its caption with it, which leaves the tiles the rest", () => {
    // A square one, in a space 690px tall: 414px of it, less the caption's 28px.
    expect(stageLayout(2, 1, 500, 690)).toMatchObject({ beside: false, screen: 386 });
    expect(stageLayout(2, 1, 366, 690)).toEqual({ beside: false, screen: 366, tiles: { columns: 2, width: 177, square: true } });
    // One twice as tall as it's wide would be 193px wide there, and is wider beside the strip.
    expect(stageLayout(2, 0.5, 366, 690)).toEqual({ beside: true, screen: 222, tiles: { columns: 1, width: 132, square: false } });
  });

  it("shows no screen before there's any space to measure", () => {
    expect(stageLayout(3, WIDE, 0, 0)).toEqual({ beside: false, screen: 0, tiles: { columns: 1, width: 132, square: true } });
  });
});

describe("The size a huddle's tiles show a camera in", () => {
  it("is the smaller of the two it's sent in once a tile is no taller than that one, 4 by 3 or square", () => {
    // 4 by 3, a tile 240px wide is 180px tall.
    expect(showsCamerasSmall({ width: 240, square: false })).toBe(true);
    expect(showsCamerasSmall({ width: 241, square: false })).toBe(false);
    expect(showsCamerasSmall({ width: 180, square: true })).toBe(true);
    expect(showsCamerasSmall({ width: 181, square: true })).toBe(false);
  });

  it("is the smaller in the strip beside a shared screen, whose tiles get no taller", () => {
    expect(showsCamerasSmall(stageLayout(2, 16 / 9, 1400, 800).tiles)).toBe(true);
    // And the larger for two people by themselves in the same window.
    expect(showsCamerasSmall(tilesLayout(2, 1400, 800))).toBe(false);
  });
});
