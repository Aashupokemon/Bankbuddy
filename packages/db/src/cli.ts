import { migrate, resetSchema } from "./migrate.ts";
import { seed } from "./seed.ts";
import { openDatabase } from "./index.ts";

const command = process.argv[2] ?? "migrate";

async function main(): Promise<void> {
  const database = await openDatabase();
  try {
    if (command === "migrate") {
      const ran = await migrate(database);
      console.log(ran.length ? `Applied migrations: ${ran.join(", ")}` : "No pending migrations.");
      return;
    }

    if (command === "seed") {
      await migrate(database);
      const summary = await seed(database);
      console.log(`Seeded workspace ${summary.workspaceId} with ${summary.taskCount} synthetic tasks.`);
      for (const branch of summary.branches) {
        console.log(`  ${branch.name} (${branch.timezone})`);
        for (const user of branch.users) console.log(`    ${user.role.padEnd(16)} ${user.email}`);
      }
      return;
    }

    if (command === "reset") {
      await resetSchema(database);
      await migrate(database);
      const summary = await seed(database);
      console.log(`Reset complete. ${summary.taskCount} synthetic tasks across ${summary.branches.length} branches.`);
      return;
    }

    console.error(`Unknown command "${command}". Use migrate, seed or reset.`);
    process.exitCode = 1;
  } finally {
    await database.close();
  }
}

await main();
