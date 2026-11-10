/**
 * Sitewide SEO constants. The canonical origin is configurable via the
 * `VITE_SITE_URL` build env var and defaults to the production domain so
 * canonical / Open Graph / sitemap URLs are absolute and correct.
 */

export const SITE_NAME = 'OpenFinShaper';

/** Production origin (no trailing slash). Override with VITE_SITE_URL at build time. */
export const SITE_URL = (import.meta.env.VITE_SITE_URL ?? 'https://openfinshaper.com').replace(
  /\/+$/,
  '',
);

export const SITE_TAGLINE = 'Free, open-source surf fin design software';

export const DEFAULT_DESCRIPTION =
  'Design surf fins in your browser with OpenFinShaper — free, open-source fin CAD. Draw the outline, foil, thickness and cant, and export STEP and STL for CNC or 3D printing. Nothing to install.';

/** Social share card (1200×630). PNG — scrapers don't render SVG og:images; regenerate with `pnpm og`. */
export const OG_IMAGE = '/og-cover.png';

/** This project's source. */
export const GITHUB_URL = 'https://github.com/JunoNeko/OpenShaper';

/**
 * The project OpenFinShaper was forked from (GPL-3.0-or-later). Credited in the
 * designer's status bar.
 */
export const UPSTREAM_URL = 'https://github.com/jarbid/openshaper';

/** Contact address for feedback, bugs, feature requests and enquiries. */
export const CONTACT_EMAIL = 'stephen.franklin@outlook.com';
export const CONTACT_MAILTO = `mailto:${CONTACT_EMAIL}`;

/** Build an absolute URL from a site-root path. */
export const absUrl = (path: string): string =>
  `${SITE_URL}${path.startsWith('/') ? path : `/${path}`}`;
