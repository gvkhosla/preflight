import { describe, expect, test } from "bun:test";
import { extractSymbols } from "../src/context";
import { parseDiff } from "../src/diff";

const DIFF = `diff --git a/src/billing/charge.ts b/src/billing/charge.ts
--- a/src/billing/charge.ts
+++ b/src/billing/charge.ts
@@ -1,3 +1,6 @@
-export async function chargeCustomer(x: any) {
+export async function chargeCustomer(input: { customerId: string }) {
+  const idempotencyKey = input.customerId;
+  return stripe.charges.create({ idempotencyKey });
 }
`;

describe("extractSymbols", () => {
  test("finds function names from added lines", () => {
    const symbols = extractSymbols(parseDiff(DIFF));
    expect(symbols).toContain("chargeCustomer");
  });
});
