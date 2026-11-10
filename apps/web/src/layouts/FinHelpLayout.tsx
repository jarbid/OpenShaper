// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * A bare frame for the site's two text pages, help and privacy: the documentation
 * styles, and a slim bar back to the designer. The pages are for people using the
 * fin designer, so they lead only back there.
 */
import { Link, Outlet } from 'react-router-dom';
import '../marketing.css';

export function FinHelpLayout() {
  return (
    <div className="marketing flex min-h-screen flex-col overflow-x-clip">
      <header className="sticky top-0 z-30 border-b border-border bg-background/80 backdrop-blur-md">
        <div className="mx-auto flex h-14 w-full max-w-6xl items-center justify-between gap-3 px-4 sm:px-5">
          <span className="text-sm font-semibold">OpenFinShaper</span>
          <Link
            to="/fin"
            className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          >
            Back to OpenFinShaper
          </Link>
        </div>
      </header>
      <main className="flex-1">
        <Outlet />
      </main>
    </div>
  );
}
