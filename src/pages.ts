function escapeHtml(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function page(title: string, query: string, content: string, script: string, attrs = "") {
  const nonce = crypto.randomUUID();
  return new Response(`<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · 4Seas Passport</title>
<style nonce="${nonce}">
  :root{font:16px/1.55 system-ui,sans-serif;color:#162929;background:#f2f5ef}
  body{margin:0;padding:clamp(1rem,7vw,5rem) 1rem}
  main{max-width:27rem;margin:auto;background:#fff;padding:clamp(1.25rem,5vw,2.5rem);
    border:1px solid #d9e2d9;border-top:4px solid #226754;border-radius:.75rem}
  header{font-weight:650;color:#226754}
  h1{font-size:1.8rem;margin:.55rem 0 1.5rem}
  label{display:block;margin-bottom:.35rem;font-weight:600}
  input,button{box-sizing:border-box;font:inherit;border-radius:.45rem;padding:.55rem .75rem}
  input{width:100%;border:1px solid #8ba99d;margin-bottom:.65rem}
  button{cursor:pointer;border:1px solid #226754;background:#226754;color:#fff}
  button.secondary{color:#205543;background:#fff}
  button:disabled{opacity:.5;cursor:wait}
  form + form,.actions{margin-top:1rem}
  .actions{display:flex;flex-wrap:wrap;gap:.55rem}
  dd{margin:0 0 .7rem;overflow-wrap:anywhere}
  #status{min-height:1.6rem;margin-bottom:0}
</style>
</head>
<body>
<main data-oauth-query="${escapeHtml(query)}" ${attrs}>
<header>4Seas Passport</header>
<h1>${title}</h1>
${content}
<p id="status" role="status"></p>
</main>
<script nonce="${nonce}">
const status = document.querySelector("#status");
const oauthQuery = document.querySelector("main").dataset.oauthQuery;
async function api(path, body) {
  const options = { headers: { Accept: "application/json" } };
  if (body !== undefined) {
    options.method = "POST";
    options.headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(body);
  }
  const prefix = location.pathname === "/passport" || location.pathname.startsWith("/passport/") ? "/passport" : "";
  const response = await fetch(prefix + "/api/auth" + path, options);
  if (!response.ok) {
    if (response.status === 429) throw new Error("请求过于频繁，请稍后再试。");
    throw new Error("操作失败，请检查输入或稍后重试。");
  }
  return response.json();
}
async function act(button, action) {
  button.disabled = true;
  status.textContent = "";
  try { await action(); }
  catch (error) { status.textContent = error.message || "操作失败，请重试。"; }
  finally { button.disabled = false; }
}
function finish(result, fallback) {
  if (result.redirect === true && typeof result.url === "string") {
    const url = new URL(result.url, window.location.origin);
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("回调地址无效。");
    window.location.assign(url);
  } else {
    status.textContent = fallback;
  }
}
${script}
</script>
</body>
</html>`, {
    headers: {
      "Content-Type": "text/html; charset=UTF-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`,
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export function signInPage(
  query: string,
  legacy: { clientId: string; redirectUri: string; state: string },
) {
  const attrs = `data-client-id="${escapeHtml(legacy.clientId)}" data-redirect-uri="${escapeHtml(legacy.redirectUri)}" data-state="${escapeHtml(legacy.state)}"`;
  return page("登录", query, `
<form id="request-code">
  <label for="email">电子邮箱</label>
  <input id="email" type="email" autocomplete="email" required>
  <button type="submit">发送验证码</button>
</form>
<form id="verify-code" hidden>
  <label for="code">六位验证码</label>
  <input id="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required>
  <button type="submit">验证并登录</button>
</form>
<div class="actions">
  <button class="secondary" data-provider="google">使用 Google 登录</button>
  <button class="secondary" data-provider="github">使用 GitHub 登录</button>
  <button id="passkey" class="secondary">使用通行密钥</button>
</div>`, `
const mainEl = document.querySelector("main");
const legacy = {
  clientId: mainEl.dataset.clientId || "",
  redirectUri: mainEl.dataset.redirectUri || "",
  state: mainEl.dataset.state || "",
};
async function continueLegacy() {
  if (!legacy.clientId || !legacy.redirectUri || !legacy.state) return false;
  const prefix = location.pathname === "/passport" || location.pathname.startsWith("/passport/") ? "/passport" : "";
  const response = await fetch(prefix + "/v1/connect/authorize", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_id: legacy.clientId,
      redirect_uri: legacy.redirectUri,
      state: legacy.state,
    }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const code = payload.code || payload.error?.code;
    if (code === "canteen_requires_coliving") throw new Error("需要先完成 CoLiving 注册。");
    throw new Error("无法回到应用。");
  }
  const url = new URL(payload.redirect_to, window.location.origin);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("回调地址无效。");
  window.location.assign(url);
  return true;
}
const requestForm = document.querySelector("#request-code");
const verifyForm = document.querySelector("#verify-code");
const email = document.querySelector("#email");
const code = document.querySelector("#code");
let requestedEmail = "";
const oauth = oauthQuery ? { oauth_query: oauthQuery } : {};
if (legacy.clientId && legacy.redirectUri && legacy.state) {
  fetch((location.pathname === "/passport" || location.pathname.startsWith("/passport/") ? "/passport" : "") + "/api/auth/get-session", {
    headers: { Accept: "application/json" },
  }).then(async (response) => {
    if (!response.ok) return;
    const session = await response.json().catch(() => null);
    if (session?.user) await continueLegacy();
  }).catch(() => {});
}
requestForm.addEventListener("submit", (event) => {
  event.preventDefault();
  act(event.submitter, async () => {
    const target = email.value.trim().toLowerCase();
    await api("/email-otp/send-verification-otp", { email: target, type: "sign-in" });
    requestedEmail = target;
    verifyForm.hidden = false;
    code.focus();
    status.textContent = "验证码已请求，请检查邮箱。";
  });
});
verifyForm.addEventListener("submit", (event) => {
  event.preventDefault();
  act(event.submitter, async () => {
    if (email.value.trim().toLowerCase() !== requestedEmail) throw new Error("邮箱已更改，请重新发送验证码。");
    const result = await api("/sign-in/email-otp", { email: requestedEmail, otp: code.value, ...oauth });
    if (await continueLegacy()) return;
    finish(result, "已登录。");
  });
});
for (const button of document.querySelectorAll("[data-provider]")) {
  button.addEventListener("click", () => act(button, async () => {
    finish(await api("/sign-in/social", {
      provider: button.dataset.provider,
      callbackURL: window.location.href,
      disableRedirect: true,
      ...oauth,
    }), "无法开始第三方登录。");
  }));
}
const passkey = document.querySelector("#passkey");
passkey.addEventListener("click", () => act(passkey, async () => {
  if (!window.PublicKeyCredential?.parseRequestOptionsFromJSON) {
    throw new Error("当前浏览器无法使用通行密钥，请使用验证码登录。");
  }
  const options = await api("/passkey/generate-authenticate-options");
  const publicKey = PublicKeyCredential.parseRequestOptionsFromJSON(options);
  const credential = await navigator.credentials.get({ publicKey });
  if (!credential) throw new Error("已取消通行密钥登录。");
  finish(await api("/passkey/verify-authentication", { response: credential.toJSON(), ...oauth }), "已登录。");
}));`, attrs);
}

export function consentPage(query: string, client: string, scope: string) {
  return page("授权应用", query, `
<dl>
  <dt>应用</dt><dd>${escapeHtml(client)}</dd>
  <dt>请求权限</dt><dd>${escapeHtml(scope || "默认权限")}</dd>
</dl>
<form id="consent" class="actions">
  <button type="submit" value="allow">同意</button>
  <button type="submit" value="deny" class="secondary">拒绝</button>
</form>`, `
document.querySelector("#consent").addEventListener("submit", (event) => {
  event.preventDefault();
  act(event.submitter, async () => {
    finish(await api("/oauth2/consent", {
      accept: event.submitter.value === "allow",
      oauth_query: oauthQuery,
    }), "授权已处理。");
  });
});`);
}
