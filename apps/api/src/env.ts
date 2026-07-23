export type Environment = {
  nodeEnv: "development" | "test" | "production";
  host: string;
  port: number;
  databaseUrl: string;
  redisUrl: string;
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
  return {
    nodeEnv,
    host: source.API_HOST || "127.0.0.1",
    port,
    databaseUrl: required("DATABASE_URL", source),
    redisUrl: required("REDIS_URL", source),
  };
}
