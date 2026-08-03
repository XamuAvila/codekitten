import { createApp } from "./server.js";

const port = Number(process.env.PORT ?? "3001");
const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";
const namespace = process.env.K8S_NAMESPACE ?? "kitten";
const reviewerImage = process.env.REVIEWER_IMAGE ?? "kitten-reviewer:latest";
const idleTimeoutMs = Number(process.env.POD_IDLE_TIMEOUT_MS ?? "600000");

const app = createApp({
  redisUrl,
  podConfig: {
    namespace,
    image: reviewerImage,
    idleTimeoutMs,
    redisUrl,
  },
});

app.listen(port, () => {
  console.log(`[dispatcher] starting on port ${port}`);
});
