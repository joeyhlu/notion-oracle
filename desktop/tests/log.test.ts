import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileLog, formatLine } from "../src/main/log.ts";

test("formatLine writes one line with the time, level, message and detail", () => {
  const at = new Date("2026-10-07T12:00:00.000Z");
  assert.equal(formatLine("info", "started", undefined, at), "2026-10-07T12:00:00.000Z INFO  started\n");
  assert.equal(formatLine("warn", "refused", "file:///etc/passwd", at), "2026-10-07T12:00:00.000Z WARN  refused file:///etc/passwd\n");
  assert.equal(formatLine("error", "turn", { code: 1 }, at), "2026-10-07T12:00:00.000Z ERROR turn {\"code\":1}\n");
  const line = formatLine("error", "boom", new Error("bad"), at);
  assert.match(line, /ERROR boom Error: bad\n/, "an Error contributes its stack, which starts with name and message");
});

test("the log creates its folder, appends, and keeps one previous file once it fills", () => {
  const dir = mkdtempSync(join(tmpdir(), "oracle-log-"));
  try {
    const file = join(dir, "logs", "oracle.log");
    const log = new FileLog(file, 120);
    log.info("first");
    log.error("second", "why");
    const text = readFileSync(file, "utf8");
    assert.equal(text.split("\n").filter(Boolean).length, 2);
    assert.match(text, /INFO  first\n/);
    assert.match(text, /ERROR second why\n/);

    // Past the cap, the next write starts a fresh file and the old one becomes .1.
    log.info("x".repeat(200));
    log.info("after rotation");
    assert.ok(existsSync(`${file}.1`));
    assert.match(readFileSync(`${file}.1`, "utf8"), /first/);
    assert.equal(readFileSync(file, "utf8").split("\n").filter(Boolean).length, 1);
    assert.match(readFileSync(file, "utf8"), /after rotation/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a log that cannot be written does not throw", () => {
  const log = new FileLog(join("/dev/null", "impossible", "oracle.log"));
  assert.doesNotThrow(() => log.error("lost", new Error("x")));
});
