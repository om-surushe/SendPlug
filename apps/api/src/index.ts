import { readFile } from "node:fs/promises";
import Redis from "ioredis";
import { WorkOS } from "@workos-inc/node";
import { createDatabase, getOrCreateWorkOSIdentity } from "@sendplug/database";
import { createEmailQueue, enqueueEmail } from "@sendplug/worker";
import { GmailSmtpTransport } from "@sendplug/worker/smtp";
import { createAccountDependencies, createDeliveryDependencies, createLocalAuthStore, createSessionResolver, recoveryIdentity } from "./adapters";
import { createApp } from "./app";
import { loadEnvironment } from "./env";
import { createRedisSendRateLimiter } from "./send-rate-limit";
import type { LocalAuthIdentity } from "./local-auth";

const env = loadEnvironment();
const database = createDatabase(env.databaseUrl);
const redis = new Redis(env.redisUrl, { maxRetriesPerRequest: 1 });
const credentialKeyText = (await readFile(env.credentialKeyFile, "utf8")).trim();
const encryptionKey = Buffer.from(credentialKeyText, "base64url");
if (encryptionKey.length !== 32) throw new Error("CREDENTIAL_KEY_FILE must contain a Fernet-compatible 32-byte key");
const tokenPepper = Buffer.from((await readFile(env.tokenPepperFile, "utf8")).trim(), "utf8");
if (tokenPepper.length < 32) throw new Error("API token pepper must contain at least 32 bytes");
const secureCookies = env.nodeEnv === "production";

const workos = env.workos
  ? {
      client: new WorkOS({ apiKey: env.workos.apiKey, clientId: env.workos.clientId }).userManagement,
      database,
      state: {
        async put(state: string, verifier: string) {
          const stored = await redis.set(`sendplug:workos:${state}`, verifier, "EX", 600, "NX");
          if (stored !== "OK") throw new Error("Unable to store WorkOS login state");
        },
        take(state: string) { return redis.getdel(`sendplug:workos:${state}`); },
      },
      clientId: env.workos.clientId,
      cookiePassword: env.workos.cookiePassword,
      redirectUri: env.workos.redirectUri,
      secureCookies,
    }
  : undefined;

function requestCookie(request: Request, name: string): string | null {
  const item = request.headers.get("cookie")?.split(";").map((value) => value.trim()).find((value) => value.startsWith(`${name}=`));
  if (!item) return null;
  try { return decodeURIComponent(item.slice(name.length + 1)); } catch { return null; }
}

async function resolveWorkOS(request: Request): Promise<LocalAuthIdentity | null> {
  if (!workos) return null;
  const sealed = requestCookie(request, secureCookies ? "__Host-sendplug_session" : "sendplug_session");
  if (!sealed) return null;
  const result = await workos.client.loadSealedSession({ sessionData: sealed, cookiePassword: workos.cookiePassword }).authenticate();
  if (!result.authenticated) return null;
  const identity = await getOrCreateWorkOSIdentity(database, result.user);
  return { accountId: identity.accountId, user: { id: identity.user.id, email: identity.user.email, name: identity.user.name }, role: "owner" };
}

const resolveLocal = createSessionResolver(redis, secureCookies, env.sessionSecret);
const resolveIdentity = async (request: Request) => await resolveLocal(request) ?? await resolveWorkOS(request);
const smtp = new GmailSmtpTransport();
const queueResource = createEmailQueue(env.redisUrl);

const accountApi = {
  ...createAccountDependencies({
    database,
    resolveIdentity,
    encryptionKey,
    legacyFernetKey: credentialKeyText,
    tokenPepper,
    testSender: ({ email, appPassword }) => smtp.testCredentials(email, appPassword),
  }),
  senderTestRateLimit: createRedisSendRateLimiter(redis, {
    limit: 5,
    windowSeconds: 60,
    keyPrefix: "sendplug:sender-test-rate",
  }),
};
const delivery = createDeliveryDependencies({
  database,
  redis,
  tokenPepper,
  burstLimit: env.sendBurstLimit,
  burstWindowSeconds: env.sendBurstWindowSeconds,
  queue: {
    async enqueue(value) {
      await enqueueEmail(queueResource.queue, {
        version: 1,
        messageId: value.messageId,
        accountId: value.accountId,
        senderId: value.senderId,
        to: value.to,
        cc: value.cc,
        bcc: value.bcc,
        subject: value.subject,
        body: value.body,
        html: value.html,
      });
    },
  },
});
const localAuth = {
  store: createLocalAuthStore(database),
  redis,
  signupsEnabled: env.signupsEnabled,
  googleEnabled: Boolean(workos),
  secureCookies,
  sessionSecret: env.sessionSecret,
  clientIp(request: Request) { return request.headers.get("x-real-ip") || "unknown"; },
  authenticateRecovery(email: string, password: string) {
    return recoveryIdentity(database, email, password, { email: env.recoveryEmail, password: env.recoveryPassword });
  },
  resolveWorkOSSession: resolveWorkOS,
};

const app = createApp({ database, redis, nodeEnv: env.nodeEnv, ...(workos ? { auth: workos } : {}), localAuth, accountApi, delivery, staticDir: env.staticDir });
app.listen({ hostname: env.host, port: env.port });
console.log(`SendPlug Bun API listening on http://${env.host}:${env.port}`);

async function shutdown() {
  await app.stop();
  await queueResource.close();
  await database.$disconnect();
  redis.disconnect();
}
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
