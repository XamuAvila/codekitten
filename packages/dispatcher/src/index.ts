import { createApp } from "./server.js";

const port = Number(process.env.PORT ?? "3001");
const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";
const namespace = process.env.K8S_NAMESPACE ?? "kitten";
const reviewerImage = process.env.REVIEWER_IMAGE ?? "kitten-reviewer:latest";
const idleTimeoutMs = Number(process.env.POD_IDLE_TIMEOUT_MS ?? "600000");
const sembleImage = process.env.SEMBLE_IMAGE;
const sembleIndexPvc = process.env.SEMBLE_INDEX_PVC;
const webhookSecret = process.env.WEBHOOK_SECRET;
const triggerWord = process.env.TRIGGER_WORD ?? "@reviewer";

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
  },
});

app.listen(port, () => {
  console.log(`[dispatcher] starting on port ${port}`);
});
