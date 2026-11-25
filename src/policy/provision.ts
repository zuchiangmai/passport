export const COLIVING_MEMBER_URL = "https://4seas.xyz/coliving/api/internal/passport-member";

export async function provisionColivingMember(
  fetchImpl: typeof fetch,
  opts: { serviceKey: string; email: string; name: string | null; sub: string; url?: string },
): Promise<{ externalId: string } | null> {
  if (!opts.serviceKey.trim() || !opts.email || !opts.sub) return null;
  let response: Response;
  try {
    response = await fetchImpl(opts.url ?? COLIVING_MEMBER_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Service-Key": opts.serviceKey,
      },
      body: JSON.stringify({
        email: opts.email,
        display_name: opts.name,
        sub: opts.sub,
      }),
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    return null;
  }
  if (!response.ok) return null;
  const body: unknown = await response.json().catch(() => null);
  if (!body || typeof body !== "object" || !("external_id" in body)) return null;
  const externalId = (body as { external_id?: unknown }).external_id;
  return typeof externalId === "string" && /^member:\d+$/.test(externalId) ? { externalId } : null;
}
