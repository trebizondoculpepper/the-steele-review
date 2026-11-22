import { SubstackDraftDestination } from "../../src/publishing/substack/destination.js";
import type { SubstackDraft, NewDraft } from "../../src/publishing/substack/client.js";
import type { DraftTarget } from "../../src/content/owner-draft-authorization.js";

export function localDraftDestination() {
  const policy = { allowed: true, reads: 0, currentRealIdentity: "", draftOnly: true };
  const control = {
    allow: async (target: DraftTarget) => {
      policy.reads++;
      return (
        policy.allowed &&
        policy.draftOnly &&
        (target.provider === "dummy" || target.identity === policy.currentRealIdentity)
      );
    },
  };
  const records: SubstackDraft[] = [],
    calls = { create: 0, get: 0, list: 0 };
  const client = {
    draftTargetIdentity: `sha256:${"f".repeat(64)}`,
    createDraft: async (input: NewDraft) => {
      calls.create++;
      const draft = {
        id: String(records.length + 1),
        draft_title: input.title,
        draft_subtitle: input.subtitle ?? "",
        draft_body: JSON.stringify(input.body),
        is_published: false,
        email_sent_at: null,
      };
      records.push(draft);
      return { id: draft.id };
    },
    getDraft: async (id: string) => {
      calls.get++;
      const found = records.find((r) => r.id === id);
      if (!found) throw new Error("synthetic absent draft");
      return found;
    },
    listDrafts: async () => {
      calls.list++;
      return [...records];
    },
  };
  const destination = new SubstackDraftDestination(client, { deliveryControl: control });
  policy.currentRealIdentity = destination.draftTarget!.identity;
  return { client, records, calls, control, policy, destination };
}
