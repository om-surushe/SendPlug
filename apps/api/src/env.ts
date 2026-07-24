export type Environment = {
  nodeEnv: "development" | "test" | "production";
  host: string;
  port: number;
  databaseUrl: string;
  redisUrl: string;
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

export function loadEnvironment(source: NodeJS.ProcessEnv = Bun.env): Environment {
  const nodeEnv = (source.NODE_ENV || "development") as Environment["nodeEnv"];
  if (!(["development", "test", "production"] as const).includes(nodeEnv)) {
    throw new Error("NODE_ENV must be development, test, or production");
  }
  const port = Number(source.API_PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("API_PORT must be a valid TCP port");
  }
  const workosValues = [
    source.WORKOS_API_KEY,
    source.WORKOS_CLIENT_ID,
    source.WORKOS_COOKIE_PASSWORD,
    source.WORKOS_REDIRECT_URI,
  ];
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

  return {
    nodeEnv,
    host: source.API_HOST || "127.0.0.1",
    port,
    databaseUrl: required("DATABASE_URL", source),
    redisUrl: required("REDIS_URL", source),
    workos,
  };
}
