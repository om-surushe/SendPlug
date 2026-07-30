-- Add local email/password identities without changing existing WorkOS/Google identities.
CREATE TABLE "local_identities" (
    "user_id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "local_identities_pkey" PRIMARY KEY ("user_id")
);

CREATE UNIQUE INDEX "local_identities_email_key" ON "local_identities"("email");

ALTER TABLE "local_identities"
    ADD CONSTRAINT "local_identities_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Browser/API sessions store only a digest of the high-entropy bearer token.
CREATE TABLE "account_sessions" (
    "id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "last_used_at" TIMESTAMPTZ(6),
    "revoked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "account_sessions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "account_sessions_token_hash_key" ON "account_sessions"("token_hash");
CREATE INDEX "account_sessions_user_id_revoked_at_idx" ON "account_sessions"("user_id", "revoked_at");
CREATE INDEX "account_sessions_account_id_expires_at_idx" ON "account_sessions"("account_id", "expires_at");

ALTER TABLE "account_sessions"
    ADD CONSTRAINT "account_sessions_account_id_user_id_fkey"
    FOREIGN KEY ("account_id", "user_id") REFERENCES "memberships"("account_id", "user_id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- New Gmail App Passwords use versioned authenticated encryption. The legacy
-- Fernet column remains untouched so imported data can be rolled back safely.
ALTER TABLE "senders" ADD COLUMN "encrypted_app_password" BYTEA;

-- Sender addresses belong to an account, not to a global namespace.
DROP INDEX "senders_email_key";
CREATE UNIQUE INDEX "senders_account_id_email_key" ON "senders"("account_id", "email");
