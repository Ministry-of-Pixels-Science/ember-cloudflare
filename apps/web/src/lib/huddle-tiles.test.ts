import { describe, expect, it } from "vitest";
import { tilesLayout } from "./huddle-tiles";

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

  it("has a tile's least width even before there's any space to measure, or anyone to show", () => {
    expect(tilesLayout(3, 0, 0)).toEqual({ columns: 1, width: 132, square: true });
    expect(tilesLayout(0, 1000, 700).columns).toBe(1);
  });
});
