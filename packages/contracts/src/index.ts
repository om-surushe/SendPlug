import { type Static, Type } from "@sinclair/typebox";

const email = Type.String({ format: "email", maxLength: 320 });

export const EmailJobSchema = Type.Object(
  {
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
export const EMAIL_QUEUE = "sendplug:email";
