import { LexicalShortlister } from "../research/librarian.js";
import type { articleStages } from "./stages.js";

export const FIXTURE_PUBLICATION = "steele-fixture";
export const FIXTURE_HOST = "steele-fixture.example.test";
export const FIXTURE_TEXT =
  "A treaty bans hostile weather modification. A payment of 56 million funded an attack.";
const TREATY = "https://treaties.un.org/enmod";

const claim = (statement: string, passage: string, themeIds: string[]) => ({
  statement,
  passage,
  claimType: "factual",
  kind: "assertion",
  qualifiers: [],
  entities: [],
  dates: [],
  speaker: { kind: "author-voice" },
  themeIds,
});

/** One deterministic provider answering each stage by recognising its prompt. */
const provider = {
  modelVersion: "fixture/stage-model",
  complete: async (req: { system: string; user: string }) => {
    const isWriter = /"summary"/.test(req.system);
    if (!isWriter && /theme/i.test(req.system) && /"themes"/.test(req.system)) {
      return JSON.stringify({
        themes: [{ title: "Weather warfare", description: "Weather modification as a weapon" }],
      });
    }
    if (!isWriter && /claims/i.test(req.system) && /passage/i.test(req.system)) {
      const id = /"id":"(theme-[0-9a-f]+)"/.exec(req.user)?.[1] ?? "x";
      return JSON.stringify({
        claims: [
          claim(
            "A treaty bans hostile weather modification",
            "A treaty bans hostile weather modification.",
            [id],
          ),
          claim(
            "A payment of 56 million funded an attack",
            "A payment of 56 million funded an attack.",
            [id],
          ),
        ],
      });
    }
    const claims = [
      ...req.user.matchAll(/"claimRecordId":"(claim-[0-9a-f]+)"[^}]*?"status":"(covered|gap)"/g),
    ];
    return JSON.stringify({
      summary: "The post claims a treaty bans weather weapons and that a payment funded an attack.",
      themes: ["Weather warfare"],
      responses: claims.map(([, id, status]) =>
        status === "covered"
          ? {
              claimRecordId: id,
              verdict: "supported",
              text: "The ENMOD Convention prohibits this.",
              evidence: [0],
            }
          : {
              claimRecordId: id,
              verdict: "unresolved",
              text: "No record of this payment was found.",
              evidence: [],
            },
      ),
      limitations: [],
      narrative: { status: "limited", limitation: "No earlier posts were compared." },
      widerContext: { status: "limited", limitation: "No background used." },
    });
  },
};

/** Synthetic responses for the isolated smoke worker and integration test. */
export function fixtureProviders(): Pick<
  Parameters<typeof articleStages>[0],
  "models" | "shortlister" | "research"
> {
  return {
    models: {
      themes: provider,
      claims: provider,
      writer: provider,
      verifier: {
        modelVersion: "fixture/verifier",
        complete: async () => JSON.stringify({ verdict: "approved", issues: [] }),
      },
    },
    shortlister: new LexicalShortlister(),
    research: {
      sonar: {
        model: "fixture",
        research: async () => ({
          report: "Article I prohibits it.",
          citations: [TREATY],
          model: "fixture",
        }),
      },
      fetcher: {
        fetch: async (url) => ({
          url,
          title: "ENMOD",
          text: "Article I. Each State Party undertakes not to engage in military or any other hostile use of environmental modification techniques.",
        }),
      },
      judge: {
        judge: async ({ findings }) => ({
          passages: findings
            .filter((f) => /treaty/i.test(f.statement))
            .map((f) => ({
              findingId: f.id,
              passage: "not to engage in military or any other hostile use",
            })),
          sourceType: "treaty",
        }),
      },
    },
  };
}
