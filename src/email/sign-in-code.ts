import { escapeHtml } from "../html.ts";
import type { Language } from "../locale.ts";

export const OTP_TTL_MINUTES = 15;

const copy = {
  en: {
    subject: "Verification code",
    heading: "Your 4Seas Passport sign-in code",
    validity: `This code is valid for ${OTP_TTL_MINUTES} minutes. If you didn’t request it, you can ignore this email.`,
    automatic: "This is an automated email. Please do not reply.",
    support: "For support, contact",
  },
  zh: {
    subject: "验证码",
    heading: "你的 4Seas Passport 登录验证码",
    validity: `验证码在 ${OTP_TTL_MINUTES} 分钟内有效。如果这不是你的操作，请忽略这封邮件。`,
    automatic: "此邮件由系统自动发送，请勿回复。",
    support: "如需帮助，请联系",
  },
  th: {
    subject: "รหัสยืนยัน",
    heading: "รหัสเข้าสู่ระบบ 4Seas Passport ของคุณ",
    validity: `รหัสนี้ใช้ได้ภายใน ${OTP_TTL_MINUTES} นาที หากคุณไม่ได้ขอรหัสนี้ คุณสามารถเพิกเฉยต่ออีเมลนี้ได้`,
    automatic: "อีเมลนี้ส่งโดยอัตโนมัติ โปรดอย่าตอบกลับ",
    support: "หากต้องการความช่วยเหลือ โปรดติดต่อ",
  },
} satisfies Record<Language, Record<string, string>>;

const supportEmail = "4seascoliving@gmail.com";

// Adapted from CoLivingOS src/adapters/notification/html-email.ts.
export function signInCodeEmail(language: Language, code: string) {
  const { subject: label, heading, validity, automatic, support } = copy[language];
  const subject = `${label}:${language === "zh" ? "" : " "}${code}`;
  const text = [heading, code, validity, `${automatic}\n${support} ${supportEmail}`, "4Seas · Nimman, Chiang Mai"].join("\n\n");
  const html = `<!doctype html>
<html lang="${language === "zh" ? "zh-CN" : language}">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(label)}</title></head>
<body style="margin:0;padding:0;background:#f6f6f4">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f6f6f4">
<tr><td align="center" style="padding:28px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;background:#fff;border-radius:12px;border:1px solid #e6e4df;font-family:Arial,sans-serif">
<tr><td style="padding:26px 28px 0">
<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
<td style="vertical-align:middle;padding-right:10px"><img src="https://4seas.xyz/coliving/email/4seas-logo.png" alt="4Seas Logo" width="36" height="36" style="display:block;border-radius:6px" border="0"></td>
<td style="vertical-align:middle;font-size:20px;font-weight:700;letter-spacing:.06em;color:#0e6b4f">4SEAS</td>
</tr></table>
</td></tr>
<tr><td style="padding:18px 28px 28px;font-size:18px;line-height:1.6;color:#1c1c1a">
<p style="margin:0;font-size:20px;font-weight:600">${escapeHtml(heading)}</p>
<p dir="ltr" style="margin:16px 0;font:700 36px/1.2 monospace;letter-spacing:.16em;color:#005040">${escapeHtml(code)}</p>
<p style="margin:0">${escapeHtml(validity)}</p>
</td></tr>
<tr><td style="padding:16px 28px 24px;border-top:1px solid #efede8;font-size:12px;line-height:1.6;color:#66635c">
<div style="margin-bottom:6px;color:#854d0e;font-weight:600">${escapeHtml(automatic)}</div>
<div>${escapeHtml(support)} <a href="mailto:${supportEmail}" style="color:#0b6bcb;text-decoration:none">${supportEmail}</a></div>
<div style="margin-top:8px">4Seas · Nimman, Chiang Mai</div>
</td></tr>
</table></td></tr></table></body></html>`;
  return { subject, text, html };
}
