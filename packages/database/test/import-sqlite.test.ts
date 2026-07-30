import { afterEach, describe, expect, test } from "bun:test";
import { Database as SQLite } from "bun:sqlite";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backupSqlite, inspectSqlite } from "../src/import-sqlite";

const paths: string[] = [];
afterEach(async () =>
  Promise.all(
    paths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  ),
);

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "sendplug-import-"));
  paths.push(directory);
  const path = join(directory, "legacy.sqlite3");
  const sqlite = new SQLite(path, { create: true, strict: true });
  sqlite.exec(`
    PRAGMA user_version = 0;
    PRAGMA foreign_keys = ON;
    CREATE TABLE accounts (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE users (id TEXT PRIMARY KEY, provider TEXT NOT NULL, provider_subject TEXT NOT NULL,
      email TEXT NOT NULL, name TEXT NOT NULL, created_at TEXT NOT NULL, last_login_at TEXT NOT NULL);
    CREATE TABLE memberships (account_id TEXT NOT NULL REFERENCES accounts(id), user_id TEXT NOT NULL REFERENCES users(id),
      role TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (account_id, user_id));
    CREATE TABLE senders (id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id), name TEXT NOT NULL,
      email TEXT NOT NULL, encrypted_password BLOB NOT NULL, smtp_host TEXT NOT NULL, smtp_port INTEGER NOT NULL,
      use_tls INTEGER NOT NULL, daily_limit INTEGER NOT NULL, active INTEGER NOT NULL, created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL);
    CREATE TABLE api_tokens (id TEXT PRIMARY KEY, name TEXT NOT NULL, prefix TEXT NOT NULL, token_hash TEXT NOT NULL,
      scopes TEXT NOT NULL, sender_id TEXT REFERENCES senders(id), created_at TEXT NOT NULL, last_used_at TEXT,
      revoked_at TEXT);
    CREATE TABLE quota_reservations (message_id TEXT PRIMARY KEY, sender_id TEXT NOT NULL REFERENCES senders(id),
      recipient_count INTEGER NOT NULL, quota_date TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE campaigns (id TEXT PRIMARY KEY, name TEXT NOT NULL, sender_id TEXT NOT NULL REFERENCES senders(id),
      subject TEXT NOT NULL, body TEXT NOT NULL, html TEXT, status TEXT NOT NULL, total INTEGER NOT NULL,
      sent INTEGER NOT NULL, failed INTEGER NOT NULL, created_at TEXT NOT NULL, started_at TEXT, completed_at TEXT);
    CREATE TABLE campaign_recipients (id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL REFERENCES campaigns(id),
      email TEXT NOT NULL, status TEXT NOT NULL, message_id TEXT, error TEXT, updated_at TEXT NOT NULL);
    CREATE TABLE account_suppressions (account_id TEXT NOT NULL REFERENCES accounts(id), email TEXT NOT NULL,
      reason TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (account_id, email));
  `);
  const now = "2026-01-02T03:04:05.123456+00:00";
  sqlite.run("INSERT INTO accounts VALUES (?, ?, ?)", [
    "account",
    "Account",
    now,
  ]);
  sqlite.run("INSERT INTO users VALUES (?, ?, ?, ?, ?, ?, ?)", [
    "user",
    "recovery",
    "subject",
    "admin@example.test",
    "Admin",
    now,
    now,
  ]);
  sqlite.run("INSERT INTO memberships VALUES (?, ?, ?, ?)", [
    "account",
    "user",
    "owner",
    now,
  ]);
  sqlite.run(
    "INSERT INTO senders VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [
      "sender",
      "account",
      "Sender",
      "sender@example.test",
      Buffer.from("gAAAAABsynthetic-fernet-token"),
      "smtp.gmail.com",
      587,
      1,
      400,
      1,
      now,
      now,
    ],
  );
  sqlite.run("INSERT INTO api_tokens VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", [
    "old-token",
    "Historical",
    "sp_old",
    "synthetic-hash",
    '["send","status"]',
    null,
    now,
    now,
    now,
  ]);
  sqlite.run("INSERT INTO quota_reservations VALUES (?, ?, ?, ?, ?)", [
    "message",
    "sender",
    1,
    "2026-01-02",
    now,
  ]);
  sqlite.run(
    "INSERT INTO campaigns VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [
      "campaign",
      "Campaign",
      "sender",
      "Subject",
      "Body",
      null,
      "completed",
      1,
      1,
      0,
      now,
      now,
      now,
    ],
  );
  sqlite.run("INSERT INTO campaign_recipients VALUES (?, ?, ?, ?, ?, ?, ?)", [
    "recipient",
    "campaign",
    "recipient@example.test",
    "sent",
    "message",
    null,
    now,
  ]);
  sqlite.run("INSERT INTO account_suppressions VALUES (?, ?, ?, ?)", [
    "account",
    "blocked@example.test",
    "bounce",
    now,
  ]);
  sqlite.close();
  return { directory, path };
}

describe("SQLite importer preflight", () => {
  test("reports deterministic synthetic counts, checksums, and legacy states", async () => {
    const { path } = await fixture();
    const first = inspectSqlite(path);
    const second = inspectSqlite(path);

    expect(first).toEqual(second);
    expect(first.counts).toMatchObject({
      senders: 1,
      apiTokens: 1,
      campaignRecipients: 1,
    });
    expect(first.invariants).toMatchObject({
      ownershipReferences: "ok",
      nullSenderTokens: 1,
      fernetSecrets: 1,
    });
    expect(first.checksums.overall).toMatch(/^[a-f0-9]{64}$/);
    expect(first.timestamps).toMatchObject({ count: 15 });
    expect(first.timestamps.checksum).toMatch(/^[a-f0-9]{64}$/);
  });

  test("detects timestamp precision that JavaScript Date would truncate", async () => {
    const { path } = await fixture();
    const before = inspectSqlite(path);
    const sqlite = new SQLite(path);
    sqlite.run("UPDATE accounts SET created_at = ?", [
      "2026-01-02T03:04:05.123999+00:00",
    ]);
    sqlite.close();
    const after = inspectSqlite(path);

    expect(after.checksums.overall).toBe(before.checksums.overall);
    expect(after.timestamps.checksum).not.toBe(before.timestamps.checksum);
  });

  test("rejects unsupported schema versions and invalid SQLite value types", async () => {
    const versioned = await fixture();
    let sqlite = new SQLite(versioned.path);
    sqlite.exec("PRAGMA user_version = 1");
    sqlite.close();
    expect(() => inspectSqlite(versioned.path)).toThrow(
      "Unsupported SQLite user_version 1",
    );

    const invalid = await fixture();
    sqlite = new SQLite(invalid.path);
    sqlite.exec("PRAGMA foreign_keys = OFF; UPDATE senders SET use_tls = 2");
    sqlite.close();
    expect(() => inspectSqlite(invalid.path)).toThrow(
      "senders.use_tls must be 0 or 1",
    );
  });

  test("creates a non-overwriting mode-600 consistent backup", async () => {
    const { directory, path } = await fixture();
    const backup = join(directory, "backup.sqlite3");
    await chmod(directory, 0o755);
    const result = await backupSqlite(path, backup);
    const bytes = await readFile(backup);

    expect((await stat(backup)).mode & 0o777).toBe(0o600);
    expect(result.sha256).toBe(
      createHash("sha256").update(bytes).digest("hex"),
    );
    expect(inspectSqlite(backup).checksums).toEqual(
      inspectSqlite(path).checksums,
    );
    await expect(backupSqlite(path, backup)).rejects.toThrow();
  });
});
