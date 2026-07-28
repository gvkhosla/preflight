import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureGitChange } from "../src/change";
import { parseDiff } from "../src/diff";
import { run } from "../src/proc";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function repo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "preflight-change-"));
  roots.push(root);
  await run(["git", "init", "-q"], undefined, { cwd: root });
  await run(["git", "config", "user.email", "test@example.com"], undefined, { cwd: root });
  await run(["git", "config", "user.name", "Preflight Test"], undefined, { cwd: root });
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, ".gitignore"), "ignored.txt\n");
  await writeFile(join(root, "src", "tracked.ts"), "export const value = 1;\n");
  await run(["git", "add", "."], undefined, { cwd: root });
  await run(["git", "commit", "-qm", "initial"], undefined, { cwd: root });
  return root;
}

describe("captureGitChange", () => {
  test("captures tracked and untracked files without including ignored files", async () => {
    const root = await repo();
    await writeFile(join(root, "src", "tracked.ts"), "export const value = 2;\n");
    await writeFile(join(root, "src", "new.ts"), "export const added = true;\n");
    await writeFile(join(root, "ignored.txt"), "secret\n");

    const captured = await captureGitChange([], root);
    const files = parseDiff(captured.diff);

    expect(captured.untrackedFiles).toEqual(["src/new.ts"]);
    expect(files.map((file) => file.path)).toContain("src/tracked.ts");
    expect(files.map((file) => file.path)).toContain("src/new.ts");
    expect(captured.diff).not.toContain("ignored.txt");
    expect(files.find((file) => file.path === "src/new.ts")?.status).toBe("added");
  });

  test("preserves explicit git diff semantics", async () => {
    const root = await repo();
    await writeFile(join(root, "src", "new.ts"), "export const added = true;\n");

    const captured = await captureGitChange(["HEAD"], root);

    expect(captured.untrackedFiles).toEqual([]);
    expect(captured.diff).not.toContain("src/new.ts");
  });
});
