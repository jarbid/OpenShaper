import { ViteReactSSG } from 'vite-react-ssg';
import { routes } from './routes';
import './index.css';

// vite-react-ssg owns hydration/mount. Marketing routes are prerendered to
// static HTML at build time; the editor (/app) is a client-only island.
export const createRoot = ViteReactSSG({ routes, basename: import.meta.env.BASE_URL });
