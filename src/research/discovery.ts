import { createHash } from "node:crypto";
import { z } from "zod";
import { ArtifactReferenceSchema } from "../content/artifact-reference.js";
import type { ArtifactRef, GitArtifactStore } from "../controllers/artifact-store.js";
import { OperationStoreError, type OperationStore } from "../controllers/operation-store.js";
import { replaySonarDiscovery } from "../controllers/sonar-discovery-replay.js";
import { ModelProviderError } from "../controllers/openrouter.js";
import { researchJobId, ResearchRequestSchema, writeOnce } from "./job.js";
import {
  DiscoveryDataSchema,
  type DiscoveryData,
  type DiscoveryCapture,
} from "./discovery-data.js";
export {
  DiscoveryDataSchema,
  type DiscoveryData,
  type DiscoveryCapture,
} from "./discovery-data.js";

export const DiscoveryProcessorSchema = z
  .object({
    version: z.literal("research-discovery-v1"),
    model: z.string().min(1).max(200),
    promptVersion: z.string().min(1).max(300),
    parameters: z
      .object({
        maxResponseBytes: z
          .number()
          .int()
          .positive()
          .max(4 * 1024 * 1024)
          .optional(),
        maxOutputTokens: z.number().int().positive().optional(),
        timeoutMs: z.number().int().positive().max(900_000).optional(),
      })
      .strict(),
  })
  .strict();
export type DiscoveryProcessor = z.infer<typeof DiscoveryProcessorSchema>;
const Ref = ArtifactReferenceSchema;
export const DiscoveryReturnedSchema = z
  .object({
    schemaVersion: z.literal(1),
    requestId: z.string(),
    discoveryId: z.string(),
    processor: DiscoveryProcessorSchema,
    receivedAt: z.iso.datetime(),
    representation: z.enum(["provider-json", "adapter-return"]),
    transport: z.enum(["complete", "incomplete", "resource-limit"]),
    body: Ref,
    encoding: z.enum(["utf8", "base64"]),
    byteLength: z
      .number()
      .int()
      .nonnegative()
      .max(4 * 1024 * 1024),
    bodyHash: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
export const DiscoveryResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    requestId: z.string(),
    discoveryId: z.string(),
    input: Ref,
    returned: Ref,
    fence: Ref.optional(),
    outcome: z.enum(["captured", "invalid", "quarantined"]),
    validation: z.enum([
      "valid",
      "invalid-json",
      "invalid-schema",
      "length-limit",
      "unfenced",
      "transport-truncated",
      "resource-limit",
      "adapter-rejected",
      "invalid-encoding",
    ]),
    completion: z.enum(["completed", "length-limit", "unknown"]),
  })
  .strict();
const FailureSchema = z
  .object({
    schemaVersion: z.literal(1),
    code: z.enum(["credit-exhausted", "rate-limited", "unauthorised", "bad-request", "uncertain"]),
    definiteRejection: z.boolean(),
    status: z.number().int().min(400).max(599).optional(),
  })
  .strict();
const ref = (r: ArtifactRef) => ({
  repository: r.repository,
  commit: r.commit,
  path: r.path,
  hash: `sha256:${r.sha256}`,
});
const fromRef = (r: z.infer<typeof Ref>): ArtifactRef => ({ ...r, sha256: r.hash.slice(7) });
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
export class ResearchDiscoveryError extends Error {
  constructor(
    readonly code:
      | "busy"
      | "uncertain"
      | "archive-failed"
      | "invalid-report"
      | "quarantined"
      | "credit-exhausted"
      | "rate-limited"
      | "unauthorised"
      | "bad-request",
    readonly artifacts?: { result: ArtifactRef; returned: ArtifactRef },
  ) {
    super(`research discovery ${code}`);
    this.name = "ResearchDiscoveryError";
  }
}
export function discoveryIdentity(request: unknown, processor: unknown) {
  const parsed = ResearchRequestSchema.parse(request),
    p = DiscoveryProcessorSchema.parse(processor),
    requestId = researchJobId(parsed);
  return {
    request: parsed,
    processor: p,
    requestId,
    discoveryId: `discovery-${hash(JSON.stringify([requestId, p])).slice(0, 32)}`,
  };
}

function interpretDiscovery(
  value: z.infer<typeof DiscoveryReturnedSchema>,
  stored: string,
): {
  validation: z.infer<typeof DiscoveryResultSchema>["validation"];
  completion: z.infer<typeof DiscoveryResultSchema>["completion"];
  data: DiscoveryData | undefined;
} {
  let validation: z.infer<typeof DiscoveryResultSchema>["validation"] = "invalid-json",
    completion: z.infer<typeof DiscoveryResultSchema>["completion"] = "unknown",
    data: DiscoveryData | undefined;
  const bytes =
    value.encoding === "base64" ? Buffer.from(stored, "base64") : Buffer.from(stored, "utf8");
  if (
    (value.encoding === "base64" && bytes.toString("base64") !== stored) ||
    bytes.byteLength !== value.byteLength ||
    createHash("sha256").update(bytes).digest("hex") !== value.bodyHash
  )
    throw new ResearchDiscoveryError("archive-failed");
  let body: string;
  try {
    body = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return {
      validation:
        value.transport !== "complete"
          ? value.transport === "incomplete"
            ? "transport-truncated"
            : "resource-limit"
          : "invalid-encoding",
      completion: "unknown",
      data: undefined,
    };
  }
  if (value.representation === "provider-json") {
    ({ validation, completion, data } = replaySonarDiscovery(body, value.processor.model));
  } else {
    // The compatibility representation is our neutral typed data, not a vendor envelope.
    try {
      const parsed = DiscoveryDataSchema.safeParse(JSON.parse(body));
      validation = parsed.success && parsed.data.report.trim() ? "valid" : "invalid-schema";
      if (parsed.success) data = parsed.data;
    } catch {
      // Returned bytes remain available even when the adapter return is malformed.
    }
  }
  if (value.transport !== "complete")
    validation = value.transport === "incomplete" ? "transport-truncated" : "resource-limit";
  return { validation, completion, data };
}

/** Hash-verified, identity-bound reader for subsequent research stages; never interprets legacy report-only jobs as complete discovery. */
export async function readResearchDiscovery(
  artifacts: GitArtifactStore,
  reference: ArtifactRef,
  acceptance: Pick<OperationStore, "researchDiscoveryAccepted">,
) {
  try {
    const result = DiscoveryResultSchema.parse(JSON.parse(await artifacts.read(reference)));
    if (!acceptance.researchDiscoveryAccepted(result.discoveryId, ref(reference)))
      throw new ResearchDiscoveryError("quarantined");
    if (result.outcome !== "captured")
      throw new ResearchDiscoveryError(
        result.outcome === "quarantined" ? "quarantined" : "invalid-report",
      );
    const returned = DiscoveryReturnedSchema.parse(
      JSON.parse(await artifacts.read(fromRef(result.returned))),
    );
    const descriptor = z
      .object({
        schemaVersion: z.literal(1),
        request: ResearchRequestSchema,
        processor: DiscoveryProcessorSchema,
        requestId: z.string(),
        discoveryId: z.string(),
      })
      .strict()
      .parse(JSON.parse(await artifacts.read(fromRef(result.input))));
    const expected = discoveryIdentity(descriptor.request, descriptor.processor);
    if (
      [descriptor, result, returned].some(
        (x) => x.requestId !== expected.requestId || x.discoveryId !== expected.discoveryId,
      ) ||
      JSON.stringify(returned.processor) !== JSON.stringify(expected.processor) ||
      !result.fence
    )
      throw new ResearchDiscoveryError("archive-failed");
    if (
      await artifacts.lookup(
        `research-discovery/${expected.requestId}/${expected.discoveryId}/quarantined.json`,
      )
    )
      throw new ResearchDiscoveryError("quarantined");
    const fence = JSON.parse(await artifacts.read(fromRef(result.fence)));
    if (fence.returnedHash !== result.returned.hash.slice(7))
      throw new ResearchDiscoveryError("archive-failed");
    const parsed = interpretDiscovery(returned, await artifacts.read(fromRef(returned.body)));
    if (
      parsed.validation !== "valid" ||
      !parsed.data ||
      result.validation !== parsed.validation ||
      result.completion !== parsed.completion
    )
      throw new ResearchDiscoveryError("archive-failed");
    return {
      result,
      returned,
      data: parsed.data,
      request: descriptor.request,
      processor: expected.processor,
    };
  } catch (error) {
    if (error instanceof ResearchDiscoveryError) throw error;
    throw new ResearchDiscoveryError("archive-failed");
  }
}

/** Retain a bounded provider body before interpretation; no headers, credentials or environment are supplied. */
export async function captureResearchDiscovery(input: {
  artifacts: GitArtifactStore;
  operations: OperationStore;
  request: unknown;
  processor: DiscoveryProcessor;
  invoke: (capture: DiscoveryCapture) => Promise<DiscoveryData>;
  owner: string;
  leaseMs?: number;
  now?: () => Date;
}): Promise<{
  data: DiscoveryData;
  ref: ArtifactRef;
  returned: ArtifactRef;
  requestId: string;
  discoveryId: string;
  reused: boolean;
}> {
  const identity = discoveryIdentity(input.request, input.processor),
    { requestId, discoveryId } = identity;
  const dir = `research-discovery/${requestId}/${discoveryId}`,
    key = `research-discovery:${discoveryId}`;
  const save = async (path: string, value: unknown, exact = false) => {
    try {
      const saved = await writeOnce(input.artifacts, path, value);
      if (
        exact &&
        saved.sha256 !==
          hash(typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`)
      )
        throw new ResearchDiscoveryError("archive-failed");
      return saved;
    } catch {
      throw new ResearchDiscoveryError("archive-failed");
    }
  };
  const descriptor = await save(`${dir}/input.json`, { schemaVersion: 1, ...identity });
  const read = async (path: string) => {
    try {
      const r = await input.artifacts.lookup(path);
      return r ? { ref: r, value: JSON.parse(await input.artifacts.read(r)) } : undefined;
    } catch {
      throw new ResearchDiscoveryError("archive-failed");
    }
  };
  const finish = async (
    returned: ArtifactRef,
    value: z.infer<typeof DiscoveryReturnedSchema>,
    reused: boolean,
    held?: Parameters<OperationStore["complete"]>[0],
  ) => {
    if (
      value.requestId !== requestId ||
      value.discoveryId !== discoveryId ||
      JSON.stringify(value.processor) !== JSON.stringify(identity.processor)
    )
      throw new ResearchDiscoveryError("archive-failed");
    if (await read(`${dir}/quarantined.json`)) throw new ResearchDiscoveryError("quarantined");
    const fence = await read(`${dir}/fenced.json`),
      fenced = !!fence && fence.value.returnedHash === returned.sha256;
    let parsed: ReturnType<typeof interpretDiscovery> = {
      validation: "unfenced",
      completion: "unknown",
      data: undefined,
    };
    if (fenced) {
      let body: string;
      try {
        body = await input.artifacts.read(fromRef(value.body));
      } catch {
        throw new ResearchDiscoveryError("archive-failed");
      }
      parsed = interpretDiscovery(value, body);
    }
    if (parsed.validation === "valid" && (await read(`${dir}/adapter-rejected.json`)))
      parsed.validation = "adapter-rejected";
    const { validation, completion, data } = parsed;
    const outcome = !fenced ? "quarantined" : validation === "valid" ? "captured" : "invalid";
    const result = await save(
      `${dir}/result.json`,
      DiscoveryResultSchema.parse({
        schemaVersion: 1,
        requestId,
        discoveryId,
        input: ref(descriptor),
        returned: ref(returned),
        ...(fenced ? { fence: ref(fence!.ref) } : {}),
        outcome,
        validation,
        completion,
      }),
      true,
    );
    if (outcome === "quarantined")
      throw new ResearchDiscoveryError("quarantined", { result, returned });
    try {
      if (held) input.operations.completeResearchDiscovery(held, ref(result));
      else input.operations.reconcileResearchDiscovery(discoveryId, ref(result));
    } catch (error) {
      const lost = error instanceof OperationStoreError && error.code === "not-owner";
      if (held && lost)
        await save(`${dir}/quarantined.json`, {
          schemaVersion: 1,
          reason: "lost-fence",
          returned: ref(returned),
          result: ref(result),
        });
      throw new ResearchDiscoveryError(
        error instanceof OperationStoreError && error.code === "busy"
          ? "busy"
          : lost
            ? "quarantined"
            : "archive-failed",
        { result, returned },
      );
    }
    if (outcome !== "captured" || !data)
      throw new ResearchDiscoveryError("invalid-report", { result, returned });
    return { data, ref: result, returned, requestId, discoveryId, reused };
  };
  const returned = await read(`${dir}/returned.json`);
  if (returned) {
    const parsed = DiscoveryReturnedSchema.safeParse(returned.value);
    if (!parsed.success) throw new ResearchDiscoveryError("archive-failed");
    return finish(returned.ref, parsed.data, true);
  }
  // A crash between body and envelope commits must never buy another response.
  if (
    (await input.artifacts.lookup(`${dir}/response.txt`)) ||
    (await input.artifacts.lookup(`${dir}/response.base64`)) ||
    (await input.artifacts.lookup(`${dir}/adapter-return.json`))
  )
    throw new ResearchDiscoveryError("quarantined");
  if (await read(`${dir}/uncertain.json`)) throw new ResearchDiscoveryError("uncertain");
  const previous = await read(`${dir}/failure.json`);
  if (previous) {
    const rejected = FailureSchema.safeParse(previous.value);
    if (!rejected.success) throw new ResearchDiscoveryError("archive-failed");
    if (!rejected.data.definiteRejection || rejected.data.code === "uncertain")
      throw new ResearchDiscoveryError("uncertain");
  }
  const leaseMs = z
      .number()
      .int()
      .min(1000)
      .max(20 * 60_000)
      .parse(input.leaseMs ?? 16 * 60_000),
    claim = input.operations.claim(key, input.owner, leaseMs, 1);
  if (claim.kind === "busy") throw new ResearchDiscoveryError("busy");
  if (claim.kind !== "claimed") throw new ResearchDiscoveryError("uncertain");
  let captured: ArtifactRef | undefined;
  const capture: DiscoveryCapture = async (value) => {
    if (captured) throw new ResearchDiscoveryError("invalid-report");
    const partial =
      value &&
      typeof value === "object" &&
      "representation" in value &&
      value.representation === "provider-json" &&
      "body" in value &&
      typeof value.body === "string" &&
      "transport" in value &&
      (value.transport === "complete" ||
        value.transport === "incomplete" ||
        value.transport === "resource-limit")
        ? value
        : undefined;
    const representation =
      typeof value === "string" || partial ? "provider-json" : "adapter-return";
    const body =
      typeof value === "string"
        ? value
        : partial
          ? (partial.body as string)
          : JSON.stringify(value);
    const encoding =
      partial && "encoding" in partial && partial.encoding === "base64" ? "base64" : "utf8";
    if (encoding === "base64" && body.length > Math.ceil((4 * 1024 * 1024) / 3) * 4)
      throw new ResearchDiscoveryError("invalid-report");
    const bytes = encoding === "base64" ? Buffer.from(body, "base64") : Buffer.from(body, "utf8");
    if (
      bytes.byteLength > 4 * 1024 * 1024 ||
      (encoding === "base64" && bytes.toString("base64") !== body)
    )
      throw new ResearchDiscoveryError("invalid-report");
    const bodyRef = await save(
      `${dir}/${representation === "provider-json" ? (encoding === "base64" ? "response.base64" : "response.txt") : "adapter-return.json"}`,
      body,
    );
    if (bodyRef.sha256 !== hash(body)) throw new ResearchDiscoveryError("archive-failed");
    captured = await save(
      `${dir}/returned.json`,
      {
        schemaVersion: 1,
        requestId,
        discoveryId,
        processor: identity.processor,
        receivedAt: (input.now ?? (() => new Date()))().toISOString(),
        representation,
        transport: partial ? partial.transport : "complete",
        body: ref(bodyRef),
        encoding,
        byteLength: bytes.byteLength,
        bodyHash: createHash("sha256").update(bytes).digest("hex"),
      },
      true,
    );
    try {
      input.operations.renewResearchDiscovery(claim.claim, leaseMs);
    } catch {
      throw new ResearchDiscoveryError("quarantined");
    }
    await save(`${dir}/fenced.json`, { returnedHash: captured.sha256 });
  };
  try {
    const value = await input.invoke(capture);
    if (!captured) await capture(value);
  } catch (error) {
    if (captured) {
      if (error instanceof ResearchDiscoveryError && error.code === "archive-failed") throw error;
      await save(`${dir}/adapter-rejected.json`, {
        schemaVersion: 1,
        code: error instanceof ModelProviderError ? error.code : "adapter-rejected",
      });
      // Interpretation below records invalid returned data; it is never a no-response retry.
    } else {
      const code =
        error instanceof ModelProviderError &&
        ["credit-exhausted", "rate-limited", "unauthorised", "bad-request"].includes(error.code)
          ? (error.code as "credit-exhausted" | "rate-limited" | "unauthorised" | "bad-request")
          : "uncertain";
      const definiteRejection = code !== "uncertain";
      await save(`${dir}/${definiteRejection ? "failure" : "uncertain"}.json`, {
        schemaVersion: 1,
        code,
        definiteRejection,
        ...(error instanceof ModelProviderError && error.status ? { status: error.status } : {}),
      });
      try {
        if (definiteRejection) input.operations.yieldClaim(claim.claim);
        else input.operations.fail(claim.claim, "discovery-uncertain", false);
      } catch {
        /* Expired owners cannot change another owner's state. */
      }
      if (error instanceof ModelProviderError) throw error;
      throw new ResearchDiscoveryError(code);
    }
  }
  const saved = await read(`${dir}/returned.json`);
  if (!saved || !captured) throw new ResearchDiscoveryError("archive-failed");
  const parsed = DiscoveryReturnedSchema.safeParse(saved.value);
  if (!parsed.success) throw new ResearchDiscoveryError("archive-failed");
  return finish(captured, parsed.data, false, claim.claim);
}
