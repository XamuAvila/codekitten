import { createApp } from "./server.js";

const port = Number(process.env.PORT ?? "3000");
const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";

const app = createApp(redisUrl);

app.listen(port, () => {
  console.log(`[dispatcher] starting on port ${port}`);
});
