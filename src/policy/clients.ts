import { createHash, timingSafeEqual } from "node:crypto";

export type ClientId = "coliving" | "canteen";

export interface ClientSecrets {
  colivingSecret?: string | null;
  canteenSecret?: string | null;
}

export class PolicyError extends Error {
  readonly code: "forbidden" | "not_found" | "conflict" | "canteen_requires_coliving";

  constructor(code: PolicyError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

interface Client {
  secret: keyof ClientSecrets;
  redirects: readonly string[];
}

const clients: Record<ClientId, Client> = {
  coliving: {
    secret: "colivingSecret",
    redirects: ["https://4seas.xyz/coliving/auth/callback"],
  },
  canteen: {
    secret: "canteenSecret",
    redirects: ["https://4seas.xyz/canteen/auth/callback"],
  },
};

// SHA-256 fingerprints of the two published development defaults.
const publishedDefaults = new Set([
  "7848561242909e871b3c27b1822d5cd2f71b0415252866ea1b2d1c08aa65a602",
  "b767014ae8a00d48a50591b60d30e9e7578c76aaa9a37461fc0049a623a052c6",
]);

function getClient(clientId: string): Client {
  if (clientId !== "coliving" && clientId !== "canteen") {
    throw new PolicyError("forbidden", "unknown client");
  }
  return clients[clientId];
}

export function checkRedirect(clientId: string, redirectUri: string): void {
  if (!getClient(clientId).redirects.includes(redirectUri)) {
    throw new PolicyError("forbidden", "redirect_uri is not registered");
  }
}

export function client_secret_ok(
  presented: string | null | undefined,
  expected: string | null | undefined,
): boolean {
  const supplied = presented?.trim();
  const configured = expected?.trim();
  if (!supplied || !configured || configured.startsWith("change-me")) return false;

  const expectedDigest = createHash("sha256").update(configured).digest();
  if (publishedDefaults.has(expectedDigest.toString("hex"))) return false;

  const presentedDigest = createHash("sha256").update(supplied).digest();
  return timingSafeEqual(presentedDigest, expectedDigest);
}

export function clientSecretOk(
  clientId: string,
  presented: string | null | undefined,
  secrets: ClientSecrets,
): boolean {
  return client_secret_ok(presented, secrets[getClient(clientId).secret]);
}
