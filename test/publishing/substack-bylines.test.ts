import { describe, expect, it } from "vite-plus/test";
import { DraftSchema } from "../../src/publishing/substack/client.js";

// Shapes as Substack's draft endpoint returned them live (#814), synthetic ids.
describe("saved Substack bylines (#814)", () => {
  it("reads bylines from postBylines, where Substack reports them", () => {
    const explicit = DraftSchema.parse({ id: 1, postBylines: [42] });
    expect(explicit.draft_bylines).toEqual([{ id: "42" }]);
    const objects = DraftSchema.parse({ id: 2, postBylines: [{ id: 7, name: "x" }] });
    expect(objects.draft_bylines).toEqual([{ id: "7" }]);
  });

  it("keeps no byline visible as no byline, never inventing one", () => {
    expect(DraftSchema.parse({ id: 3, postBylines: [] }).draft_bylines).toEqual([]);
    // Older responses without postBylines keep draft_bylines as they were.
    expect(DraftSchema.parse({ id: 4, draft_bylines: [{ id: 9 }] }).draft_bylines).toEqual([
      { id: "9" },
    ]);
    expect(DraftSchema.parse({ id: 5 }).draft_bylines).toBeUndefined();
  });
});
