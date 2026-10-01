// GET /api/confirm?email=&token= (the link in the confirmation email): adds the address to the
// Resend segment the broadcasts go to. Resend keeps the list and handles unsubscribes.
import { page, resend, same, sign, valid } from '../../src/mail';

interface Env { RESEND_API_KEY: string; RESEND_SEGMENT_ID: string; SUBSCRIBE_SECRET: string }

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const url = new URL(request.url);
  const email = (url.searchParams.get('email') ?? '').trim().toLowerCase();
  const token = url.searchParams.get('token') ?? '';
  if (!valid(email) || !same(token, await sign(email, env.SUBSCRIBE_SECRET))) {
    return page('That link is not valid', 'Subscribe again from the bottom of the paper and use the newest email.', 400);
  }
  await resend(env.RESEND_API_KEY, '/contacts', { email, unsubscribed: false, segments: [{ id: env.RESEND_SEGMENT_ID }] });
  return page("You're in", 'The next edition lands in your inbox in the morning. Every email has an unsubscribe link.');
};
