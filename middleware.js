import { next } from '@vercel/functions';
import { verifySession, sessionCookie } from './lib/session.js';

// Only the private document and APIs invoke middleware. Versioned assets stay on the CDN.
export default async function middleware(request) {
  const url = new URL(request.url);
  if (url.pathname === '/api/auth' || url.pathname === '/api/tv') return next();
  if (await verifySession(sessionCookie(request), process.env.SESSION_SECRET || '')) return next();
  const headers = { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow, noarchive' };
  if (url.pathname.startsWith('/api/')) {
    return new Response(JSON.stringify({ error: 'Connectez-vous à votre espace privé.', code: 'AUTH_REQUIRED' }), {
      status: 401, headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8' }
    });
  }
  return new Response(null, { status: 302, headers: { ...headers, Location: '/login.html?next=' + encodeURIComponent(url.pathname + url.search) } });
}

export const config = { runtime: 'nodejs', matcher: ['/', '/index.html', '/api/:path*'] };
