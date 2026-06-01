import { Head } from 'vite-react-ssg';

type Json = Record<string, unknown>;

/**
 * Emits a JSON-LD `<script>` into the document head for rich results.
 * Pass a single schema object or an array of them.
 */
export function JsonLd({ data }: { data: Json | Json[] }) {
  const json = JSON.stringify(data);
  return (
    <Head>
      <script type="application/ld+json">{json}</script>
    </Head>
  );
}
