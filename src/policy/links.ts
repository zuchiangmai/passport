import { PolicyError, type ClientId } from "./clients.ts";

export type App = ClientId;

export interface AppLink {
  user_id: string;
  app: App;
  external_id: string;
}

interface StoredLink extends AppLink {
  id: string;
  created_at: number;
}

interface LinkRequest {
  sub: string;
  app: string;
  externalId: string;
}

interface PassportUser {
  id: string;
  email: string;
  emailVerified: boolean;
  name: string | null;
}

export function hasColiving(links: readonly Pick<AppLink, "app">[]): boolean {
  return links.some((link) => link.app === "coliving");
}

export function authorizeGate(clientId: string, links: readonly Pick<AppLink, "app">[]): void {
  if (clientId === "canteen" && !hasColiving(links)) {
    throw new PolicyError("canteen_requires_coliving", "canteen requires a CoLiving registration");
  }
}

export function snapshot(user: PassportUser, links: readonly AppLink[]) {
  const userLinks = links.filter((link) => link.user_id === user.id);
  return {
    sub: user.id,
    email: user.email,
    email_verified: user.emailVerified,
    display_name: user.name,
    apps: userLinks.map((link) => link.app).sort(),
    canteen_allowed: hasColiving(userLinks),
  };
}

function normalizeLink({ sub, app, externalId }: LinkRequest): AppLink {
  if (app !== "coliving" && app !== "canteen") {
    throw new PolicyError("not_found", "unknown app");
  }
  const external_id = externalId.trim();
  if (!external_id) throw new PolicyError("not_found", "external_id required");

  return { user_id: sub, app, external_id };
}

function findExistingLink<T extends AppLink>(links: readonly T[], requested: AppLink): T | undefined {
  const userLinks = links.filter((link) => link.user_id === requested.user_id);
  authorizeGate(requested.app, userLinks);

  const taken = links.find((link) => link.app === requested.app && link.external_id === requested.external_id);
  if (taken && taken.user_id !== requested.user_id) {
    throw new PolicyError("conflict", "external id already linked to another sub");
  }

  const existing = userLinks.find((link) => link.app === requested.app);
  if (existing && existing.external_id !== requested.external_id) {
    throw new PolicyError("conflict", "this sub is already linked to another id in that app");
  }
  return existing;
}

export function linkApp(links: readonly AppLink[], request: LinkRequest): AppLink {
  const requested = normalizeLink(request);
  return findExistingLink(links, requested) ?? requested;
}

interface D1Statement<Statement> {
  bind(...values: (string | number)[]): Statement;
}

interface D1Database<Statement> {
  prepare(query: string): Statement;
  batch<T>(statements: Statement[]): Promise<{ results: T[] }[]>;
}

export async function ensureLink<Statement extends D1Statement<Statement>>(
  db: D1Database<Statement>,
  request: LinkRequest,
): Promise<StoredLink> {
  const requested = normalizeLink(request);
  const { user_id, app, external_id } = requested;
  const insert = db.prepare(`
    INSERT INTO app_link (id, user_id, app, external_id, created_at)
    SELECT ?1, ?2, ?3, ?4, ?5
    WHERE ?3 <> 'canteen' OR EXISTS (
      SELECT 1 FROM app_link WHERE user_id = ?2 AND app = 'coliving'
    )
    ON CONFLICT DO NOTHING
  `).bind(crypto.randomUUID(), user_id, app, external_id, Date.now());
  const read = db.prepare(`
    SELECT id, user_id, app, external_id, created_at FROM app_link
    WHERE (user_id = ?1 AND app IN ('coliving', ?2)) OR (app = ?2 AND external_id = ?3)
  `).bind(user_id, app, external_id);

  const [, readResult] = await db.batch<StoredLink>([insert, read]);
  if (!readResult) throw new Error("app_link query returned no result");
  const existing = findExistingLink(readResult.results, requested);
  if (!existing) throw new Error("app_link insert did not produce a row");
  return existing;
}
