import { join, normalize } from "node:path";
import { Elysia } from "elysia";

function safeFile(root: string, relative: string): Bun.BunFile | null {
  const path = normalize(join(root, relative));
  if (!path.startsWith(normalize(root))) return null;
  const file = Bun.file(path);
  return file.size ? file : null;
}

export function createStaticPlugin(root: string) {
  const index = () => safeFile(root, "index.html") ?? new Response("UI is not built", { status: 503 });
  return new Elysia({ name: "sendplug-static" })
    .get("/", index)
    .get("/docs", () => safeFile(root, "docs/index.html") ?? new Response("Documentation is not built", { status: 503 }))
    .get("/docs/", () => safeFile(root, "docs/index.html") ?? new Response("Documentation is not built", { status: 503 }))
    .get("/assets/*", ({ params, set }) => {
      const file = safeFile(root, `assets/${params["*"]}`);
      if (!file) { set.status = 404; return { error: "Not found" }; }
      return file;
    })
    .get("/sendplug-app-icon.svg", () => safeFile(root, "sendplug-app-icon.svg") ?? new Response(null, { status: 404 }))
    .get("/sendplug-favicon.svg", () => safeFile(root, "sendplug-favicon.svg") ?? new Response(null, { status: 404 }))
    .get("/favicon.ico", () => safeFile(root, "favicon.ico") ?? new Response(null, { status: 404 }));
}
