import { LANGUAGES, renderFooter, renderHeader, VERSION } from "@4seas/site-chrome";
import { escapeHtml } from "./html.ts";
import type { Language } from "./locale.ts";
import { pageCopy } from "./page-copy.ts";

const assetBase = "/passport/site-chrome";

type PageLocation = {
  language: Language;
  prefix: string;
  route: string;
  search: string;
};

function page(location: PageLocation, title: string, query: string, content: string, script: string, attrs = "", subtitle = "") {
  const nonce = crypto.randomUUID();
  const { language, prefix, route, search } = location;
  const languages = LANGUAGES.map(({ code, label }) => ({
    code, label, href: `${prefix}/${code}/${route}${search}`,
  }));
  return new Response(`<!doctype html>
<html lang="${language === "zh" ? "zh-CN" : language}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · 4Seas Passport</title>
<link rel="stylesheet" href="${assetBase}/style.css?v=${VERSION}">
<style nonce="${nonce}">
  :root{color-scheme:light;--bg:#f8f9fa;--fg:#212529;--muted:#6c757d;--line:#dee2e6;--card:#fff}
  body{margin:0;background:var(--bg);color:var(--fg);min-height:100vh;display:flex;flex-direction:column;
    font:15px/1.7 ui-sans-serif,system-ui,-apple-system,"Noto Sans SC","Noto Sans Thai",sans-serif}
  .passport-card{box-sizing:border-box;width:min(840px,calc(100% - 32px));margin:24px auto;padding:28px 18px;background:var(--card);
    border:1px solid var(--line);border-radius:20px;box-shadow:0 4px 24px rgba(0,0,0,.04)}
  .passport-content{width:100%;max-width:540px;margin-inline:auto}
  .intro{text-align:center;margin-bottom:18px}
  .passport-brand{display:inline-flex;align-items:center;gap:9px;margin:0;font-size:14px;font-weight:600;letter-spacing:.03em;color:#005040}
  .passport-brand img{width:24px;height:24px;border-radius:6px}
  h1{font-size:24px;font-weight:700;margin:8px 0}
  .sub{margin:0;font-size:14px;color:var(--muted);line-height:1.5}
  .passport-card :is(input,button){box-sizing:border-box;font:inherit}
  input{width:100%;padding:12px 14px;border-radius:12px;border:1px solid var(--line);background:var(--bg);font-size:15px}
  input::placeholder{color:var(--muted)}
  .passport-card button{display:flex;align-items:center;justify-content:center;width:100%;min-height:45px;padding:10px 20px;
    border-radius:24px;border:1px solid #004a33;background:#004a33;color:#fffefa;font-size:15px;font-weight:500;cursor:pointer}
  .passport-card button.secondary{background:var(--bg);color:var(--fg);border-color:var(--line);font-size:14px;font-weight:500}
  .passport-card button:disabled{opacity:.5;cursor:wait}
  .code-row{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
  .code-row + .code-row{margin-top:8px}
  .code-row input,.passport-card .code-row button{min-height:44px;padding:8px 10px}
  .passport-card .code-row button{font-size:14px;white-space:nowrap}
  .actions{display:grid;gap:8px;margin-bottom:16px}
  .actions button{gap:12px}
  .mark{width:18px;height:18px;flex:none}
  .or{display:flex;align-items:center;gap:12px;margin:0 0 12px;color:var(--muted);font-size:12px}
  .or::before,.or::after{content:"";flex:1;height:1px;background:var(--line)}
  dd{margin:0 0 .7rem;overflow-wrap:anywhere}
  .quiz{margin-top:20px;padding-top:16px;border-top:1px solid var(--line)}
  .quiz h2{font-size:18px;margin:0 0 6px}
  .quiz-note{margin:0 0 12px;color:var(--muted);font-size:14px;line-height:1.5}
  .quiz fieldset{margin:0 0 12px;padding:12px 14px;border:1px solid var(--line);border-radius:12px}
  .quiz legend{padding:0 4px;font-weight:600;line-height:1.5}
  .quiz .topic{display:inline-block;margin-left:6px;padding:0 8px;border-radius:10px;background:var(--bg);color:var(--muted);font-size:12px;font-weight:500}
  .quiz label{display:flex;gap:10px;align-items:flex-start;padding:6px 4px;cursor:pointer;line-height:1.45}
  .quiz label input{width:auto;margin:3px 0 0;flex:none}
  .quiz-review ol{margin:8px 0 0;padding-left:20px}
  .quiz-review li{margin-bottom:12px}
  .quiz-review ul{margin:4px 0;padding-left:18px}
  .quiz-review .right{color:#087443;font-weight:600}
  .quiz-review .wrong{color:#a32222;text-decoration:line-through}
  .quiz-review p{margin:4px 0;font-size:14px;color:var(--muted);line-height:1.5}
  .quiz-review a{color:#005040}
  #status{margin:0}
  #status:not(:empty){margin-top:12px;padding:8px 12px;border-radius:8px;font-weight:600;color:#087443;background:#e8f7ee}
  #status[data-kind="error"]:not(:empty){color:#a32222;background:#fceaea}
  @media (min-width:700px){
    .passport-card{display:grid;align-content:center;min-height:600px;margin:clamp(56px,9vh,88px) auto;padding:52px 64px}
    .passport-card .intro{margin-bottom:30px}
    .passport-card h1{font-size:42px;line-height:1.15;margin:12px 0}
    .passport-card .sub{font-size:17px}
    .passport-card .actions{gap:12px;margin-bottom:22px}
    .passport-card .or{margin-bottom:16px}
    .passport-card button,.passport-card .code-row input,.passport-card .code-row button{min-height:50px}
    .code-row + .code-row{margin-top:12px}
  }
</style>
</head>
<body>
${renderHeader({ assetBase, locale: language, languages })}
<main class="passport-card" data-oauth-query="${escapeHtml(query)}" ${attrs}>
<div class="passport-content">
<div class="intro">
<p class="passport-brand"><img src="/passport/brand-mark.jpg" width="24" height="24" alt="">4Seas Passport</p>
<h1>${escapeHtml(title)}</h1>
${subtitle ? `<p class="sub">${escapeHtml(subtitle)}</p>` : ""}
</div>
${content}
<p id="status" role="status"></p>
</div>
</main>
${renderFooter({ assetBase, locale: language })}
<script type="module" nonce="${nonce}" src="${assetBase}/chrome.js?v=${VERSION}"></script>
<script nonce="${nonce}">
const status = document.querySelector("#status");
const oauthQuery = document.querySelector(".passport-card").dataset.oauthQuery;
const prefix = ${JSON.stringify(prefix)};
const language = ${JSON.stringify(language)};
const copy = ${JSON.stringify(pageCopy[language])};
class FeedbackError extends Error {}
function showStatus(message, kind = "success") {
  status.dataset.kind = kind;
  status.textContent = message;
}
async function api(path, body) {
  const options = { headers: { Accept: "application/json", "X-Passport-Language": language } };
  if (body !== undefined) {
    options.method = "POST";
    options.headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(body);
  }
  const response = await fetch(prefix + "/api/auth" + path, options);
  if (!response.ok) {
    if (response.status === 429) throw new FeedbackError(copy.rateLimited);
    throw new FeedbackError(copy.failed);
  }
  return response.json();
}
async function act(button, action) {
  button.disabled = true;
  showStatus("");
  try { await action(); }
  catch (error) { showStatus(error instanceof FeedbackError ? error.message : copy.failed, "error"); }
  finally { button.disabled = false; }
}
function followRedirect(target) {
  if (typeof target !== "string" || !target) return false;
  const url = new URL(target, window.location.origin);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new FeedbackError(copy.badRedirect);
  window.location.assign(url);
  return true;
}
function finish(result, fallback) {
  if (result.redirect !== true || !followRedirect(result.url)) showStatus(fallback);
}
${script}
</script>
</body>
</html>`, {
    headers: {
      "Content-Type": "text/html; charset=UTF-8",
      "Content-Language": language,
      "Vary": "Accept-Language",
      "Cache-Control": "no-store",
      "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'self' 'nonce-${nonce}'; img-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`,
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export function signInPage(
  location: PageLocation,
  query: string,
  legacy: { clientId: string; redirectUri: string; state: string },
  options: { quiz?: boolean; learnBase?: string } = {},
) {
  const copy = pageCopy[location.language];
  const quiz = options.quiz === true;
  const learnBase = options.learnBase?.trim() ? options.learnBase.trim().replace(/\/*$/, "/") : "";
  const attrs = `data-client-id="${escapeHtml(legacy.clientId)}" data-redirect-uri="${escapeHtml(legacy.redirectUri)}" data-state="${escapeHtml(legacy.state)}"`;
  return page(location, copy.signIn, query, `
<div class="actions">
  <button class="secondary" data-provider="google"><svg class="mark" viewBox="0 0 24 24" aria-hidden="true"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"/></svg>${copy.google}</button>
  <button class="secondary" data-provider="github"><svg class="mark" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.53 1.032 1.53 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z"/></svg>${copy.github}</button>
  <button id="passkey" class="secondary"><svg class="mark" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M14.5 2a5.5 5.5 0 0 0-5.4 6.6L2 15.7V20h4.3v-2.2H8.5v-2.2h2.2l2.2-2.2A5.5 5.5 0 1 0 14.5 2zm1.8 4.2a1.4 1.4 0 1 1 0 2.8 1.4 1.4 0 0 1 0-2.8z"/></svg>${copy.passkey}</button>
</div>
<p class="or">${copy.or}</p>
<form id="request-code" class="code-row">
  <input id="email" type="email" autocomplete="email" aria-label="${copy.email}" placeholder="${copy.email}" required>
  <button type="submit">${copy.send}</button>
</form>
<form id="verify-code" class="code-row">
  <input id="code" inputmode="numeric" autocomplete="one-time-code" aria-label="${copy.code}" placeholder="${copy.code}" pattern="[0-9]{6}" maxlength="6" required>
  <button type="submit">${copy.confirm}</button>
</form>${quiz ? `
<section id="quiz" class="quiz" data-learn-base="${escapeHtml(learnBase)}" hidden>
  <h2>${copy.quizTitle}</h2>
  <p id="quiz-note" class="quiz-note"></p>
  <form id="quiz-form"><div id="quiz-questions"></div><button type="submit">${copy.quizSubmit}</button></form>
  <div id="quiz-review" class="quiz-review" hidden><h2>${copy.quizReview}</h2><ol id="quiz-review-list"></ol></div>
</section>` : ""}`, `
const mainEl = document.querySelector(".passport-card");
const legacy = {
  clientId: mainEl.dataset.clientId || "",
  redirectUri: mainEl.dataset.redirectUri || "",
  state: mainEl.dataset.state || "",
};
const hasLegacyRequest = !oauthQuery && Boolean(legacy.clientId && legacy.redirectUri && legacy.state);
// CoLiving sets its own session via this round trip before opening the profile.
const profileSignInURL = "https://4seas.xyz/coliving/auth/passport?locale=en&next=%2Fen%2Fprofile";
async function continueLegacy() {
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
    if (code === "canteen_requires_coliving") throw new FeedbackError(copy.colivingRequired);
    throw new FeedbackError(copy.cannotReturn);
  }
  const url = new URL(payload.redirect_to, window.location.origin);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new FeedbackError(copy.badRedirect);
  window.location.assign(url);
}
async function finishLogin(result) {
  if (hasLegacyRequest) {
    await continueLegacy();
  } else if (oauthQuery || result.redirect === true) {
    finish(result, copy.signedIn);
  } else {
    window.location.assign(profileSignInURL);
  }
}
const requestForm = document.querySelector("#request-code");
const verifyForm = document.querySelector("#verify-code");
const email = document.querySelector("#email");
const code = document.querySelector("#code");
let requestedEmail = "";
const oauth = oauthQuery ? { oauth_query: oauthQuery } : {};
if (hasLegacyRequest) {
  api("/get-session").then(async (session) => {
    if (session?.user) await continueLegacy();
  }).catch((error) => showStatus(error instanceof FeedbackError ? error.message : copy.cannotReturn, "error"));
}
const quizEnabled = ${quiz ? "true" : "false"};
function fill(text, values) {
  return text.replace(/\\{(\\w+)\\}/g, (match, key) => key in values ? String(values[key]) : match);
}
function when(ms) {
  return new Intl.DateTimeFormat(language === "zh" ? "zh-CN" : language, { dateStyle: "medium", timeStyle: "short" }).format(new Date(ms));
}
async function apiRaw(path, body) {
  const response = await fetch(prefix + "/api/auth" + path, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json", "X-Passport-Language": language },
    body: JSON.stringify(body),
  });
  return { response, payload: await response.json().catch(() => ({})) };
}
function quizError(response, payload) {
  const retry = typeof payload.retryAt === "number" ? when(payload.retryAt) : "";
  if (payload.code === "QUIZ_COOLDOWN") return new FeedbackError(fill(copy.quizCooldown, { time: retry }));
  if (payload.code === "QUIZ_LIMIT") return new FeedbackError(fill(copy.quizLimit, { time: retry }));
  if (payload.code === "QUIZ_ATTEMPT_INVALID") return new FeedbackError(copy.quizExpired);
  if (payload.code === "QUIZ_UNAVAILABLE" || response.status === 404) return new FeedbackError(copy.quizUnavailable);
  if (response.status === 429) return new FeedbackError(copy.rateLimited);
  return new FeedbackError(copy.failed);
}
async function sendCode(target) {
  const { response, payload } = await apiRaw("/email-otp/send-verification-otp", { email: target, type: "sign-in" });
  if (response.ok) {
    requestedEmail = target;
    return "sent";
  }
  if (quizEnabled && response.status === 403 && payload.code === "QUIZ_REQUIRED") return "quiz";
  throw quizError(response, payload);
}
const quizSection = document.querySelector("#quiz");
let quizAttempt = null;
function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function safeLink(href, label) {
  const base = quizSection.dataset.learnBase;
  let url = null;
  try { url = href.startsWith("/") ? (base ? new URL(href.replace(/^\\/+/, ""), base) : null) : new URL(href); } catch {}
  if (!url || (url.protocol !== "https:" && url.protocol !== "http:")) return null;
  const link = element("a", "", label);
  link.href = url.href;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  return link;
}
async function startQuiz(target) {
  const { response, payload } = await apiRaw("/quiz/start", { email: target });
  if (!response.ok) throw quizError(response, payload);
  if (payload.status !== "quiz") throw new FeedbackError(copy.failed);
  quizAttempt = { email: target, id: payload.attemptId, count: payload.questions.length };
  const holder = document.querySelector("#quiz-questions");
  holder.replaceChildren();
  for (const question of payload.questions) {
    const fieldset = element("fieldset");
    const legend = element("legend", "", fill(copy.quizQuestion, { n: question.n }) + " ");
    legend.append(element("span", "topic", question.topic), document.createElement("br"), question.q);
    fieldset.append(legend);
    question.options.forEach((option, index) => {
      const label = element("label");
      const input = element("input");
      input.type = "radio";
      input.name = "quiz-" + question.n;
      input.value = String(index);
      label.append(input, element("span", "", String.fromCharCode(65 + index) + ". " + option));
      fieldset.append(label);
    });
    holder.append(fieldset);
  }
  document.querySelector("#quiz-note").textContent = fill(copy.quizNeeded, { total: payload.questions.length, pass: payload.passScore });
  document.querySelector("#quiz-form").hidden = false;
  document.querySelector("#quiz-review").hidden = true;
  quizSection.hidden = false;
  holder.querySelector("input")?.focus();
}
function showReview(review) {
  const list = document.querySelector("#quiz-review-list");
  list.replaceChildren();
  for (const item of review ?? []) {
    const entry = element("li");
    entry.append(element("strong", "", item.q));
    const options = element("ul");
    item.options.forEach((option, index) => {
      const isRight = index === item.correct;
      const isChosen = index === item.chosen;
      if (!isRight && !isChosen) return;
      const line = element("li", isRight ? "right" : "wrong", option);
      line.append(" (" + (isRight ? copy.quizCorrect : copy.quizYourAnswer) + (isRight && isChosen ? " · " + copy.quizYourAnswer : "") + ")");
      options.append(line);
    });
    entry.append(options);
    if (item.explain) entry.append(element("p", "", item.explain));
    const links = element("p");
    if (item.source?.url) {
      const link = safeLink(item.source.url, copy.quizSource + (item.source.date ? " (" + item.source.date + ")" : ""));
      if (link) links.append(link);
    }
    for (const learn of item.learn ?? []) {
      const link = safeLink(learn.u, copy.quizLearn + ": " + learn.t);
      if (link) links.append(links.childNodes.length ? " · " : "", link);
    }
    if (links.childNodes.length) entry.append(links);
    list.append(entry);
  }
  document.querySelector("#quiz-review").hidden = !(review ?? []).length;
}
if (quizEnabled) {
  document.querySelector("#quiz-form").addEventListener("submit", (event) => {
    event.preventDefault();
    act(event.submitter, async () => {
      if (!quizAttempt) throw new FeedbackError(copy.quizExpired);
      const answers = [];
      for (let n = 1; n <= quizAttempt.count; n++) {
        const picked = document.querySelector('input[name="quiz-' + n + '"]:checked');
        if (!picked) throw new FeedbackError(copy.quizAnswerAll);
        answers.push(Number(picked.value));
      }
      const attempt = quizAttempt;
      quizAttempt = null;
      const { response, payload } = await apiRaw("/quiz/submit", { email: attempt.email, attemptId: attempt.id, answers });
      document.querySelector("#quiz-form").hidden = true;
      if (!response.ok) throw quizError(response, payload);
      showReview(payload.review);
      const values = { score: payload.score, total: payload.total, pass: payload.passScore };
      if (!payload.passed) {
        throw new FeedbackError(fill(copy.quizFailed, { ...values, time: when(payload.retryAt) }));
      }
      if (payload.recorded) return showStatus(fill(copy.quizRecorded, values));
      if (await sendCode(attempt.email) !== "sent") throw new FeedbackError(copy.failed);
      email.value = attempt.email;
      code.focus();
      showStatus(fill(copy.quizPassed, values));
    });
  });
}
requestForm.addEventListener("submit", (event) => {
  event.preventDefault();
  act(event.submitter, async () => {
    const target = email.value.trim().toLowerCase();
    if (!quizEnabled) {
      await api("/email-otp/send-verification-otp", { email: target, type: "sign-in" });
      requestedEmail = target;
      code.focus();
      showStatus(copy.sent);
      return;
    }
    if (await sendCode(target) === "quiz") return startQuiz(target);
    if (quizSection) quizSection.hidden = true;
    code.focus();
    showStatus(copy.sent);
  });
});
verifyForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (!email.reportValidity()) return;
  act(event.submitter, async () => {
    const target = email.value.trim().toLowerCase();
    if (requestedEmail && target !== requestedEmail) throw new FeedbackError(copy.emailChanged);
    await finishLogin(await api("/sign-in/email-otp", { email: target, otp: code.value, ...oauth }));
  });
});
for (const button of document.querySelectorAll("[data-provider]")) {
  button.addEventListener("click", () => act(button, async () => {
    const result = await api("/sign-in/social", {
      provider: button.dataset.provider,
      callbackURL: hasLegacyRequest || oauthQuery ? window.location.href : profileSignInURL,
      disableRedirect: true,
      ...oauth,
    });
    if (!followRedirect(result.url)) throw new FeedbackError(copy.socialFailed);
  }));
}
const passkey = document.querySelector("#passkey");
passkey.addEventListener("click", () => act(passkey, async () => {
  if (!window.PublicKeyCredential?.parseRequestOptionsFromJSON) {
    throw new FeedbackError(copy.passkeyUnsupported);
  }
  const options = await api("/passkey/generate-authenticate-options");
  const publicKey = PublicKeyCredential.parseRequestOptionsFromJSON(options);
  const credential = await navigator.credentials.get({ publicKey });
  if (!credential) throw new FeedbackError(copy.passkeyCanceled);
  await finishLogin(await api("/passkey/verify-authentication", { response: credential.toJSON(), ...oauth }));
}));`, attrs, copy.subtitle);
}

export function consentPage(location: PageLocation, query: string, client: string, scope: string) {
  const copy = pageCopy[location.language];
  return page(location, copy.consent, query, `
<dl>
  <dt>${copy.app}</dt><dd>${escapeHtml(client)}</dd>
  <dt>${copy.permissions}</dt><dd>${escapeHtml(scope || copy.defaultPermissions)}</dd>
</dl>
<form id="consent" class="actions">
  <button type="submit" value="allow">${copy.allow}</button>
  <button type="submit" value="deny" class="secondary">${copy.deny}</button>
</form>`, `
document.querySelector("#consent").addEventListener("submit", (event) => {
  event.preventDefault();
  act(event.submitter, async () => {
    finish(await api("/oauth2/consent", {
      accept: event.submitter.value === "allow",
      oauth_query: oauthQuery,
    }), copy.consentDone);
  });
});`);
}
