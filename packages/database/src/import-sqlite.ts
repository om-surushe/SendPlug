import { Database as SQLite } from "bun:sqlite";
import {
  CampaignStatus,
  MembershipRole,
  RecipientStatus,
  createDatabase,
  type Database,
} from "./index";

const LEGACY_ACCOUNT_ID = "account_legacy_admin";

type Row = Record<string, unknown>;

function timestamp(value: unknown): Date {
  const parsed = new Date(String(value));
  if (Number.isNaN(parsed.valueOf())) throw new Error(`Invalid timestamp: ${String(value)}`);
  return parsed;
}

function nullableTimestamp(value: unknown): Date | null {
  return value == null ? null : timestamp(value);
}

function rows(sqlite: SQLite, table: string): Row[] {
  return sqlite.query(`SELECT * FROM "${table}"`).all() as Row[];
}

function tableExists(sqlite: SQLite, table: string): boolean {
  return Boolean(
    sqlite.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table),
  );
}

function sourceCounts(sqlite: SQLite) {
  const count = (table: string) =>
    tableExists(sqlite, table)
      ? Number((sqlite.query(`SELECT COUNT(*) AS count FROM "${table}"`).get() as { count: number }).count)
      : 0;
  return {
    accounts: count("accounts"),
    users: count("users"),
    memberships: count("memberships"),
    senders: count("senders"),
    apiTokens: count("api_tokens"),
    quotaReservations: count("quota_reservations"),
    campaigns: count("campaigns"),
    campaignRecipients: count("campaign_recipients"),
    suppressions: count(tableExists(sqlite, "account_suppressions") ? "account_suppressions" : "suppressions"),
  };
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
  if (counts.some(Boolean)) {
    throw new Error("Target PostgreSQL database is not empty; refusing to import");
  }
}

export async function importSqlite(sqlitePath: string, database: Database, dryRun = false) {
  const sqlite = new SQLite(sqlitePath, { readonly: true, strict: true });
  try {
    const counts = sourceCounts(sqlite);
    if (dryRun) return { dryRun: true, source: counts };
    await ensureEmpty(database);

    const target = await database.$transaction(
      async (tx) => {
        await tx.account.createMany({
          data: rows(sqlite, "accounts").map((row) => ({
            id: String(row.id),
            name: String(row.name),
            createdAt: timestamp(row.created_at),
          })),
        });
        await tx.user.createMany({
          data: rows(sqlite, "users").map((row) => ({
            id: String(row.id),
            provider: String(row.provider),
            providerSubject: String(row.provider_subject),
            email: String(row.email),
            name: String(row.name),
            createdAt: timestamp(row.created_at),
            lastLoginAt: timestamp(row.last_login_at),
          })),
        });
        await tx.membership.createMany({
          data: rows(sqlite, "memberships").map((row) => ({
            accountId: String(row.account_id),
            userId: String(row.user_id),
            role: String(row.role).toUpperCase() as MembershipRole,
            createdAt: timestamp(row.created_at),
          })),
        });
        await tx.sender.createMany({
          data: rows(sqlite, "senders").map((row) => ({
            id: String(row.id),
            accountId: String(row.account_id),
            name: String(row.name),
            email: String(row.email),
            legacyEncryptedSecret: String(row.encrypted_password),
            smtpHost: String(row.smtp_host),
            smtpPort: Number(row.smtp_port),
            useTls: Boolean(row.use_tls),
            dailyLimit: Number(row.daily_limit),
            active: Boolean(row.active),
            createdAt: timestamp(row.created_at),
            updatedAt: timestamp(row.updated_at),
          })),
        });
        await tx.apiToken.createMany({
          data: rows(sqlite, "api_tokens").map((row) => ({
            id: String(row.id),
            name: String(row.name),
            prefix: String(row.prefix),
            tokenHash: String(row.token_hash),
            scopes: JSON.parse(String(row.scopes)) as string[],
            senderId: row.sender_id == null ? null : String(row.sender_id),
            createdAt: timestamp(row.created_at),
            lastUsedAt: nullableTimestamp(row.last_used_at),
            revokedAt: nullableTimestamp(row.revoked_at),
          })),
        });
        await tx.quotaReservation.createMany({
          data: rows(sqlite, "quota_reservations").map((row) => ({
            messageId: String(row.message_id),
            senderId: String(row.sender_id),
            recipientCount: Number(row.recipient_count),
            quotaDate: timestamp(`${String(row.quota_date)}T00:00:00Z`),
            createdAt: timestamp(row.created_at),
          })),
        });
        await tx.campaign.createMany({
          data: rows(sqlite, "campaigns").map((row) => ({
            id: String(row.id),
            name: String(row.name),
            senderId: String(row.sender_id),
            subject: String(row.subject),
            body: String(row.body),
            html: row.html == null ? null : String(row.html),
            status: String(row.status).toUpperCase() as CampaignStatus,
            total: Number(row.total),
            sent: Number(row.sent),
            failed: Number(row.failed),
            createdAt: timestamp(row.created_at),
            startedAt: nullableTimestamp(row.started_at),
            completedAt: nullableTimestamp(row.completed_at),
          })),
        });
        await tx.campaignRecipient.createMany({
          data: rows(sqlite, "campaign_recipients").map((row) => ({
            id: String(row.id),
            campaignId: String(row.campaign_id),
            email: String(row.email),
            status: String(row.status).toUpperCase() as RecipientStatus,
            messageId: row.message_id == null ? null : String(row.message_id),
            error: row.error == null ? null : String(row.error),
            updatedAt: timestamp(row.updated_at),
          })),
        });
        const suppressionTable = tableExists(sqlite, "account_suppressions")
          ? "account_suppressions"
          : "suppressions";
        await tx.suppression.createMany({
          data: rows(sqlite, suppressionTable).map((row) => ({
            accountId: row.account_id == null ? LEGACY_ACCOUNT_ID : String(row.account_id),
            email: String(row.email),
            reason: String(row.reason),
            createdAt: timestamp(row.created_at),
          })),
        });

        const imported = {
          accounts: await tx.account.count(),
          users: await tx.user.count(),
          memberships: await tx.membership.count(),
          senders: await tx.sender.count(),
          apiTokens: await tx.apiToken.count(),
          quotaReservations: await tx.quotaReservation.count(),
          campaigns: await tx.campaign.count(),
          campaignRecipients: await tx.campaignRecipient.count(),
          suppressions: await tx.suppression.count(),
        };
        if (JSON.stringify(counts) !== JSON.stringify(imported)) {
          throw new Error(`Import count mismatch: ${JSON.stringify({ source: counts, target: imported })}`);
        }
        return imported;
      },
      { timeout: 120_000 },
    );
    return { dryRun: false, source: counts, target };
  } finally {
    sqlite.close();
  }
}

if (import.meta.main) {
  const sqlitePath = process.env.SQLITE_PATH;
  const databaseUrl = process.env.DATABASE_URL;
  if (!sqlitePath || !databaseUrl) throw new Error("SQLITE_PATH and DATABASE_URL are required");
  const database = createDatabase(databaseUrl);
  try {
    console.log(JSON.stringify(await importSqlite(sqlitePath, database, process.argv.includes("--dry-run"))));
  } finally {
    await database.$disconnect();
  }
}
