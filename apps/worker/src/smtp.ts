import { once } from "node:events";
import net, { type Socket } from "node:net";
import tls, { type TLSSocket } from "node:tls";

export type SmtpRequest = {
  host: "smtp.gmail.com";
  port: 587;
  username: string;
  password: string;
  from: string;
  recipients: string[];
  mime: string;
};

export interface SmtpTransport {
  send(request: SmtpRequest): Promise<void>;
}

export class SmtpResponseError extends Error {
  constructor(public readonly code: number) {
    super(`SMTP rejected request (${code})`);
  }
  get retryable(): boolean { return this.code >= 400 && this.code < 500; }
}

class Responses {
  private buffer = "";
  private lines: string[] = [];
  private waiters: Array<{ resolve: (line: string) => void; reject: (error: Error) => void }> = [];
  private onData = (chunk: Buffer) => {
    this.buffer += chunk.toString("utf8");
    let split: number;
    while ((split = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, split).replace(/\r$/, "");
      this.buffer = this.buffer.slice(split + 1);
      const waiter = this.waiters.shift();
      if (waiter) waiter.resolve(line); else this.lines.push(line);
    }
  };
  private onError = (error: Error) => {
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  };
  private onClose = () => this.onError(new Error("SMTP connection closed"));
  attach(socket: Socket | TLSSocket) {
    socket.on("data", this.onData); socket.on("error", this.onError); socket.on("close", this.onClose);
  }
  detach(socket: Socket | TLSSocket) {
    socket.off("data", this.onData); socket.off("error", this.onError); socket.off("close", this.onClose);
  }
  line(): Promise<string> {
    return this.lines.length ? Promise.resolve(this.lines.shift()!) : new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }
}

async function response(reader: Responses, accepted: number[]): Promise<void> {
  let line = await reader.line();
  const code = Number(line.slice(0, 3));
  while (line[3] === "-") line = await reader.line();
  if (!accepted.includes(code)) throw new SmtpResponseError(code);
}

function write(socket: Socket | TLSSocket, value: string): Promise<void> {
  return new Promise((resolve, reject) => socket.write(value, (error) => error ? reject(error) : resolve()));
}

async function command(socket: Socket | TLSSocket, reader: Responses, value: string, accepted: number[]) {
  await write(socket, `${value}\r\n`);
  await response(reader, accepted);
}

export class GmailSmtpTransport implements SmtpTransport {
  constructor(private readonly timeoutMs = 30_000) {}

  async testCredentials(username: string, password: string): Promise<void> {
    const plain = net.createConnection({ host: "smtp.gmail.com", port: 587 });
    plain.setTimeout(this.timeoutMs, () => plain.destroy(new Error("SMTP timeout")));
    await once(plain, "connect");
    const reader = new Responses();
    reader.attach(plain);
    let socket: Socket | TLSSocket = plain;
    try {
      await response(reader, [220]);
      await command(plain, reader, "EHLO sendplug.local", [250]);
      await command(plain, reader, "STARTTLS", [220]);
      reader.detach(plain);
      const secure = tls.connect({ socket: plain, servername: "smtp.gmail.com", minVersion: "TLSv1.2", rejectUnauthorized: true });
      socket = secure;
      reader.attach(secure);
      await once(secure, "secureConnect");
      await command(secure, reader, "EHLO sendplug.local", [250]);
      await command(secure, reader, "AUTH LOGIN", [334]);
      await command(secure, reader, Buffer.from(username).toString("base64"), [334]);
      await command(secure, reader, Buffer.from(password).toString("base64"), [235]);
      await command(secure, reader, "QUIT", [221]);
    } finally { socket.destroy(); }
  }

  async send(request: SmtpRequest): Promise<void> {
    if (request.host !== "smtp.gmail.com" || request.port !== 587) throw new TypeError("Gmail STARTTLS endpoint required");
    const plain = net.createConnection({ host: request.host, port: request.port });
    plain.setTimeout(this.timeoutMs, () => plain.destroy(new Error("SMTP timeout")));
    await once(plain, "connect");
    const reader = new Responses();
    reader.attach(plain);
    let socket: Socket | TLSSocket = plain;
    try {
      await response(reader, [220]);
      await command(plain, reader, "EHLO sendplug.local", [250]);
      await command(plain, reader, "STARTTLS", [220]);
      reader.detach(plain);
      const secure = tls.connect({ socket: plain, servername: request.host, minVersion: "TLSv1.2", rejectUnauthorized: true });
      socket = secure;
      reader.attach(secure);
      await once(secure, "secureConnect");
      await command(secure, reader, "EHLO sendplug.local", [250]);
      await command(secure, reader, "AUTH LOGIN", [334]);
      await command(secure, reader, Buffer.from(request.username).toString("base64"), [334]);
      await command(secure, reader, Buffer.from(request.password).toString("base64"), [235]);
      await command(secure, reader, `MAIL FROM:<${request.from}>`, [250]);
      for (const recipient of request.recipients) await command(secure, reader, `RCPT TO:<${recipient}>`, [250, 251]);
      await command(secure, reader, "DATA", [354]);
      const data = request.mime.replace(/(^|\r\n)\./g, "$1..");
      await command(secure, reader, `${data}\r\n.`, [250]);
      await command(secure, reader, "QUIT", [221]);
    } finally {
      socket.destroy();
    }
  }
}
