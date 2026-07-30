import { Elysia, t } from "elysia";
import { getOrCreateWorkOSIdentity, type Database } from "@sendplug/database";

export type WorkOSAuthClient = {
  getAuthorizationUrlWithPKCE(options: {
    clientId: string;
    provider: "authkit";
    redirectUri: string;
  }): Promise<{ url: string; state: string; codeVerifier: string }>;
  authenticateWithCode(options: {
    clientId: string;
    code: string;
    codeVerifier: string;
    session: { sealSession: true; cookiePassword: string };
  }): Promise<{
    user: { id: string; email: string; firstName?: string | null; lastName?: string | null };
    sealedSession?: string;
  }>;
  loadSealedSession(options: { sessionData: string; cookiePassword: string }): {
    authenticate(): Promise<
      | { authenticated: false }
      | {
          authenticated: true;
          user: { id: string; email: string; firstName?: string | null; lastName?: string | null };
        }
    >;
  };
};

export type AuthDependencies = {
  client: WorkOSAuthClient;
  database: Database;
  state: {
    put(state: string, verifier: string): Promise<void>;
    take(state: string): Promise<string | null>;
  };
  clientId: string;
  cookiePassword: string;
  redirectUri: string;
  secureCookies: boolean;
};

function sessionCookie(value: string, secure: boolean, clear = false): string {
  const name = secure ? "__Host-sendplug_session" : "sendplug_session";
  return [
    `${name}=${clear ? "" : encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    secure ? "Secure" : "",
    clear ? "Max-Age=0" : "Max-Age=604800",
  ]
    .filter(Boolean)
    .join("; ");
}

function readSessionCookie(request: Request, secure: boolean): string | null {
  const name = secure ? "__Host-sendplug_session" : "sendplug_session";
  const entry = request.headers
    .get("cookie")
    ?.split(";")
    .map((cookie) => cookie.trim())
    .find((cookie) => cookie.startsWith(`${name}=`));
  if (!entry) return null;
  try {
    return decodeURIComponent(entry.slice(name.length + 1));
  } catch {
    return null;
  }
}

export function createAuthRoutes(dependencies: AuthDependencies) {
  return new Elysia({ name: "sendplug-workos-auth", prefix: "/workos" })
    .get("/login", async () => {
      const authorization = await dependencies.client.getAuthorizationUrlWithPKCE({
        clientId: dependencies.clientId,
        provider: "authkit",
        redirectUri: dependencies.redirectUri,
      });
      await dependencies.state.put(authorization.state, authorization.codeVerifier);
      return Response.redirect(authorization.url, 302);
    })
    .get(
      "/callback",
      async ({ query }) => {
        const verifier = await dependencies.state.take(query.state);
        if (!verifier) return new Response("Invalid or expired login state", { status: 400 });

        const authentication = await dependencies.client.authenticateWithCode({
          clientId: dependencies.clientId,
          code: query.code,
          codeVerifier: verifier,
          session: { sealSession: true, cookiePassword: dependencies.cookiePassword },
        });
        if (!authentication.sealedSession) {
          return new Response("WorkOS did not return a sealed session", { status: 502 });
        }
        await getOrCreateWorkOSIdentity(dependencies.database, authentication.user);
        return new Response(null, {
          status: 302,
          headers: {
            location: "/",
            "set-cookie": sessionCookie(authentication.sealedSession, dependencies.secureCookies),
          },
        });
      },
      {
        query: t.Object({
          code: t.String({ minLength: 1 }),
          state: t.String({ minLength: 1 }),
        }),
      },
    )
    .get("/me", async ({ request, set }) => {
      const sessionData = readSessionCookie(request, dependencies.secureCookies);
      if (!sessionData) {
        set.status = 401;
        return { error: "Not authenticated" };
      }
      const session = dependencies.client.loadSealedSession({
        sessionData,
        cookiePassword: dependencies.cookiePassword,
      });
      const authentication = await session.authenticate();
      if (!authentication.authenticated) {
        set.status = 401;
        return { error: "Not authenticated" };
      }
      const identity = await getOrCreateWorkOSIdentity(dependencies.database, authentication.user);
      return {
        accountId: identity.accountId,
        user: { id: identity.user.id, email: identity.user.email, name: identity.user.name },
      };
    })
    .post("/logout", ({ set }) => {
      set.headers["set-cookie"] = sessionCookie("", dependencies.secureCookies, true);
      set.status = 204;
    });
}
