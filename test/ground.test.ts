import { describe, expect, test } from "bun:test";
import { parseDiff } from "../src/diff";
import { groundFindings } from "../src/ground";
import type { Finding } from "../src/analysis";

const DIFF = `diff --git a/src/greet.ts b/src/greet.ts
--- a/src/greet.ts
+++ b/src/greet.ts
@@ -1,3 +1,4 @@ export function greet
 export function greet(name: string) {
-  return "Hello, " + name;
+  if (!name.trim()) throw new Error("blank name");
+  return \`Hello, \${name}\`;
 }
`;

const base = (over: Partial<Finding> = {}): Finding => ({
  id: "F1",
  severity: "blocker",
  kind: "bug",
  title: "x",
  why: "y",
  where: "src/greet.ts:2",
  action: "z",
  hunk_id: "h1",
  from: 2,
  to: 3,
  ...over,
});

describe("groundFindings", () => {
  const files = parseDiff(DIFF);

  test("keeps grounded finding", () => {
    const [f] = groundFindings([base()], files);
    expect(f.grounded).toBe(true);
    expect(f.severity).toBe("blocker");
  });

  test("downgrades ungrounded blocker and notes reason", () => {
    const [f] = groundFindings([base({ hunk_id: "h99", from: 1, to: 2 })], files);
    expect(f.grounded).toBe(false);
    expect(f.severity).toBe("should-fix");
    expect(f.why).toContain("ungrounded");
  });

  test("drops ungrounded nits", () => {
    const out = groundFindings([base({ severity: "nit", hunk_id: "h99" })], files);
    expect(out).toHaveLength(0);
  });

  test("flags missing line range", () => {
    const [f] = groundFindings([base({ from: 99, to: 120 })], files);
    expect(f.grounded).toBe(false);
  });
});
