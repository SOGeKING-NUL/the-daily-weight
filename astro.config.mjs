import { defineConfig } from 'astro/config';

try { process.loadEnvFile(); } catch {} // .env, when there is one

// The published address, for absolute links in feeds, link previews, the email and /txt.
// Set SITE_URL (a repo variable in Actions, or .env locally) once the domain exists.
export default defineConfig({ site: process.env.SITE_URL || 'https://thedailyweight.example' });
