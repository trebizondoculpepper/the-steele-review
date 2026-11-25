import { it, expect } from "vite-plus/test";
import {
  TitleFirstJudge,
  type Shortlist,
} from "../../src/research/librarian.js";

const shortlist = (scope: string): Shortlist =>
  ({
    method: "lexical",
    candidates: [
      { themeId: "weather", title: "Weather modification", scope, score: 1 },
    ],
  }) as unknown as Shortlist;

it("abstains when same-title scopes differ in polarity", async () => {
  const decision = await new TitleFirstJudge().decide(
    {
      title: "Weather modification",
      description: "Treaty prohibits hostile environmental modification",
    },
    shortlist("Treaty permits hostile environmental modification"),
  );
  expect(decision.themeId).toBeNull();
  expect(decision.abstain).toBe(true);
});

it("still matches same-title scopes that agree", async () => {
  const decision = await new TitleFirstJudge().decide(
    {
      title: "Weather modification",
      description:
        "Treaty prohibits hostile environmental modification techniques",
    },
    shortlist("Treaty prohibits hostile environmental modification"),
  );
  expect(decision.themeId).toBe("weather");
});
