// Shared by the Cloudflare Pages Functions in functions/api: Web Crypto only, no Node.

// A signed token proves the address went through the confirmation email; nothing is stored before that.
export async function sign(email: string, secret: string) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(email.trim().toLowerCase()));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Constant-time, so a wrong token takes as long as a right one.
export function same(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export const valid = (email: string) => email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email);

export async function resend(key: string, path: string, body: unknown) {
  const res = await fetch(`https://api.resend.com${path}`, {
    method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Resend ${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

// A small page in the paper's look for "check your inbox" and "you're in".
export const page = (title: string, body: string, status = 200) => new Response(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title} — The Daily Weight</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Lora:wght@700&family=PT+Serif&display=swap">
<style>body{margin:0;background:#fbfaf6;color:#1a1a1a;font:400 1.1rem/1.6 'PT Serif',Georgia,serif}main{max-width:560px;margin:12vh auto;padding:0 24px}
h1{font:700 2.2rem/1.1 Lora,Georgia,serif;letter-spacing:-.02em;padding-bottom:12px;border-bottom:4px solid #1a1a1a;box-shadow:0 3px 0 #fbfaf6,0 4px 0 #1a1a1a}a{color:#1a1a1a}</style></head>
<body><main><h1>${title}</h1><p>${body}</p><p><a href="/">‹ The Daily Weight</a></p></main></body></html>`,
  { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
