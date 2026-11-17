import {
  extractRequestSchema,
  extractionDraftSchema,
  type ExtractRequest,
  type ExtractResponse,
  type ExtractionDraft,
  type TaskPriority,
} from "@bankbuddy/contracts";
import { resolveDuePhrase } from "@bankbuddy/date";
import type { Queryable } from "@bankbuddy/db";

import type { Identity } from "./auth.ts";

/**
 * Assistant extraction.
 *
 * The model is an *untrusted* input source. It runs on a code path with no write access, its output
 * is schema-validated, and nothing reaches the database until a person confirms the draft in the
 * client. When no provider is configured — or the provider fails — a deterministic rule-based
 * extractor still produces a usable draft, so the feature degrades instead of breaking.
 */

export interface Member {
  id: string;
  name: string;
}

const SENSITIVE_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: "card_or_account_number", pattern: /\b\d{12,19}\b/g },
  { name: "phone_number", pattern: /\b(?:\+?\d{1,3}[\s-]?)?\d{10}\b/g },
  { name: "email_address", pattern: /\b[\w.+-]+@[\w-]+\.[\w.]{2,}\b/gi },
  { name: "ifsc_code", pattern: /\b[A-Z]{4}0[A-Z0-9]{6}\b/g },
];

export function redactSensitive(text: string): { text: string; detected: boolean } {
  let output = text;
  let detected = false;
  for (const { pattern } of SENSITIVE_PATTERNS) {
    if (pattern.test(output)) {
      detected = true;
      output = output.replace(pattern, "[redacted]");
    }
    pattern.lastIndex = 0;
  }
  return { text: output, detected };
}

const PRIORITY_HINTS: Array<{ priority: TaskPriority; pattern: RegExp }> = [
  { priority: "urgent", pattern: /\b(urgent|asap|immediately|right away|critical)\b/i },
  { priority: "high", pattern: /\b(high priority|important|before close|today itself)\b/i },
  { priority: "low", pattern: /\b(low priority|whenever|if time permits|someday)\b/i },
];

const CATEGORY_HINTS: Array<{ key: string; pattern: RegExp }> = [
  { key: "kyc", pattern: /\b(kyc|know your customer|address proof|documentation)\b/i },
  { key: "cash", pattern: /\b(cash|vault|locker|currency|teller)\b/i },
  { key: "audit", pattern: /\b(audit|compliance|observation|inspection)\b/i },
  { key: "customer_service", pattern: /\b(customer|client|account holder|complaint)\b/i },
];

function titleCase(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function trimToTitle(text: string): string {
  const cleaned = text
    .replace(/^(please|kindly|can you|could you|we need to|need to|i need|remind me to)\s+/i, "")
    .replace(/\s+/g, " ")
    .trim();
  const withoutDue = cleaned.replace(/\s+(by|before|due on|due by|on)\s+[^.,;]*$/i, "").trim();
  const base = (withoutDue.length >= 3 ? withoutDue : cleaned) || cleaned;
  const firstSentence = base.split(/[.;\n]/)[0] ?? base;
  const truncated = firstSentence.length > 110 ? `${firstSentence.slice(0, 107).trimEnd()}…` : firstSentence;
  return titleCase(truncated.trim());
}

function findAssignee(text: string, members: Member[]): { id: string; name: string } | null {
  const lowered = text.toLowerCase();
  const explicit = /\b(?:assign(?:ed)? to|hand(?:ed)? to|ask)\s+([a-z]+(?:\s[a-z]+)?)/i.exec(text);
  const willDo = /\b([A-Z][a-z]+(?:\s[A-Z][a-z]+)?)\s+will\b/.exec(text);
  const mention = /@([a-z]+)/i.exec(text);
  const candidate = explicit?.[1] ?? willDo?.[1] ?? mention?.[1];

  if (candidate) {
    const needle = candidate.toLowerCase().trim();
    const exact = members.find((m) => m.name.toLowerCase() === needle);
    if (exact) return exact;
    const first = members.find((m) => m.name.toLowerCase().split(" ")[0] === needle.split(" ")[0]);
    if (first) return first;
  }

  // Fall back to the first member mentioned by first name anywhere in the sentence.
  const mentioned = members.find((m) => lowered.includes(m.name.toLowerCase().split(" ")[0]!));
  return mentioned ?? null;
}

function findDuePhrase(text: string): string | null {
  const explicit = /\b(?:by|due(?:\s+on|\s+by)?|before|on)\s+([^.,;\n]+)/i.exec(text);
  if (explicit?.[1]) return explicit[1].trim();

  const inline = /\b(today|tomorrow|day after tomorrow|eod|end of day|in \d{1,3} (?:days|weeks)|next \w+day|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d{4}-\d{2}-\d{2})\b/i.exec(text);
  return inline?.[1]?.trim() ?? null;
}

export function rulesExtract(
  text: string,
  options: { timeZone: string; members: Member[]; now?: Date },
): { draft: ExtractionDraft; warnings: string[] } {
  const warnings: string[] = [];
  const assignee = findAssignee(text, options.members);
  const duePhrase = findDuePhrase(text);
  const priority = PRIORITY_HINTS.find((hint) => hint.pattern.test(text))?.priority ?? "normal";
  const category = CATEGORY_HINTS.find((hint) => hint.pattern.test(text))?.key ?? null;

  let dueAt: string | null = null;
  let duePrecision: "date" | "datetime" | null = null;

  if (duePhrase) {
    const resolved = resolveDuePhrase(duePhrase, {
      timeZone: options.timeZone,
      ...(options.now ? { now: options.now } : {}),
    });
    if (resolved?.dueAt) {
      dueAt = resolved.dueAt.toISOString();
      duePrecision = resolved.precision;
      warnings.push(...resolved.warnings);
    } else if (resolved && !resolved.dueAt) {
      warnings.push("due_date_needs_confirmation");
    } else {
      warnings.push("due_phrase_not_understood");
    }
  }

  if (!duePhrase) warnings.push("no_due_date_detected");
  if (!assignee) warnings.push("no_owner_detected");

  return {
    draft: {
      title: trimToTitle(text),
      description: text.trim(),
      ownerName: assignee?.name ?? null,
      duePhrase,
      dueAt,
      duePrecision,
      priority,
      categoryKey: category,
    },
    warnings,
  };
}

export interface AiProvider {
  name: string;
  extract(text: string, options: { timeZone: string; memberNames: string[] }): Promise<ExtractionDraft | null>;
}

/**
 * Optional OpenAI-compatible provider. Returns null unless explicitly configured, and any failure
 * (network, model, schema) falls back to the rules extractor rather than surfacing an error.
 */
export function createAiProvider(): AiProvider | null {
  const provider = (process.env.ASSISTANT_PROVIDER ?? "none").trim().toLowerCase();
  const apiKey = process.env.ASSISTANT_API_KEY?.trim();
  if (provider === "none" || !apiKey) return null;

  const baseUrl = process.env.ASSISTANT_BASE_URL?.trim() || "https://api.openai.com/v1";
  const model = process.env.ASSISTANT_MODEL?.trim() || "gpt-4o-mini";

  return {
    name: provider,
    async extract(text, options) {
      try {
        const response = await fetch(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({
            model,
            temperature: 0,
            response_format: { type: "json_object" },
            messages: [
              {
                role: "system",
                content:
                  "Extract one task from the sentence. Reply with JSON: title, description, ownerName, duePhrase, dueAt (ISO with offset or null), duePrecision ('date'|'datetime'|null), priority ('low'|'normal'|'high'|'urgent'), categoryKey (string|null). Never invent a due date. Only use these owners: " +
                  options.memberNames.join(", ") +
                  `. Assume the timezone ${options.timeZone}.`,
              },
              { role: "user", content: text },
            ],
          }),
          signal: AbortSignal.timeout(8000),
        });
        if (!response.ok) return null;
        const payload = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
        const content = payload.choices?.[0]?.message?.content;
        if (!content) return null;
        const parsed = extractionDraftSchema.safeParse(JSON.parse(content));
        return parsed.success ? parsed.data : null;
      } catch {
        return null;
      }
    },
  };
}

export async function extractDraft(
  db: Queryable,
  identity: Identity,
  request: ExtractRequest,
): Promise<ExtractResponse> {
  const input = extractRequestSchema.parse(request);
  const timeZone = input.timeZone ?? identity.timezone;

  const members = (
    await db.query<Member>(
      `select u.id, u.name from memberships m join users u on u.id = m.user_id where m.branch_id = $1 order by u.name`,
      [identity.branchId],
    )
  ).rows;

  const killed = (process.env.ASSISTANT_KILL_SWITCH ?? "false").toLowerCase() === "true";
  const provider = killed ? null : createAiProvider();

  const redacted = redactSensitive(input.text);
  const rules = rulesExtract(input.text, { timeZone, members });

  let draft: ExtractionDraft = rules.draft;
  const warnings = [...rules.warnings];
  let providerName: ExtractResponse["provider"] = "rules";

  if (provider) {
    const ai = await provider.extract(input.text, {
      timeZone,
      memberNames: members.map((m) => m.name),
    });
    if (ai) {
      draft = ai;
      providerName = "ai";
    } else {
      warnings.push("assistant_fallback_to_rules");
    }
  }
  if (killed) warnings.push("assistant_disabled");

  if (redacted.detected) {
    warnings.push("sensitive_data_detected");
    draft = { ...draft, description: redacted.text, title: redactSensitive(draft.title).text };
  }

  return {
    draft,
    warnings: [...new Set(warnings)],
    provider: providerName,
    requiresConfirmation: true,
    sensitiveDataDetected: redacted.detected,
  };
}
