import assert from "node:assert/strict";
import { test } from "node:test";
import { authHandlerPath, authRouteBase } from "./auth.ts";

const issuer = "https://4seas.xyz/passport";

test("a mounted issuer keeps the origin and puts the mount on the auth path", () => {
  assert.deepEqual(authRouteBase(issuer), {
    baseURL: "https://4seas.xyz",
    basePath: "/passport/api/auth",
  });
  assert.deepEqual(authRouteBase("http://127.0.0.1:8788"), {
    baseURL: "http://127.0.0.1:8788",
    basePath: "/api/auth",
  });
});

test("public auth urls keep the /passport prefix the router matches", () => {
  assert.equal(
    authHandlerPath("/passport/api/auth/get-session", issuer),
    "/passport/api/auth/get-session",
  );
  assert.equal(
    authHandlerPath("/passport/api/auth/email-otp/send-verification-otp", issuer),
    "/passport/api/auth/email-otp/send-verification-otp",
  );
  assert.equal(
    authHandlerPath("/api/auth/get-session", issuer),
    "/passport/api/auth/get-session",
  );
});

test("local auth urls stay at /api/auth and our own pages are not auth routes", () => {
  assert.equal(
    authHandlerPath("/passport/api/auth/get-session", "http://127.0.0.1:8788"),
    "/api/auth/get-session",
  );
  assert.equal(authHandlerPath("/passport/login", issuer), null);
  assert.equal(authHandlerPath("/passport/healthz", issuer), null);
  assert.equal(authHandlerPath("/v1/auth/passcode/request", issuer), null);
});
