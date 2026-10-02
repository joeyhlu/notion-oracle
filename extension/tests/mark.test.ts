import { test } from "node:test";
import assert from "node:assert/strict";
import { MARK, markSvg, pointCentre } from "../src/shared/mark.ts";

test("the point sits on the orbit, inside the tile", () => {
  const p = pointCentre();
  assert.ok(Math.abs(Math.hypot(p.x - 0.5, p.y - 0.5) - MARK.orbitRadius) < 1e-9);
  assert.ok(p.x + MARK.pointRadius < 1 - 0.05 && p.y - MARK.pointRadius > 0.05, "the point clears the tile edge");
});

test("the SVG uses the mark's colours, and drops the tile when asked", () => {
  const svg = markSvg(24);
  for (const colour of [MARK.ink, MARK.paper, MARK.point]) assert.ok(svg.includes(colour), colour);
  assert.match(svg, /width="24" height="24"/);
  assert.ok(!markSvg(24, { tile: false }).includes(MARK.ink));
});
