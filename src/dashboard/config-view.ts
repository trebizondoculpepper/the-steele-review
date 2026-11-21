import {
  inspectSettings,
  resolveSettings,
  type InspectedSetting,
} from "../config/settings.js";

/**
 * Read-only configuration page for the console (#544).
 *
 * Renders only the configuration controller's safe projection: public values,
 * and for everything else just configured/missing/invalid plus where the value
 * came from. Credentials, endpoints, hosts and file contents never reach the
 * browser, and an observed file is not treated as proof that the running
 * process loaded it.
 */

function esc(value: string): string {
  return value.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

function valueCell(setting: InspectedSetting): string {
  // Defence in depth: even if a caller hands us a value for a non-public
  // setting, the page never renders it.
  if (setting.sensitivity !== "public") return "(not shown)";
  if (setting.state !== "configured" && setting.state !== "default") return "—";
  return setting.value === undefined ? "(not shown)" : esc(String(setting.value));
}

export function renderConfig(inspected: readonly InspectedSetting[]): string {
  if (inspected.length === 0) return '<p class="empty">No settings are registered.</p>';
  const domains = [...new Set(inspected.map((s) => s.domain))].sort();
  return domains
    .map((domain) => {
      const rows = inspected
        .filter((s) => s.domain === domain)
        .map(
          (s) =>
            `<tr><td>${esc(s.key)}</td><td>${esc(s.description)}</td><td>${valueCell(s)}</td><td>${s.state}</td><td>${s.source}</td></tr>`,
        )
        .join("");
      return `<h2>${esc(domain)}</h2><table><thead><tr><th>Setting</th><th>Description</th><th>Value</th><th>State</th><th>Origin</th></tr></thead><tbody>${rows}</tbody></table>`;
    })
    .join("");
}

/** The page body from the runtime environment and saved configuration file. */
export function configPage(env: NodeJS.ProcessEnv, file: Record<string, string> = {}): string {
  return renderConfig(inspectSettings(resolveSettings(env, file)));
}
