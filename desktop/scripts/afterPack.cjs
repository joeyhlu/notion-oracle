/**
 * Ad-hoc signs the macOS app bundle after packaging.
 *
 * electron-builder's `identity` option only searches the keychain — passing "-" makes it look
 * for a certificate literally named "-", find none, and skip signing entirely. That leaves
 * Electron's own linker-signed binary inside a bundle whose resources were never sealed, which
 * macOS reports as "the app is damaged and can't be opened". Signing here, before the DMG is
 * built, produces a valid ad-hoc signature covering the whole bundle.
 */
const { execFileSync } = require("node:child_process");
const { existsSync } = require("node:fs");
const { join } = require("node:path");

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;

  const appName = `${context.packager.appInfo.productFilename}.app`;
  const appPath = join(context.appOutDir, appName);
  if (!existsSync(appPath)) throw new Error(`afterPack: expected app bundle at ${appPath}`);

  const entitlements = join(context.packager.info.projectDir, "build", "entitlements.mac.plist");
  const run = (args) => execFileSync("codesign", args, { stdio: "inherit" });

  // --deep is deprecated for distribution signing but is the supported way to ad-hoc sign a
  // bundle's nested frameworks and helpers in one pass.
  const args = ["--force", "--deep", "--sign", "-"];
  if (existsSync(entitlements)) args.push("--entitlements", entitlements);
  run([...args, appPath]);

  // Fail the build here rather than shipping a DMG nobody can open.
  run(["--verify", "--deep", "--strict", "--verbose=2", appPath]);
  console.log(`  • ad-hoc signed and verified  app=${appPath}`);
};
