import { ViteReactSSG } from 'vite-react-ssg';
import { routes } from './routes';
import './index.css';

// vite-react-ssg owns hydration/mount. The help and privacy pages are prerendered to
// static HTML at build time; the fin designer (/fin) is a client-only island.
//
// (The board editor this was forked from also stripped shared-board links out of
// the address bar here, before analytics could read them — see share-bootstrap.ts.
// The fin designer has no share links, so there is nothing to strip.)
export const createRoot = ViteReactSSG({ routes, basename: import.meta.env.BASE_URL });
