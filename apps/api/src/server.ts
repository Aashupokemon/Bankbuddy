import { openDatabase } from "@bankbuddy/db";

import { migrate } from "../../../packages/db/src/migrate.ts";
import { createApp } from "./app.ts";

const requestedPort = Number(process.env.PORT ?? "");
const port = Number.isInteger(requestedPort) && requestedPort > 0 ? requestedPort : 8787;

const database = await openDatabase();
const ran = await migrate(database);
if (ran.length) console.log(`[api] applied migrations: ${ran.join(", ")}`);

const app = createApp(database);
const server = app.listen(port, () => {
  console.log(`[api] listening on http://127.0.0.1:${port}`);
});

const shutdown = async (): Promise<void> => {
  console.log("[api] shutting down");
  server.close();
  await database.close();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
