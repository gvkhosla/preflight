import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDiff } from "../src/diff";
import { discoverVerificationPlan } from "../src/verify";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const files = parseDiff(`diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1 +1 @@
-export const a = 1;
+export const a = 2;
`);

describe("discoverVerificationPlan", () => {
  test("discovers package-native typecheck, lint, test, and build scripts", async () => {
    const root = await mkdtemp(join(tmpdir(), "preflight-verify-"));
    roots.push(root);
    await writeFile(join(root, "bun.lock"), "");
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ scripts: { typecheck: "tsc --noEmit", lint: "eslint .", test: "bun test", build: "vite build" } }),
    );

    const plan = await discoverVerificationPlan(root, files);

    expect(plan.map((check) => check.name)).toEqual(["typecheck", "lint", "test", "build"]);
    expect(plan.every((check) => check.command[0] === "bun")).toBe(true);
  });

  test("prefers an aggregate check script over duplicate typecheck and lint", async () => {
    const root = await mkdtemp(join(tmpdir(), "preflight-verify-"));
    roots.push(root);
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ scripts: { check: "npm run typecheck && npm run lint", typecheck: "tsc", lint: "eslint ." } }),
    );

    const plan = await discoverVerificationPlan(root, files);

    expect(plan.map((check) => check.name)).toEqual(["check"]);
  });
});
