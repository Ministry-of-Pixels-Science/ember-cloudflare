// Ember's rich text: message bodies as Campfire's Action Text pipeline reads them, checked against what
// Rails made of the bodies in corpus/. This entry point parses with parse5, for the Worker; browsers
// import "@ember/richtext/dom".

import { withParser } from "./body";
import { parseHtml } from "./parse";

export * from "./shared";
export { parseHtml };

export const { prepareBody, plainText, mentionedUsers, userIdsIn, writtenBody, editableBody, autoLink, displayBody, hasPreview } = withParser(parseHtml);
