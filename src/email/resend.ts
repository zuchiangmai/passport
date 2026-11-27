const ENDPOINT = "https://api.resend.com/emails";
const DEFAULT_FROM = "4Seas Passport <no-reply@idoris.ai>";
const RETRIABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

type SendResendEmailArgs = {
  apiKey: string;
  from?: string;
  to: string;
  subject: string;
  text: string;
  html?: string;
  tag?: string;
  idempotencyKey?: string;
  /** Override for local capture. Only http(s)://127.0.0.1 or localhost is honored. */
  endpoint?: string;
};

export function resendEndpoint(override?: string): string {
  if (!override?.trim()) return ENDPOINT;
  try {
    const url = new URL(override);
    if ((url.protocol === "http:" || url.protocol === "https:") &&
        (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]")) {
      return url.href;
    }
  } catch {}
  return ENDPOINT;
}

type SendResendEmailResult =
  | { ok: true; providerId?: string }
  | { ok: false; error: string; retriable: boolean };

export function safeTag(raw: string): string {
  return raw.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
}

export async function sendResendEmail({
  apiKey,
  from = DEFAULT_FROM,
  to,
  subject,
  text,
  html,
  tag,
  idempotencyKey,
  endpoint,
}: SendResendEmailArgs): Promise<SendResendEmailResult> {
  let response: Response;
  try {
    response = await fetch(resendEndpoint(endpoint), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
      },
      body: JSON.stringify({
        from,
        to: [to],
        subject,
        text,
        ...(html ? { html } : {}),
        ...(tag ? { tags: [{ name: "template", value: safeTag(tag) }] } : {}),
      }),
    });
  } catch {
    return { ok: false, error: "network_error", retriable: true };
  }

  if (!response.ok) {
    return {
      ok: false,
      error: `resend ${response.status}`,
      retriable: RETRIABLE_STATUS.has(response.status),
    };
  }

  const body: unknown = await response.json().catch(() => null);
  if (body && typeof body === "object" && "id" in body && typeof body.id === "string") {
    return { ok: true, providerId: body.id };
  }
  return { ok: true };
}
