import { describe, expect, it } from "vite-plus/test";
import {
  restateInvocations,
  restateRunLinksHtml,
  restateUiLinks,
} from "../../src/dashboard/restate-links.js";

const ID = "inv_10nRQOddrGqJ4xd2oWFg0zR2hxcb7tBYL8";

describe("Restate UI links (#561)", () => {
  it("builds links only from a validated base and invocation id", () => {
    const links = restateUiLinks("http://ui.example.invalid:9000/ui")!;
    expect(links.home).toBe("http://ui.example.invalid:9000/ui/");
    expect(links.invocation(ID)).toBe(`http://ui.example.invalid:9000/ui/invocations/${ID}`);
    // Hostile or malformed ids never become links.
    expect(links.invocation("inv_x/../../admin")).toBeUndefined();
    expect(links.invocation('"><script>')).toBeUndefined();
    // Unavailable or unsafe configuration gives no links at all.
    for (const bad of [
      undefined,
      "",
      "javascript:alert(1)",
      "http://u:p@ui.example/",
      "http://ui.example/?x=1",
      "not a url",
    ]) {
      expect(restateUiLinks(bad)).toBeUndefined();
    }
  });

  it("resolves the exact invocation of a workflow key, refusing ambiguity", async () => {
    const queries: string[] = [];
    const respond = (rows: unknown[]) =>
      (async (_url: string, init: RequestInit) => {
        queries.push(JSON.parse(String(init.body)).query);
        return Response.json({ rows });
      }) as typeof fetch;
    expect(
      await restateInvocations("http://admin.invalid", {
        fetch: respond([{ id: ID }]),
      }).invocationFor("pub/post@abc"),
    ).toBe(ID);
    expect(queries[0]).toContain("target_service_key = 'pub/post@abc'");
    // None or several matches: not established.
    expect(
      await restateInvocations("http://admin.invalid", { fetch: respond([]) }).invocationFor("k"),
    ).toBeUndefined();
    expect(
      await restateInvocations("http://admin.invalid", {
        fetch: respond([{ id: ID }, { id: ID }]),
      }).invocationFor("k"),
    ).toBeUndefined();
    // A hostile key is never sent.
    const before = queries.length;
    expect(
      await restateInvocations("http://admin.invalid", {
        fetch: respond([{ id: ID }]),
      }).invocationFor("k' OR 1=1 --"),
    ).toBeUndefined();
    expect(queries).toHaveLength(before);
    // An unreachable admin API is not an invocation.
    const down = (async () => {
      throw new Error("down");
    }) as typeof fetch;
    expect(
      await restateInvocations("http://admin.invalid", { fetch: down }).invocationFor("k"),
    ).toBeUndefined();
  });

  it("links the original and recovery runs to their own invocations, with an explicit limitation otherwise", async () => {
    const links = restateUiLinks("http://ui.example.invalid/ui")!;
    const recoveryId = "inv_1RecoveryRunAbcdefghij";
    const html = await restateRunLinksHtml({
      links,
      lookup: {
        invocationFor: async (key) =>
          key === "orig" ? ID : key === "orig~recovery" ? recoveryId : undefined,
      },
      runs: [
        { label: "Original run", workflowKey: "orig" },
        { label: "Recovery run", workflowKey: "orig~recovery" },
        { label: "Other run", workflowKey: "unknown" },
      ],
    });
    expect(html).toContain(`/ui/invocations/${ID}`);
    expect(html).toContain(`/ui/invocations/${recoveryId}`);
    expect(html).toContain(
      'Other run: <span class="empty">no exact invocation could be established</span>',
    );
    expect(html).toContain("external, administrative view");
    // Without an admin lookup, only the home link is offered.
    const homeOnly = await restateRunLinksHtml({
      links,
      runs: [{ label: "Original run", workflowKey: "orig" }],
    });
    expect(homeOnly).not.toContain("/invocations/");
    expect(homeOnly).toContain('href="http://ui.example.invalid/ui/"');
  });
});
