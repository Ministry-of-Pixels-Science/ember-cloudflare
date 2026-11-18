// The corpus cases where Ember deliberately reads a body differently from Rails, each with its
// reason. corpus.test.ts fails when a listed case starts matching, so the list stays true.

export type Field = "plain_text" | "mentioned" | "filtered" | "presentation";

const TRIX =
  "Action Text turns the `<figure data-trix-attachment>` elements of Trix, Campfire's earlier editor, into attachments as it loads a " +
  "body. Ember never stored a Trix body and its clients send Lexxy's markup, so a figure a client sends stays a figure: its text " +
  "shows, and its JSON is ignored.";

const HEADINGS =
  "Action Text ends a block after `h1` alone, and runs any other heading into what follows it. Ember's formatting row writes `h2` " +
  "and `h3` as well as `h1`, so in its plain text, which search and notifications read, every heading ends a block, as `h1` does.";

/** The cases with a heading other than `h1`, which Rails ran into what follows it. */
const SMALLER_HEADINGS = ["lexxy heading", "malformed headings", ...[
  7, 12, 24, 25, 28, 29, 36, 37, 46, 60, 71, 87, 89, 96, 103, 111, 143, 153, 172, 173, 180, 196, 197, 200, 202, 223, 225, 227, 229,
  230, 237, 243, 254, 260, 263, 277, 287, 291, 307, 309, 313, 317, 353, 368, 369, 370, 385, 390, 395,
].map((n) => `fuzz ${n}`)];

export const KNOWN_DIFFERENCES: Record<string, { fields: readonly Field[]; reason: string }> = {
  ...Object.fromEntries(SMALLER_HEADINGS.map((name) => [name, { fields: ["plain_text"], reason: HEADINGS }])),
  "trix figure attachment": { fields: ["plain_text", "mentioned", "filtered", "presentation"], reason: TRIX },
  "trix figure attachment typed values": { fields: ["plain_text", "filtered", "presentation"], reason: TRIX },
  "trix figure attachment empty json": { fields: ["plain_text", "filtered", "presentation"], reason: TRIX },
  "trix figure attachment broken json": { fields: ["plain_text", "filtered", "presentation"], reason: TRIX },
  "trix figure attachment array json": { fields: ["plain_text", "mentioned", "filtered", "presentation"], reason: TRIX },
  "trix figure attachment json comment": { fields: ["plain_text", "filtered", "presentation"], reason: TRIX },
};
