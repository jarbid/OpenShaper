import { Head } from 'vite-react-ssg';
import { absUrl, DEFAULT_DESCRIPTION, OG_IMAGE, SITE_NAME } from './site';

export interface SeoProps {
  /** Page title. The site name is appended automatically unless already present. */
  title: string;
  description?: string;
  /** Site-root path for this page, e.g. `/about`. Drives canonical + og:url. */
  path: string;
  image?: string;
  type?: 'website' | 'article';
  /** Set for app shells / utility routes that shouldn't be indexed. */
  noindex?: boolean;
}

/**
 * Per-page document head: title, description, canonical, Open Graph and
 * Twitter card. Rendered into static HTML at build time by vite-react-ssg.
 */
export function Seo({
  title,
  description = DEFAULT_DESCRIPTION,
  path,
  image = OG_IMAGE,
  type = 'website',
  noindex = false,
}: SeoProps) {
  const url = absUrl(path);
  const img = absUrl(image);
  const fullTitle = title.includes(SITE_NAME) ? title : `${title} · ${SITE_NAME}`;

  return (
    <Head>
      <title>{fullTitle}</title>
      <meta name="description" content={description} />
      <link rel="canonical" href={url} />
      {noindex && <meta name="robots" content="noindex,follow" />}

      <meta property="og:site_name" content={SITE_NAME} />
      <meta property="og:title" content={fullTitle} />
      <meta property="og:description" content={description} />
      <meta property="og:type" content={type} />
      <meta property="og:url" content={url} />
      <meta property="og:image" content={img} />
      <meta property="og:image:width" content="1200" />
      <meta property="og:image:height" content="630" />

      <meta name="twitter:card" content="summary_large_image" />
      <meta name="twitter:title" content={fullTitle} />
      <meta name="twitter:description" content={description} />
      <meta name="twitter:image" content={img} />
    </Head>
  );
}
