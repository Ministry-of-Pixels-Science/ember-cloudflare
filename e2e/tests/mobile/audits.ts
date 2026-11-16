import type { Page } from "@playwright/test";
import type { SafeArea } from "./fixtures";

/**
 * Layout audits that run inside the page, over everything currently on screen. Each returns
 * plain-language problems, empty when the screen is fine, so a failure says what to fix.
 */
export interface AuditResults {
  /** Content cut off where scrolling can't reach it, or pushed past the sides of the screen. */
  overflow: string[];
  /** Controls a fingertip can miss: smaller than 44×44px, or partly covered or cut off. */
  touchTargets: string[];
  /** Text, controls or media under the notch, the rounded corners or the home indicator. */
  safeArea: string[];
  /** Text fields under 16px, which make iOS Safari zoom the page when they're focused. */
  zoomingFields: string[];
}

/** Waits for transitions such as the drawer sliding in, so the audits see where things land. */
export async function settle(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const finite = document.getAnimations().filter((animation) => animation.effect?.getTiming().iterations !== Infinity);
    await Promise.all(finite.map((animation) => animation.finished.catch(() => undefined)));
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
}

export async function auditScreen(page: Page, safeArea: SafeArea, options: { denseTargets?: string[] } = {}): Promise<AuditResults> {
  await settle(page);
  return page.evaluate(runAudits, { insets: safeArea, denseTargets: options.denseTargets ?? [] });
}

/** Serialized into the page, so it must not refer to anything outside itself. */
function runAudits({ insets, denseTargets }: { insets: SafeArea; denseTargets: string[] }): AuditResults {
  const TOLERANCE = 1;
  // Apple's Human Interface Guidelines and WCAG 2.5.5 ask for 44×44px; WCAG 2.5.8's floor is 24px.
  const TARGET = 44;
  const DENSE_TARGET = 24;
  const INTERACTIVE = [
    "a[href]",
    "button",
    "input:not([type=hidden])",
    "select",
    "textarea",
    "summary",
    "[contenteditable=true]",
    "[tabindex]:not([tabindex='-1'])",
    ...["button", "link", "menuitem", "menuitemradio", "menuitemcheckbox", "option", "tab", "switch", "checkbox", "radio"].map((role) => `[role=${role}]`),
  ].join(",");
  const TEXT_FIELDS = "input:not([type=hidden],[type=checkbox],[type=radio],[type=button],[type=submit],[type=reset],[type=range],[type=color],[type=file]), textarea, select, [contenteditable=true]";
  const MEDIA = "img, svg, video, canvas, iframe";

  type Box = { left: number; top: number; right: number; bottom: number };
  type Point = [x: number, y: number];

  const describe = (node: Node): string => {
    const element = node instanceof Element ? node : node.parentElement!;
    const text = (node.textContent ?? "").trim().replace(/\s+/g, " ");
    const name = element.getAttribute("aria-label") ?? element.getAttribute("title") ?? text;
    const role = element.getAttribute("role");
    const what = node instanceof Element ? `<${element.tagName.toLowerCase()}${role ? ` role=${role}` : ""}>` : `text in <${element.tagName.toLowerCase()}>`;
    return name ? `${what} "${name.length > 40 ? `${name.slice(0, 39)}…` : name}"` : what;
  };
  const px = (value: number) => `${Math.round(value)}px`;

  const isShown = (element: Element) => element.checkVisibility({ opacityProperty: true, visibilityProperty: true });
  // Screen-reader-only text is clipped to 1px on purpose.
  const isVisuallyHidden = (element: Element) => {
    for (let node: Element | null = element; node; node = node.parentElement) {
      const rect = node.getBoundingClientRect();
      if (rect.width <= 1 && rect.height <= 1 && getComputedStyle(node).overflow !== "visible") return true;
    }
    return false;
  };
  const isDisabled = (element: Element) => element.matches(":disabled, [aria-disabled=true], [data-disabled]");

  /** Elements whose overflow clips `element`, nearest first, stopping where `position: fixed` escapes them. */
  const clippers = (element: Element, includeSelf: boolean) => {
    const result: Element[] = [];
    let node: Element | null = includeSelf ? element : element.parentElement;
    // An element fixed in place, such as a modal dialog, escapes them all.
    let escaped = !includeSelf && getComputedStyle(element).position === "fixed";
    for (; node && node !== document.documentElement; node = node.parentElement) {
      if (escaped) break;
      const style = getComputedStyle(node);
      if (style.overflowX !== "visible" || style.overflowY !== "visible") result.push(node);
      if (style.position === "fixed") escaped = true;
    }
    return result;
  };

  /** The containers that can scroll `element` along an axis right now, from the nearest out: its ancestors, and the page. */
  const scrollersOf = (element: Element, axis: "x" | "y"): Element[] => {
    const [overflow, size, client] = axis === "y" ? (["overflowY", "scrollHeight", "clientHeight"] as const) : (["overflowX", "scrollWidth", "clientWidth"] as const);
    const scrollers: Element[] = [];
    for (let node = element; node.parentElement; ) {
      // The page's scroll doesn't move anything fixed in place, such as a drawer.
      if (getComputedStyle(node).position === "fixed") break;
      node = node.parentElement;
      const scrolls = node[size] > node[client] + TOLERANCE;
      // A modal dialog stops the page scrolling by hiding the body's overflow.
      if (node === document.scrollingElement) {
        if (scrolls && getComputedStyle(document.body)[overflow] !== "hidden") scrollers.push(node);
        break;
      }
      if (scrolls && /auto|scroll/.test(getComputedStyle(node)[overflow])) scrollers.push(node);
    }
    return scrollers;
  };

  /** The nearest container that can scroll `element` along an axis right now: an ancestor, or the page. */
  const scrollerOf = (element: Element, axis: "x" | "y"): Element | null => scrollersOf(element, axis)[0] ?? null;

  /** The part of `box` that is painted, after clipping by overflow containers and the screen. */
  const paintedPart = (box: Box, clipping: Element[]): Box | null => {
    let { left, top, right, bottom } = box;
    for (const clipper of clipping) {
      const style = getComputedStyle(clipper);
      const rect = clipper.getBoundingClientRect();
      if (style.overflowX !== "visible") [left, right] = [Math.max(left, rect.left), Math.min(right, rect.right)];
      if (style.overflowY !== "visible") [top, bottom] = [Math.max(top, rect.top), Math.min(bottom, rect.bottom)];
    }
    [left, top, right, bottom] = [Math.max(left, 0), Math.max(top, 0), Math.min(right, innerWidth), Math.min(bottom, innerHeight)];
    return right - left > 0.5 && bottom - top > 0.5 ? { left, top, right, bottom } : null;
  };

  const textNodes = () => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => (node.nodeValue?.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
    });
    const nodes: Text[] = [];
    while (walker.nextNode()) nodes.push(walker.currentNode as Text);
    return nodes.filter((node) => isShown(node.parentElement!) && !isVisuallyHidden(node.parentElement!));
  };
  const lineBoxes = (node: Text) => {
    const range = document.createRange();
    range.selectNodeContents(node);
    return [...range.getClientRects()].filter((rect) => rect.width > 0.5 && rect.height > 0.5);
  };
  const elements = (selector: string) =>
    [...document.body.querySelectorAll(selector)].filter((element) => isShown(element) && !isVisuallyHidden(element));

  // Overflow: every box and line of text must fit inside the containers that clip it and the
  // screen, unless a container between them scrolls that way or truncates text on purpose, with an
  // ellipsis or a line clamp. The page may scroll down to something, but never sideways.
  const overflow: string[] = [];
  /** Why `box` is cut off for good, or null when all of it shows or can be scrolled into view. */
  const cutOff = (node: Node, box: Box, clipping: Element[]): string | null => {
    let [checkX, checkY] = [true, true];
    for (const clipper of clipping) {
      const style = getComputedStyle(clipper);
      if (style.textOverflow === "ellipsis" || /auto|scroll/.test(style.overflowX)) checkX = false;
      if (style.webkitLineClamp !== "none" || /auto|scroll/.test(style.overflowY)) checkY = false;
      const rect = clipper.getBoundingClientRect();
      if (checkX && style.overflowX !== "visible" && (box.left < rect.left - TOLERANCE || box.right > rect.right + TOLERANCE)) {
        return `${describe(node)} spans ${px(box.left)}–${px(box.right)} but ${describe(clipper)} cuts it off at ${px(rect.left)}–${px(rect.right)}`;
      }
      if (checkY && style.overflowY !== "visible" && (box.top < rect.top - TOLERANCE || box.bottom > rect.bottom + TOLERANCE)) {
        return `${describe(node)} spans ${px(box.top)}–${px(box.bottom)} down the screen but ${describe(clipper)} cuts it off at ${px(rect.top)}–${px(rect.bottom)}`;
      }
    }
    if (checkX && (box.left < -TOLERANCE || box.right > innerWidth + TOLERANCE)) {
      return `${describe(node)} spans ${px(box.left)}–${px(box.right)} on a ${px(innerWidth)}-wide screen`;
    }
    const element = node instanceof Element ? node : node.parentElement!;
    if (checkY && !scrollerOf(element, "y") && (box.top < -TOLERANCE || box.bottom > innerHeight + TOLERANCE)) {
      return `${describe(node)} spans ${px(box.top)}–${px(box.bottom)} down a ${px(innerHeight)}-tall screen and can't be scrolled into view`;
    }
    return null;
  };
  const checkFits = (node: Node, box: Box, clipping: Element[]) => {
    const problem = cutOff(node, box, clipping);
    if (problem) overflow.push(problem);
  };
  // A phone widens the window to fit a page wider than the screen, but not the box the page is laid out in.
  const [scrollWidth, screenWidth] = [document.scrollingElement!.scrollWidth, document.documentElement.clientWidth];
  if (scrollWidth > screenWidth + TOLERANCE) overflow.push(`the page scrolls sideways: ${px(scrollWidth)} wide on a ${px(screenWidth)}-wide screen`);
  for (const node of textNodes()) {
    for (const line of lineBoxes(node)) checkFits(node, line, clippers(node.parentElement!, true));
  }
  for (const element of elements("body *")) {
    const rect = element.getBoundingClientRect();
    if (rect.width > 0.5 && rect.height > 0.5) checkFits(element, rect, clippers(element, false));
  }

  /**
   * Whether `list` can scroll a fingertip's `points` out from under whatever floats over it: to a
   * place in its scroll range where every point lands on the list's own content. Scrolling by
   * `shift` moves the content back by `shift`, so it tries every shift that keeps the fingertip
   * inside the list, a few pixels apart.
   */
  const scrollsClear = (list: Element, axis: "x" | "y", points: Point[]): boolean => {
    const box = list.getBoundingClientRect();
    const along = points.map(([pointX, pointY]) => (axis === "x" ? pointX : pointY));
    const [scrolled, range] = axis === "x" ? [list.scrollLeft, list.scrollWidth - list.clientWidth] : [list.scrollTop, list.scrollHeight - list.clientHeight];
    const from = Math.max(-scrolled, Math.max(...along) - (axis === "x" ? box.right : box.bottom));
    const to = Math.min(range - scrolled, Math.min(...along) - (axis === "x" ? box.left : box.top));
    const steps = Math.ceil((to - from) / 4);
    for (let step = 0; step <= steps; step++) {
      const shift = from + ((to - from) * step) / Math.max(steps, 1);
      const clear = points.every(([pointX, pointY]) => {
        const hit = axis === "x" ? document.elementFromPoint(pointX - shift, pointY) : document.elementFromPoint(pointX, pointY - shift);
        return hit !== null && list.contains(hit);
      });
      if (clear) return true;
    }
    return false;
  };

  /** A fingertip `size` across on the point (x, y): its middle and eight points around its edge. */
  const fingertip = ([x, y]: Point, size: number): Point[] => {
    const reach = size / 2 - 1;
    return [null, 0, 45, 90, 135, 180, 225, 270, 315].map((angle): Point =>
      angle === null ? [x, y] : [x + reach * Math.cos((angle * Math.PI) / 180), y + reach * Math.sin((angle * Math.PI) / 180)],
    );
  };
  const middle = (box: Box): Point => [(box.left + box.right) / 2, (box.top + box.bottom) / 2];
  const isWithin = ([x, y]: Point, box: Box) => box.left <= x && x < box.right && box.top <= y && y < box.bottom;
  /** Whether `part`, what's painted of `box`, leaves some of it out. */
  const isCut = (box: Box, part: Box) =>
    part.left > box.left + TOLERANCE || part.right < box.right - TOLERANCE || part.top > box.top + TOLERANCE || part.bottom < box.bottom - TOLERANCE;
  /** The smallest box around `boxes`. */
  const boundsOf = (boxes: Box[]): Box => ({
    left: Math.min(...boxes.map((box) => box.left)),
    top: Math.min(...boxes.map((box) => box.top)),
    right: Math.max(...boxes.map((box) => box.right)),
    bottom: Math.max(...boxes.map((box) => box.bottom)),
  });

  /**
   * The boxes of a control's ::before and ::after placed absolutely, which take its taps where they
   * spread past it, as a reaction pill's button spreads its ::after over the whole pill.
   */
  const spreadHitAreas = (element: Element): Box[] =>
    ["::before", "::after"].flatMap((pseudo) => {
      const style = getComputedStyle(element, pseudo);
      if (style.content === "none" || style.position !== "absolute") return [];
      const holder = getComputedStyle(element).position === "static" ? (element as HTMLElement).offsetParent : element;
      if (!holder) return [];
      const outer = holder.getBoundingClientRect();
      const [left, top] = [outer.left + holder.clientLeft, outer.top + holder.clientTop];
      const inset = (side: "top" | "right" | "bottom" | "left") => parseFloat(style[side]);
      return [{ left: left + inset("left"), top: top + inset("top"), right: left + holder.clientWidth - inset("right"), bottom: top + holder.clientHeight - inset("bottom") }];
    });

  /**
   * Whether `element` is set in a line of text: inline itself, as a link in a sentence is, or in an
   * inline box that holds words too, as a mention's avatar sits by the person's name.
   */
  const isInRunningText = (element: Element): boolean => {
    if (getComputedStyle(element).display === "inline") return true;
    const box = element.parentElement;
    if (!box || !getComputedStyle(box).display.startsWith("inline")) return false;
    return [...box.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && node.textContent!.trim() !== "");
  };

  // Touch targets: probe a fingertip-sized circle around the middle of what shows of each control and
  // make sure every point lands on the control or a label for it. That catches small controls,
  // controls crowded together and controls partly covered or cut off, and credits hit areas enlarged
  // with padding or pseudo-elements. Controls partly scrolled out of view, or whose hit areas are, are
  // probed against their boxes instead, since the audits don't scroll, a control under something
  // floating over its list passes if it's big enough under the cover and the list can scroll it clear,
  // and controls that can't take a tap right now (behind an open menu or dialog) are skipped.
  const touchTargets: string[] = [];
  const dense = denseTargets.join(",");
  // A modal <dialog> makes everything outside it inert, without marking it, and a Radix one marks
  // everything outside it hidden from assistive tech.
  const modal = document.querySelector(":modal");
  const isBehindModal = (element: Element) => !!element.closest("[inert], [data-aria-hidden=true]") || (modal !== null && !modal.contains(element));
  for (const element of elements(INTERACTIVE)) {
    if (isDisabled(element) || element.closest("[aria-hidden=true]") || isBehindModal(element) || getComputedStyle(element).pointerEvents === "none") continue;
    // WCAG 2.5.8 exempts targets in running text, which are sized by the text around them, as a
    // message's time is, which links to the message from the line of its heading.
    if (isInRunningText(element) || element.matches("article h3 > a:has(> time)")) continue;
    const rect = element.getBoundingClientRect();
    const clipping = clippers(element, false);
    const shown = paintedPart(rect, clipping);
    if (!shown) continue;
    const size = dense && element.matches(dense) ? DENSE_TARGET : TARGET;
    const labels = "labels" in element ? [...((element as HTMLInputElement).labels ?? [])] : [];
    const partlyShown = isCut(rect, shown);
    // What takes the control's taps: its box, its labels, and its hit area where that spreads past it,
    // which can be partly scrolled out of view while all of the control shows, as an avatar's can by the
    // screen's edge, or the label around a field by the edge of the list it's in.
    const hitAreas = [rect, ...spreadHitAreas(element), ...labels.flatMap((label) => [...label.getClientRects()])];
    const reach = boundsOf(hitAreas);
    if (isCut(reach, paintedPart(reach, clipping)!) && !cutOff(element, reach, clipping)) {
      // Scrolling can bring the rest into view, but the audits don't scroll and can't probe what's
      // scrolled away, so probe the boxes of the control, its labels and what spreads its hit area.
      if (!fingertip(middle(rect), size).every((point) => hitAreas.some((box) => isWithin(point, box)))) {
        touchTargets.push(`${describe(element)} is ${px(rect.width)}×${px(rect.height)} and partly scrolled out of view; a ${size}px fingertip on it can land beside it`);
      }
      continue;
    }

    // A control's own popup, such as the people an @ lists, may cover it while it shows: WAI-ARIA's
    // combobox pattern makes the two one control, and a tap on the popup does what the control is for.
    const popup = element.hasAttribute("aria-haspopup") ? document.getElementById(element.getAttribute("aria-controls") ?? "") : null;
    const isOnControl = (hit: Element) => element.contains(hit) || labels.some((label) => label.contains(hit)) || !!popup?.contains(hit);
    const axis = scrollerOf(element, "y") ? "y" : "x";
    const list = scrollerOf(element, axis);
    const floatsOver = (hit: Element) => list !== null && list !== document.scrollingElement && !list.contains(hit);
    // A control cut by no more than TOLERANCE counts as all shown, and the fingertip shrinks by the cut, as
    // a whole one on the middle of what shows would reach within a pixel of its edge, where Chromium's
    // elementFromPoint finds whatever is past it.
    const cut = Math.max(rect.width - (shown.right - shown.left), rect.height - (shown.bottom - shown.top));
    const points = fingertip(middle(shown), partlyShown ? size : size - cut);
    const [misses, floating] = [new Set<string>(), new Set<string>()];
    for (const [pointX, pointY] of points) {
      const hit = document.elementFromPoint(pointX, pointY);
      if (hit && isOnControl(hit)) continue;
      if (!hit) misses.add("the edge of the screen");
      else if (!floatsOver(hit)) misses.add(describe(hit));
      else {
        // Scrolling the cover away only helps if the fingertip would then land on the control under it.
        const under = document.elementsFromPoint(pointX, pointY).find((beneath) => list!.contains(beneath));
        if (under && isOnControl(under)) floating.add(describe(hit));
        else misses.add(describe(under ?? hit));
      }
    }
    if (floating.size > 0 && !scrollsClear(list!, axis, points)) floating.forEach((what) => misses.add(what));
    if (misses.size > 0) {
      const cut = partlyShown ? ` (${px(shown.right - shown.left)}×${px(shown.bottom - shown.top)} of it shows)` : "";
      touchTargets.push(`${describe(element)} is ${px(rect.width)}×${px(rect.height)}${cut}; a ${size}px fingertip on it can land on ${[...misses].join(", ")}`);
    }
  }

  // Safe area: backgrounds may run under the notch and home indicator, but nothing you read or tap.
  // Scrolling content may pass under them too, as long as it can be scrolled clear: a list that
  // runs to the bottom of the screen needs room after its last item, not to stop short of the edge.
  // What a modal dialog covers waits until it closes, when the page can scroll again.
  const safe: Box = { left: insets.left, top: insets.top, right: innerWidth - insets.right, bottom: innerHeight - insets.bottom };
  const safeArea: string[] = [];
  const checkSafe = (node: Node, box: Box, clipping: Element[]) => {
    const element = node instanceof Element ? node : node.parentElement!;
    if (isBehindModal(element)) return;
    const painted = paintedPart(box, clipping);
    if (!painted) return;
    // A list that scrolls inside a page that scrolls is moved by both.
    const [x, y] = [scrollersOf(element, "x"), scrollersOf(element, "y")];
    const sum = (amounts: number[]) => amounts.reduce((total, amount) => total + amount, 0);
    const room = {
      left: sum(x.map((scroller) => scroller.scrollLeft)),
      top: sum(y.map((scroller) => scroller.scrollTop)),
      right: sum(x.map((scroller) => scroller.scrollWidth - scroller.clientWidth - scroller.scrollLeft)),
      bottom: sum(y.map((scroller) => scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop)),
    };
    const outside = [
      painted.left < safe.left - TOLERANCE && box.left + room.left < safe.left - TOLERANCE && `left inset (${px(insets.left)})`,
      painted.top < safe.top - TOLERANCE && box.top + room.top < safe.top - TOLERANCE && `top inset (${px(insets.top)})`,
      painted.right > safe.right + TOLERANCE && box.right - room.right > safe.right + TOLERANCE && `right inset (${px(insets.right)})`,
      painted.bottom > safe.bottom + TOLERANCE && box.bottom - room.bottom > safe.bottom + TOLERANCE && `bottom inset (${px(insets.bottom)})`,
    ].filter(Boolean);
    if (outside.length > 0) {
      safeArea.push(`${describe(node)} at ${px(painted.left)},${px(painted.top)}–${px(painted.right)},${px(painted.bottom)} is under the ${outside.join(" and ")}`);
    }
  };
  for (const node of textNodes()) {
    for (const line of lineBoxes(node)) checkSafe(node, line, clippers(node.parentElement!, true));
  }
  for (const element of elements(`${INTERACTIVE}, ${MEDIA}`)) {
    checkSafe(element, element.getBoundingClientRect(), clippers(element, false));
  }

  const zoomingFields = elements(TEXT_FIELDS)
    .filter((element) => parseFloat(getComputedStyle(element).fontSize) < 16)
    .map((element) => `${describe(element)} uses ${getComputedStyle(element).fontSize} text`);

  return { overflow, touchTargets, safeArea, zoomingFields };
}
