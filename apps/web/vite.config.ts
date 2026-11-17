import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";
import { APP_VERSION_PATH, assetsInHtml, type AppVersion } from "./src/lib/updates.ts";

/**
 * Serves each icon a room can have as an SVG of its own, which `RoomIcon` draws: Lucide's at
 * /lucide/icons/<name>.svg and Iconoir's at /iconoir/icons/<variant>/<name>.svg, as `roomIconUrl` has
 * them, writing them from the picker's catalog in src/components/icons/picker/ (its README says more).
 */
function roomIcons(): Plugin {
  type Catalog = { icons: Array<{ name: string; svg: string }> };
  /** Where icon `name` is served, without the leading slash. */
  const fileOf = (name: string) => (name.startsWith("iconoir:") ? `iconoir/icons/${name.split(":").slice(1).join("/")}.svg` : `lucide/icons/${name}.svg`);
  let files: Map<string, string> | undefined;
  /** Each icon's drawing, by where it's served. */
  const icons = () => {
    if (files) return files;
    const catalog = JSON.parse(readFileSync(path.resolve(import.meta.dirname, "src/components/icons/picker/catalog.json"), "utf8")) as Catalog;
    return (files = new Map(catalog.icons.map(({ name, svg }) => [fileOf(name), svg])));
  };
  return {
    name: "ember-room-icons",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const svg = icons().get(request.url?.slice(1) ?? "");
        if (!svg) return next();
        response.setHeader("Content-Type", "image/svg+xml");
        response.end(svg);
      });
    },
    // Written beside the bundle rather than emitted with it, which would list all 3,540 in the build's output.
    writeBundle({ dir }) {
      for (const [file, svg] of icons()) {
        mkdirSync(path.dirname(path.join(dir!, file)), { recursive: true });
        writeFileSync(path.join(dir!, file), svg);
      }
    },
  };
}

/**
 * Serves Emojibase's English emoji data, which the composer's emoji picker reads (emoji-panel.tsx), at
 * /emojibase/en/, from the emojibase-data package: from Ember itself, since the page's Content-Security-Policy
 * keeps it from asking a CDN, and a CDN would hear from everyone who opens the picker.
 */
function emojiData(): Plugin {
  const FILES = ["en/data.json", "en/messages.json"];
  const read = (file: string) => readFileSync(createRequire(import.meta.url).resolve(`emojibase-data/${file}`));
  return {
    name: "ember-emoji-data",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const file = FILES.find((name) => request.url?.split("?")[0] === `/emojibase/${name}`);
        if (!file) return next();
        response.setHeader("Content-Type", "application/json");
        response.end(read(file));
      });
    },
    writeBundle({ dir }) {
      for (const file of FILES) {
        const to = path.join(dir!, "emojibase", file);
        mkdirSync(path.dirname(to), { recursive: true });
        writeFileSync(to, read(file));
      }
    },
  };
}

/**
 * Fails the build when the app's script imports another besides Rolldown's runtime: one more for the page to
 * load before the app can run. Rolldown leaves what the main chunk shares with the pages few visits need and
 * the editor in a chunk of its own when the main chunk imports a module it doesn't use that those pages do, as
 * @ember/protocol's index did bots.ts until the bot pages imported it from @ember/protocol/bots.
 */
function oneAppScript(): Plugin {
  const app = path.resolve(import.meta.dirname, "index.html");
  return {
    name: "ember-one-app-script",
    apply: "build",
    generateBundle(_, bundle) {
      const script = Object.values(bundle).find((chunk) => chunk.type === "chunk" && chunk.facadeModuleId === app);
      const more = script?.type === "chunk" ? script.imports.filter((name) => bundle[name]?.name !== "rolldown-runtime") : [];
      if (more.length > 0) this.error(`The app's script imports ${more.join(", ")} besides Rolldown's runtime, so the page loads one more before the app can run (see oneAppScript).`);
    },
  };
}

/**
 * Writes app-version.json beside the bundle, naming the scripts and stylesheets the built page loads,
 * which a page left open asks for to tell whether Ember has been updated since it loaded
 * (src/lib/updates.ts).
 */
function appVersion(): Plugin {
  return {
    name: "ember-app-version",
    apply: "build",
    writeBundle({ dir }, bundle) {
      const page = bundle["index.html"];
      const html = page?.type !== "asset" ? "" : typeof page.source === "string" ? page.source : new TextDecoder().decode(page.source);
      const version: AppVersion = { assets: assetsInHtml(html) };
      if (version.assets.length === 0) this.error("The built page loads none of the app's scripts, so app-version.json can't name them (see appVersion).");
      writeFileSync(path.join(dir!, APP_VERSION_PATH), `${JSON.stringify(version)}\n`);
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), roomIcons(), emojiData(), oneAppScript(), appVersion()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
      // Lexxy's package exports only its scripts, so its stylesheets are reached by their path.
      "@37signals/lexxy/stylesheets": path.resolve(import.meta.dirname, "node_modules/@37signals/lexxy/dist/stylesheets"),
    },
  },
  build: {
    // Browsers without modulepreload still load everything; they just don't fetch it early.
    modulePreload: { polyfill: false },
    // The app's script, about 650 kB with React DOM, and the editor's, about 600 kB of Lexxy, which loads
    // with the first composer, are each one chunk on purpose (see oneAppScript), so only a chunk that grows
    // past them is worth a warning.
    chunkSizeWarningLimit: 700,
  },
  server: {
    // `wrangler dev` serves the API, room sockets, web app manifest, QR codes, Turnstile's check page, avatars,
    // files, the logo and bots' webhooks on 8787.
    proxy: {
      "/api": { target: "http://localhost:8787", ws: true },
      "/webmanifest": "http://localhost:8787",
      "/qr_code": "http://localhost:8787",
      "/account/turnstile_check": "http://localhost:8787",
      // Only avatars, so people's pages under /users, once they're built, stay the app's.
      "^/users/[^/]+/avatar": "http://localhost:8787",
      // Rooms' files and their previews, and the workspace's logo.
      "^/(files|previews)/": "http://localhost:8787",
      "^/account/logo(\\.[^/.?]+)?(\\?|$)": "http://localhost:8787",
      // Bots' webhooks, at the addresses the Chat bots page shows here.
      "^/rooms/[^/]+/[^/]+/(messages|slack)(\\?|$)": "http://localhost:8787",
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test-setup.ts"],
  },
});
