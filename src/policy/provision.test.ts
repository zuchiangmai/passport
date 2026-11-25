import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { provisionColivingMember } from "./provision.ts";

describe("canteen signup provisions a CoLiving contact", () => {
  it("keeps the member external id and ignores a housing-shaped payload", async () => {
    const calls: { url: string; key: string; body: unknown }[] = [];
    const created = await provisionColivingMember(async (url, init) => {
      calls.push({
        url: String(url),
        key: new Headers(init?.headers).get("X-Service-Key") ?? "",
        body: JSON.parse(String(init?.body)),
      });
      return new Response(JSON.stringify({ member_id: 9, external_id: "member:9", application: false }), { status: 200 });
    }, { serviceKey: "svc", email: "a@b.c", name: "A", sub: "sub-a", url: "https://4seas.xyz/coliving/api/internal/passport-member" });
    assert.deepEqual(created, { externalId: "member:9" });
    assert.equal(calls[0]?.url, "https://4seas.xyz/coliving/api/internal/passport-member");
    assert.equal(calls[0]?.key, "svc");
    assert.equal((calls[0]?.body as { email: string }).email, "a@b.c");
  });

  it("does not invent a link when CoLiving refuses", async () => {
    const missed = await provisionColivingMember(async () => new Response("no", { status: 401 }), {
      serviceKey: "svc", email: "a@b.c", name: null, sub: "sub-a",
    });
    assert.equal(missed, null);
  });
});
