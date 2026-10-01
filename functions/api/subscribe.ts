// POST /api/subscribe (the footer form): emails a signed confirmation link. Double opt-in, no
// database: the address is only added to the Resend segment once the link is clicked (confirm.ts).
import { page, resend, sign, valid } from '../../src/mail';

interface Env { RESEND_API_KEY: string; SUBSCRIBE_SECRET: string; MAIL_FROM: string }

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const form = await request.formData();
  const email = String(form.get('email') ?? '').trim().toLowerCase();
  // The hidden "website" field: a person never fills it, a bot does. Thank the bot and do nothing.
  if (form.get('website')) return page('Check your inbox', 'We sent you a confirmation link.');
  if (!valid(email)) return page('That address does not look right', 'Go back and check the spelling.', 400);

  const link = new URL(`/api/confirm?email=${encodeURIComponent(email)}&token=${await sign(email, env.SUBSCRIBE_SECRET)}`, request.url);
  await resend(env.RESEND_API_KEY, '/emails', {
    from: env.MAIL_FROM, to: email, subject: 'Confirm your subscription to The Daily Weight',
    text: `Click to get The Daily Weight every morning:\n\n${link}\n\nIf you didn't ask for this, ignore this email and nothing happens.`,
  });
  return page('Check your inbox', `We sent a confirmation link to <strong>${email}</strong>. Click it and the paper arrives every morning.`);
};
