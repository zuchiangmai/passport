// Crawler and AI-agent user agents that never take a quiz. Lower-case substrings.
export const BOT_USER_AGENTS = [
  "googlebot", "google-extended", "adsbot-google", "mediapartners-google", "storebot-google", "bingbot",
  "adidxbot", "bingpreview", "msnbot", "gptbot", "chatgpt-user", "oai-searchbot", "claudebot", "claude-web",
  "anthropic-ai", "ccbot", "perplexitybot", "perplexity-user", "bytespider", "amazonbot", "applebot",
  "facebookbot", "meta-externalagent", "facebot", "facebookexternalhit", "linkedinbot", "twitterbot",
  "slackbot", "ahrefsbot", "semrushbot", "dotbot", "petalbot", "yandexbot", "yandex.com/bots", "baiduspider",
  "sogou", "duckduckbot", "duckassistbot", "ia_archiver", "archive.org_bot", "mj12bot", "blexbot",
  "dataforseobot", "imagesiftbot", "diffbot", "youbot", "phindbot", "timpibot", "cohere-ai", "ai2bot",
  "omgili", "seznambot", "rogerbot", "screaming frog", "siteauditbot", "serpstatbot",
];

export function isLikelyBot(userAgent: string | null | undefined): boolean {
  const ua = (userAgent ?? "").toLowerCase();
  return BOT_USER_AGENTS.some((token) => ua.includes(token));
}
