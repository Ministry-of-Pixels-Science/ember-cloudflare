import { readFileSync } from "node:fs";
import { render } from "@testing-library/react";
import type { ComponentType } from "react";
import { describe, expect, it } from "vitest";
import * as iconoir from "./iconoir";

function pascalCase(name: string) {
  return name.split("-").map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join("");
}

// Iconoir's files in iconoir/, by their names there: `multi-bubble`, and `solid/star` for a solid one.
const files = new Map(
  Object.entries(import.meta.glob<string>(["./iconoir/*.svg", "./iconoir/solid/*.svg"], { query: "?raw", import: "default", eager: true })).map(([path, svg]) => [
    path.slice("./iconoir/".length, -".svg".length),
    svg,
  ]),
);

/** The file iconoir.tsx draws each icon from, by the icon's name: MultiBubble's is `multi-bubble`, and StarSolid's `solid/star`. */
const fileOf = new Map([...files.keys()].map((file) => [pascalCase(file.replace(/^solid\/(.*)$/, "$1-solid")), file]));

/** The files the app serves as they are, from apps/web/public, that draw Iconoir's icons. */
const pages = import.meta.glob<string>(["../../../public/*.html", "../../../public/globe.svg", "../../../public/shortcuts/*.svg"], {
  query: "?raw",
  import: "default",
  eager: true,
});
const page = (path: string) => pages[`../../../public/${path}`]!;

function parseSvg(svg: string): Element {
  return new DOMParser().parseFromString(svg, "image/svg+xml").documentElement;
}

function drawing(svg: Element) {
  const stroke = ["viewBox", "fill", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin"].map((name) => svg.getAttribute(name));
  const shapes = [...svg.children].map((shape) => [shape.tagName, ...[...shape.attributes].map(({ name, value }) => `${name}=${value}`).sort()].join(" "));
  return { stroke, shapes: shapes.sort() };
}

/** The editor's stylesheet, from disk, since Vitest imports every stylesheet empty. */
const editorStyles = readFileSync(`${import.meta.dirname}/../workspace/rich-text-editor.css`, "utf8");

/** The Iconoir files it paints over Lexxy's icons with. */
const editorFiles = [...editorStyles.matchAll(/url\("\.\.\/icons\/iconoir\/([\w/-]+)\.svg"\)/g)].map(([, file]) => file!);

/** The icons each error page draws inline: its picture, then its buttons'. */
const ERROR_PAGES = {
  "404.html": ["web-window-xmark", "arrow-left"],
  "422.html": ["warning-circle", "arrow-left", "refresh-double"],
  "500.html": ["database-warning", "arrow-left"],
};

/** Iconoir's files served as they are: the upgrade page's globe and the installed app's shortcuts. */
const PUBLIC_COPIES = { "globe.svg": "globe", "shortcuts/plus.svg": "plus", "shortcuts/user.svg": "user" };

describe("Ember's icons", () => {
  describe("Iconoir icons", () => {
    it.each(Object.keys(iconoir))("draws %s exactly as Iconoir's file does, named for it", (name) => {
      const file = fileOf.get(name);
      expect(file, `iconoir/ has no file for ${name}: copy it from the pinned release's icons/regular/ or icons/solid/`).toBeDefined();
      const Icon = iconoir[name as keyof typeof iconoir] as ComponentType;
      const { container } = render(<Icon />);
      const svg = container.querySelector("svg")!;
      expect(svg).toHaveClass(`iconoir-${file!.replace(/^solid\/(.*)$/, "$1-solid")}`);
      expect(svg).toHaveAttribute("aria-hidden", "true");
      expect(drawing(svg)).toEqual(drawing(parseSvg(files.get(file!)!)));
    });

    it("names an icon for screen readers only when it's given a label", () => {
      const { container } = render(<iconoir.BellOff aria-label="Notifications are off" />);
      const svg = container.querySelector("svg")!;
      expect(svg).toHaveAttribute("role", "img");
      expect(svg).not.toHaveAttribute("aria-hidden");
      expect(svg).toHaveAccessibleName("Notifications are off");
    });

    it("paints over Lexxy's icons with Iconoir's files", () => {
      expect(editorFiles.length).toBeGreaterThan(0);
      for (const file of editorFiles) expect(files.has(file), `iconoir/ has no ${file}.svg`).toBe(true);
    });

    it.each(Object.entries(ERROR_PAGES))("draws %s with Iconoir's files, sized by the page", (path, icons) => {
      const svgs = [...new DOMParser().parseFromString(page(path), "text/html").querySelectorAll("svg")];
      expect(svgs.map((svg) => drawing(svg))).toEqual(icons.map((file) => drawing(parseSvg(files.get(file)!))));
      for (const svg of svgs) expect([svg.getAttribute("width"), svg.getAttribute("height")]).toEqual([null, null]);
    });

    it.each(Object.entries(PUBLIC_COPIES))("serves %s as Iconoir's file, byte for byte", (path, file) => {
      expect(page(path)).toBe(files.get(file));
    });

    it("bundles only Iconoir's files that Ember draws", () => {
      const drawn = new Set([...Object.keys(iconoir).map((name) => fileOf.get(name)), ...editorFiles, ...Object.values(ERROR_PAGES).flat(), ...Object.values(PUBLIC_COPIES)]);
      expect([...files.keys()].filter((file) => !drawn.has(file))).toEqual([]);
    });
  });

  describe("icon imports", () => {
    const sources = import.meta.glob<string>(["/src/**/*.{ts,tsx}", "!/src/components/icons/**"], { query: "?raw", import: "default", eager: true });
    // The package or any of its subpaths, in either quote style, so dynamic imports and re-exports count too.
    const lucideReact = /["']lucide-react(\/[^"']*)?["']/;

    it.each([
      `import { Trash2 } from "lucide-react";`,
      `import { Trash2 } from 'lucide-react';`,
      `const icons = await import("lucide-react");`,
      `export { DynamicIcon } from "lucide-react/dynamic";`,
    ])("treat %s as importing lucide-react", (code) => {
      expect(code).toMatch(lucideReact);
    });

    it("take every icon from this folder, never straight from lucide-react", () => {
      const strays = Object.entries(sources)
        .filter(([, code]) => lucideReact.test(code))
        .map(([file]) => file);
      expect(strays).toEqual([]);
    });
  });
});
