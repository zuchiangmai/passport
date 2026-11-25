import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { signInCodeEmail } from "./email/sign-in-code.ts";
import { preferredLanguage } from "./locale.ts";
import { signInPage } from "./pages.ts";

test("language negotiation uses supported browser preferences", () => {
  assert.equal(preferredLanguage("de, th;q=0.6, zh-CN;q=0.9"), "zh");
  assert.equal(preferredLanguage("th;q=0, en-US;q=0.5"), "en");
  assert.equal(preferredLanguage("de"), "en");
});

test("language links carry the Passport mount and the entire application query", async () => {
  const search = "?client_id=canteen&redirect_uri=https%3A%2F%2F4seas.xyz%2Fcanteen%2Fauth%2Fcallback&state=two%2Btwo";
  const response = signInPage({ language: "en", prefix: "/passport", route: "login", search }, "", {
    clientId: "canteen",
    redirectUri: "https://4seas.xyz/canteen/auth/callback",
    state: "two+two",
  });
  const html = await response.text();
  assert.equal(response.headers.get("Content-Language"), "en");
  assert.match(html, /<p class="sub">Just one account<\/p>/);
  assert.equal((html.match(/<header class="fs-header"/g) ?? []).length, 1);
  assert.equal((html.match(/<footer class="fs-footer"/g) ?? []).length, 1);
  for (const language of ["en", "zh", "th"]) {
    assert.ok(html.includes(`href="/passport/${language}/login${search.replaceAll("&", "&amp;")}"`));
  }
});

test("verification email puts the complete code in the subject and on its own line", () => {
  for (const [language, subject] of [
    ["en", "Verification code: 012345"], ["zh", "验证码:012345"], ["th", "รหัสยืนยัน: 012345"],
  ] as const) {
    const message = signInCodeEmail(language, "012345");
    assert.equal(message.subject, subject);
    assert.equal(message.text.split("\n")[2], "012345");
    assert.match(message.html, /<p dir="ltr" style="[^"]*36px[^"]*">012345<\/p>/);
    assert.match(message.html, /coliving\/email\/4seas-logo\.png/);
  }
});

test("social buttons follow the authorization URL when automatic redirection is off", async () => {
  const response = signInPage({ language: "en", prefix: "/passport", route: "login", search: "" }, "", {
    clientId: "", redirectUri: "", state: "",
  });
  const html = await response.text();
  const script = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  const buttons = ["google", "github"].map((provider) => ({
    dataset: { provider },
    click: () => Promise.resolve(),
    addEventListener(_event: string, listener: () => Promise<void>) { this.click = listener; },
  }));
  const status = { dataset: {}, textContent: "" };
  const visited: string[] = [];
  const destinations: Record<string, string> = {
    google: "https://accounts.google.com/o/oauth2/v2/auth",
    github: "https://github.com/login/oauth/authorize",
  };
  const location = {
    origin: "https://4seas.xyz",
    assign: (url: URL) => visited.push(url.href),
  };
  runInNewContext(script, {
    URL,
    window: { location },
    document: {
      querySelector(selector: string) {
        if (selector === "#status") return status;
        if (selector === ".passport-card") return { dataset: {} };
        return { addEventListener() {} };
      },
      querySelectorAll: () => buttons,
    },
    fetch: async (path: string, options: { body: string }) => {
      assert.equal(path, "/passport/api/auth/sign-in/social");
      const body = JSON.parse(options.body);
      assert.equal(body.disableRedirect, true);
      return Response.json({ redirect: false, url: destinations[body.provider] });
    },
  });
  for (const button of buttons) await button.click();
  assert.deepEqual(visited, Object.values(destinations));
  assert.equal(status.textContent, "");
});
