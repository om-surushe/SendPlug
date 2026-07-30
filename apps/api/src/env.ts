export type Environment = {
  nodeEnv: "development" | "test" | "production";
  host: string;
  port: number;
  databaseUrl: string;
  redisUrl: string;
  publicOrigin: string;
  signupsEnabled: boolean;
  sessionSecret: string;
  recoveryEmail: string;
  recoveryPassword: string;
  tokenPepperFile: string;
  credentialKeyFile: string;
  sendBurstLimit: number;
  sendBurstWindowSeconds: number;
  staticDir: string;
  workos: null | {
    apiKey: string;
    clientId: string;
    cookiePassword: string;
    redirectUri: string;
  };
};

function required(name: string, source: NodeJS.ProcessEnv): string {
  const value = source[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function positiveInteger(name: string, value: string | undefined, fallback: number): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function boolean(name: string, value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === "") return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be true or false`);
}

export function loadEnvironment(source: NodeJS.ProcessEnv = Bun.env): Environment {
  const nodeEnv = (source.NODE_ENV || "development") as Environment["nodeEnv"];
  if (!("development,test,production".split(",") as Environment["nodeEnv"][]).includes(nodeEnv)) {
    throw new Error("NODE_ENV must be development, test, or production");
  }
  const port = positiveInteger("API_PORT", source.API_PORT, 3000);
  if (port > 65535) throw new Error("API_PORT must be a valid TCP port");
  const publicOrigin = required("PUBLIC_ORIGIN", source);
  const origin = new URL(publicOrigin);
  if (nodeEnv === "production" && origin.protocol !== "https:") {
    throw new Error("PUBLIC_ORIGIN must use HTTPS in production");
  }

  const workosValues = [source.WORKOS_API_KEY, source.WORKOS_CLIENT_ID, source.WORKOS_COOKIE_PASSWORD, source.WORKOS_REDIRECT_URI];
  let workos: Environment["workos"] = null;
  if (workosValues.some((value) => value?.trim())) {
    const redirectUri = required("WORKOS_REDIRECT_URI", source);
    const parsedRedirect = new URL(redirectUri);
    if (nodeEnv === "production" && parsedRedirect.protocol !== "https:") {
      throw new Error("WORKOS_REDIRECT_URI must use HTTPS in production");
    }
    const cookiePassword = required("WORKOS_COOKIE_PASSWORD", source);
    if (cookiePassword.length < 32) throw new Error("WORKOS_COOKIE_PASSWORD must be at least 32 characters");
    workos = {
      apiKey: required("WORKOS_API_KEY", source),
      clientId: required("WORKOS_CLIENT_ID", source),
      cookiePassword,
      redirectUri,
    };
  }

  if (nodeEnv === "production" && workos) {
    throw new Error("WorkOS login is disabled in production until callback state is browser-bound");
  }

  const sessionSecret = required("SESSION_SECRET", source);
  const recoveryPassword = required("RECOVERY_ADMIN_PASSWORD", source);
  if (sessionSecret.length < 32) throw new Error("SESSION_SECRET must be at least 32 characters");
  if (recoveryPassword.length < 16) throw new Error("RECOVERY_ADMIN_PASSWORD must be at least 16 characters");
  if (nodeEnv === "production") {
    const placeholders = new Set(["changeme", "generate-a-long-random-password"]);
    if (placeholders.has(sessionSecret) || placeholders.has(recoveryPassword)) {
      throw new Error("Replace documented placeholder secrets before production");
    }
  }

  return {
    nodeEnv,
    host: source.API_HOST || "127.0.0.1",
    port,
    databaseUrl: required("DATABASE_URL", source),
    redisUrl: required("REDIS_URL", source),
    publicOrigin: origin.origin,
    signupsEnabled: boolean("AUTH_SIGNUPS_ENABLED", source.AUTH_SIGNUPS_ENABLED, true),
    sessionSecret,
    recoveryEmail: required("RECOVERY_ADMIN_EMAIL", source).toLowerCase(),
    recoveryPassword,
    tokenPepperFile: source.API_TOKEN_PEPPER_FILE?.trim() || "/run/secrets/token_pepper",
    credentialKeyFile: source.CREDENTIAL_KEY_FILE?.trim() || "/run/secrets/credential_key",
    sendBurstLimit: positiveInteger("SEND_BURST_LIMIT", source.SEND_BURST_LIMIT, 10),
    sendBurstWindowSeconds: positiveInteger("SEND_BURST_WINDOW_SECONDS", source.SEND_BURST_WINDOW_SECONDS, 60),
    staticDir: source.STATIC_DIR?.trim() || "/app/static",
    workos,
  };
}
