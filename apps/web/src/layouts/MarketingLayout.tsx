import { buttonVariants, cn } from '@openshaper/ui';
import { useEffect } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import { BoardOutline } from '../components/marks';
import { GITHUB_URL, SITE_NAME } from '../seo/site';
import { SUPPORT_LABEL, SUPPORT_URL } from '../support';
import '../marketing.css';

const NAV = [
  { to: '/surfboard-design-guide', label: 'Design Guide' },
  { to: '/surfboard-construction-methods', label: 'Construction' },
  { to: '/about', label: 'About' },
];

function GithubIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <path d="M12 .5C5.7.5.5 5.7.5 12c0 5.1 3.3 9.4 7.9 10.9.6.1.8-.2.8-.6v-2c-3.2.7-3.9-1.5-3.9-1.5-.5-1.3-1.3-1.7-1.3-1.7-1.1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1 1.8 2.7 1.3 3.4 1 .1-.8.4-1.3.7-1.6-2.6-.3-5.3-1.3-5.3-5.8 0-1.3.5-2.3 1.2-3.1-.1-.3-.5-1.5.1-3.1 0 0 1-.3 3.3 1.2a11.5 11.5 0 0 1 6 0c2.3-1.5 3.3-1.2 3.3-1.2.6 1.6.2 2.8.1 3.1.8.8 1.2 1.8 1.2 3.1 0 4.5-2.7 5.5-5.3 5.8.4.4.8 1.1.8 2.2v3.3c0 .4.2.7.8.6 4.6-1.5 7.9-5.8 7.9-10.9C23.5 5.7 18.3.5 12 .5Z" />
    </svg>
  );
}

function Brand() {
  return (
    <Link to="/" className="group flex items-center gap-2.5" aria-label={`${SITE_NAME} home`}>
      <BoardOutline className="h-4 w-16 text-primary transition-transform group-hover:-translate-y-px" />
      <span className="font-display text-xl tracking-tight">{SITE_NAME}</span>
    </Link>
  );
}

export function MarketingLayout() {
  const { pathname } = useLocation();

  // Scroll to top on route change (and honour in-page #anchors).
  useEffect(() => {
    if (window.location.hash) return;
    window.scrollTo(0, 0);
  }, [pathname]);

  return (
    <div className="marketing grain flex min-h-screen flex-col">
      {/* ---- Header ---- */}
      <header className="sticky top-0 z-30 border-b border-border/70 bg-background/80 backdrop-blur-md">
        <div className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between gap-4 px-5">
          <Brand />

          <nav className="hidden items-center gap-1 md:flex">
            {NAV.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                className={({ isActive }) =>
                  cn(
                    'rounded-md px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground',
                    isActive && 'text-foreground',
                  )
                }
              >
                {item.label}
              </NavLink>
            ))}
          </nav>

          <div className="flex items-center gap-1.5">
            <a
              href={GITHUB_URL}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="OpenShaper on GitHub"
              className="hidden rounded-md p-2 text-muted-foreground transition-colors hover:text-foreground sm:inline-flex"
            >
              <GithubIcon className="h-5 w-5" />
            </a>
            <Link to="/app" className={cn(buttonVariants({ size: 'sm' }), 'shadow-sm')}>
              Open the app
            </Link>
          </div>
        </div>

        {/* Mobile nav row */}
        <nav className="flex items-center gap-1 overflow-x-auto border-t border-border/60 px-3 py-1.5 md:hidden">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                cn(
                  'whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground hover:text-foreground',
                  isActive && 'text-foreground',
                )
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
      </header>

      {/* ---- Page ---- */}
      <main className="relative z-10 flex-1">
        <Outlet />
      </main>

      {/* ---- Footer ---- */}
      <footer className="relative z-10 mt-20 border-t border-border/70">
        <BoardOutline className="h-6 w-full text-border" />
        <div className="mx-auto grid w-full max-w-6xl gap-10 px-5 py-14 sm:grid-cols-2 lg:grid-cols-4">
          <div className="lg:col-span-2">
            <Brand />
            <p className="mt-3 max-w-sm text-sm leading-relaxed text-muted-foreground">
              A free, open-source surfboard design app that runs entirely in your browser. Built by
              a maker, for makers.
            </p>
          </div>

          <div>
            <h3 className="label-tech mb-3">Learn</h3>
            <ul className="space-y-2 text-sm">
              <li>
                <Link
                  to="/surfboard-design-guide"
                  className="text-muted-foreground hover:text-foreground"
                >
                  Surfboard design guide
                </Link>
              </li>
              <li>
                <Link
                  to="/surfboard-construction-methods"
                  className="text-muted-foreground hover:text-foreground"
                >
                  Construction methods
                </Link>
              </li>
              <li>
                <Link to="/about" className="text-muted-foreground hover:text-foreground">
                  About the project
                </Link>
              </li>
            </ul>
          </div>

          <div>
            <h3 className="label-tech mb-3">Project</h3>
            <ul className="space-y-2 text-sm">
              <li>
                <Link to="/app" className="text-muted-foreground hover:text-foreground">
                  Open the design app
                </Link>
              </li>
              <li>
                <a
                  href={GITHUB_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-muted-foreground hover:text-foreground"
                >
                  Source on GitHub
                </a>
              </li>
              {SUPPORT_URL && (
                <li>
                  <a
                    href={SUPPORT_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-muted-foreground hover:text-foreground"
                  >
                    {SUPPORT_LABEL}
                  </a>
                </li>
              )}
            </ul>
          </div>
        </div>

        <div className="border-t border-border/60">
          <div className="mx-auto flex w-full max-w-6xl flex-col items-center justify-between gap-2 px-5 py-5 text-xs text-muted-foreground sm:flex-row">
            <p>
              © {new Date().getFullYear()} {SITE_NAME}. Free &amp; open-source.
            </p>
            <p>
              Licensed{' '}
              <a
                href="https://www.gnu.org/licenses/gpl-3.0.html"
                target="_blank"
                rel="noopener noreferrer"
                className="underline underline-offset-2 hover:text-foreground"
              >
                GPL-3.0-or-later
              </a>
              . A modern rebuild of BoardCAD.
            </p>
          </div>
        </div>
      </footer>
    </div>
  );
}
