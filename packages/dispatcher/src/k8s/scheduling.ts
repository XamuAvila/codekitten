import { z } from "zod";
import { AppError } from "@kitten/shared";

/**
 * Reviewer Pod scheduling controls (v10). Parsed from REVIEWER_POD_SCHEDULING
 * at dispatcher boot and spread into the Pod spec when present.
 *
 * strictObject at every level: an unknown key is a VALIDATION error, never a
 * silent strip — same rationale as RawReviewerSchema (parse-config.ts) and
 * MCPConfigSchema (mcp-config.ts). A typo in a scheduling key must not be
 * swallowed, because the visible symptom would be Pods on the wrong nodes.
 */
const TolerationSchema = z.strictObject({
  key: z.string().min(1).optional(),
  operator: z.enum(["Equal", "Exists"]).optional(),
  value: z.string().optional(),
  effect: z.enum(["NoSchedule", "PreferNoSchedule", "NoExecute"]).optional(),
  tolerationSeconds: z.number().int().nonnegative().optional(),
});

export const PodSchedulingSchema = z.strictObject({
  nodeSelector: z.record(z.string(), z.string()).optional(),
  tolerations: z.array(TolerationSchema).readonly().optional(),
  serviceAccountName: z.string().min(1).optional(),
});

export type PodScheduling = z.infer<typeof PodSchedulingSchema>;

/**
 * Parses REVIEWER_POD_SCHEDULING. Empty/absent → undefined (current behavior).
 * Invalid JSON or schema violation → AppError VALIDATION; the caller exits.
 */
export function parsePodScheduling(json: string | undefined): PodScheduling | undefined {
  if (json === undefined || json.trim() === "") {
    return undefined;
  }

  let document: unknown;
  try {
    document = JSON.parse(json);
  } catch (error) {
    throw new AppError("VALIDATION", "Invalid JSON in REVIEWER_POD_SCHEDULING", [
      { message: error instanceof Error ? error.message : String(error) },
    ]);
  }

  const result = PodSchedulingSchema.safeParse(document);
  if (!result.success) {
    throw new AppError(
      "VALIDATION",
      "Invalid REVIEWER_POD_SCHEDULING schema",
      result.error.issues.map((issue) => ({
        // zod 4 reports an unknown key on a strictObject as `unrecognized_keys`
        // with the offending names in `keys` and an empty `path` — surface
        // them as the path so the operator sees exactly which key is wrong.
        path:
          issue.path.join(".") ||
          (issue.code === "unrecognized_keys" ? (issue.keys ?? []).join(",") : ""),
        code: issue.code,
        message: issue.message,
      })),
    );
  }
  return result.data;
}
