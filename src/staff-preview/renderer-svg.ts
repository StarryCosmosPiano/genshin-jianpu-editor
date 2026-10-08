export const SVG_NS = "http://www.w3.org/2000/svg";

export function svgText(svg: SVGElement, text: string, x: number, y: number, size = 14): SVGTextElement {
  const node = document.createElementNS(SVG_NS, "text");
  node.textContent = text;
  node.setAttribute("x", String(x));
  node.setAttribute("y", String(y));
  node.setAttribute("font-family", "Arial, Microsoft YaHei, sans-serif");
  node.setAttribute("font-size", String(size));
  node.setAttribute("fill", "#111");
  svg.appendChild(node);
  return node;
}

/** Attach only while measuring: detached SVG text has zero geometry in some engines. */
export function withMountedSvg<T>(host: HTMLElement, action: () => T): T {
  host.style.cssText = "position:absolute;left:-100000px;top:0;visibility:hidden;pointer-events:none";
  document.body.appendChild(host);
  try { return action(); } finally { host.remove(); }
}

export function noteHitBox(element: SVGGraphicsElement, parent: SVGElement, index: number,
  tight?: { x: number; y: number; width: number; height: number }): SVGRectElement {
  const box = element.getBBox();
  // SMuFL text getBBox includes Bravura's entire 4-em font line box. Use
  // VexFlow's browser glyph-ink metrics to trim it, retaining SVG coordinates.
  const ink = tight ?? box;
  const hit = document.createElementNS(SVG_NS, "rect");
  hit.setAttribute("x", String(ink.x - 2));
  hit.setAttribute("y", String(ink.y - 2));
  hit.setAttribute("width", String(Math.max(5, ink.width + 4)));
  hit.setAttribute("height", String(Math.max(5, ink.height + 4)));
  hit.setAttribute("fill", "transparent");
  hit.setAttribute("stroke", "none");
  hit.setAttribute("pointer-events", "all");
  hit.setAttribute("data-staff-hit", String(index));
  parent.appendChild(hit);
  return hit;
}

/** Identical unisons still have independently selectable source notes. */
export function partitionUnisonHits(hits: SVGRectElement[]): void {
  const groups = new Map<string, SVGRectElement[]>();
  for (const hit of hits) {
    const key = ["x", "y", "width", "height"].map((name) => hit.getAttribute(name)).join(",");
    const group = groups.get(key) ?? [];
    group.push(hit);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const x = Number(group[0].getAttribute("x"));
    const width = Number(group[0].getAttribute("width")) / group.length;
    group.forEach((hit, index) => {
      hit.setAttribute("x", String(x + width * index));
      hit.setAttribute("width", String(width));
    });
  }
}
