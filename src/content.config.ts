import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';

const stories = defineCollection({
  loader: glob({ pattern: '*/*.md', base: './content/editions' }),
  schema: z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    title: z.string(),
    authors: z.array(z.string()).min(1),
    url: z.string().url(),
    discuss_url: z.string().url().nullable(),
    source: z.enum(['hn', 'reddit', 'x', 'labs', 'arxiv', 'github', 'press']),
    section: z.enum(['models', 'agents', 'infra', 'research', 'safety', 'industry']),
    interest_score: z.number().int().min(1).max(10),
    recommended: z.boolean(),
    must_read: z.boolean(),
    why_read: z.string(),
    summary: z.string(),
    image: z.string().nullable(),
    image_credit: z.string().nullable().optional(),
    image_source: z.string().url().nullable().optional(),
    sample: z.boolean(),
  }),
});

export const collections = { stories };
