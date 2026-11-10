// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Head } from 'vite-react-ssg';
import { Seo } from '../seo/Seo';

/**
 * `/`: the site is the fin designer, so the home page is a pointer to it.
 *
 * In production `public/_redirects` answers `/` with a 301 before this page is ever
 * served. This is what a host without that file shows instead: a meta refresh (no
 * script needed), a client-side replace once hydrated, and a plain link for anyone
 * whose browser does neither.
 */
export default function Home() {
  useEffect(() => {
    window.location.replace('/fin');
  }, []);

  return (
    <>
      <Seo title="OpenFinShaper" path="/fin" noindex />
      <Head>
        <meta httpEquiv="refresh" content="0; url=/fin" />
      </Head>
      <main className="flex min-h-screen items-center justify-center p-6 text-sm">
        <Link to="/fin" className="underline underline-offset-4">
          Open OpenFinShaper
        </Link>
      </main>
    </>
  );
}
