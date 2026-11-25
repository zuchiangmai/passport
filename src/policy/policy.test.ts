import assert from "node:assert/strict";
import { test } from "node:test";
import { checkRedirect, client_secret_ok, clientSecretOk } from "./clients.ts";
import { authorizeGate, hasColiving, linkApp, snapshot } from "./links.ts";

const coliving = linkApp([], { sub: "user-1", app: "coliving", externalId: "resident-1" });
const canteenRequest = { sub: "user-1", app: "canteen", externalId: "diner-1" };
const requiresColiving = {
  code: "canteen_requires_coliving",
  message: "canteen requires a CoLiving registration",
};

test("blocks canteen authorization and linking without CoLiving for the same sub", () => {
  const otherUserLink = { ...coliving, user_id: "user-2" };
  assert.equal(hasColiving([]), false);
  assert.throws(() => authorizeGate("canteen", []), requiresColiving);
  assert.throws(() => linkApp([otherUserLink], canteenRequest), requiresColiving);
  assert.doesNotThrow(() => authorizeGate("coliving", []));
});

test("allows canteen authorization and linking with CoLiving for the same sub", () => {
  assert.equal(hasColiving([coliving]), true);
  assert.doesNotThrow(() => authorizeGate("canteen", [coliving]));
  const canteen = linkApp([coliving], { ...canteenRequest, externalId: " diner-1 " });
  assert.deepEqual(canteen, { user_id: "user-1", app: "canteen", external_id: "diner-1" });
  assert.equal(linkApp([coliving, canteen], canteenRequest), canteen);
});

test("accepts only exact redirects registered to a known client", () => {
  assert.doesNotThrow(() => checkRedirect("coliving", "https://4seas.xyz/coliving/auth/callback"));
  assert.doesNotThrow(() => checkRedirect("canteen", "https://4seas.xyz/canteen/auth/callback"));
  assert.throws(() => checkRedirect("canteen", "https://healthyliving-admin.jhfnetboy.workers.dev/auth/callback"), {
    code: "forbidden",
    message: "redirect_uri is not registered",
  });
  assert.throws(() => checkRedirect("canteen", "https://healthyliving-admin.jhfnetboy.workers.dev/canteen/auth/callback"), {
    code: "forbidden",
    message: "redirect_uri is not registered",
  });
  assert.throws(() => checkRedirect("canteen", "https://4seas.xyz/canteen/auth/callback/"), {
    code: "forbidden",
    message: "redirect_uri is not registered",
  });
  assert.throws(() => checkRedirect("toString", "https://4seas.xyz/canteen/auth/callback"), {
    code: "forbidden",
    message: "unknown client",
  });
});

test("rejects blank or missing secrets on either side", () => {
  assert.equal(client_secret_ok("", ""), false);
  assert.equal(client_secret_ok("fixture", " \t"), false);
  assert.equal(client_secret_ok(" \t", "fixture"), false);
  assert.equal(client_secret_ok("fixture", undefined), false);
});

test("rejects matching published development secrets and change-me prefixes", () => {
  for (const clientId of ["coliving", "canteen"]) {
    const publishedDefault = ["dev", clientId, "secret"].join("-");
    assert.equal(client_secret_ok(publishedDefault, ` ${publishedDefault} `), false);
  }
  assert.equal(client_secret_ok("change-me-example", "change-me-example"), false);
});

test("matches a configured secret only for the selected client", () => {
  const secrets = { colivingSecret: "fixture-a", canteenSecret: "fixture-b" };
  assert.equal(clientSecretOk("coliving", " fixture-a ", secrets), true);
  assert.equal(clientSecretOk("coliving", "fixture-b", secrets), false);
  assert.equal(clientSecretOk("canteen", "fixture-b", secrets), true);
});

test("rejects both kinds of external ID conflict", () => {
  assert.throws(() => linkApp([coliving], { sub: "user-2", app: "coliving", externalId: "resident-1" }), {
    code: "conflict",
    message: "external id already linked to another sub",
  });
  assert.throws(() => linkApp([coliving], { sub: "user-1", app: "coliving", externalId: "resident-2" }), {
    code: "conflict",
    message: "this sub is already linked to another id in that app",
  });
});

test("rejects unknown apps and blank external IDs", () => {
  assert.throws(() => linkApp([], { ...canteenRequest, app: "unknown" }), {
    code: "not_found",
    message: "unknown app",
  });
  assert.throws(() => linkApp([], { ...canteenRequest, externalId: " " }), {
    code: "not_found",
    message: "external_id required",
  });
});

test("builds a sorted identity snapshot scoped to the Better Auth ID", () => {
  const user = { id: "user-1", email: "user@example.test", emailVerified: false, name: "Test User" };
  const otherUserLink = { ...coliving, user_id: "user-2" };
  const canteen = linkApp([coliving], canteenRequest);
  assert.deepEqual(snapshot(user, [otherUserLink, coliving, canteen]), {
    sub: "user-1",
    email: "user@example.test",
    email_verified: false,
    display_name: "Test User",
    apps: ["canteen", "coliving"],
    canteen_allowed: true,
  });
  assert.equal(snapshot(user, [otherUserLink]).canteen_allowed, false);
});
