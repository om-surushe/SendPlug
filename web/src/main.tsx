import React, { FormEvent, ReactNode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

type Sender = {
  id: string; name: string; email: string; daily_limit: number; sent_today: number;
  active: boolean; credential_configured: boolean;
};
type ApiToken = {
  id: string; name: string; prefix: string; scopes: string[]; sender_id: string;
  sender_name?: string; sender_email?: string; created_at: string; last_used_at?: string; revoked_at?: string;
};
type Recipient = { email: string; status: string; error?: string };
type Campaign = {
  id: string; name: string; sender_id: string; subject: string; body: string; html?: string;
  status: string; total: number; sent: number; failed: number; created_at: string; recipients?: Recipient[];
};
type Dashboard = {
  senders: number; tokens: number; campaigns: number; sent: number; failed: number; suppressed: number;
  recent_campaigns: Campaign[];
};

const storedToken = () => localStorage.getItem("smtp_admin_token") || "";

async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  headers.set("Content-Type", "application/json");
  const token = storedToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const response = await fetch(path, { ...options, headers });
  if (response.status === 401) {
    localStorage.removeItem("smtp_admin_token");
    window.location.reload();
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.detail || `Request failed (${response.status})`);
  }
  return response.status === 204 ? (undefined as T) : response.json();
}

function BrandMark({ className = "" }: { className?: string }) {
  return <span className={`brand-mark ${className}`} aria-hidden="true">
    <img src="/sendplug-app-icon.svg?v=2" alt="" />
  </span>;
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { ref.current?.showModal(); }, []);
  return <dialog ref={ref} className="modal" onCancel={onClose} onClose={onClose}>
    <div className="modal-head"><h2>{title}</h2><button className="close" onClick={onClose} aria-label="Close">×</button></div>
    {children}
  </dialog>;
}

function Login() {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError("");
    const form = new FormData(event.currentTarget);
    try {
      const result = await api<{ token: string }>("/auth/login", {
        method: "POST",
        body: JSON.stringify({ email: form.get("email"), password: form.get("password") }),
      });
      localStorage.setItem("smtp_admin_token", result.token);
      window.location.reload();
    } catch (err) { setError((err as Error).message); setBusy(false); }
  }
  return <main className="login-shell">
    <section className="login-card" aria-labelledby="login-title">
      <BrandMark />
      <p className="eyebrow">PLUG-AND-PLAY EMAIL</p>
      <h1 id="login-title">SendPlug</h1>
      <p className="muted">Connect Google, create an API token, and manage every delivery.</p>
      <form onSubmit={submit} className="stack-lg">
        <label>Email<input name="email" type="email" autoComplete="username" required autoFocus /></label>
        <label>Password<input name="password" type="password" autoComplete="current-password" required /></label>
        {error && <div className="alert error" role="alert">{error}</div>}
        <button className="primary wide" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
      </form>
    </section>
  </main>;
}

const nav = [
  ["dashboard", "⌘", "Overview"], ["senders", "↗", "Senders"],
  ["tokens", "⚿", "API Tokens"], ["campaigns", "✦", "Campaigns"],
] as const;

function Layout() {
  const [view, setView] = useState<(typeof nav)[number][0]>("dashboard");
  const [notice, setNotice] = useState("");
  return <div className="app-shell">
    <aside className="sidebar">
      <div className="logo"><BrandMark /><strong>SendPlug</strong></div>
      <nav>{nav.map(([id, icon, label]) =>
        <button key={id} className={view === id ? "active" : ""} onClick={() => setView(id)}>
          <span>{icon}</span>{label}
        </button>)}
        <a href="/docs" target="_blank" rel="noreferrer"><span>?</span>Developer Docs</a>
      </nav>
      <div className="sidebar-foot"><span className="status-dot" /> SendPlug delivery online</div>
    </aside>
    <main className="content">
      <header><div><p className="eyebrow">EMAIL CONTROL CENTER</p><h1>{nav.find(n => n[0] === view)?.[2]}</h1></div>
        <button className="ghost" onClick={() => { localStorage.removeItem("smtp_admin_token"); location.reload(); }}>Sign out</button>
      </header>
      {notice && <div className="alert success" onClick={() => setNotice("")}>{notice}</div>}
      {view === "dashboard" && <DashboardView />}
      {view === "senders" && <SendersView notify={setNotice} />}
      {view === "tokens" && <TokensView notify={setNotice} />}
      {view === "campaigns" && <CampaignsView notify={setNotice} />}
    </main>
  </div>;
}

function Loading() { return <div className="empty">Loading…</div>; }
function ErrorBox({ error }: { error: string }) { return <div className="alert error">{error}</div>; }
function formatDate(value?: string) { return value ? new Date(value).toLocaleString() : "Never"; }

function DashboardView() {
  const [data, setData] = useState<Dashboard>(); const [error, setError] = useState("");
  useEffect(() => { api<Dashboard>("/api/v1/dashboard").then(setData).catch(e => setError(e.message)); }, []);
  if (error) return <ErrorBox error={error} />; if (!data) return <Loading />;
  const stats = [["Active senders", data.senders], ["API tokens", data.tokens], ["Campaigns", data.campaigns], ["Accepted by Gmail", data.sent], ["Suppressed", data.suppressed]];
  return <>
    <div className="stats">{stats.map(([label, value]) => <article className="stat" key={label}><span>{label}</span><strong>{value}</strong></article>)}</div>
    <section className="panel"><div className="panel-title"><div><h2>Recent campaigns</h2><p>Per-recipient delivery through Gmail</p></div></div>
      {data.recent_campaigns.length ? <CampaignTable campaigns={data.recent_campaigns} /> : <div className="empty">No campaigns yet.</div>}
    </section>
  </>;
}

function SendersView({ notify }: { notify: (s: string) => void }) {
  const [items, setItems] = useState<Sender[]>([]); const [error, setError] = useState("");
  const [show, setShow] = useState(false); const [editing, setEditing] = useState<Sender>();
  const load = () => api<Sender[]>("/api/v1/senders").then(setItems).catch(e => setError(e.message));
  useEffect(() => { void load(); }, []);
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const f = new FormData(event.currentTarget);
    const body = { name: f.get("name"), email: f.get("email"), app_password: f.get("password") || null, daily_limit: Number(f.get("limit")), active: f.get("active") !== "false" };
    try {
      await api(editing ? `/api/v1/senders/${editing.id}` : "/api/v1/senders", { method: editing ? "PUT" : "POST", body: JSON.stringify(body) });
      setShow(false); setEditing(undefined); notify(editing ? "Sender updated" : "Sender encrypted and saved"); void load();
    } catch (e) { setError((e as Error).message); }
  }
  async function test(id: string) { try { await api(`/api/v1/senders/${id}/test`, { method: "POST" }); notify("Gmail connection successful"); } catch (e) { setError((e as Error).message); } }
  async function remove(id: string) { if (!confirm("Remove this sender? Existing history is retained.")) return; try { await api(`/api/v1/senders/${id}`, { method: "DELETE" }); notify("Sender removed"); void load(); } catch (e) { setError((e as Error).message); } }
  const open = (sender?: Sender) => { setEditing(sender); setShow(true); setError(""); };
  return <>
    <div className="toolbar"><p className="muted">App Passwords are encrypted before they reach the database.</p><button className="primary" onClick={() => open()}>+ Add Gmail sender</button></div>
    {error && <ErrorBox error={error} />}
    {show && <Modal title={editing ? "Edit Gmail sender" : "Connect Gmail"} onClose={() => { setShow(false); setEditing(undefined); }}>
      <p className="muted">Use a Google App Password, not your normal Gmail password.</p>
      <form key={editing?.id || "new"} onSubmit={save} className="form-grid">
        <label>Name<input name="name" defaultValue={editing?.name} placeholder="Primary Gmail" required /></label>
        <label>Gmail address<input name="email" type="email" defaultValue={editing?.email} required /></label>
        <label>{editing ? "New App Password (optional)" : "16-character App Password"}<input name="password" type="password" minLength={8} required={!editing} /></label>
        <label>Daily safety limit<input name="limit" type="number" min="1" max="2000" defaultValue={editing?.daily_limit || 400} required /></label>
        {editing && <label>Status<select name="active" defaultValue={String(editing.active)}><option value="true">Active</option><option value="false">Inactive</option></select></label>}
        <button className="primary">{editing ? "Save changes" : "Encrypt and connect"}</button>
      </form>
    </Modal>}
    <div className="card-grid">{items.map(item => <article className={`panel sender-card ${item.active ? "" : "inactive"}`} key={item.id}><div className="sender-icon">G</div><div className="grow"><h3>{item.name} {!item.active && <span className="badge">inactive</span>}</h3><p>{item.email}</p><div className="quota"><span style={{ width: `${Math.min(100, item.sent_today / item.daily_limit * 100)}%` }} /></div><small>{item.sent_today} / {item.daily_limit} recipients today</small></div><div className="actions"><button className="ghost" onClick={() => open(item)}>Edit</button><button className="ghost" disabled={!item.active} onClick={() => test(item.id)}>Test</button><button className="danger ghost" onClick={() => remove(item.id)}>Remove</button></div></article>)}</div>
    {!items.length && !show && <div className="empty">Connect Gmail to start sending.</div>}
  </>;
}

function TokensView({ notify }: { notify: (s: string) => void }) {
  const [items, setItems] = useState<ApiToken[]>([]); const [senders, setSenders] = useState<Sender[]>([]);
  const [raw, setRaw] = useState(""); const [error, setError] = useState(""); const [editing, setEditing] = useState<ApiToken>();
  const load = () => Promise.all([api<ApiToken[]>("/api/v1/tokens"), api<Sender[]>("/api/v1/senders")]).then(([t, s]) => { setItems(t); setSenders(s.filter(x => x.active)); }).catch(e => setError(e.message));
  useEffect(() => { void load(); }, []);
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = event.currentTarget; const f = new FormData(form); const scopes = ["send", "status"].filter(scope => f.get(scope));
    try {
      const result = await api<ApiToken & { token?: string }>(editing ? `/api/v1/tokens/${editing.id}` : "/api/v1/tokens", { method: editing ? "PUT" : "POST", body: JSON.stringify({ name: f.get("name"), sender_id: f.get("sender"), scopes }) });
      if (result.token) setRaw(result.token); setEditing(undefined); notify(editing ? "Token updated" : "Sender-scoped token generated"); void load();
      form.reset();
    } catch (e) { setError((e as Error).message); }
  }
  async function revoke(id: string) { if (!confirm("Revoke this token? This cannot be undone.")) return; try { await api(`/api/v1/tokens/${id}`, { method: "DELETE" }); notify("Token revoked"); setEditing(undefined); void load(); } catch (e) { setError((e as Error).message); } }
  return <>
    <section className="panel form-panel"><div className="panel-heading"><h2>{editing ? "Edit API token" : "Create API token"}</h2>{editing && <button className="close" onClick={() => setEditing(undefined)} aria-label="Cancel edit">×</button>}</div>
      <form key={editing?.id || "new"} onSubmit={save} className="token-form">
        <label>Name<input name="name" defaultValue={editing?.name} placeholder="Production application" required /></label>
        <label>Gmail sender<select name="sender" defaultValue={editing?.sender_id} required><option value="" disabled>Select a sender</option>{senders.map(s => <option value={s.id} key={s.id}>{s.name} · {s.email}</option>)}</select></label>
        <fieldset><legend>Permissions</legend><label><input type="checkbox" name="send" defaultChecked={!editing || editing.scopes.includes("send")} /> Send</label><label><input type="checkbox" name="status" defaultChecked={!editing || editing.scopes.includes("status")} /> Status</label></fieldset>
        <button className="primary" disabled={!senders.length}>{editing ? "Save changes" : "Generate token"}</button>
      </form>
      <p className="form-help">A token can only send from and read delivery status for its selected Gmail sender.</p>
    </section>
    {raw && <div className="secret-box"><div><strong>Copy this token now</strong><p>It cannot be displayed again.</p></div><code>{raw}</code><button onClick={() => { void navigator.clipboard.writeText(raw); notify("Token copied"); }}>Copy</button></div>}
    {error && <ErrorBox error={error} />}
    <section className="panel"><div className="table-wrap"><table><thead><tr><th>Name</th><th>Gmail sender</th><th>Prefix</th><th>Scopes</th><th>Last used</th><th /></tr></thead><tbody>{items.map(item => <tr key={item.id}><td>{item.name}</td><td><strong>{item.sender_name || "Legacy token"}</strong><small>{item.sender_email || "No sender assigned"}</small></td><td><code>{item.prefix}…</code></td><td>{item.scopes.join(", ")}</td><td>{formatDate(item.last_used_at)}</td><td><div className="row-actions"><button className="ghost" disabled={!!item.revoked_at} onClick={() => setEditing(item)}>Edit</button><button className="danger ghost" disabled={!!item.revoked_at} onClick={() => revoke(item.id)}>{item.revoked_at ? "Revoked" : "Revoke"}</button></div></td></tr>)}</tbody></table></div></section>
  </>;
}

function CampaignsView({ notify }: { notify: (s: string) => void }) {
  const [items, setItems] = useState<Campaign[]>([]); const [senders, setSenders] = useState<Sender[]>([]);
  const [show, setShow] = useState(false); const [editing, setEditing] = useState<Campaign>(); const [error, setError] = useState("");
  const load = () => Promise.all([api<Campaign[]>("/api/v1/campaigns"), api<Sender[]>("/api/v1/senders")]).then(([c, s]) => { setItems(c); setSenders(s.filter(x => x.active)); }).catch(e => setError(e.message));
  useEffect(() => { void load(); }, []);
  async function open(campaign?: Campaign) {
    setError("");
    if (!campaign) { setEditing(undefined); setShow(true); return; }
    try { setEditing(await api<Campaign>(`/api/v1/campaigns/${campaign.id}`)); setShow(true); } catch (e) { setError((e as Error).message); }
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const f = new FormData(event.currentTarget); const recipients = String(f.get("recipients")).split(/[\n,;]+/).map(x => x.trim()).filter(Boolean);
    try {
      await api(editing ? `/api/v1/campaigns/${editing.id}` : "/api/v1/campaigns", { method: editing ? "PUT" : "POST", body: JSON.stringify({ name: f.get("name"), sender_id: f.get("sender"), subject: f.get("subject"), body: f.get("body"), html: f.get("html") || null, recipients }) });
      setShow(false); setEditing(undefined); notify(editing ? "Campaign updated" : `Draft created for ${recipients.length} recipients`); void load();
    } catch (e) { setError((e as Error).message); }
  }
  async function start(id: string) { if (!confirm("Start this campaign? Each recipient counts toward the Gmail daily limit.")) return; try { await api(`/api/v1/campaigns/${id}/start`, { method: "POST" }); notify("Campaign queued at one message per second"); void load(); } catch (e) { setError((e as Error).message); } }
  async function remove(id: string) { if (!confirm("Delete this draft campaign?")) return; try { await api(`/api/v1/campaigns/${id}`, { method: "DELETE" }); notify("Draft deleted"); void load(); } catch (e) { setError((e as Error).message); } }
  const readOnly = !!editing && editing.status !== "draft";
  return <>
    <div className="toolbar"><p className="muted">Only email people who explicitly opted in.</p><button className="primary" disabled={!senders.length} onClick={() => void open()}>+ New campaign</button></div>
    {error && <ErrorBox error={error} />}
    {show && <Modal title={readOnly ? "Campaign details" : editing ? "Edit campaign" : "Campaign draft"} onClose={() => { setShow(false); setEditing(undefined); }}>
      <form key={editing?.id || "new"} onSubmit={save} className="stack-lg">
        <div className="form-grid"><label>Name<input name="name" defaultValue={editing?.name} required disabled={readOnly} /></label><label>Sender<select name="sender" defaultValue={editing?.sender_id} required disabled={readOnly}>{senders.map(s => <option value={s.id} key={s.id}>{s.name} · {s.email}</option>)}</select></label></div>
        <label>Subject<input name="subject" defaultValue={editing?.subject} required disabled={readOnly} /></label>
        <label>Recipients<textarea name="recipients" rows={5} defaultValue={editing?.recipients?.map(x => x.email).join("\n")} placeholder="one@example.com&#10;two@example.com" required disabled={readOnly} /></label>
        <label>Plain-text message<textarea name="body" rows={6} defaultValue={editing?.body} required disabled={readOnly} /></label>
        <label>HTML message <span className="optional">optional</span><textarea name="html" rows={6} defaultValue={editing?.html} placeholder="<h1>Hello</h1>" disabled={readOnly} /></label>
        {!readOnly && <button className="primary">{editing ? "Save changes" : "Save draft"}</button>}
      </form>
    </Modal>}
    <section className="panel">{items.length ? <CampaignTable campaigns={items} actions={item => <div className="row-actions"><button className="ghost" onClick={() => void open(item)}>{item.status === "draft" ? "Edit" : "View"}</button>{item.status === "draft" && <><button className="primary" onClick={() => start(item.id)}>Start</button><button className="danger ghost" onClick={() => remove(item.id)}>Delete</button></>}</div>} /> : <div className="empty">No campaigns yet.</div>}</section>
  </>;
}

function CampaignTable({ campaigns, actions }: { campaigns: Campaign[]; actions?: (item: Campaign) => ReactNode }) {
  return <div className="table-wrap"><table><thead><tr><th>Campaign</th><th>Status</th><th>Recipients</th><th>Sent</th><th>Failed</th><th>Created</th>{actions && <th />}</tr></thead><tbody>{campaigns.map(item => <tr key={item.id}><td><strong>{item.name}</strong><small>{item.subject}</small></td><td><span className={`badge ${item.status}`}>{item.status}</span></td><td>{item.total}</td><td>{item.sent}</td><td>{item.failed}</td><td>{formatDate(item.created_at)}</td>{actions && <td>{actions(item)}</td>}</tr>)}</tbody></table></div>;
}

createRoot(document.getElementById("root")!).render(<React.StrictMode>{storedToken() ? <Layout /> : <Login />}</React.StrictMode>);
