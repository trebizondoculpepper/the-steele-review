import type {
  Build,
  BuildsPort,
  DashboardStackPort,
  ReadinessPort,
  RegistryPort,
} from "../deploy/dashboard-update.js";

/**
 * Typed adapters for the dashboard auto-update (#476). Addresses, stack
 * identity and credentials are supplied by private deployment configuration;
 * no value here is logged, and errors carry fixed categories only.
 */

export class DeployAdapterError extends Error {
  constructor(readonly category: string) {
    super(`dashboard deploy: ${category}`);
    this.name = "DeployAdapterError";
  }
}

type Fetch = typeof fetch;
const TIMEOUT_MS = 30_000;

async function call(
  f: Fetch,
  category: string,
  url: string,
  init: RequestInit = {},
): Promise<Response> {
  let response: Response;
  try {
    response = await f(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    throw new DeployAdapterError(`${category}-unreachable`);
  }
  return response;
}

/** GitHub Actions runs and commit ancestry, read-only and unauthenticated or with a read token. */
export function githubBuilds(config: {
  repository: string;
  workflowFile: string;
  token?: string;
  fetch?: Fetch;
}): BuildsPort {
  const f = config.fetch ?? fetch;
  const api = `https://api.github.com/repos/${config.repository}`;
  const headers = {
    accept: "application/vnd.github+json",
    ...(config.token ? { authorization: `Bearer ${config.token}` } : {}),
  };
  return {
    async latestMainBuild(): Promise<Build | undefined> {
      const url = `${api}/actions/workflows/${encodeURIComponent(config.workflowFile)}/runs?branch=main&event=push&status=completed&per_page=1`;
      const res = await call(f, "github", url, { headers });
      if (!res.ok) throw new DeployAdapterError("github-status");
      const body = (await res.json()) as {
        workflow_runs?: {
          id: number;
          head_sha: string;
          conclusion: string | null;
          head_branch: string;
          event: string;
        }[];
      };
      const run = body.workflow_runs?.[0];
      return run
        ? {
            runId: run.id,
            commit: run.head_sha,
            conclusion: run.conclusion ?? "pending",
            branch: run.head_branch,
            event: run.event,
          }
        : undefined;
    },
    async isStrictlyNewer(older, newer) {
      const res = await call(f, "github", `${api}/compare/${older}...${newer}`, { headers });
      if (!res.ok) throw new DeployAdapterError("github-status");
      const body = (await res.json()) as { status?: string };
      // "ahead": newer descends from older. "behind", "identical", "diverged": never deploy.
      return body.status === "ahead";
    },
  };
}

/** Digest of a commit-tagged image in GHCR, via an anonymous pull token. */
export function ghcrRegistry(config: { repository: string; fetch?: Fetch }): RegistryPort {
  const f = config.fetch ?? fetch;
  return {
    async digestFor(commit) {
      const tokenRes = await call(
        f,
        "registry",
        `https://ghcr.io/token?scope=repository:${config.repository}:pull`,
      );
      if (!tokenRes.ok) throw new DeployAdapterError("registry-status");
      const { token } = (await tokenRes.json()) as { token?: string };
      if (!token) throw new DeployAdapterError("registry-token");
      const res = await call(
        f,
        "registry",
        `https://ghcr.io/v2/${config.repository}/manifests/${commit}`,
        {
          method: "HEAD",
          headers: {
            authorization: `Bearer ${token}`,
            accept: [
              "application/vnd.oci.image.index.v1+json",
              "application/vnd.docker.distribution.manifest.list.v2+json",
              "application/vnd.oci.image.manifest.v1+json",
              "application/vnd.docker.distribution.manifest.v2+json",
            ].join(", "),
          },
        },
      );
      if (res.status === 404) return undefined;
      if (!res.ok) throw new DeployAdapterError("registry-status");
      const digest = res.headers.get("docker-content-digest") ?? "";
      return /^sha256:[0-9a-f]{64}$/.test(digest) ? digest : undefined;
    },
  };
}

/**
 * One Portainer (Community Edition) stack: reads its current file and
 * environment fresh before every write, changes only the one image variable,
 * and redeploys without re-pulling, so only the dashboard is recreated.
 */
export function portainerDashboardStack(config: {
  url: string;
  apiKey: string;
  stackId: number;
  imageVariable: string;
  fetch?: Fetch;
}): DashboardStackPort {
  const f = config.fetch ?? fetch;
  const headers = { "x-api-key": config.apiKey, "content-type": "application/json" };
  const json = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
    const res = await call(f, "portainer", `${config.url}${path}`, {
      ...init,
      headers: { ...headers, ...(init.headers ?? {}) },
    });
    if (!res.ok) throw new DeployAdapterError("portainer-status");
    return (await res.json()) as T;
  };
  type Stack = { EndpointId: number; Env: { name: string; value: string }[] };
  return {
    async currentImage() {
      const stack = await json<Stack>(`/api/stacks/${config.stackId}`);
      return stack.Env.find((e) => e.name === config.imageVariable)?.value;
    },
    async pull(image) {
      const stack = await json<Stack>(`/api/stacks/${config.stackId}`);
      const res = await call(
        f,
        "portainer",
        `${config.url}/api/endpoints/${stack.EndpointId}/docker/images/create?${new URLSearchParams({ fromImage: image })}`,
        { method: "POST", headers },
      );
      // The Docker API streams progress; an error appears in the body, not the status.
      const text = await res.text();
      if (!res.ok || /"error"\s*:/.test(text)) throw new DeployAdapterError("pull-failed");
    },
    async setImage(image) {
      // Read fresh immediately before writing, so other changes are preserved.
      const stack = await json<Stack>(`/api/stacks/${config.stackId}`);
      const file = await json<{ StackFileContent: string }>(`/api/stacks/${config.stackId}/file`);
      if (!stack.Env.some((e) => e.name === config.imageVariable)) {
        throw new DeployAdapterError("image-variable-missing");
      }
      const env = stack.Env.map((e) =>
        e.name === config.imageVariable ? { ...e, value: image } : e,
      );
      await json(`/api/stacks/${config.stackId}?endpointId=${stack.EndpointId}`, {
        method: "PUT",
        body: JSON.stringify({
          stackFileContent: file.StackFileContent,
          env,
          prune: false,
          pullImage: false,
        }),
      });
    },
  };
}

/** Bounded readiness: every page must answer 200 before the deadline. */
export function httpReadiness(config: {
  baseUrl: string;
  paths?: string[];
  deadlineMs?: number;
  intervalMs?: number;
  fetch?: Fetch;
}): ReadinessPort {
  const f = config.fetch ?? fetch;
  const paths = config.paths ?? ["/health", "/articles", "/drafts"];
  const deadline = config.deadlineMs ?? 120_000;
  const interval = config.intervalMs ?? 5_000;
  return {
    async ready() {
      const end = Date.now() + deadline;
      for (;;) {
        let ok = true;
        for (const path of paths) {
          try {
            const res = await f(`${config.baseUrl}${path}`, {
              signal: AbortSignal.timeout(Math.min(TIMEOUT_MS, deadline)),
            });
            await res.arrayBuffer();
            // A page whose render failed still answers 200, flagged by the server.
            if (res.status !== 200 || res.headers.get("x-view-status") === "unavailable")
              ok = false;
          } catch {
            ok = false;
          }
          if (!ok) break;
        }
        if (ok) return true;
        if (Date.now() + interval > end) return false;
        await new Promise((r) => setTimeout(r, interval));
      }
    },
  };
}
