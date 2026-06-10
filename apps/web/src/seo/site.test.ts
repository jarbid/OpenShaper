import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { absUrl, OG_IMAGE } from './site';

describe('social share card', () => {
  it('is a raster format — Twitter/Slack/iMessage scrapers do not render SVG og:images', () => {
    expect(OG_IMAGE).toMatch(/\.(png|jpe?g)$/);
  });

  it('exists in public/ (regenerate with `pnpm og` after editing og-cover.svg)', () => {
    const publicDir = join(dirname(fileURLToPath(import.meta.url)), '../../public');
    expect(existsSync(join(publicDir, OG_IMAGE))).toBe(true);
  });

  it('absUrl builds absolute URLs from site-root paths', () => {
    expect(absUrl(OG_IMAGE)).toMatch(/^https?:\/\/.+\.(png|jpe?g)$/);
  });
});
