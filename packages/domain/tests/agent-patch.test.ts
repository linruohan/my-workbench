import { describe, expect, it } from "vitest";
import { applyHunks, parsePatch, PatchParseError } from "../src/index.js";

describe("parsePatch / applyHunks", () => {
  it("adds, updates, and deletes files", () => {
    const ops = parsePatch(`*** Begin Patch
*** Add File: a.txt
+hello
*** Update File: b.txt
@@
-old
+new
*** Delete File: c.txt
*** End Patch`);
    expect(ops.map((op) => op.kind)).toEqual(["add", "update", "delete"]);
    expect(ops[0]).toMatchObject({ kind: "add", path: "a.txt", content: "hello\n" });
    const update = ops[1];
    expect(update?.kind).toBe("update");
    if (update?.kind !== "update") return;
    const applied = applyHunks("old\n", update.hunks);
    expect(applied).toEqual({ ok: true, after: "new\n" });
  });

  it("rejects malformed patches", () => {
    expect(() => parsePatch("not a patch")).toThrow(PatchParseError);
  });
});
