from fastapi import APIRouter
from fastapi.responses import HTMLResponse

router = APIRouter(tags=["login"])

PAGE = """<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>4Seas Passport</title>
<style>
  body { font: 16px/1.4 system-ui, sans-serif; margin: 0; background: #f6f4ef; color: #1c1915; }
  main { max-width: 420px; margin: 8vh auto; padding: 24px; }
  h1 { font-size: 22px; margin: 0 0 8px; }
  p { color: #5c564c; }
  label { display: block; margin: 14px 0 6px; font-size: 14px; }
  input { width: 100%; box-sizing: border-box; padding: 10px 12px; font-size: 16px; }
  button, a.btn { display: block; width: 100%; margin-top: 12px; padding: 10px 12px; font-size: 16px;
    background: #1c1915; color: #fff; border: 0; text-align: center; text-decoration: none; box-sizing: border-box; }
  .err { color: #8a2b2b; min-height: 1.2em; }
</style>
</head>
<body>
<main>
  <h1>4Seas Passport</h1>
  <p>用邮箱验证码登录。CoLiving 和食堂共用这一次登录里的同一个人。</p>
  <form id="ask">
    <label for="email">邮箱</label>
    <input id="email" type="email" autocomplete="username" required>
    <button type="submit">发送验证码</button>
  </form>
  <form id="code" hidden>
    <label for="passcode">6 位验证码</label>
    <input id="passcode" inputmode="numeric" autocomplete="one-time-code" minlength="6" maxlength="6" required>
    <button type="submit">登录</button>
  </form>
  <a id="google" class="btn" hidden>用 Google 继续</a>
  <a id="github" class="btn" hidden>用 GitHub 继续</a>
  <p class="err" id="msg"></p>
</main>
<script>
const root = location.pathname.startsWith("/passport") ? "/passport" : "";
const q = new URLSearchParams(location.search);
const msg = document.getElementById("msg");
function show(text) { msg.textContent = text || ""; }
async function post(path, body, token) {
  const res = await fetch(root + path, {
    method: "POST",
    headers: Object.assign({ "Content-Type": "application/json" }, token ? { Authorization: "Bearer " + token } : {}),
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data.error && data.error.message) || "请求失败");
  return data;
}
document.getElementById("ask").addEventListener("submit", async (e) => {
  e.preventDefault();
  show("");
  try {
    await post("/v1/auth/passcode/request", { email: document.getElementById("email").value.trim() });
    document.getElementById("code").hidden = false;
  } catch (err) { show(err.message); }
});
document.getElementById("code").addEventListener("submit", async (e) => {
  e.preventDefault();
  show("");
  try {
    const email = document.getElementById("email").value.trim();
    const session = await post("/v1/auth/passcode/verify", { email, code: document.getElementById("passcode").value.trim() });
    const clientId = q.get("client_id");
    if (!clientId) { show("已登录。sub = " + session.user.sub); return; }
    const next = await post("/v1/connect/authorize", {
      client_id: clientId,
      redirect_uri: q.get("redirect_uri") || "",
      state: q.get("state") || "",
    }, session.access_token);
    location.href = next.redirect_to;
  } catch (err) { show(err.message); }
});
const clientId = q.get("client_id");
const redirectUri = q.get("redirect_uri");
const state = q.get("state");
if (clientId && redirectUri && state) {
  const common = "client_id=" + encodeURIComponent(clientId) + "&redirect_uri=" + encodeURIComponent(redirectUri) + "&state=" + encodeURIComponent(state);
  const google = document.getElementById("google");
  const github = document.getElementById("github");
  google.href = root + "/v1/auth/google/start?" + common;
  github.href = root + "/v1/auth/github/start?" + common;
  google.hidden = false;
  github.hidden = false;
}
</script>
</body>
</html>
"""


@router.get("/login", response_class=HTMLResponse)
@router.get("/passport", response_class=HTMLResponse)
@router.get("/passport/", response_class=HTMLResponse)
@router.get("/passport/login", response_class=HTMLResponse)
def login_page():
    return PAGE
