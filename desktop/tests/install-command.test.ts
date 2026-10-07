import { test } from "node:test";
import assert from "node:assert/strict";
import { INSTALL_COMMANDS, installCommand } from "../src/shared/types.ts";

test("the install button runs the vendor's installer for this platform", () => {
  assert.equal(installCommand("claude", "darwin"), INSTALL_COMMANDS.claude.mac);
  assert.equal(installCommand("claude", "win32"), INSTALL_COMMANDS.claude.win);
  assert.equal(installCommand("claude", "linux"), INSTALL_COMMANDS.claude.mac, "the shell installer covers Linux too");
  assert.equal(installCommand("codex", "darwin"), INSTALL_COMMANDS.codex.mac);
  assert.equal(installCommand("codex", "linux"), INSTALL_COMMANDS.codex.npm, "Homebrew is not on Linux");
  // Every command is one line the terminal can take as is.
  for (const brain of ["claude", "codex"] as const) for (const platform of ["darwin", "win32", "linux"] as const) {
    assert.doesNotMatch(installCommand(brain, platform), /\n/);
  }
});
