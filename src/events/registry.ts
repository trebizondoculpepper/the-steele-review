import {
  CAPTURED_CONTENT_EVENT_TYPE_V1,
  CAPTURED_CONTENT_SUBJECT,
} from "./captured-content-event.js";
import {
  ARTICLE_APPROVED_EVENT_TYPE_V1,
  ARTICLE_APPROVED_SUBJECT,
  PUBLICATION_STREAM,
} from "./article-approved-event.js";
import {
  RESEARCH_REINDEX_EVENT_TYPE_V1,
  RESEARCH_REINDEX_SUBJECT,
} from "./research-reindex-event.js";
import {
  CLAIMS_EXTRACTED_EVENT_TYPE_V1,
  CLAIMS_EXTRACTED_SUBJECT,
} from "../analysis/claim-worker.js";
import {
  CONTENT_EMBEDDED_EVENT_TYPE_V1,
  CONTENT_EMBEDDED_SUBJECT,
} from "../content/embedding-consumer.js";
import { DEFAULT_DISCOVERY_SUBJECT } from "../controllers/nats-discovery.js";
import { BRIEF_READY_EVENT_TYPE_V1, BRIEF_READY_SUBJECT } from "../drafting/brief.js";
import { DRAFT_READY_EVENT_TYPE_V1, DRAFT_READY_SUBJECT } from "../drafting/draft.js";
import {
  RESEARCH_REQUESTED_EVENT_TYPE_V1,
  RESEARCH_REQUESTED_SUBJECT,
} from "../drafting/research-coordinator.js";
import {
  REVISION_DECIDED_EVENT_TYPE_V1,
  REVISION_DECIDED_SUBJECT,
} from "../drafting/revision-attempts.js";
import { DRAFT_VERIFIED_EVENT_TYPE_V1, DRAFT_VERIFIED_SUBJECT } from "../drafting/verify.js";
import {
  ARTICLE_PUBLISHED_EVENT_TYPE_V1,
  ARTICLE_PUBLISHED_SUBJECT,
} from "../publishing/publisher-worker.js";
import { CLAIM_OCCURRED_EVENT_TYPE_V1, CLAIM_OCCURRED_SUBJECT } from "./claim-occurred-event.js";
import { DISCOVERY_EVENT_TYPE_V1 } from "./discovery-event.js";
import {
  ANALYSIS_STREAM,
  POST_ANALYSED_EVENT_TYPE_V1,
  POST_ANALYSED_SUBJECT,
} from "./post-analysed-event.js";
import {
  RESEARCH_COMPLETED_EVENT_TYPE_V1,
  RESEARCH_COMPLETED_SUBJECT,
  RESEARCH_STREAM,
} from "./research-completed-event.js";
import { TEXT_READY_EVENT_TYPE_V1, TEXT_READY_SUBJECT } from "./text-ready-event.js";
import { THEME_OCCURRED_EVENT_TYPE_V1, THEME_OCCURRED_SUBJECT } from "./theme-occurred-event.js";

/**
 * Shared stream and message registry (#209).
 *
 * One typed inventory of JetStream streams (what they capture and why) and
 * of every application subject (its event type and which stream, if any,
 * retains it). Provisioning reads stream definitions from here, and the
 * checked-in reference (doc/architecture/generated/streams-and-messages.md)
 * is generated from it, so there is no second handwritten inventory.
 *
 * Naming: subjects are `steele.v1.<area>.<event>`; streams are
 * `STEELE_<RESPONSIBILITY>`. Existing deployed names are kept as they are.
 * Streams are per responsibility, never per post, theme or claim. A stream
 * name can be overridden by its configured environment variable; subjects
 * are fixed contract identities.
 *
 * Adding a definition: export the subject (and event type) beside its event
 * schema, add a `MESSAGES` entry, and either assign it to an existing stream
 * whose purpose fits or add a `STREAMS` entry. Then regenerate the reference
 * (`npm run events:reference`); the registry tests fail on uncovered,
 * overlapping or drifting definitions.
 */

export interface StreamDefinition {
  /** Default stream name; deployments may override it with `overrideEnv`. */
  name: string;
  overrideEnv: string;
  purpose: string;
  /** Subject filters the stream captures (exact subjects; no wildcards today). */
  subjects: readonly string[];
}

export interface MessageDefinition {
  subject: string;
  /** CloudEvents type, where the message has a published envelope contract. */
  eventType?: string;
  /** Stream that retains it, or null when no stream is provisioned yet. */
  stream: string | null;
  producer: string;
  description: string;
  /**
   * When the message is emitted (the producing state change). Required for
   * every message retained by a provisioned stream.
   */
  emittedWhen?: string;
  /**
   * What consumers can rely on: identity and deduplication, and how
   * redelivery and invalid payloads are handled.
   */
  guarantees?: string;
}

export const STREAMS: readonly StreamDefinition[] = [
  {
    name: "STEELE_DISCOVERY",
    overrideEnv: "STEELE_DISCOVERY_STREAM",
    purpose: "Newly discovered or redelivered source posts awaiting capture.",
    subjects: [DEFAULT_DISCOVERY_SUBJECT],
  },
  {
    name: "STEELE_CONTENT",
    overrideEnv: "STEELE_CONTENT_STREAM",
    purpose: "Captured source text ready for indexing and analysis.",
    subjects: [TEXT_READY_SUBJECT, CAPTURED_CONTENT_SUBJECT],
  },
  {
    name: ANALYSIS_STREAM,
    overrideEnv: "STEELE_ANALYSIS_STREAM",
    purpose:
      "Analysis-stage handoffs: one post-analysed completion per post and analysis version, plus its per-theme and per-claim occurrence events.",
    subjects: [POST_ANALYSED_SUBJECT, THEME_OCCURRED_SUBJECT, CLAIM_OCCURRED_SUBJECT],
  },
  {
    name: RESEARCH_STREAM,
    overrideEnv: "STEELE_RESEARCH_STREAM",
    purpose:
      "Research job completions (complete, complete with gaps, failed) and research-index reconciliation requests.",
    subjects: [RESEARCH_COMPLETED_SUBJECT, RESEARCH_REINDEX_SUBJECT],
  },
  {
    name: PUBLICATION_STREAM,
    overrideEnv: "STEELE_PUBLICATION_STREAM",
    purpose: "Approved articles, consumed independently by each configured destination (#262).",
    subjects: [ARTICLE_APPROVED_SUBJECT],
  },
];

export const MESSAGES: readonly MessageDefinition[] = [
  {
    subject: DEFAULT_DISCOVERY_SUBJECT,
    eventType: DISCOVERY_EVENT_TYPE_V1,
    stream: "STEELE_DISCOVERY",
    producer: "discover, backfill, retry-collection",
    description: "A source post to capture.",
    emittedWhen: "A feed poll, backfill or retry finds a post to capture.",
    guarantees:
      "Deduplicated by the collection operation key; redelivery is safe (already-collected). Invalid payloads are terminated.",
  },
  {
    subject: TEXT_READY_SUBJECT,
    eventType: TEXT_READY_EVENT_TYPE_V1,
    stream: "STEELE_CONTENT",
    producer: "collect-worker",
    description: "Captured text archived and ready.",
    emittedWhen:
      "The collector commits an archived post (outbox, same step as the archive operation).",
    guarantees:
      "Exact archived artifact reference; consumers re-read and verify the hash. Redelivery is idempotent for indexing. Invalid payloads are terminated.",
  },
  {
    subject: POST_ANALYSED_SUBJECT,
    eventType: POST_ANALYSED_EVENT_TYPE_V1,
    stream: ANALYSIS_STREAM,
    producer: "announce-post",
    description: "Theme proposals and claims saved for one post.",
    emittedWhen: "Theme and claim results for one post are saved (outbox).",
    guarantees:
      "Stable event ID per (theme result, claim result) pair; consumers deduplicate by it.",
  },
  {
    subject: THEME_OCCURRED_SUBJECT,
    eventType: THEME_OCCURRED_EVENT_TYPE_V1,
    stream: ANALYSIS_STREAM,
    producer: "fan-out-worker",
    description: "One detected theme occurrence in a saved analysis.",
    emittedWhen: "Fan-out of a post-analysed event: one per theme occurrence (outbox).",
    guarantees: "Stable occurrence ID; duplicate parent delivery is idempotent.",
  },
  {
    subject: CLAIM_OCCURRED_SUBJECT,
    eventType: CLAIM_OCCURRED_EVENT_TYPE_V1,
    stream: ANALYSIS_STREAM,
    producer: "fan-out-worker",
    description: "One extracted claim occurrence in a saved analysis.",
    emittedWhen: "Fan-out of a post-analysed event: one per claim occurrence (outbox).",
    guarantees: "Stable occurrence ID; duplicate parent delivery is idempotent.",
  },
  {
    subject: RESEARCH_COMPLETED_SUBJECT,
    eventType: RESEARCH_COMPLETED_EVENT_TYPE_V1,
    stream: RESEARCH_STREAM,
    producer: "research jobs (#215)",
    description: "A research job reached a terminal outcome.",
    emittedWhen: "A research job reaches a terminal outcome (outbox, with the saved result).",
    guarantees: "Event ID is the job ID; a redelivered request never repeats the provider call.",
  },
  {
    subject: RESEARCH_REINDEX_SUBJECT,
    eventType: RESEARCH_REINDEX_EVENT_TYPE_V1,
    stream: RESEARCH_STREAM,
    producer: "research-reindex CLI, external schedulers (#232)",
    description: "Reconcile one configured research-index route from its checkpoint.",
    emittedWhen: "An operator or scheduler requests reconciliation of a route.",
    guarantees:
      "Idempotent from the index checkpoint; acked after the pass, redelivered while busy or failed, terminated and recorded when malformed, for an unknown route or when retries are exhausted.",
  },
  {
    subject: CAPTURED_CONTENT_SUBJECT,
    eventType: CAPTURED_CONTENT_EVENT_TYPE_V1,
    stream: "STEELE_CONTENT",
    producer: "collect-worker (Substack); any ingestion source",
    description: "Source-neutral captured item revision for the writing engine (#269).",
  },
  {
    subject: ARTICLE_APPROVED_SUBJECT,
    eventType: ARTICLE_APPROVED_EVENT_TYPE_V1,
    stream: PUBLICATION_STREAM,
    producer: "recordApproval (package verification approval)",
    description:
      "An exact article revision was approved; each destination consumes it independently.",
    emittedWhen: "The package verifier approves an exact draft revision (outbox).",
    guarantees:
      "Stable event ID per (draft, approval); each destination keeps its own keyed intent and receipt, reuses it on redelivery and reconciles uncertain deliveries before retrying.",
  },
  // Declared by existing stages but not yet retained by any provisioned stream.
  {
    subject: CLAIMS_EXTRACTED_SUBJECT,
    eventType: CLAIMS_EXTRACTED_EVENT_TYPE_V1,
    stream: null,
    producer: "claim-worker",
    description: "Claims extracted by the automatic worker.",
  },
  {
    subject: CONTENT_EMBEDDED_SUBJECT,
    eventType: CONTENT_EMBEDDED_EVENT_TYPE_V1,
    stream: null,
    producer: "embedding-consumer",
    description: "Passages embedded.",
  },
  {
    subject: RESEARCH_REQUESTED_SUBJECT,
    eventType: RESEARCH_REQUESTED_EVENT_TYPE_V1,
    stream: null,
    producer: "research-coordinator",
    description: "Research requested for an analysed post.",
  },
  {
    subject: BRIEF_READY_SUBJECT,
    eventType: BRIEF_READY_EVENT_TYPE_V1,
    stream: null,
    producer: "brief",
    description: "Drafting brief saved.",
  },
  {
    subject: DRAFT_READY_SUBJECT,
    eventType: DRAFT_READY_EVENT_TYPE_V1,
    stream: null,
    producer: "drafting-worker",
    description: "Draft saved.",
  },
  {
    subject: DRAFT_VERIFIED_SUBJECT,
    eventType: DRAFT_VERIFIED_EVENT_TYPE_V1,
    stream: null,
    producer: "verification-worker",
    description: "Draft verification report saved.",
  },
  {
    subject: REVISION_DECIDED_SUBJECT,
    eventType: REVISION_DECIDED_EVENT_TYPE_V1,
    stream: null,
    producer: "revision-worker",
    description: "Revision decision recorded.",
  },
  {
    subject: ARTICLE_PUBLISHED_SUBJECT,
    eventType: ARTICLE_PUBLISHED_EVENT_TYPE_V1,
    stream: null,
    producer: "publisher-worker",
    description: "Article published.",
  },
];

const SUBJECT = /^steele\.v1\.[a-z]+(?:\.[a-z]+)+$/;
const STREAM = /^STEELE_[A-Z]+$/;
/** Deployments may use any valid JetStream name, but never an empty one. */
const STREAM_OVERRIDE = /^[A-Za-z0-9_-]+$/;

/** Problems in the registry: uncovered subjects, overlaps, bad names. Empty when consistent. */
export function registryProblems(
  streams: readonly StreamDefinition[] = STREAMS,
  messages: readonly MessageDefinition[] = MESSAGES,
): string[] {
  const problems: string[] = [];
  const owner = new Map<string, string>();
  const names = new Set<string>();
  for (const s of streams) {
    if (names.has(s.name)) problems.push(`stream ${s.name} is defined twice`);
    names.add(s.name);
    if (!STREAM.test(s.name))
      problems.push(`stream ${s.name} does not follow STEELE_<RESPONSIBILITY>`);
    for (const subject of s.subjects) {
      const prior = owner.get(subject);
      if (prior) problems.push(`subject ${subject} is captured by both ${prior} and ${s.name}`);
      owner.set(subject, s.name);
    }
  }
  const declared = new Set<string>();
  for (const m of messages) {
    if (!SUBJECT.test(m.subject))
      problems.push(`subject ${m.subject} does not follow steele.v1.<area>.<event>`);
    if (declared.has(m.subject)) problems.push(`subject ${m.subject} is declared twice`);
    declared.add(m.subject);
    const captured = owner.get(m.subject) ?? null;
    if (captured !== m.stream) {
      problems.push(
        `subject ${m.subject} is assigned to ${m.stream ?? "no stream"} but captured by ${captured ?? "no stream"}`,
      );
    }
  }
  for (const m of messages) {
    if (m.stream && (!m.emittedWhen || !m.guarantees)) {
      problems.push(
        `subject ${m.subject} is retained by a stream but does not state when it is emitted and what consumers can rely on`,
      );
    }
  }
  for (const subject of owner.keys()) {
    if (!declared.has(subject))
      problems.push(`stream subject ${subject} has no message definition`);
  }
  return problems;
}

/** Stream name to provision, honouring the configured override. */
export function streamName(def: StreamDefinition, env: NodeJS.ProcessEnv = process.env): string {
  const override = env[def.overrideEnv];
  if (override === undefined) return def.name;
  if (!STREAM_OVERRIDE.test(override)) {
    throw new Error(`${def.overrideEnv} must be a non-empty stream name`);
  }
  return override;
}

/** Markdown reference generated from the registry (checked in; tests catch drift). */
export function renderRegistryReference(): string {
  const lines = [
    "# Streams and messages",
    "",
    "Generated from `src/events/registry.ts` by `npm run events:reference`. Do not edit by hand.",
    "",
    "## Streams",
    "",
    "| Stream | Override | Captures | Purpose |",
    "| --- | --- | --- | --- |",
    ...STREAMS.map(
      (s) =>
        `| \`${s.name}\` | \`${s.overrideEnv}\` | ${s.subjects.map((x) => `\`${x}\``).join(", ")} | ${s.purpose} |`,
    ),
    "",
    "## Messages",
    "",
    "| Subject | Event type | Stream | Producer | Description |",
    "| --- | --- | --- | --- | --- |",
    ...MESSAGES.map(
      (m) =>
        `| \`${m.subject}\` | ${m.eventType ? `\`${m.eventType}\`` : "—"} | ${m.stream ? `\`${m.stream}\`` : "not provisioned"} | ${m.producer} | ${m.description} |`,
    ),
    "",
    "## Message contracts",
    "",
    "The standard these follow is in doc/architecture/20-messaging-contract.md.",
    "",
    "| Subject | Emitted when | Consumer guarantees |",
    "| --- | --- | --- |",
    ...MESSAGES.filter((m) => m.emittedWhen).map(
      (m) => `| \`${m.subject}\` | ${m.emittedWhen} | ${m.guarantees} |`,
    ),
    "",
  ];
  return lines.join("\n");
}
