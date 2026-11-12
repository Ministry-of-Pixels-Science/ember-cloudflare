import { describe, expect, it } from "vitest";
import { ASSISTANT_ID } from "./index";
import {
  AGENT_TEMPLATE,
  AI_SETTINGS,
  CARDS_PROMPT,
  EMBER_TEMPLATE,
  INSTRUCTIONS_PLACE_NEEDED,
  MAX_TEMPLATE_LENGTH,
  ownTemplateFor,
  parseTemplate,
  promptAround,
  TEMPLATE_REFUSED,
  TEMPLATE_TOO_LONG,
  templateRefusal,
  unknownPlaceholder,
  webPromptFor,
  withInstructions,
} from "./prompts";

const NOW = new Date("2026-11-10T12:00:00Z");
const IN_LAUNCH = { community: "Fernwood", roomName: "Launch", inThread: true };

describe("What @ember and the agents are told", () => {
  it("tells an agent who it is before its instructions, and how to write, how to show cards, what it may do on the web, the date and where it's asked after them", () => {
    const prompt = promptAround("0mgk3x2a9b4c5e", "Scout", "Ada Lovelace", IN_LAUNCH, 150, "WEB", NOW);
    expect(prompt.before).toBe(
      `You are Scout, an AI agent in the team chat "Fernwood". People ask you things by mentioning @Scout in a room or a thread, or by writing to you directly.\n\n`,
    );
    const [space, writing, ...rest] = prompt.after.split("\n\n");
    expect(space).toBe("");
    expect(writing).toMatch(/^Write in Markdown\..* Don't begin with your name\.$/);
    // What changes from question to question comes last, as providers cache the start of a prompt.
    expect(rest.join("\n\n")).toBe(
      [
        CARDS_PROMPT,
        "WEB",
        "Today is Tuesday, November 10, 2026, in UTC.",
        `You're asked in a thread in the room "Launch". Its messages follow, oldest first, each after its writer's name. Answer the last one, which Ada Lovelace wrote, in at most about 150 words.`,
      ].join("\n\n"),
    );
    expect(withInstructions(prompt, "Say what's current.")).toBe(`${prompt.before}Say what's current.${prompt.after}`);
    expect(withInstructions(prompt, "")).toBe(`${prompt.before.trimEnd()}\n\n${prompt.after.trimStart()}`);
  });

  it("tells @ember it's the AI assistant, answering as a helpful teammate would, and an agent not saved yet as it's named", () => {
    const ember = promptAround(ASSISTANT_ID, "Ember", "Ada Lovelace", { community: "Fernwood", roomName: null, inThread: false }, 1_500, "WEB", NOW);
    expect(ember.before).toMatch(/^You are Ember, the AI assistant in the team chat "Fernwood"\. People ask you things by mentioning @ember/);
    expect(ember.after).toMatch(/^\n\nWrite in Markdown\./);
    expect(ember.after).toMatch(/\n\nYou're asked in a direct message\. .* Answer the last one, which Ada Lovelace wrote, as a helpful teammate would: plainly, and in at most about 1,500 words\.$/);
    expect(promptAround(null, "Polyglot", "Ada Lovelace", IN_LAUNCH, 150, "WEB", NOW).before).toMatch(/^You are Polyglot, an AI agent/);
  });

  it("teaches how to show cards with an example that's a payload as it should be written: JSON that parses, a status's attachment, and its parts", () => {
    const [, example = ""] = /\n```slack\n([\s\S]*?)\n```$/.exec(CARDS_PROMPT) ?? [];
    const payload = JSON.parse(example) as { attachments: { color: string; blocks: { type: string }[] }[] };
    expect(payload.attachments.map(({ color, blocks }) => [color, blocks.map(({ type }) => type)])).toEqual([["warning", ["header", "section", "section", "context"]]]);
    // It's in every question an answerer's asked, so it's kept to about 1,800 of Claude's tokens.
    expect(CARDS_PROMPT.length).toBeLessThan(5_500);
  });

  it("says what it may do on the web, or who could let it", () => {
    expect(webPromptFor("Ada Lovelace", ["search", "read"], true)).toMatch(/^You can search the web, and read the pages people link to or your searches find, when a question needs/);
    expect(webPromptFor("Ada Lovelace", ["search"], true)).toMatch(/^You can search the web when a question needs what's current/);
    expect(webPromptFor("Ada Lovelace", [], false)).toBe(
      `You can't search the web or open links. When someone asks you to, say so, and that an administrator can turn on Search the web under ${AI_SETTINGS}.`,
    );
    expect(webPromptFor("Ada Lovelace", [], true)).toMatch(/^You can't search the web or open links with the model Ada Lovelace picked for your answers to them\./);
  });
});

describe("What an administrator changes it to", () => {
  it("fills in each placeholder of their template, the instructions where it puts them", () => {
    const template = "{{name}} of {{ community }}, asked in {{where}} by {{asker}}, on {{today}}: {{instructions}} (about {{words}} words; {{web}}) {{cards}}";
    const prompt = promptAround("0mgk3x2a9b4c5e", "Scout", "Ada Lovelace", IN_LAUNCH, 1_500, "WEB", NOW, template);
    expect(withInstructions(prompt, "Be brief.")).toBe(
      `Scout of Fernwood, asked in a thread in the room "Launch" by Ada Lovelace, on Tuesday, November 10, 2026: Be brief. (about 1,500 words; WEB) ${CARDS_PROMPT}`,
    );
  });

  it("leaves what fills a placeholder as it is, though it's written as one, and keeps a placeholder Ember doesn't fill in as it's written", () => {
    const prompt = promptAround("0mgk3x2a9b4c5e", "{{web}}", "Ada Lovelace", IN_LAUNCH, 150, "WEB", NOW, "{{name}} {{nickname}}\n\n{{instructions}}");
    expect(prompt).toEqual({ before: "{{web}} {{nickname}}\n\n", after: "" });
  });

  it("drops the line the instructions would take when there are none, leaving the lines around it as far apart as the further side was", () => {
    const withNone = (template: string) => withInstructions(promptAround(ASSISTANT_ID, "Ember", "Ada Lovelace", IN_LAUNCH, 150, "WEB", NOW, template), "");
    expect(withNone("{{instructions}}\n\nToday is {{today}}.")).toBe("Today is Tuesday, November 10, 2026.");
    expect(withNone("You are {{name}}.\n{{instructions}}\nToday is {{today}}.")).toBe("You are Ember.\nToday is Tuesday, November 10, 2026.");
    expect(withNone("You are {{name}}.\n\n  {{instructions}}\nToday is {{today}}.")).toBe("You are Ember.\n\nToday is Tuesday, November 10, 2026.");
    expect(withNone("You are {{name}}.\n\n{{instructions}}")).toBe("You are Ember.");
  });

  it("leaves the rest of the line as it's written when the instructions' place within it has none", () => {
    const withNone = (template: string) => withInstructions(promptAround(ASSISTANT_ID, "Ember", "Ada Lovelace", IN_LAUNCH, 150, "WEB", NOW, template), "");
    expect(withNone('Answer as {"instructions": "{{instructions}}"} says.')).toBe('Answer as {"instructions": ""} says.');
    expect(withNone("You are {{name}}. Also: {{instructions}}\n\nToday is {{today}}.")).toBe("You are Ember. Also: \n\nToday is Tuesday, November 10, 2026.");
  });

  it("takes a template with the instructions once and only the placeholders Ember fills in, of at most the length it takes", () => {
    expect(templateRefusal(AGENT_TEMPLATE)).toBeNull();
    expect(templateRefusal(EMBER_TEMPLATE)).toBeNull();
    expect(templateRefusal("You are {{name}}.")).toBe(INSTRUCTIONS_PLACE_NEEDED);
    expect(templateRefusal("{{instructions}} and {{ instructions }}")).toBe(INSTRUCTIONS_PLACE_NEEDED);
    expect(templateRefusal("{{instructions}} for {{comunity}}")).toBe(unknownPlaceholder("comunity"));
    expect(unknownPlaceholder("comunity")).toBe(
      "Ember has nothing to fill in for {{comunity}}. It fills in {{name}}, {{community}}, {{where}}, {{asker}}, {{words}}, {{cards}}, {{web}}, {{today}}, {{instructions}}.",
    );
    expect(templateRefusal(`{{instructions}}${" ".repeat(MAX_TEMPLATE_LENGTH)}`)).toBe(TEMPLATE_TOO_LONG);
    // Single braces are anyone's to write.
    expect(templateRefusal('{{instructions}} Answer as {"answer": "…"}.')).toBeNull();
  });

  it("parses one as a page saves it: null or Ember's own for Ember's own, and anything else without the spaces around it", () => {
    expect(parseTemplate(null, null)).toEqual({ template: null });
    expect(parseTemplate(`\n${AGENT_TEMPLATE}  `, "0mgk3x2a9b4c5e")).toEqual({ template: null });
    expect(parseTemplate(EMBER_TEMPLATE, ASSISTANT_ID)).toEqual({ template: null });
    // @ember's own isn't an agent's, nor an agent's @ember's.
    expect(parseTemplate(EMBER_TEMPLATE, null)).toEqual({ template: EMBER_TEMPLATE });
    expect(parseTemplate(AGENT_TEMPLATE, ASSISTANT_ID)).toEqual({ template: AGENT_TEMPLATE });
    expect(parseTemplate(" Be {{name}}.\n\n{{instructions}} ", null)).toEqual({ template: "Be {{name}}.\n\n{{instructions}}" });
    expect(parseTemplate("Be {{name}}.", null)).toEqual({ error: INSTRUCTIONS_PLACE_NEEDED });
    expect(parseTemplate(42, null)).toEqual({ error: TEMPLATE_REFUSED });
    expect(ownTemplateFor(ASSISTANT_ID)).toBe(EMBER_TEMPLATE);
    expect(ownTemplateFor(null)).toBe(AGENT_TEMPLATE);
  });
});
