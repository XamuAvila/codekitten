import { AppError } from "@kitten/shared";
import { createApp } from "./server.js";
import { parsePodScheduling } from "./k8s/scheduling.js";

const port = Number(process.env.PORT ?? "3001");
const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";
const namespace = process.env.K8S_NAMESPACE ?? "kitten";
const reviewerImage = process.env.REVIEWER_IMAGE ?? "kitten-reviewer:latest";
const idleTimeoutMs = Number(process.env.POD_IDLE_TIMEOUT_MS ?? "600000");
const sembleImage = process.env.SEMBLE_IMAGE;
const sembleIndexPvc = process.env.SEMBLE_INDEX_PVC;
const webhookSecret = process.env.WEBHOOK_SECRET;
const triggerWord = process.env.TRIGGER_WORD ?? "@reviewer";

// v10 — scheduling controls for reviewer Pods. Fail fast on an invalid value:
// ignoring broken scheduling would put review Pods on the wrong nodes, the
// exact outcome the setting exists to prevent. Absent/empty is fine and means
// "no constraints". This deliberately breaks the v3–v7 degrade-with-a-warning
// pattern; rationale recorded in the v10 epic.
let scheduling: ReturnType<typeof parsePodScheduling>;
try {
  scheduling = parsePodScheduling(process.env.REVIEWER_POD_SCHEDULING);
} catch (error) {
  if (error instanceof AppError) {
    console.error(
      `[dispatcher] ${error.code}: ${error.message}`,
      ...(error.details?.length ? [JSON.stringify(error.details)] : []),
    );
  } else {
    console.error("[dispatcher] Failed to parse REVIEWER_POD_SCHEDULING", error);
  }
  process.exit(1);
}

if (!webhookSecret) {
  console.warn("[dispatcher] WEBHOOK_SECRET not set — /webhook/github will answer 503");
}

const app = createApp({
  redisUrl,
  webhookSecret,
  triggerWord,
  podConfig: {
    namespace,
    image: reviewerImage,
    idleTimeoutMs,
    redisUrl,
    ...(sembleImage !== undefined ? { sembleImage } : {}),
    ...(sembleIndexPvc !== undefined ? { sembleIndexPvc } : {}),
    ...(scheduling !== undefined ? { scheduling } : {}),
  },
});

app.listen(port, () => {
  console.log(`[dispatcher] starting on port ${port}`);
});
