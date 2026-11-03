/* RETIRED — DO NOT DEPLOY.
 *
 * The private Vercel application now uses direct provider playback and returns
 * HTTP 410 for every former video-relay action. This file is excluded from the
 * production build and intentionally contains no executable proxy.
 *
 * The previous relay forwarded provider credentials in URLs, had a hard-coded
 * fallback signing secret, and made unverified "free bandwidth" claims. It also
 * conflicts with the direct-only architecture used to protect Vercel Hobby.
 * Moving video bytes to another proxy does not create unlimited free capacity
 * or exempt a deployment from its provider's terms and fair-use rules.
 *
 * See DEPLOIEMENT.md for the supported private setup. If your provider cannot
 * serve HTTPS/CORS-compatible streams to a browser, use a compatible provider
 * or a separate native player; do not silently re-enable a Vercel video proxy.
 */