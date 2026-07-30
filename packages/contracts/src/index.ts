import { FormatRegistry, type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

if (!FormatRegistry.Has("email")) {
  FormatRegistry.Set("email", (value) => /^(?!.*\.\.)[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value));
}

export const EMAIL_JOB_VERSION = 1 as const;
const email = Type.String({ format: "email", maxLength: 320 });

export const EmailJobSchema = Type.Object(
  {
    // Optional until every producer has migrated; consumers normalize it to v1.
    version: Type.Optional(Type.Literal(EMAIL_JOB_VERSION)),
    messageId: Type.String({ minLength: 3, maxLength: 255 }),
    accountId: Type.String({ minLength: 3, maxLength: 255 }),
    senderId: Type.String({ minLength: 3, maxLength: 255 }),
    to: Type.Array(email, { minItems: 1, maxItems: 1 }),
    cc: Type.Optional(Type.Array(email, { maxItems: 10 })),
    bcc: Type.Optional(Type.Array(email, { maxItems: 10 })),
    subject: Type.String({ minLength: 1, maxLength: 998 }),
    body: Type.String(),
    html: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    campaignId: Type.Optional(Type.String({ minLength: 3, maxLength: 255 })),
  },
  { additionalProperties: false },
);

export type EmailJob = Static<typeof EmailJobSchema>;
export type NormalizedEmailJob = Omit<EmailJob, "version"> & { version: typeof EMAIL_JOB_VERSION };

export function parseEmailJob(value: unknown): NormalizedEmailJob {
  if (!Value.Check(EmailJobSchema, value)) throw new TypeError("Invalid email job");
  return { ...(value as EmailJob), version: EMAIL_JOB_VERSION };
}

export const EMAIL_QUEUE = "sendplug-email";
