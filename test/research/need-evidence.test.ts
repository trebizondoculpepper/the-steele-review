import { expect, it } from "vite-plus/test";
import { ArtifactStoreError } from "../../src/controllers/artifact-store.js";
import { createLegacyResearchNeedLookup } from "../../src/research/need-evidence.js";
import { CanonicalNeedSchema } from "../../src/research/canonical-need.js";
const need = CanonicalNeedSchema.parse({
  version: "canonical-theme-need-v1",
  themeId: "enmod",
  proposition: {
    statement: "The ENMOD Convention was adopted in 1976.",
    kind: "assertion",
    claimType: "factual",
    qualifiers: [],
    entities: ["ENMOD Convention"],
    dates: [{ text: "1976" }],
  },
});
it("bounds the entire legacy path scan once per assessment and reports incomplete proof explicitly", async () => {
  let pages = 0;
  let reads = 0;
  const lookup = createLegacyResearchNeedLookup({
    list: async () => {
      const offset = pages++ * 1000;
      return Array.from(
        { length: 1000 },
        (_, i) => `research-jobs/unrelated-${String(offset + i).padStart(8, "0")}.json`,
      );
    },
    lookup: async () => {
      reads++;
      throw new Error("nonmatching paths are not requests");
    },
    lookupAt: async () => undefined,
    read: async () => {
      reads++;
      throw new Error("no artifact should be read");
    },
  });
  expect(await lookup(need)).toEqual({ status: "unavailable", reason: "legacy-proof-scan-bound" });
  expect(
    await lookup({
      ...need,
      proposition: { ...need.proposition, statement: "Another named assertion." },
    }),
  ).toEqual({ status: "unavailable", reason: "legacy-proof-scan-bound" });
  expect(pages).toBe(21);
  expect(reads).toBe(0);
});
it("propagates operational reads rather than recertifying an unreadable legacy request as absence", async () => {
  let reads = 0;
  const lookup = createLegacyResearchNeedLookup({
    list: async () => [`research-jobs/research-${"a".repeat(32)}/request.json`],
    lookup: async (path) => ({
      repository: "synthetic",
      commit: "b".repeat(40),
      path,
      sha256: "c".repeat(64),
    }),
    lookupAt: async () => undefined,
    read: async () => {
      reads++;
      throw new ArtifactStoreError("git-failed");
    },
  });
  await expect(lookup(need)).rejects.toMatchObject({ code: "git-failed" });
  expect(reads).toBe(1);
});
