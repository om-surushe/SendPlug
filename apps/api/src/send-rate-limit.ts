export type SendRateLimitRedis = {
  eval(script: string, numberOfKeys: number, ...args: Array<string | number>): Promise<unknown>;
};

export type SendRateLimitResult =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number };

export type SendRateLimiter = {
  check(senderId: string): Promise<SendRateLimitResult>;
};

const FIXED_WINDOW_SCRIPT = `
local count = redis.call("INCR", KEYS[1])
if count == 1 then
  redis.call("PEXPIRE", KEYS[1], ARGV[1])
end
local ttl = redis.call("PTTL", KEYS[1])
return {count, ttl}
`;

export function createRedisSendRateLimiter(
  redis: SendRateLimitRedis,
  options: { limit: number; windowSeconds: number; keyPrefix?: string },
): SendRateLimiter {
  if (!Number.isInteger(options.limit) || options.limit < 1) throw new RangeError("limit must be a positive integer");
  if (!Number.isInteger(options.windowSeconds) || options.windowSeconds < 1) {
    throw new RangeError("windowSeconds must be a positive integer");
  }
  const windowMilliseconds = options.windowSeconds * 1_000;
  const prefix = options.keyPrefix ?? "sendplug:send-rate";

  return {
    async check(senderId) {
      const result = await redis.eval(
        FIXED_WINDOW_SCRIPT,
        1,
        `${prefix}:${senderId}`,
        windowMilliseconds,
      );
      if (!Array.isArray(result) || result.length < 2) throw new Error("Invalid Redis rate-limit response");
      const count = Number(result[0]);
      const ttlMilliseconds = Number(result[1]);
      if (!Number.isFinite(count) || !Number.isFinite(ttlMilliseconds)) {
        throw new Error("Invalid Redis rate-limit response");
      }
      if (count <= options.limit) return { allowed: true };
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil(ttlMilliseconds / 1_000)),
      };
    },
  };
}
