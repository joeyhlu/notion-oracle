/**
 * The Oracle mark, defined once.
 *
 * An ink tile with a cream orbit and one terracotta point on it. Every size of the PNG icon is
 * rendered from these numbers by scripts/make-icons.mjs, and the in-page button draws the same
 * geometry as SVG through markSvg(), so the toolbar icon and the button in Notion cannot drift.
 *
 * All lengths are fractions of the tile's side.
 */

export const MARK = {
  ink: "#1f1e1d",
  paper: "#faf9f5",
  point: "#dd7a52",
  /** Corner radius of the tile. */
  corner: 0.235,
  /** Orbit: centre-line radius and stroke width. */
  orbitRadius: 0.265,
  orbitWidth: 0.1,
  /** Where the point sits on the orbit, in degrees, measured clockwise from 12 o'clock. */
  pointAngle: 45,
  pointRadius: 0.1,
  /** Gap between the point and the orbit, so the two read as separate shapes at 16px. */
  clearance: 0.05,
} as const;

/** Centre of the point, in tile fractions (y grows downward). */
export function pointCentre(): { x: number; y: number } {
  const a = (MARK.pointAngle * Math.PI) / 180;
  return { x: 0.5 + MARK.orbitRadius * Math.sin(a), y: 0.5 - MARK.orbitRadius * Math.cos(a) };
}

/**
 * The mark as an SVG string, `size` pixels square. The orbit is a circle with the point's
 * clearance masked out, which is the same construction the rasteriser uses.
 */
export function markSvg(size: number, options: { tile?: boolean } = {}): string {
  const s = 100;
  const p = pointCentre();
  const tile = options.tile !== false;
  const orbitColour = tile ? MARK.paper : "currentColor";
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${s} ${s}" aria-hidden="true">`,
    `<defs><mask id="oracle-clear"><rect width="${s}" height="${s}" fill="#fff"/>`,
    `<circle cx="${p.x * s}" cy="${p.y * s}" r="${(MARK.pointRadius + MARK.clearance) * s}" fill="#000"/></mask></defs>`,
    tile ? `<rect width="${s}" height="${s}" rx="${MARK.corner * s}" fill="${MARK.ink}"/>` : "",
    `<circle cx="50" cy="50" r="${MARK.orbitRadius * s}" fill="none" stroke="${orbitColour}" stroke-width="${MARK.orbitWidth * s}" mask="url(#oracle-clear)"/>`,
    `<circle cx="${p.x * s}" cy="${p.y * s}" r="${MARK.pointRadius * s}" fill="${MARK.point}"/>`,
    `</svg>`,
  ].join("");
}
