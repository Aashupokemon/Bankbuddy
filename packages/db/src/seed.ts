import type { Database } from "./driver.ts";

/**
 * Synthetic data only. Every name, address and reference here is fabricated; nothing in this file
 * may be replaced with real bank or customer data.
 */

export interface SeedSummary {
  workspaceId: string;
  branches: Array<{ id: string; name: string; timezone: string; users: Array<{ id: string; email: string; role: string }> }>;
  taskCount: number;
}

const KOLKATA = "Asia/Kolkata";

export async function seed(database: Database): Promise<SeedSummary> {
  const existing = await database.query<{ count: string }>("select count(*)::text as count from workspaces");
  if ((existing.rows[0]?.count ?? "0") !== "0") {
    throw new Error("Database already seeded. Run `npm run db:reset` to start over.");
  }

  const workspace = (
    await database.query<{ id: string }>(
      "insert into workspaces (name) values ($1) returning id",
      ["BankBuddy Pilot Workspace (synthetic)"],
    )
  ).rows[0]!.id;

  const branchRows = await database.query<{ id: string }>(
    `insert into branches (workspace_id, name, timezone) values
       ($1, 'MG Road Branch', $2),
       ($1, 'Koramangala Branch', $2)
     returning id`,
    [workspace, KOLKATA],
  );
  const alphaId = branchRows.rows[0]!.id;
  const betaId = branchRows.rows[1]!.id;

  const people: Array<{ name: string; email: string; branch: "alpha" | "beta" | "both"; role: string }> = [
    { name: "Priya Menon", email: "priya@alpha.example", branch: "alpha", role: "manager" },
    { name: "Arun Das", email: "arun@alpha.example", branch: "alpha", role: "lead" },
    { name: "Ravi Kumar", email: "ravi@alpha.example", branch: "alpha", role: "employee" },
    { name: "Meera Iyer", email: "meera@alpha.example", branch: "alpha", role: "auditor" },
    { name: "Sanjay Rao", email: "sanjay@beta.example", branch: "beta", role: "manager" },
    { name: "Divya Nair", email: "divya@beta.example", branch: "beta", role: "employee" },
    { name: "Workspace Admin", email: "admin@workspace.example", branch: "both", role: "workspace_admin" },
  ];

  const users: Array<{ id: string; email: string; role: string; branchId: string }> = [];
  for (const person of people) {
    const id = (
      await database.query<{ id: string }>("insert into users (name, email) values ($1, $2) returning id", [
        person.name,
        person.email,
      ])
    ).rows[0]!.id;

    const targets: Array<{ branchId: string; role: string }> = [];
    if (person.branch === "alpha" || person.branch === "both") targets.push({ branchId: alphaId, role: person.role });
    if (person.branch === "beta" || person.branch === "both") targets.push({ branchId: betaId, role: person.role });

    for (const target of targets) {
      await database.query(
        `insert into memberships (workspace_id, branch_id, user_id, role)
         values ($1, $2, $3, $4)`,
        [workspace, target.branchId, id, target.role],
      );
      users.push({ id, email: person.email, role: target.role, branchId: target.branchId });
    }
  }

  const alphaUsers = users.filter((u) => u.branchId === alphaId);
  const manager = alphaUsers.find((u) => u.role === "manager")!;
  const lead = alphaUsers.find((u) => u.role === "lead")!;
  const employee = alphaUsers.find((u) => u.role === "employee")!;
  const betaEmployee = users.find((u) => u.branchId === betaId && u.role === "employee")!;

  for (const branchId of [alphaId, betaId]) {
    await database.query(
      `insert into branch_settings (branch_id, quiet_hours_start, quiet_hours_end, reminder_lead_minutes, weekly_overdue_day)
       values ($1, '19:00', '08:00', 120, 1)`,
      [branchId],
    );
    const categories: Array<[string, string]> = [
      ["kyc", "KYC and documentation"],
      ["cash", "Cash and vault"],
      ["customer_service", "Customer service"],
      ["audit", "Audit and compliance"],
    ];
    for (const [key, label] of categories) {
      await database.query("insert into categories (branch_id, key, label) values ($1, $2, $3)", [
        branchId,
        key,
        label,
      ]);
    }
    await database.query("insert into holidays (branch_id, day, label) values ($1, $2, $3)", [
      branchId,
      "2026-12-25",
      "Synthetic holiday",
    ]);
  }

  const now = Date.now();
  const iso = (offsetHours: number): string => new Date(now + offsetHours * 3600_000).toISOString();

  interface SeedTask {
    title: string;
    description: string;
    status: string;
    priority: string;
    category: string | null;
    ownerId: string | null;
    dueAt: string | null;
    duePrecision: "date" | "datetime" | null;
    blockedReason?: string | null;
    recurrence?: string | null;
  }

  const alphaTasks: SeedTask[] = [
    {
      title: "Collect pending KYC documents for the Sharma account",
      description: "Call the customer and collect the address proof before the file goes for review.",
      status: "open",
      priority: "high",
      category: "kyc",
      ownerId: employee.id,
      dueAt: iso(30),
      duePrecision: "datetime",
    },
    {
      title: "Reconcile the vault count against the register",
      description: "Evening reconciliation, differencing to be signed by the manager.",
      status: "in_progress",
      priority: "urgent",
      category: "cash",
      ownerId: lead.id,
      dueAt: iso(4),
      duePrecision: "datetime",
    },
    {
      title: "Overdue: respond to the audit observation on cheque storage",
      description: "Audit observation 4.2 is past its response date.",
      status: "open",
      priority: "urgent",
      category: "audit",
      ownerId: manager.id,
      dueAt: iso(-26),
      duePrecision: "date",
    },
    {
      title: "Fix the cheque-book request backlog",
      description: "Three requests are stuck at the printer integration step.",
      status: "blocked",
      priority: "high",
      category: "customer_service",
      ownerId: employee.id,
      dueAt: iso(52),
      duePrecision: "date",
      blockedReason: "Waiting for the vendor to restore the printer integration.",
    },
    {
      title: "Hand over the locker key register for the evening shift",
      description: "Physical register and the digital entry must match at shift change.",
      status: "open",
      priority: "normal",
      category: "cash",
      ownerId: null,
      dueAt: iso(10),
      duePrecision: "datetime",
    },
    {
      title: "Weekly review of dormant account list",
      description: "Recurring review of the synthetic dormant list.",
      status: "open",
      priority: "normal",
      category: "audit",
      ownerId: lead.id,
      dueAt: iso(72),
      duePrecision: "date",
      recurrence: "weekly",
    },
    {
      title: "Confirm the new customer onboarding checklist",
      description: "Completed after the branch meeting.",
      status: "done",
      priority: "normal",
      category: "customer_service",
      ownerId: employee.id,
      dueAt: iso(-50),
      duePrecision: "date",
    },
    {
      title: "Cancel the duplicate stationery order",
      description: "Order raised twice by mistake.",
      status: "cancelled",
      priority: "low",
      category: null,
      ownerId: manager.id,
      dueAt: iso(-10),
      duePrecision: "date",
    },
  ];

  let taskCount = 0;
  const createdIds: string[] = [];
  for (const task of alphaTasks) {
    const id = (
      await database.query<{ id: string }>(
        `insert into tasks (
           branch_id, title, description, status, priority, category_key, owner_id, unassigned_explicit,
           blocked_reason, due_at, due_precision, completed_at, completed_by, recurrence_rule,
           created_by, updated_by, version
         ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::timestamptz,$11,$12,$13,$14,$15,$15,1)
         returning id`,
        [
          alphaId,
          task.title,
          task.description,
          task.status,
          task.priority,
          task.category,
          task.ownerId,
          task.ownerId === null,
          task.blockedReason ?? null,
          task.dueAt,
          task.dueAt === null ? null : task.duePrecision,
          task.status === "done" ? iso(-48) : null,
          task.status === "done" ? employee.id : null,
          task.recurrence ?? null,
          manager.id,
        ],
      )
    ).rows[0]!.id;
    createdIds.push(id);
    taskCount += 1;

    await database.query(
      `insert into task_events (branch_id, task_id, actor_id, kind, summary, after)
       values ($1, $2, $3, 'created', $4, $5::jsonb)`,
      [alphaId, id, manager.id, `Created “${task.title}”`, JSON.stringify({ title: task.title, status: task.status })],
    );
    await database.query(
      `insert into audit_events (branch_id, actor_id, action, entity_type, entity_id, after)
       values ($1, $2, 'task.create', 'task', $3, $4::jsonb)`,
      [alphaId, manager.id, id, JSON.stringify({ title: task.title, status: task.status })],
    );
  }

  // One dependency: the KYC task blocks the audit response.
  await database.query(
    `insert into task_dependencies (branch_id, task_id, depends_on_task_id, created_by)
     values ($1, $2, $3, $4)`,
    [alphaId, createdIds[2]!, createdIds[0]!, lead.id],
  );

  await database.query(
    `insert into task_comments (branch_id, task_id, author_id, body)
     values ($1, $2, $3, $4)`,
    [alphaId, createdIds[0]!, lead.id, "Customer said the document will be ready by Thursday."],
  );

  const betaTasks: SeedTask[] = [
    {
      title: "Branch opening checklist",
      description: "Synthetic checklist for the morning shift.",
      status: "done",
      priority: "normal",
      category: "customer_service",
      ownerId: betaEmployee.id,
      dueAt: iso(-20),
      duePrecision: "date",
    },
    {
      title: "Archive last quarter's visitor register",
      description: "Move the synthetic register to the archive shelf.",
      status: "open",
      priority: "low",
      category: "audit",
      ownerId: betaEmployee.id,
      dueAt: iso(120),
      duePrecision: "date",
    },
  ];

  for (const task of betaTasks) {
    await database.query(
      `insert into tasks (branch_id, title, description, status, priority, category_key, owner_id,
         unassigned_explicit, due_at, due_precision, created_by, updated_by, version)
       values ($1,$2,$3,$4,$5,$6,$7,false,$8::timestamptz,$9,$10,$10,1)`,
      [
        betaId,
        task.title,
        task.description,
        task.status,
        task.priority,
        task.category,
        task.ownerId,
        task.dueAt,
        task.dueAt === null ? null : task.duePrecision,
        betaEmployee.id,
      ],
    );
    taskCount += 1;
  }

  return {
    workspaceId: workspace,
    branches: [
      {
        id: alphaId,
        name: "MG Road Branch",
        timezone: KOLKATA,
        users: alphaUsers.map((u) => ({ id: u.id, email: u.email, role: u.role })),
      },
      {
        id: betaId,
        name: "Koramangala Branch",
        timezone: KOLKATA,
        users: users
          .filter((u) => u.branchId === betaId)
          .map((u) => ({ id: u.id, email: u.email, role: u.role })),
      },
    ],
    taskCount,
  };
}
