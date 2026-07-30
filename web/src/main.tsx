import React, { FormEvent, ReactNode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

type Session = { accountId: string; user: { id: string; email: string; name: string }; role?: string };
type AuthConfig = { google: boolean; password: boolean; signups: boolean };
type Sender = {
  id: string; name: string; email: string; dailyLimit: number; sentToday?: number;
  active: boolean; createdAt: string; updatedAt: string;
};
type ApiToken = {
  id: string; name: string; prefix: string; scopes: string[]; senderId: string;
  senderName?: string; senderEmail?: string; createdAt: string; lastUsedAt?: string; revokedAt?: string;
};
type Dashboard = { senders: number; tokens: number; sent: number; failed: number; suppressed: number };
type EmailStatus = {
  message_id: string; status: "queued" | "sending" | "sent" | "failed"; to?: string[];
  recipients?: string[]; subject: string; sender_id: string; created_at: string; updated_at: string;
  error?: string | null; details?: Record<string, unknown> | null;
};

async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body) headers.set("Content-Type", "application/json");
  const response = await fetch(path, { ...options, headers, credentials: "include" });
  if (response.status === 401) window.dispatchEvent(new Event("sendplug:unauthorized"));
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.detail || body.error || `Request failed (${response.status})`);
  }
  return response.status === 204 ? (undefined as T) : response.json();
}

function BrandMark() {
  return <span className="brand-mark" aria-hidden="true"><img src="/sendplug-app-icon.svg?v=3" alt="" /></span>;
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { ref.current?.showModal(); }, []);
  return <dialog ref={ref} className="modal" onCancel={onClose} onClose={onClose}>
    <div className="modal-head"><h2>{title}</h2><button className="close" onClick={onClose} aria-label="Close">×</button></div>
    {children}
  </dialog>;
}

function Login({ onAuthenticated }: { onAuthenticated: () => void }) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<"login" | "register">("register");
  const [config, setConfig] = useState<AuthConfig>({ google: false, password: true, signups: true });
  useEffect(() => {
    api<AuthConfig>("/auth/config").then(next => { setConfig(next); if (!next.signups) setMode("login"); }).catch(() => undefined);
  }, []);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError("");
    const form = new FormData(event.currentTarget);
    try {
      await api(mode === "register" ? "/auth/register" : "/auth/login", {
        method: "POST",
        body: JSON.stringify({ email: form.get("email"), password: form.get("password"), ...(mode === "register" ? { name: form.get("name") || null } : {}) }),
      });
      onAuthenticated();
    } catch (err) { setError((err as Error).message); setBusy(false); }
  }
  return <main className="login-shell landing-shell">
    <section className="landing-copy" aria-labelledby="landing-title">
      <p className="eyebrow">OPEN SOURCE · SELF-HOSTED</p>
      <h1 id="landing-title">Your Gmail. Your server. Your API.</h1>
      <p>Self-host a simple transactional email API through Gmail or Google Workspace—without paying for another email platform. Use this hosted beta to try it before deploying.</p>
      <div className="landing-points">
        <span><strong>1.</strong> Deploy the open-source Bun stack</span>
        <span><strong>2.</strong> Connect Gmail with a separate App Password</span>
        <span><strong>3.</strong> Send through the native API or a Resend SDK</span>
      </div>
      <p className="boundary">Built for personal projects, internal tools, and low-volume MVPs. Gmail acceptance is not inbox delivery, and Google sending limits still apply.</p>
      <div className="landing-links"><a className="primary" href="https://github.com/om-surushe/SendPlug" target="_blank" rel="noreferrer">Self-host on GitHub</a><a className="ghost" href="/docs" target="_blank" rel="noreferrer">API quick start</a></div>
      <p className="landing-credit">Vibe coded by <a href="https://omsurushe.bio.link" target="_blank" rel="noreferrer">Om Surushe</a>.</p>
    </section>
    <section className="login-card" aria-labelledby="login-title">
      <BrandMark />
      <p className="eyebrow">SENDPLUG ACCOUNT</p>
      <h2 id="login-title">{mode === "register" ? "Create account" : "Sign in"}</h2>
      <p className="muted">Account credentials are separate from the Gmail App Password you connect after sign-in.</p>
      {config.google && <><a className="google-button" href="/workos/login">Continue with WorkOS</a><div className="auth-divider"><span>or use email</span></div></>}
      {config.password && <form onSubmit={submit} className="stack-lg">
        {mode === "register" && <label>Name <span className="optional">optional</span><input name="name" autoComplete="name" maxLength={100} /></label>}
        <label>Email<input name="email" type="email" autoComplete="username" required autoFocus={!config.google} /></label>
        <label>Password<input name="password" type="password" minLength={mode === "register" ? 12 : 1} maxLength={128} autoComplete={mode === "register" ? "new-password" : "current-password"} required /></label>
        {mode === "register" && <p className="muted">Use at least 12 characters. Never enter your Gmail password here.</p>}
        {error && <div className="alert error" role="alert">{error}</div>}
        <button className="primary wide" disabled={busy}>{busy ? "Please wait…" : mode === "register" ? "Create free account" : "Sign in"}</button>
        {config.signups && <button type="button" className="ghost wide" onClick={() => { setMode(mode === "login" ? "register" : "login"); setError(""); }}>{mode === "login" ? "Create an account" : "Already have an account? Sign in"}</button>}
      </form>}
    </section>
  </main>;
}

const nav = [
  ["dashboard", "⌘", "Overview"], ["senders", "↗", "Senders"],
  ["tokens", "⚿", "API Tokens"], ["status", "◉", "Status"],
] as const;

type View = (typeof nav)[number][0];

function Layout({ session, onSignedOut }: { session: Session; onSignedOut: () => void }) {
  const [view, setView] = useState<View>("dashboard");
  const [notice, setNotice] = useState("");
  async function signOut() {
    try { await api("/auth/logout", { method: "POST" }); } finally { onSignedOut(); }
  }
  return <div className="app-shell">
    <aside className="sidebar">
      <div className="logo"><BrandMark /><strong>SendPlug</strong></div>
      <nav aria-label="Dashboard">{nav.map(([id, icon, label]) =>
        <button key={id} className={view === id ? "active" : ""} aria-current={view === id ? "page" : undefined} onClick={() => setView(id)}>
          <span aria-hidden="true">{icon}</span>{label}
        </button>)}
        <a href="/docs"><span aria-hidden="true">?</span>Docs</a>
      </nav>
      <div className="sidebar-foot"><strong>{session.user.name}</strong><span>{session.user.email}</span></div>
    </aside>
    <main className="content">
      <header><div><p className="eyebrow">{session.user.name}</p><h1>{nav.find(item => item[0] === view)?.[2]}</h1></div>
        <button className="ghost" onClick={() => void signOut()}>Sign out</button>
      </header>
      {notice && <div className="alert success" role="status"><span>{notice}</span><button aria-label="Dismiss notification" onClick={() => setNotice("")}>×</button></div>}
      {view === "dashboard" && <DashboardView onNavigate={setView} />}
      {view === "senders" && <SendersView notify={setNotice} />}
      {view === "tokens" && <TokensView notify={setNotice} />}
      {view === "status" && <StatusView />}
    </main>
  </div>;
}

function Loading() { return <div className="empty">Loading…</div>; }
function ErrorBox({ error }: { error: string }) { return <div className="alert error" role="alert">{error}</div>; }
function formatDate(value?: string) { return value ? new Date(value).toLocaleString() : "Never"; }

function DashboardView({ onNavigate }: { onNavigate: (view: View) => void }) {
  const [data, setData] = useState<Dashboard>(); const [error, setError] = useState("");
  useEffect(() => { api<Dashboard>("/api/v1/dashboard").then(setData).catch(err => setError(err.message)); }, []);
  if (error) return <ErrorBox error={error} />; if (!data) return <Loading />;
  const stats = [["Active senders", data.senders], ["API tokens", data.tokens], ["Accepted by Gmail", data.sent], ["Failed", data.failed], ["Suppressed", data.suppressed]];
  return <>
    {!data.senders && <section className="panel first-run"><p className="eyebrow">FIRST EMAIL</p><h2>Start with your Gmail sender</h2><ol><li><button className="text-button" onClick={() => onNavigate("senders")}>Add a Gmail sender</button> with an App Password, then run its connection test.</li><li>Create a sender-scoped key under <button className="text-button" onClick={() => onNavigate("tokens")}>API Tokens</button>.</li><li>Use the <a href="/docs" target="_blank" rel="noreferrer">Resend SDK quick start</a>, then inspect a message under <button className="text-button" onClick={() => onNavigate("status")}>Status</button>.</li></ol></section>}
    <div className="stats">{stats.map(([label, value]) => <article className="stat" key={label}><span>{label}</span><strong>{value}</strong></article>)}</div>
    <section className="panel resource-panel"><div><p className="eyebrow">DROP-IN SDK</p><h2>Send with familiar Resend clients</h2><p className="muted">Keep the sender-scoped key on your server and point the official SDK at SendPlug.</p></div><div className="resource-links"><a className="primary" href="/docs" target="_blank" rel="noreferrer">SendPlug quick start</a><a className="ghost" href="https://resend.com/docs/send-with-nodejs" target="_blank" rel="noreferrer">Resend Node.js docs</a><a className="ghost" href="https://resend.com/docs/send-with-python" target="_blank" rel="noreferrer">Resend Python docs</a></div></section>
  </>;
}

function SendersView({ notify }: { notify: (message: string) => void }) {
  const [items, setItems] = useState<Sender[]>([]); const [error, setError] = useState("");
  const [show, setShow] = useState(false); const [editing, setEditing] = useState<Sender>();
  const load = () => api<Sender[]>("/api/v1/senders").then(setItems).catch(err => setError(err.message));
  useEffect(() => { void load(); }, []);
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(""); const form = new FormData(event.currentTarget);
    const body = { name: form.get("name"), email: form.get("email"), ...(form.get("password") ? { appPassword: form.get("password") } : {}), dailyLimit: Number(form.get("limit")), active: form.get("active") !== "false" };
    try {
      await api(editing ? `/api/v1/senders/${editing.id}` : "/api/v1/senders", { method: editing ? "PUT" : "POST", body: JSON.stringify(body) });
      setShow(false); setEditing(undefined); notify(editing ? "Sender updated" : "Sender saved. Run Test before sending."); void load();
    } catch (err) { setError((err as Error).message); }
  }
  async function test(id: string) { try { await api(`/api/v1/senders/${id}/test`, { method: "POST" }); notify("Gmail connection successful"); } catch (err) { setError((err as Error).message); } }
  async function remove(id: string) { if (!confirm("Remove this sender? Existing history is retained.")) return; try { await api(`/api/v1/senders/${id}`, { method: "DELETE" }); notify("Sender removed"); void load(); } catch (err) { setError((err as Error).message); } }
  const open = (sender?: Sender) => { setEditing(sender); setShow(true); setError(""); };
  return <>
    <div className="toolbar"><p className="muted">Gmail sending credentials are separate from account sign-in. SendPlug encrypts App Passwords before database storage.</p><button className="primary" onClick={() => open()}>+ Add Gmail sender</button></div>
    {error && <ErrorBox error={error} />}
    {show && <Modal title={editing ? "Edit Gmail sender" : "Connect Gmail"} onClose={() => { setShow(false); setEditing(undefined); }}>
      <p className="muted">Turn on Google 2-Step Verification, then create a <a href="https://support.google.com/accounts/answer/185833" target="_blank" rel="noreferrer">Google App Password</a>. It is sent over HTTPS and encrypted before database storage. Never use your normal Gmail password.</p>
      <form key={editing?.id || "new"} onSubmit={save} className="form-grid">
        <label>Name<input name="name" defaultValue={editing?.name} placeholder="Primary Gmail" required /></label>
        <label>Gmail address<input name="email" type="email" defaultValue={editing?.email} required /></label>
        <label>{editing ? "New 16-character App Password (optional)" : "16-character App Password"}<input name="password" type="password" minLength={16} maxLength={19} autoComplete="new-password" required={!editing} /></label>
        <label>Daily safety limit<input name="limit" type="number" min="1" max="2000" defaultValue={editing?.dailyLimit || 400} required /></label>
        {editing && <label>Status<select name="active" defaultValue={String(editing.active)}><option value="true">Active</option><option value="false">Inactive</option></select></label>}
        <button className="primary">{editing ? "Save changes" : "Save sender"}</button>
      </form>
    </Modal>}
    <div className="card-grid">{items.map(item => { const sent = item.sentToday ?? 0; return <article className={`panel sender-card ${item.active ? "" : "inactive"}`} key={item.id}><div className="sender-icon" aria-hidden="true">G</div><div className="grow"><h3>{item.name} {!item.active && <span className="badge">inactive</span>}</h3><p>{item.email}</p><div className="quota" aria-label={`${sent} of ${item.dailyLimit} recipients used today`}><span style={{ width: `${Math.min(100, sent / item.dailyLimit * 100)}%` }} /></div><small>{sent} / {item.dailyLimit} recipients today</small></div><div className="actions"><button className="ghost" onClick={() => open(item)}>Edit</button><button className="ghost" disabled={!item.active} onClick={() => void test(item.id)}>Test</button><button className="danger ghost" onClick={() => void remove(item.id)}>Remove</button></div></article>; })}</div>
    {!items.length && !show && <div className="empty">Connect Gmail to start sending.</div>}
  </>;
}

function TokensView({ notify }: { notify: (message: string) => void }) {
  const [items, setItems] = useState<ApiToken[]>([]); const [senders, setSenders] = useState<Sender[]>([]);
  const [raw, setRaw] = useState(""); const [error, setError] = useState(""); const [editing, setEditing] = useState<ApiToken>();
  const load = () => Promise.all([api<ApiToken[]>("/api/v1/tokens"), api<Sender[]>("/api/v1/senders")]).then(([tokens, senderItems]) => { setItems(tokens); setSenders(senderItems.filter(item => item.active)); }).catch(err => setError(err.message));
  useEffect(() => { void load(); }, []);
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(""); const form = event.currentTarget; const data = new FormData(form); const scopes = ["send", "status"].filter(scope => data.get(scope));
    try {
      const result = await api<ApiToken & { token?: string }>(editing ? `/api/v1/tokens/${editing.id}` : "/api/v1/tokens", { method: editing ? "PUT" : "POST", body: JSON.stringify({ name: data.get("name"), senderId: data.get("sender"), scopes }) });
      if (result.token) setRaw(result.token); setEditing(undefined); notify(editing ? "Token updated" : "Sender-scoped key generated"); void load(); form.reset();
    } catch (err) { setError((err as Error).message); }
  }
  async function copyToken() { try { await navigator.clipboard.writeText(raw); notify("Token copied"); } catch { setError("Copy failed. Select the key and copy it manually."); } }
  async function revoke(id: string) { if (!confirm("Revoke this token? This cannot be undone.")) return; try { await api(`/api/v1/tokens/${id}`, { method: "DELETE" }); notify("Token revoked"); setEditing(undefined); void load(); } catch (err) { setError((err as Error).message); } }
  return <>
    <section className="panel form-panel"><div className="panel-heading"><h2>{editing ? "Edit API token" : "Create API token"}</h2>{editing && <button className="close" onClick={() => setEditing(undefined)} aria-label="Cancel edit">×</button>}</div>
      <form key={editing?.id || "new"} onSubmit={save} className="token-form">
        <label>Name<input name="name" defaultValue={editing?.name} placeholder="Production application" required /></label>
        <label>Gmail sender<select name="sender" defaultValue={editing?.senderId} required><option value="" disabled>Select a sender</option>{senders.map(sender => <option value={sender.id} key={sender.id}>{sender.name} · {sender.email}</option>)}</select></label>
        <fieldset><legend>Permissions</legend><label><input type="checkbox" name="send" defaultChecked={!editing || editing.scopes.includes("send")} /> Send</label><label><input type="checkbox" name="status" defaultChecked={!editing || editing.scopes.includes("status")} /> Status</label></fieldset>
        <button className="primary" disabled={!senders.length}>{editing ? "Save changes" : "Generate key"}</button>
      </form>
      <p className="form-help">Keys work with the Resend SDK and are limited to the selected sender. Create and deploy a replacement before revoking an old key.</p>
    </section>
    {raw && <div className="secret-box" role="status"><div><strong>Copy this key now</strong><p>It cannot be displayed again.</p></div><code>{raw}</code><button onClick={() => void copyToken()}>Copy</button><button className="secret-dismiss" aria-label="Hide API key" onClick={() => setRaw("")}>×</button></div>}
    {error && <ErrorBox error={error} />}
    <section className="panel"><div className="table-wrap" tabIndex={0} role="region" aria-label="API tokens table"><table><thead><tr><th>Name</th><th>Gmail sender</th><th>Prefix</th><th>Scopes</th><th>Last used</th><th /></tr></thead><tbody>{items.map(item => <tr key={item.id}><td>{item.name}</td><td><strong>{item.senderName || "Gmail sender"}</strong><small>{item.senderEmail || item.senderId}</small></td><td><code>{item.prefix}…</code></td><td>{item.scopes.join(", ")}</td><td>{formatDate(item.lastUsedAt)}</td><td><div className="row-actions"><button className="ghost" disabled={!!item.revokedAt} onClick={() => setEditing(item)}>Edit</button><button className="danger ghost" disabled={!!item.revokedAt} onClick={() => void revoke(item.id)}>{item.revokedAt ? "Revoked" : "Revoke"}</button></div></td></tr>)}</tbody></table></div>{!items.length && <div className="empty">Create a sender before generating a key.</div>}</section>
  </>;
}

function StatusView() {
  const [result, setResult] = useState<EmailStatus>(); const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  async function lookup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(""); setResult(undefined);
    const messageId = String(new FormData(event.currentTarget).get("message_id") || "").trim();
    try { setResult(await api<EmailStatus>(`/api/v1/emails/${encodeURIComponent(messageId)}`)); } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }
  const recipients = result?.to || result?.recipients || [];
  return <>
    <section className="panel form-panel"><h2>Look up a delivery</h2><p className="muted">Paste the message ID returned by the SendPlug or Resend-compatible send endpoint.</p><form className="inline-form status-form" onSubmit={lookup}><label><span>Message ID</span><input name="message_id" placeholder="message_…" required /></label><button className="primary" disabled={busy}>{busy ? "Checking…" : "Check status"}</button></form></section>
    {error && <ErrorBox error={error} />}
    {result && <section className="panel status-result" aria-live="polite"><div className="panel-title"><div><p className="eyebrow">DELIVERY</p><h2>{result.subject}</h2></div><span className={`badge ${result.status}`}>{result.status}</span></div><dl><div><dt>Message ID</dt><dd><code>{result.message_id}</code></dd></div><div><dt>Recipients</dt><dd>{recipients.join(", ") || "—"}</dd></div><div><dt>Sender ID</dt><dd><code>{result.sender_id}</code></dd></div><div><dt>Created</dt><dd>{formatDate(result.created_at)}</dd></div><div><dt>Updated</dt><dd>{formatDate(result.updated_at)}</dd></div>{result.error && <div><dt>Error</dt><dd className="danger">{result.error}</dd></div>}</dl></section>}
    <p className="status-note">“Sent” means Gmail accepted the SMTP message. It does not confirm inbox placement, opens, or clicks.</p>
  </>;
}

function App() {
  const [session, setSession] = useState<Session | null>();
  const loadSession = () => api<Session>("/auth/me").then(setSession).catch(() => setSession(null));
  useEffect(() => { void loadSession(); }, []);
  useEffect(() => {
    const unauthorized = () => setSession(null);
    window.addEventListener("sendplug:unauthorized", unauthorized);
    return () => window.removeEventListener("sendplug:unauthorized", unauthorized);
  }, []);
  if (session === undefined) return <main className="login-shell"><div className="empty">Loading SendPlug…</div></main>;
  return session ? <Layout session={session} onSignedOut={() => setSession(null)} /> : <Login onAuthenticated={() => void loadSession()} />;
}

createRoot(document.getElementById("root")!).render(<React.StrictMode><App /></React.StrictMode>);
