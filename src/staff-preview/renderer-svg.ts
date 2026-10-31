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

/** Place a direction's actual SVG ink just above its staff, then lift it only
 * as far as overlapping music requires. Horizontal neighbours stay independent. */
export function placeStaffDirection(elements: SVGGraphicsElement[], staffTop: number, gap: number,
  obstacles: ReadonlyArray<{ left: number; right: number; top: number; bottom: number }>):
  { left: number; right: number; top: number; bottom: number } | null {
  if (!elements.length) return null;
  const boxes = elements.map(element => element.getBBox());
  const box = { left: Math.min(...boxes.map(item => item.x)), right: Math.max(...boxes.map(item => item.x + item.width)),
    top: Math.min(...boxes.map(item => item.y)), bottom: Math.max(...boxes.map(item => item.y + item.height)) };
  let shift = staffTop - gap - box.bottom;
  const nearby = obstacles.filter(item => item.right > box.left - gap && item.left < box.right + gap);
  // Each move passes at least one obstacle's top, so the bounded loop also
  // handles several beam/ledger/text lanes occupying the same horizontal slot.
  for (let step = 0; step <= nearby.length; step++) {
    const collisions = nearby.filter(item => box.bottom + shift > item.top - gap && box.top + shift < item.bottom + gap);
    if (!collisions.length) break;
    shift = Math.min(...collisions.map(item => item.top - gap - box.bottom));
  }
  elements.forEach(element => element.setAttribute("y", String(Number(element.getAttribute("y")) + shift)));
  return { left: box.left, right: box.right, top: box.top + shift, bottom: box.bottom + shift };
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
  // Preserve the actual glyph-ink bounds separately from padded/partitioned
  // mouse hits, so a finger directly on one notehead wins over nearby notes.
  hit.setAttribute("data-staff-ink-x", String(ink.x));
  hit.setAttribute("data-staff-ink-y", String(ink.y));
  hit.setAttribute("data-staff-ink-width", String(ink.width));
  hit.setAttribute("data-staff-ink-height", String(ink.height));
  parent.appendChild(hit);
  return hit;
}

/** Unisons can be identical or displaced by VexFlow. Partition overlapping
 * padded hits horizontally, then trim adjacent pitch rows at their midpoint. */
export function partitionUnisonHits(hits: SVGRectElement[]): void {
  const groups = new Map<string, SVGRectElement[]>();
  const clusters: Array<{ hits: SVGRectElement[]; left: number; right: number;
    top: number; bottom: number; center: number }> = [];
  for (const hit of hits) {
    const key = ["y", "height"].map(name => Math.round(Number(hit.getAttribute(name)) * 1000)).join(",");
    const group = groups.get(key) ?? [];
    group.push(hit);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    const ordered = group.map(hit => ({ hit, left: Number(hit.getAttribute("x")),
      right: Number(hit.getAttribute("x")) + Number(hit.getAttribute("width")) }))
      .sort((a, b) => a.left - b.left);
    let start = 0;
    while (start < ordered.length) {
      let end = start + 1;
      let right = ordered[start].right;
      while (end < ordered.length && ordered[end].left < right - 1e-6) {
        right = Math.max(right, ordered[end].right);
        end++;
      }
      if (end - start > 1) {
        const left = ordered[start].left;
        const width = Math.max(5, (right - left) / (end - start));
        const x = (left + right - width * (end - start)) / 2;
        for (let index = start; index < end; index++) {
          ordered[index].hit.setAttribute("x", String(x + width * (index - start)));
          ordered[index].hit.setAttribute("width", String(width));
        }
      }
      const members = ordered.slice(start, end).map(item => item.hit);
      const top = Number(members[0].getAttribute("y"));
      const bottom = top + Number(members[0].getAttribute("height"));
      clusters.push({ hits: members,
        left: Math.min(...members.map(hit => Number(hit.getAttribute("x")))),
        right: Math.max(...members.map(hit => Number(hit.getAttribute("x")) + Number(hit.getAttribute("width")))),
        top, bottom, center: (top + bottom) / 2 });
      start = end;
    }
  }
  // Keep every unison member on the same vertical interval. Overlap between
  // neighbouring pitch rows is clipped; each ink centre stays
  // safely inside its own row instead of near a rival hit's top/bottom edge.
  for (let index = 0; index < clusters.length; index++) {
    const current = clusters[index];
    for (let otherIndex = index + 1; otherIndex < clusters.length; otherIndex++) {
      const other = clusters[otherIndex];
      if (current.left >= other.right || other.left >= current.right
        || current.top >= other.bottom || other.top >= current.bottom
        || Math.abs(current.center - other.center) < 1e-3) continue;
      const upper = current.center < other.center ? current : other;
      const lower = upper === current ? other : current;
      const boundary = (upper.center + lower.center) / 2;
      upper.bottom = Math.min(upper.bottom, boundary);
      lower.top = Math.max(lower.top, boundary);
    }
  }
  for (const cluster of clusters) for (const hit of cluster.hits) {
    hit.setAttribute("y", String(cluster.top));
    hit.setAttribute("height", String(cluster.bottom - cluster.top));
  }
}
