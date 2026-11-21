#!/usr/bin/env bash
# Summarise a Trivy JSON report as Markdown for the job summary (#297).
# Secrets: rule IDs, categories and file paths only; never the matched text.
# Vulnerabilities: counts by severity and a bounded table, fixed and unfixed.
# A missing or unreadable report is reported as such (the scan step itself
# fails closed).
set -euo pipefail
kind="$1"
report="$2"

if [ ! -s "$report" ] || ! jq -e . "$report" > /dev/null 2>&1; then
  echo "### Trivy ${kind} scan"
  echo
  echo "No readable report: the scan did not complete."
  exit 0
fi

case "$kind" in
  secrets)
    count="$(jq '[.Results[]?.Secrets[]?] | length' "$report")"
    echo "### Trivy secret scan: ${count} finding(s)"
    echo
    if [ "$count" -gt 0 ]; then
      echo "| Rule | Category | Severity | Path |"
      echo "| --- | --- | --- | --- |"
      jq -r '.Results[]? as $r | $r.Secrets[]? | "| \(.RuleID) | \(.Category) | \(.Severity) | `\($r.Target)` |"' "$report" | head -50
    fi
    ;;
  vulns)
    echo "### Trivy vulnerability report (not a gate)"
    echo
    echo "| Severity | Total | With a fix | Without a fix |"
    echo "| --- | --- | --- | --- |"
    jq -r '
      [.Results[]?.Vulnerabilities[]?] as $v
      | ["CRITICAL","HIGH","MEDIUM","LOW","UNKNOWN"][] as $s
      | ($v | map(select(.Severity == $s))) as $x
      | "| \($s) | \($x | length) | \($x | map(select(.FixedVersion)) | length) | \($x | map(select(.FixedVersion | not)) | length) |"' "$report"
    echo
    echo "<details><summary>Critical and high findings (first 50)</summary>"
    echo
    echo "| Severity | ID | Package | Installed | Fixed |"
    echo "| --- | --- | --- | --- | --- |"
    jq -r '[.Results[]?.Vulnerabilities[]? | select(.Severity == "CRITICAL" or .Severity == "HIGH")]
      | .[:50][] | "| \(.Severity) | \(.VulnerabilityID) | \(.PkgName) | \(.InstalledVersion) | \(.FixedVersion // "none") |"' "$report"
    echo
    echo "</details>"
    ;;
  *)
    echo "usage: trivy-summary.sh secrets|vulns <report.json>" >&2
    exit 2
    ;;
esac
