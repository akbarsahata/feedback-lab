import type { SessionUser } from './auth';

const STYLES = `
:root{--bg:#f5f6f8;--surface:#fff;--ink:#192437;--muted:#546176;--line:#d7dee8;--accent:#294fd2;--soft:#e9eeff;--ok:#146447;--ok-bg:#e8f4ee;--warn:#80510b;--warn-bg:#fff3d9;--bad:#9b2331;--bad-bg:#fbe9ea}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
button,input,textarea{font:inherit}button,a,input,textarea{outline-offset:4px}a{color:var(--accent)}
button,.button{display:inline-flex;align-items:center;justify-content:center;gap:6px;padding:8px 13px;border:1px solid var(--line);border-radius:7px;background:#fff;color:var(--ink);font-weight:650;text-decoration:none;cursor:pointer}
button:hover,.button:hover{border-color:var(--accent)}.primary{background:var(--accent);border-color:var(--accent);color:white}.primary:hover{background:#1c3db6}
.link-button{border:0;background:transparent;padding:0;color:var(--accent);font-weight:650}
.shell{display:grid;grid-template-columns:210px minmax(0,1fr);min-height:100vh}
.rail{border-right:1px solid var(--line);background:#fff;padding:26px 16px}
.brand{display:flex;align-items:center;gap:9px;color:var(--ink);text-decoration:none;font-size:17px;font-weight:750;padding:0 8px}
.mark{background:var(--accent);border-radius:7px;color:white;width:29px;height:29px;display:grid;place-items:center;font:700 13px monospace}
.nav{display:grid;gap:5px;margin-top:38px}.nav a{padding:9px 10px;border-radius:7px;display:flex;align-items:center;gap:9px;text-decoration:none;color:var(--muted);font-weight:620}
.nav a:hover{background:var(--bg)}
.workspace{min-width:0}.bar{background:#fff;border-bottom:1px solid var(--line);min-height:64px;padding:13px 30px;display:flex;align-items:center;justify-content:space-between;gap:12px;color:var(--muted);font-size:13px;flex-wrap:wrap}
.bar-user{display:flex;align-items:center;gap:12px;flex-wrap:wrap}.wrap{max-width:1210px;margin:auto;padding:32px 30px 46px}
.head{display:flex;align-items:start;justify-content:space-between;gap:16px;margin-bottom:24px;flex-wrap:wrap}
h1{font-size:32px;letter-spacing:-.035em;line-height:1.15;margin:0 0 7px}h2{font-size:18px;line-height:1.3;margin:0 0 6px}h3{font-size:15px;margin:0 0 4px}
p{margin:0 0 12px}.muted,.small{color:var(--muted)}.small{font-size:13px}.head p:last-child,.panel p:last-child{margin-bottom:0}
.split{display:grid;grid-template-columns:minmax(0,1.65fr) minmax(0,1fr);gap:16px;align-items:start}
.stack{display:grid;gap:16px}.panel{border:1px solid var(--line);border-radius:9px;background:var(--surface);overflow:hidden}
.pad{padding:18px}.panel-top{padding:14px 18px;border-bottom:1px solid var(--line);display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap}
.panel-top h2{margin:0}.actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.end{margin-top:15px}
.tag{display:inline-flex;align-items:center;font-size:12px;line-height:1.32;padding:4px 8px;border-radius:5px;color:#3e4b61;background:#eef1f6;white-space:nowrap;font-weight:650}
.tag.ok{background:var(--ok-bg);color:var(--ok)}.tag.warn{background:var(--warn-bg);color:var(--warn)}.tag.info{background:var(--soft);color:#203dab}.tag.bad{background:var(--bad-bg);color:var(--bad)}
.table-wrap{overflow:auto}table{width:100%;border-collapse:collapse;text-align:left}th,td{padding:12px 14px;border-bottom:1px solid #e4e9f0;vertical-align:middle}
th{background:#f8f9fb;color:var(--muted);font-size:12px;font-weight:750}tr:last-child td{border-bottom:0}td a{font-weight:650}td.compact{white-space:nowrap}
label{display:grid;gap:5px;min-width:0;font-weight:650}input,textarea{min-width:0;width:100%;padding:8px 10px;border:1px solid #bbc7d7;border-radius:6px;background:#fff;color:var(--ink)}
textarea{min-height:88px;resize:vertical}textarea[rows="1"]{min-height:0}.fields{display:grid;grid-template-columns:1fr 1fr;gap:12px}.wide{grid-column:1/-1}
.field{display:grid;gap:8px}.field-error{margin:0;color:var(--bad);font-size:12px;font-weight:600}
.is-hidden{display:none!important}select{min-width:0;width:100%;padding:8px 10px;border:1px solid #bbc7d7;border-radius:6px;background:#fff;color:var(--ink);font:inherit}
.alert{margin-bottom:16px;padding:11px 13px;border-radius:7px;border:1px solid var(--line);background:#fff;font-size:14px}
.alert-error{border-color:#e6b4ba;background:var(--bad-bg);color:#7d1b27}.alert-warn{border-color:#eed398;background:var(--warn-bg);color:#68440e}
.alert-ok{border-color:#b9dccb;background:var(--ok-bg);color:var(--ok)}
.hint{color:var(--muted);font-size:12px;font-weight:500}p.hint{margin:0}
.row-card{border-top:1px solid #e4e9f0;padding:16px 18px}.row-card:first-of-type{border-top:0}
.row-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:10px}
.row-title{font-size:13px;font-weight:750;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}
.row-grid{display:grid;grid-template-columns:180px minmax(0,1fr) minmax(0,1fr);gap:10px;align-items:start}
.row-grid.tests{grid-template-columns:150px minmax(0,1fr) minmax(0,1fr)}
.remove-row{color:var(--bad)}
.mono,code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px}
pre.code{margin:0;background:#f6f8fb;border:1px solid #e4e9f0;border-radius:7px;padding:12px;overflow:auto;white-space:pre-wrap;word-break:break-word}
.prewrap{white-space:pre-wrap;word-break:break-word}
.source{max-height:70vh;overflow:auto;background:#f6f8fb;font:13px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace}
.source-line{display:grid;grid-template-columns:52px minmax(0,1fr);min-height:20px}
.source-number{padding:0 10px;text-align:right;color:#7a8699;background:#eef1f6;border-right:1px solid #e4e9f0;user-select:none}
.source-code{padding:0 12px;white-space:pre-wrap;word-break:break-word}
input[type="file"]{padding:7px;background:#fff}
.meta-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}.metric{border:1px solid var(--line);border-radius:8px;padding:13px;background:white}
.metric strong{display:block;font-size:21px;line-height:1.2;margin:2px 0 3px}
.banner{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:16px;padding:11px 14px;border:1px solid #eed398;border-radius:7px;background:var(--warn-bg);color:#68440e;font-size:13px}
.banner.ok{border-color:#b9dccb;background:var(--ok-bg);color:var(--ok)}
.auth-shell{min-height:100vh;display:grid;place-items:center;padding:24px}.auth-card{width:min(430px,100%);background:#fff;border:1px solid var(--line);border-radius:10px;padding:28px;box-shadow:0 12px 40px #19243714}
.auth-card h1{font-size:28px}.auth-card label{margin-bottom:12px}.auth-card .button{width:100%;margin-top:4px}
.footnote{color:var(--muted);font-size:12px;padding-top:18px}
@media(max-width:920px){.shell{grid-template-columns:165px minmax(0,1fr)}.rail{padding-inline:10px}.wrap,.bar{padding-inline:20px}.split{grid-template-columns:1fr}.row-grid,.row-grid.tests{grid-template-columns:1fr}.meta-grid{grid-template-columns:repeat(3,minmax(0,1fr))}}
@media(max-width:600px){.shell{display:block}.rail{padding:13px;border-right:0;border-bottom:1px solid var(--line)}.nav{margin:12px 0 0;display:flex;overflow:auto}.nav a{white-space:nowrap;padding:6px 8px;font-size:13px}.wrap,.bar{padding-inline:14px}.wrap{padding-top:22px}h1{font-size:27px}.fields,.meta-grid{grid-template-columns:1fr}.pad{padding:14px}th,td{padding:9px 10px}}
`;

export function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function brand(): string {
  return '<a class="brand" href="/assignments"><span class="mark" aria-hidden="true">&lt;/&gt;</span>Feedback Lab</a>';
}

export interface ShellOptions {
  title: string;
  user: SessionUser;
  body: string;
}

function documentPage(title: string, content: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)} · Feedback Lab</title>
<style>${STYLES}</style>
</head>
<body>${content}</body>
</html>`;
}

export function shell({ title, user, body }: ShellOptions): string {
  return documentPage(title, `<div class="shell">
<aside class="rail">
  ${brand()}
  <nav class="nav" aria-label="Main navigation">
    <a href="/assignments"><span aria-hidden="true">▤</span>Assignments</a>
  </nav>
</aside>
<div class="workspace">
  <header class="bar">
    <span>Assignments</span>
    <div class="bar-user">
      <span>${escapeHtml(user.email)}</span>
      <span class="tag">${user.role === 'researcher' ? 'Researcher' : 'Member'}</span>
      <form method="post" action="/sign-out">
        <input type="hidden" name="_csrf" value="${escapeHtml(user.csrfToken)}">
        <button class="link-button" type="submit">Sign out</button>
      </form>
    </div>
  </header>
  <main class="wrap">
    ${body}
    <div class="footnote">Feedback Lab prototype · function and script assignments in this release.</div>
  </main>
</div>
</div>`);
}

export interface SignInPageOptions {
  error?: string;
  email?: string;
  next?: string;
}

export function signInPage({ error, email = '', next = '' }: SignInPageOptions = {}): string {
  return documentPage('Sign in', `<div class="auth-shell">
<main class="auth-card">
  ${brand()}
  <h1>Sign in</h1>
  <p class="muted">Use the account a maintainer provisioned for you.</p>
  ${error === undefined ? '' : `<div class="alert alert-error" role="alert">${escapeHtml(error)}</div>`}
  <form method="post" action="/sign-in">
    <input type="hidden" name="next" value="${escapeHtml(next)}">
    <label>Email<input type="email" name="email" value="${escapeHtml(email)}" autocomplete="username" required autofocus></label>
    <label>Password<input type="password" name="password" autocomplete="current-password" required></label>
    <button class="primary" type="submit">Sign in</button>
  </form>
  <p class="small footnote">Need access? Ask a maintainer to provision a researcher account. Sign-up and role changes are not available in the app.</p>
</main>
</div>`);
}

export interface MessagePageOptions {
  title: string;
  message: string;
  user?: SessionUser;
}

export function messagePage({ title, message, user }: MessagePageOptions): string {
  const body = `<div class="head"><div><h1>${escapeHtml(title)}</h1><p class="muted">${escapeHtml(message)}</p></div></div>
<div class="panel pad"><p>Return to the <a href="/assignments">assignment library</a>.</p></div>`;

  if (user === undefined) {
    return documentPage(title,
      `<div class="auth-shell"><main class="auth-card">${brand()}<h1>${escapeHtml(title)}</h1><p class="muted">${escapeHtml(message)}</p><p><a href="/sign-in">Go to sign in</a></p></main></div>`);
  }

  return shell({ title, user, body });
}
