import { randomBytes } from "node:crypto";
import type { NormalizedEmailJob } from "@sendplug/contracts";

function header(value: string): string {
  if (/[\r\n]/.test(value)) throw new TypeError("Invalid message header");
  return value;
}

function encode(value: string): string {
  return /^[\x20-\x7e]*$/.test(value) ? header(value) : `=?UTF-8?B?${Buffer.from(header(value)).toString("base64")}?=`;
}

function crlf(value: string): string {
  return value.replace(/\r?\n/g, "\r\n");
}

export type MimeSender = { name: string; email: string };

export function buildMime(job: NormalizedEmailJob, sender: MimeSender): string {
  const lines = [
    `From: ${encode(sender.name)} <${header(sender.email)}>`,
    `To: ${job.to.map(header).join(", ")}`,
    ...(job.cc?.length ? [`Cc: ${job.cc.map(header).join(", ")}`] : []),
    `Subject: ${encode(job.subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${Buffer.from(job.messageId).toString("base64url")}@sendplug.local>`,
    "MIME-Version: 1.0",
  ];

  if (job.html != null) {
    const boundary = `sendplug-${randomBytes(12).toString("hex")}`;
    lines.push(
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      "",
      `--${boundary}`,
      "Content-Type: text/plain; charset=UTF-8",
      "Content-Transfer-Encoding: 8bit",
      "",
      crlf(job.body),
      `--${boundary}`,
      "Content-Type: text/html; charset=UTF-8",
      "Content-Transfer-Encoding: 8bit",
      "",
      crlf(job.html),
      `--${boundary}--`,
    );
  } else {
    lines.push("Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: 8bit", "", crlf(job.body));
  }
  return lines.join("\r\n");
}
