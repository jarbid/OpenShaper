/**
 * Sitewide SEO constants. The canonical origin is configurable via the
 * `VITE_SITE_URL` build env var and defaults to the production domain so
 * canonical / Open Graph / sitemap URLs are absolute and correct.
 */

export const SITE_NAME = 'OpenShaper';

/** Production origin (no trailing slash). Override with VITE_SITE_URL at build time. */
export const SITE_URL = (import.meta.env.VITE_SITE_URL ?? 'https://openshaper.com').replace(
  /\/+$/,
  '',
);

export const SITE_TAGLINE = 'Free, open-source surfboard design software';

export const DEFAULT_DESCRIPTION =
  'Design surfboards in your browser with OpenShaper — a free, open-source CAD app. Draw outlines, rocker and cross-sections, see live volume and weight, preview in 3D, and export STL, DXF and PDF. No account, no paywall, runs entirely on your machine.';

/** Social share card (1200×630). */
export const OG_IMAGE = '/og-cover.svg';

export const GITHUB_URL = 'https://github.com/jarbid/openshaper';

/** Contact address for feedback, bugs, feature requests and enquiries. */
export const CONTACT_EMAIL = 'info@openshaper.com';
export const CONTACT_MAILTO = `mailto:${CONTACT_EMAIL}`;

/** Maker name used for author / Person structured data. Update to taste. */
export const AUTHOR_NAME = 'Jared';

/** Build an absolute URL from a site-root path. */
export const absUrl = (path: string): string =>
  `${SITE_URL}${path.startsWith('/') ? path : `/${path}`}`;
