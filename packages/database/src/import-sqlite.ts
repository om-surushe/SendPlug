import { Database as SQLite } from "bun:sqlite";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { open, stat } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import type {
  CampaignStatus,
  Database,
  MembershipRole,
  RecipientStatus,
} from "./index";

const LEGACY_ACCOUNT_ID = "account_legacy_admin";
const SUPPORTED_USER_VERSION = 0;
const TABLES = [
  "accounts",
  "users",
  "memberships",
  "senders",
  "api_tokens",
  "quota_reservations",
  "campaigns",
  "campaign_recipients",
] as const;

const REQUIRED_COLUMNS: Record<string, readonly string[]> = {
  accounts: ["id", "name", "created_at"],
  users: [
    "id",
    "provider",
    "provider_subject",
    "email",
    "name",
    "created_at",
    "last_login_at",
  ],
  memberships: ["account_id", "user_id", "role", "created_at"],
  senders: [
    "id",
    "account_id",
    "name",
    "email",
    "encrypted_password",
    "smtp_host",
    "smtp_port",
    "use_tls",
    "daily_limit",
    "active",
    "created_at",
    "updated_at",
  ],
  api_tokens: [
    "id",
    "name",
    "prefix",
    "token_hash",
    "scopes",
    "sender_id",
    "created_at",
    "last_used_at",
    "revoked_at",
  ],
  quota_reservations: [
    "message_id",
    "sender_id",
    "recipient_count",
    "quota_date",
    "created_at",
  ],
  campaigns: [
    "id",
    "name",
    "sender_id",
    "subject",
    "body",
    "html",
    "status",
    "total",
    "sent",
    "failed",
    "created_at",
    "started_at",
    "completed_at",
  ],
  campaign_recipients: [
    "id",
    "campaign_id",
    "email",
    "status",
    "message_id",
    "error",
    "updated_at",
  ],
  account_suppressions: ["account_id", "email", "reason", "created_at"],
  suppressions: ["email", "reason", "created_at"],
};

type Row = Record<string, unknown>;
type ImportData = ReturnType<typeof readImportData>;
type ImportCounts = Record<keyof ImportData, number>;
type ImportChecksums = Record<keyof ImportData | "overall", string>;
type ExactTimestamp = {
  table: string;
  column: string;
  keys: Array<[string, string]>;
  value: string | null;
};

const EXACT_TIMESTAMP_SPECS = [
  ["accounts", ["id"], ["created_at"]],
  ["users", ["id"], ["created_at", "last_login_at"]],
  ["memberships", ["account_id", "user_id"], ["created_at"]],
  ["senders", ["id"], ["created_at", "updated_at"]],
  ["api_tokens", ["id"], ["created_at", "last_used_at", "revoked_at"]],
  ["quota_reservations", ["message_id"], ["created_at"]],
  ["campaigns", ["id"], ["created_at", "started_at", "completed_at"]],
  ["campaign_recipients", ["id"], ["updated_at"]],
] as const;

function tableExists(sqlite: SQLite, table: string): boolean {
  return Boolean(
    sqlite
      .query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table),
  );
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function rows(sqlite: SQLite, table: string): Row[] {
  return sqlite.query(`SELECT * FROM ${quoteIdentifier(table)}`).all() as Row[];
}

function text(row: Row, column: string, table: string): string {
  const value = row[column];
  if (typeof value !== "string")
    throw new Error(
      `${table}.${column} must be TEXT, got ${sqliteType(value)}`,
    );
  return value;
}

function nullableText(row: Row, column: string, table: string): string | null {
  return row[column] == null ? null : text(row, column, table);
}

function integer(row: Row, column: string, table: string): number {
  const value = row[column];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error(
      `${table}.${column} must be INTEGER, got ${sqliteType(value)}`,
    );
  }
  return value;
}

function booleanInteger(row: Row, column: string, table: string): boolean {
  const value = integer(row, column, table);
  if (value !== 0 && value !== 1)
    throw new Error(`${table}.${column} must be 0 or 1, got ${value}`);
  return value === 1;
}

function sqliteType(value: unknown): string {
  if (value == null) return "NULL";
  if (typeof value === "string") return "TEXT";
  if (typeof value === "number")
    return Number.isInteger(value) ? "INTEGER" : "REAL";
  if (value instanceof Uint8Array) return "BLOB";
  return typeof value;
}

function fernetToken(row: Row): string {
  const value = row.encrypted_password;
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) return Buffer.from(value).toString("utf8");
  throw new Error(
    `senders.encrypted_password must be TEXT or BLOB, got ${sqliteType(value)}`,
  );
}

function timestamp(value: string, location: string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf()))
    throw new Error(`${location} is not a valid timestamp: ${value}`);
  return parsed;
}

function requiredTimestamp(row: Row, column: string, table: string): Date {
  return timestamp(text(row, column, table), `${table}.${column}`);
}

function nullableTimestamp(
  row: Row,
  column: string,
  table: string,
): Date | null {
  const value = nullableText(row, column, table);
  return value == null ? null : timestamp(value, `${table}.${column}`);
}

function quotaDate(row: Row): Date {
  const value = text(row, "quota_date", "quota_reservations");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(
      `quota_reservations.quota_date must be YYYY-MM-DD, got ${value}`,
    );
  }
  return timestamp(`${value}T00:00:00.000Z`, "quota_reservations.quota_date");
}

function exactTimestamp(value: string, location: string): string {
  timestamp(value, location);
  const match = value.match(
    /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(?:Z|\+00:00)$/,
  );
  if (!match) {
    throw new Error(`${location} must be a UTC timestamp with at most 6 fractional digits`);
  }
  return `${match[1]}T${match[2]}.${(match[3] ?? "").padEnd(6, "0")}Z`;
}

function readExactTimestamps(sqlite: SQLite): ExactTimestamp[] {
  const records: ExactTimestamp[] = [];
  for (const [table, keys, columns] of EXACT_TIMESTAMP_SPECS) {
    for (const row of rows(sqlite, table)) {
      for (const column of columns) {
        const raw = nullableText(row, column, table);
        records.push({
          table,
          column,
          keys: keys.map((key) => [key, text(row, key, table)]),
          value: raw == null ? null : exactTimestamp(raw, `${table}.${column}`),
        });
      }
    }
  }
  const sourceTable = suppressionTable(sqlite);
  for (const row of rows(sqlite, sourceTable)) {
    const raw = text(row, "created_at", sourceTable);
    records.push({
      table: "account_suppressions",
      column: "created_at",
      keys: [
        ["account_id", sourceTable === "suppressions" ? LEGACY_ACCOUNT_ID : text(row, "account_id", sourceTable)],
        ["email", text(row, "email", sourceTable)],
      ],
      value: exactTimestamp(raw, `${sourceTable}.created_at`),
    });
  }
  return records;
}

function enumValue<T extends string>(
  row: Row,
  column: string,
  table: string,
  allowed: readonly T[],
): T {
  const value = text(row, column, table).toUpperCase();
  if (!allowed.includes(value as T))
    throw new Error(`${table}.${column} has unsupported value: ${value}`);
  return value as T;
}

function scopes(row: Row): string[] {
  const raw = text(row, "scopes", "api_tokens");
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("api_tokens.scopes must be a JSON array of strings");
  }
  if (
    !Array.isArray(value) ||
    value.some((scope) => typeof scope !== "string")
  ) {
    throw new Error("api_tokens.scopes must be a JSON array of strings");
  }
  return value;
}

function suppressionTable(
  sqlite: SQLite,
): "account_suppressions" | "suppressions" {
  if (tableExists(sqlite, "account_suppressions"))
    return "account_suppressions";
  if (tableExists(sqlite, "suppressions")) return "suppressions";
  throw new Error(
    "SQLite schema is missing suppression table (account_suppressions or suppressions)",
  );
}

function preflight(sqlite: SQLite) {
  const version = sqlite.query("PRAGMA user_version").get() as {
    user_version: number;
  };
  const schemaVersion = sqlite.query("PRAGMA schema_version").get() as {
    schema_version: number;
  };
  if (version.user_version !== SUPPORTED_USER_VERSION) {
    throw new Error(
      `Unsupported SQLite user_version ${version.user_version}; expected ${SUPPORTED_USER_VERSION}`,
    );
  }

  const selectedSuppressionTable = suppressionTable(sqlite);
  for (const table of [...TABLES, selectedSuppressionTable]) {
    if (!tableExists(sqlite, table))
      throw new Error(`SQLite schema is missing table: ${table}`);
    const actual = new Set(
      (
        sqlite
          .query(`PRAGMA table_info(${quoteIdentifier(table)})`)
          .all() as Array<{ name: string }>
      ).map(({ name }) => name),
    );
    const missing = REQUIRED_COLUMNS[table]!.filter(
      (column) => !actual.has(column),
    );
    if (missing.length)
      throw new Error(
        `SQLite table ${table} is missing columns: ${missing.join(", ")}`,
      );
  }

  const integrity = sqlite.query("PRAGMA integrity_check").all() as Array<{
    integrity_check: string;
  }>;
  if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok") {
    throw new Error(
      `SQLite integrity_check failed: ${JSON.stringify(integrity)}`,
    );
  }
  const foreignKeyViolations = sqlite.query("PRAGMA foreign_key_check").all();
  if (foreignKeyViolations.length) {
    throw new Error(
      `SQLite foreign_key_check failed: ${JSON.stringify(foreignKeyViolations)}`,
    );
  }
  return {
    userVersion: version.user_version,
    schemaVersion: schemaVersion.schema_version,
    suppressionTable: selectedSuppressionTable,
    integrityCheck: "ok" as const,
    foreignKeyViolations: 0,
  };
}

function readImportData(sqlite: SQLite) {
  const suppressions = suppressionTable(sqlite);
  return {
    accounts: rows(sqlite, "accounts").map((row) => ({
      id: text(row, "id", "accounts"),
      name: text(row, "name", "accounts"),
      createdAt: requiredTimestamp(row, "created_at", "accounts"),
    })),
    users: rows(sqlite, "users").map((row) => ({
      id: text(row, "id", "users"),
      provider: text(row, "provider", "users"),
      providerSubject: text(row, "provider_subject", "users"),
      email: text(row, "email", "users"),
      name: text(row, "name", "users"),
      createdAt: requiredTimestamp(row, "created_at", "users"),
      lastLoginAt: requiredTimestamp(row, "last_login_at", "users"),
    })),
    memberships: rows(sqlite, "memberships").map((row) => ({
      accountId: text(row, "account_id", "memberships"),
      userId: text(row, "user_id", "memberships"),
      role: enumValue(row, "role", "memberships", [
        "OWNER",
        "MEMBER",
      ] as const) as MembershipRole,
      createdAt: requiredTimestamp(row, "created_at", "memberships"),
    })),
    senders: rows(sqlite, "senders").map((row) => ({
      id: text(row, "id", "senders"),
      accountId: text(row, "account_id", "senders"),
      name: text(row, "name", "senders"),
      email: text(row, "email", "senders"),
      legacyEncryptedSecret: fernetToken(row),
      smtpHost: text(row, "smtp_host", "senders"),
      smtpPort: integer(row, "smtp_port", "senders"),
      useTls: booleanInteger(row, "use_tls", "senders"),
      dailyLimit: integer(row, "daily_limit", "senders"),
      active: booleanInteger(row, "active", "senders"),
      createdAt: requiredTimestamp(row, "created_at", "senders"),
      updatedAt: requiredTimestamp(row, "updated_at", "senders"),
    })),
    apiTokens: rows(sqlite, "api_tokens").map((row) => ({
      id: text(row, "id", "api_tokens"),
      name: text(row, "name", "api_tokens"),
      prefix: text(row, "prefix", "api_tokens"),
      tokenHash: text(row, "token_hash", "api_tokens"),
      scopes: scopes(row),
      senderId: nullableText(row, "sender_id", "api_tokens"),
      createdAt: requiredTimestamp(row, "created_at", "api_tokens"),
      lastUsedAt: nullableTimestamp(row, "last_used_at", "api_tokens"),
      revokedAt: nullableTimestamp(row, "revoked_at", "api_tokens"),
    })),
    quotaReservations: rows(sqlite, "quota_reservations").map((row) => ({
      messageId: text(row, "message_id", "quota_reservations"),
      senderId: text(row, "sender_id", "quota_reservations"),
      recipientCount: integer(row, "recipient_count", "quota_reservations"),
      quotaDate: quotaDate(row),
      createdAt: requiredTimestamp(row, "created_at", "quota_reservations"),
    })),
    campaigns: rows(sqlite, "campaigns").map((row) => ({
      id: text(row, "id", "campaigns"),
      name: text(row, "name", "campaigns"),
      senderId: text(row, "sender_id", "campaigns"),
      subject: text(row, "subject", "campaigns"),
      body: text(row, "body", "campaigns"),
      html: nullableText(row, "html", "campaigns"),
      status: enumValue(row, "status", "campaigns", [
        "DRAFT",
        "QUEUED",
        "SENDING",
        "COMPLETED",
      ] as const) as CampaignStatus,
      total: integer(row, "total", "campaigns"),
      sent: integer(row, "sent", "campaigns"),
      failed: integer(row, "failed", "campaigns"),
      createdAt: requiredTimestamp(row, "created_at", "campaigns"),
      startedAt: nullableTimestamp(row, "started_at", "campaigns"),
      completedAt: nullableTimestamp(row, "completed_at", "campaigns"),
    })),
    campaignRecipients: rows(sqlite, "campaign_recipients").map((row) => ({
      id: text(row, "id", "campaign_recipients"),
      campaignId: text(row, "campaign_id", "campaign_recipients"),
      email: text(row, "email", "campaign_recipients"),
      status: enumValue(row, "status", "campaign_recipients", [
        "PENDING",
        "QUEUED",
        "SENT",
        "FAILED",
      ] as const) as RecipientStatus,
      messageId: nullableText(row, "message_id", "campaign_recipients"),
      error: nullableText(row, "error", "campaign_recipients"),
      updatedAt: requiredTimestamp(row, "updated_at", "campaign_recipients"),
    })),
    suppressions: rows(sqlite, suppressions).map((row) => ({
      accountId:
        suppressions === "suppressions"
          ? LEGACY_ACCOUNT_ID
          : text(row, "account_id", suppressions),
      email: text(row, "email", suppressions),
      reason: text(row, "reason", suppressions),
      createdAt: requiredTimestamp(row, "created_at", suppressions),
    })),
  };
}

function stableValue(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stableValue(item)]),
    );
  }
  return value;
}

function digest(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(stableValue(value)))
    .digest("hex");
}

function report(data: ImportData) {
  const counts = Object.fromEntries(
    Object.entries(data).map(([table, records]) => [table, records.length]),
  ) as ImportCounts;
  const checksums = Object.fromEntries(
    Object.entries(data).map(([table, records]) => [
      table,
      digest(
        [...records].sort((left, right) =>
          JSON.stringify(stableValue(left)).localeCompare(
            JSON.stringify(stableValue(right)),
          ),
        ),
      ),
    ]),
  ) as ImportChecksums;
  checksums.overall = digest(checksums);
  return { counts, checksums };
}

function sourceInvariants(data: ImportData) {
  const accountIds = new Set(data.accounts.map(({ id }) => id));
  const userIds = new Set(data.users.map(({ id }) => id));
  const senderIds = new Set(data.senders.map(({ id }) => id));
  const campaignIds = new Set(data.campaigns.map(({ id }) => id));
  const failures = [
    ...data.memberships
      .filter(
        (row) => !accountIds.has(row.accountId) || !userIds.has(row.userId),
      )
      .map(() => "membership ownership"),
    ...data.senders
      .filter((row) => !accountIds.has(row.accountId))
      .map(() => "sender ownership"),
    ...data.apiTokens
      .filter((row) => row.senderId != null && !senderIds.has(row.senderId))
      .map(() => "token sender"),
    ...data.quotaReservations
      .filter((row) => !senderIds.has(row.senderId) || row.recipientCount < 0)
      .map(() => "quota reservation"),
    ...data.campaigns
      .filter(
        (row) =>
          !senderIds.has(row.senderId) ||
          row.total < 0 ||
          row.sent < 0 ||
          row.failed < 0 ||
          row.sent + row.failed > row.total,
      )
      .map(() => "campaign counters"),
    ...data.campaignRecipients
      .filter((row) => !campaignIds.has(row.campaignId))
      .map(() => "campaign recipient"),
    ...data.suppressions
      .filter((row) => !accountIds.has(row.accountId))
      .map(() => "suppression ownership"),
  ];
  if (failures.length)
    throw new Error(
      `SQLite invariant check failed: ${[...new Set(failures)].join(", ")}`,
    );
  return {
    ownershipReferences: "ok" as const,
    campaignCounters: "ok" as const,
    nullSenderTokens: data.apiTokens.filter(({ senderId }) => senderId == null)
      .length,
    fernetSecrets: data.senders.length,
  };
}

export function inspectSqlite(sqlitePath: string) {
  const sqlite = new SQLite(sqlitePath, { readonly: true, strict: true });
  try {
    const schema = preflight(sqlite);
    const data = readImportData(sqlite);
    const timestamps = readExactTimestamps(sqlite);
    return {
      schema,
      ...report(data),
      timestamps: timestampReport(timestamps),
      invariants: sourceInvariants(data),
    };
  } finally {
    sqlite.close();
  }
}

async function ensureEmpty(database: Database) {
  const counts = await Promise.all([
    database.account.count(),
    database.user.count(),
    database.membership.count(),
    database.gmailConnection.count(),
    database.sender.count(),
    database.apiToken.count(),
    database.quotaReservation.count(),
    database.campaign.count(),
    database.campaignRecipient.count(),
    database.suppression.count(),
    database.delivery.count(),
  ]);
  if (counts.some(Boolean))
    throw new Error(
      "Target PostgreSQL database is not empty; refusing to import",
    );
}

async function readTargetData(database: Database): Promise<ImportData> {
  const [
    accounts,
    users,
    memberships,
    senders,
    apiTokens,
    quotaReservations,
    campaigns,
    campaignRecipients,
    suppressions,
  ] = await Promise.all([
    database.account.findMany({
      select: { id: true, name: true, createdAt: true },
    }),
    database.user.findMany({
      select: {
        id: true,
        provider: true,
        providerSubject: true,
        email: true,
        name: true,
        createdAt: true,
        lastLoginAt: true,
      },
    }),
    database.membership.findMany({
      select: { accountId: true, userId: true, role: true, createdAt: true },
    }),
    database.sender.findMany({
      select: {
        id: true,
        accountId: true,
        name: true,
        email: true,
        legacyEncryptedSecret: true,
        smtpHost: true,
        smtpPort: true,
        useTls: true,
        dailyLimit: true,
        active: true,
        createdAt: true,
        updatedAt: true,
      },
    }),
    database.apiToken.findMany({
      select: {
        id: true,
        name: true,
        prefix: true,
        tokenHash: true,
        scopes: true,
        senderId: true,
        createdAt: true,
        lastUsedAt: true,
        revokedAt: true,
      },
    }),
    database.quotaReservation.findMany({
      select: {
        messageId: true,
        senderId: true,
        recipientCount: true,
        quotaDate: true,
        createdAt: true,
      },
    }),
    database.campaign.findMany({
      select: {
        id: true,
        name: true,
        senderId: true,
        subject: true,
        body: true,
        html: true,
        status: true,
        total: true,
        sent: true,
        failed: true,
        createdAt: true,
        startedAt: true,
        completedAt: true,
      },
    }),
    database.campaignRecipient.findMany({
      select: {
        id: true,
        campaignId: true,
        email: true,
        status: true,
        messageId: true,
        error: true,
        updatedAt: true,
      },
    }),
    database.suppression.findMany({
      select: { accountId: true, email: true, reason: true, createdAt: true },
    }),
  ]);
  return {
    accounts,
    users,
    memberships,
    senders: senders.map((sender) => {
      if (!sender.legacyEncryptedSecret) throw new Error(`Imported sender ${sender.id} is missing its legacy secret`);
      return { ...sender, legacyEncryptedSecret: sender.legacyEncryptedSecret };
    }),
    apiTokens,
    quotaReservations,
    campaigns,
    campaignRecipients,
    suppressions,
  };
}

async function targetTimestamp(database: Database, record: ExactTimestamp) {
  const where = record.keys
    .map(([column], index) => `${quoteIdentifier(column)} = $${index + 1}`)
    .join(" AND ");
  const result = await database.$queryRawUnsafe<Array<{ value: string | null }>>(
    `SELECT CASE WHEN ${quoteIdentifier(record.column)} IS NULL THEN NULL ELSE to_char(${quoteIdentifier(record.column)} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END AS value FROM ${quoteIdentifier(record.table)} WHERE ${where}`,
    ...record.keys.map(([, value]) => value),
  );
  if (result.length !== 1) throw new Error(`Missing imported row for ${record.table}.${record.column}`);
  return result[0]!.value;
}

async function assertExactTimestamps(database: Database, records: ExactTimestamp[]) {
  // ponytail: row-wise checks keep identifiers whitelisted and values parameterized;
  // batch by table only if migration volume makes this measurably slow.
  for (const record of records) {
    if (await targetTimestamp(database, record) !== record.value) {
      throw new Error(`Timestamp mismatch for ${record.table}.${record.column}`);
    }
  }
}

async function applyExactTimestamps(database: Database, records: ExactTimestamp[]) {
  for (const record of records) {
    const where = record.keys
      .map(([column], index) => `${quoteIdentifier(column)} = $${index + 2}`)
      .join(" AND ");
    const updated = await database.$executeRawUnsafe(
      `UPDATE ${quoteIdentifier(record.table)} SET ${quoteIdentifier(record.column)} = $1::timestamptz WHERE ${where}`,
      record.value,
      ...record.keys.map(([, value]) => value),
    );
    if (updated !== 1) throw new Error(`Missing imported row for ${record.table}.${record.column}`);
  }
}

async function assertRepairBaseline(database: Database, records: ExactTimestamp[]) {
  for (const record of records) {
    const current = await targetTimestamp(database, record);
    if (current === record.value) continue;
    if (current == null || record.value == null || new Date(current).toISOString() !== new Date(record.value).toISOString()) {
      throw new Error(`Refusing to overwrite a changed timestamp at ${record.table}.${record.column}`);
    }
  }
}

function timestampReport(records: ExactTimestamp[]) {
  const ordered = [...records].sort((left, right) =>
    JSON.stringify(left).localeCompare(JSON.stringify(right)),
  );
  return { count: ordered.length, checksum: digest(ordered) };
}

function assertReportsMatch(
  source: ReturnType<typeof report>,
  target: ReturnType<typeof report>,
) {
  if (JSON.stringify(source.counts) !== JSON.stringify(target.counts)) {
    throw new Error(
      `Import count mismatch: ${JSON.stringify({ source: source.counts, target: target.counts })}`,
    );
  }
  if (source.checksums.overall !== target.checksums.overall) {
    throw new Error(
      `Import checksum mismatch: ${JSON.stringify({ source: source.checksums, target: target.checksums })}`,
    );
  }
}

export async function verifyImport(sqlitePath: string, database: Database) {
  const sqlite = new SQLite(sqlitePath, { readonly: true, strict: true });
  try {
    const schema = preflight(sqlite);
    const sourceData = readImportData(sqlite);
    const source = report(sourceData);
    const timestamps = readExactTimestamps(sqlite);
    const invariants = sourceInvariants(sourceData);
    const target = report(await readTargetData(database));
    assertReportsMatch(source, target);
    await assertExactTimestamps(database, timestamps);
    const [gmailConnections, deliveries, localIdentities, accountSessions] = await Promise.all([
      database.gmailConnection.count(),
      database.delivery.count(),
      database.localIdentity.count(),
      database.accountSession.count(),
    ]);
    if (gmailConnections || deliveries || localIdentities || accountSessions)
      throw new Error("Target contains non-legacy rows not present in SQLite");
    return { verified: true as const, schema, source, target, timestamps: timestampReport(timestamps), invariants };
  } finally {
    sqlite.close();
  }
}

export async function importSqlite(
  sqlitePath: string,
  database: Database,
  dryRun = false,
) {
  const sqlite = new SQLite(sqlitePath, { readonly: true, strict: true });
  try {
    const schema = preflight(sqlite);
    const data = readImportData(sqlite);
    const source = report(data);
    const timestamps = readExactTimestamps(sqlite);
    const invariants = sourceInvariants(data);
    if (dryRun) return { dryRun: true as const, schema, source, timestamps: timestampReport(timestamps), invariants };

    const target = await database.$transaction(
      async (tx) => {
        await ensureEmpty(tx as Database);
        await tx.account.createMany({ data: data.accounts });
        await tx.user.createMany({ data: data.users });
        await tx.membership.createMany({ data: data.memberships });
        await tx.sender.createMany({ data: data.senders });
        await tx.apiToken.createMany({ data: data.apiTokens });
        await tx.quotaReservation.createMany({ data: data.quotaReservations });
        await tx.campaign.createMany({ data: data.campaigns });
        await tx.campaignRecipient.createMany({
          data: data.campaignRecipients,
        });
        await tx.suppression.createMany({ data: data.suppressions });
        await applyExactTimestamps(tx as Database, timestamps);
        const imported = report(await readTargetData(tx as Database));
        assertReportsMatch(source, imported);
        await assertExactTimestamps(tx as Database, timestamps);
        return imported;
      },
      { timeout: 120_000 },
    );
    return {
      dryRun: false as const,
      verified: true as const,
      schema,
      source,
      target,
      timestamps: timestampReport(timestamps),
      invariants,
    };
  } finally {
    sqlite.close();
  }
}

export async function repairImportedTimestamps(sqlitePath: string, database: Database) {
  const sqlite = new SQLite(sqlitePath, { readonly: true, strict: true });
  try {
    preflight(sqlite);
    const records = readExactTimestamps(sqlite);
    return database.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`LOCK TABLE
        account_suppressions, campaign_recipients, campaigns,
        quota_reservations, api_tokens, senders, memberships, users, accounts
        IN ACCESS EXCLUSIVE MODE`);
      await assertRepairBaseline(tx as Database, records);
      await applyExactTimestamps(tx as Database, records);
      await assertExactTimestamps(tx as Database, records);
      return { repaired: true as const, timestamps: timestampReport(records) };
    }, { timeout: 120_000 });
  } finally {
    sqlite.close();
  }
}

export async function rollbackImport(sqlitePath: string, database: Database) {
  return database.$transaction(
    async (tx) => {
      // Hold an exclusive fence across verification and deletion so no Bun
      // write can appear in the gap and be removed accidentally.
      await tx.$executeRawUnsafe(`LOCK TABLE
        account_sessions, local_identities, gmail_connections, deliveries,
        campaign_recipients, campaigns, quota_reservations, api_tokens,
        account_suppressions, senders, memberships, users, accounts
        IN ACCESS EXCLUSIVE MODE`);
      await verifyImport(sqlitePath, tx as Database);
      await tx.campaignRecipient.deleteMany();
      await tx.campaign.deleteMany();
      await tx.quotaReservation.deleteMany();
      await tx.apiToken.deleteMany();
      await tx.suppression.deleteMany();
      await tx.sender.deleteMany();
      await tx.membership.deleteMany();
      await tx.user.deleteMany();
      await tx.account.deleteMany();
      return { rolledBack: true as const };
    },
    { timeout: 120_000 },
  );
}

export async function backupSqlite(sqlitePath: string, backupPath: string) {
  // The source must already be fenced or produced by SQLite's backup API.
  // Stream instead of Database.serialize(), which can fail on Bun/arm64 and
  // needlessly holds the whole database in memory.
  await pipeline(
    createReadStream(sqlitePath),
    createWriteStream(backupPath, { flags: "wx", mode: 0o600 }),
  );
  const file = await open(backupPath, "r+");
  try {
    await file.chmod(0o600);
    await file.sync();
  } finally {
    await file.close();
  }
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(backupPath)) hash.update(chunk);
  const metadata = await stat(backupPath);
  return {
    path: backupPath,
    bytes: metadata.size,
    mode: "0600" as const,
    sha256: hash.digest("hex"),
  };
}

if (import.meta.main) {
  const sqlitePath = process.env.SQLITE_PATH;
  if (!sqlitePath) throw new Error("SQLITE_PATH is required");
  const dryRun = process.argv.includes("--dry-run");
  if (dryRun) {
    console.log(
      JSON.stringify(
        await importSqlite(sqlitePath, undefined as never, true),
        null,
        2,
      ),
    );
  } else {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) throw new Error("DATABASE_URL is required");
    const { createDatabase } = await import("./index");
    const database = createDatabase(databaseUrl);
    try {
      if (process.argv.includes("--repair-timestamps")) {
        if (process.env.CONFIRM_TIMESTAMP_REPAIR !== "REPAIR_IMPORTED_TIMESTAMPS") {
          throw new Error("Set CONFIRM_TIMESTAMP_REPAIR=REPAIR_IMPORTED_TIMESTAMPS to repair timestamps");
        }
        console.log(JSON.stringify(await repairImportedTimestamps(sqlitePath, database), null, 2));
      } else if (process.argv.includes("--verify-only")) {
        console.log(
          JSON.stringify(await verifyImport(sqlitePath, database), null, 2),
        );
      } else if (process.argv.includes("--rollback")) {
        if (process.env.CONFIRM_ROLLBACK !== "DELETE_IMPORTED_DATA") {
          throw new Error(
            "Set CONFIRM_ROLLBACK=DELETE_IMPORTED_DATA to rollback",
          );
        }
        console.log(
          JSON.stringify(await rollbackImport(sqlitePath, database), null, 2),
        );
      } else {
        const backupPath = process.env.BACKUP_PATH;
        if (!backupPath) throw new Error("BACKUP_PATH is required for import");
        const backup = await backupSqlite(sqlitePath, backupPath);
        console.log(
          JSON.stringify(
            { backup, import: await importSqlite(sqlitePath, database) },
            null,
            2,
          ),
        );
      }
    } finally {
      await database.$disconnect();
    }
  }
}
