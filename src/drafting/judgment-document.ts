const NONE = /^none\.?$/i;
export const emptyGuidance = (text: string) => NONE.test(text.trim());
/** Complete, unambiguous role output; section boundaries also define revision authority. */
export function parseJudgmentDocument(document: string) {
  const lines = document.split(/\r?\n/),
    last = document.trim().split(/\r?\n/).at(-1)?.trim();
  const decision: "approve" | "revise" | undefined =
    last === "DECISION: APPROVE" ? "approve" : last === "DECISION: REVISE" ? "revise" : undefined;
  if (!decision || lines.filter((line) => line.trim().startsWith("DECISION:")).length !== 1)
    return undefined;
  const section = (name: string) => {
    const starts = lines.flatMap((line, i) =>
      line.trim().toLowerCase() === `## ${name}`.toLowerCase() ? [i] : [],
    );
    if (starts.length !== 1) return undefined;
    const start = starts[0]!,
      end = lines.findIndex((line, i) => i > start && /^##\s/.test(line.trim()));
    return lines
      .slice(start + 1, end < 0 ? undefined : end)
      .filter((line) => !line.trim().startsWith("DECISION:"))
      .join("\n")
      .trim();
  };
  const reasons = section("Reasons"),
    requiredCorrections = section("Required corrections"),
    acceptedMinorObservations = section("Accepted minor observations");
  if (!reasons || emptyGuidance(reasons) || !requiredCorrections || !acceptedMinorObservations)
    return undefined;
  if (decision === "revise" && emptyGuidance(requiredCorrections)) return undefined;
  if (decision === "approve" && !emptyGuidance(requiredCorrections)) return undefined;
  return { decision, reasons, requiredCorrections, acceptedMinorObservations };
}
