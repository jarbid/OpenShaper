import { Head } from 'vite-react-ssg';

type Json = Record<string, unknown>;

const SCHEMA_ORG = 'https://schema.org';

/** Drop a member's `@context` when the wrapper already declares the same one. */
const withoutSharedContext = (node: Json): Json => {
  const { ['@context']: context, ...rest } = node;
  return context === SCHEMA_ORG ? rest : node;
};

/**
 * The object actually serialised into the script tag.
 *
 * Several entities become one `@graph` node rather than a bare JSON array. Both
 * are valid JSON-LD and Google reads either, but a top-level array has no
 * `@context` of its own, and consumers that reach straight for
 * `parsed['@context']` — browser extensions and other in-page scrapers, far
 * less forgiving than the search crawlers — throw on it. `@graph` keeps the
 * document root an object, which is also the form Google's structured-data docs
 * use for multiple entities.
 */
export const jsonLdRoot = (data: Json | Json[]): Json =>
  Array.isArray(data) ? { '@context': SCHEMA_ORG, '@graph': data.map(withoutSharedContext) } : data;

/**
 * Emits a JSON-LD `<script>` into the document head for rich results.
 * Pass a single schema object or an array of them.
 */
export function JsonLd({ data }: { data: Json | Json[] }) {
  const json = JSON.stringify(jsonLdRoot(data));
  return (
    <Head>
      <script type="application/ld+json">{json}</script>
    </Head>
  );
}
