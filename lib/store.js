/* Upstash Redis REST. One atomic round trip per lease; no paid Vercel add-on required.
 * Production NEVER falls back to process memory. Missing/unavailable storage fails closed.
 * The explicitly local adapter is for development and deterministic tests only.
 */
const RESERVE_SCRIPT = `
local now = tonumber(ARGV[1])
local owner = ARGV[2]
local lease = tonumber(ARGV[3])
local dayCap = tonumber(ARGV[4])
local monthCap = tonumber(ARGV[5])
local windowStart = tonumber(ARGV[6])
local windowEnd = tonumber(ARGV[7])
local activeOwner = redis.call('HGET', KEYS[3], 'owner')
local activeUntil = tonumber(redis.call('HGET', KEYS[3], 'expires') or '0')
if activeUntil > now and activeOwner ~= owner then
  return {'BUSY', activeUntil, 0, 0, 0, now}
end
if now < windowStart or now >= windowEnd then
  return {'OUTSIDE_HOURS', 0, 0, 0, 0, now}
end
local dayUsed = tonumber(redis.call('GET', KEYS[1]) or '0')
local monthUsed = tonumber(redis.call('GET', KEYS[2]) or '0')
local remaining = math.min(dayCap - dayUsed, monthCap - monthUsed, windowEnd - now)
if remaining < 1000 then
  local code = 'DAILY_LIMIT'
  if monthCap - monthUsed < 1000 then code = 'MONTHLY_LIMIT' end
  if windowEnd - now < 1000 then code = 'OUTSIDE_HOURS' end
  return {code, 0, dayUsed, monthUsed, 0, now}
end
local charge = math.min(lease, remaining)
local expires = now + charge
if activeUntil > now and activeOwner == owner then
  if activeUntil - now > 15000 then return {'OK', activeUntil, dayUsed, monthUsed, 0, now} end
  expires = activeUntil + charge
end
if expires > windowEnd then expires = windowEnd end
dayUsed = redis.call('INCRBY', KEYS[1], charge)
monthUsed = redis.call('INCRBY', KEYS[2], charge)
redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[8]))
redis.call('PEXPIRE', KEYS[2], tonumber(ARGV[9]))
redis.call('HSET', KEYS[3], 'owner', owner, 'expires', expires)
redis.call('PEXPIRE', KEYS[3], expires - now + 10000)
return {'OK', expires, dayUsed, monthUsed, charge, now}
`;

const HIT_SCRIPT = `
local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return n
`;
const RELEASE_SCRIPT = `
if redis.call('HGET', KEYS[1], 'owner') == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

class RedisStore {
  constructor(url, token) {
    if (!/^https:\/\//i.test(url) || !token) throw new Error('Le stockage Redis doit utiliser HTTPS et un jeton.');
    this.url = url.replace(/\/$/, '');
    this.token = token;
  }
  async command(args) {
    let response;
    try {
      response = await fetch(this.url, {
        method: 'POST', headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(args), signal: AbortSignal.timeout(5000), cache: 'no-store'
      });
    } catch { throw new Error('Stockage des quotas indisponible.'); }
    if (!response.ok) throw new Error('Stockage des quotas indisponible.');
    const payload = await response.json();
    if (payload.error) throw new Error('Stockage des quotas indisponible.');
    return payload.result;
  }
  async reserve(keys, args) { return this.command(['EVAL', RESERVE_SCRIPT, String(keys.length), ...keys, ...args.map(String)]); }
  async hit(key, ttlMs) { return Number(await this.command(['EVAL', HIT_SCRIPT, '1', key, String(ttlMs)])); }
  async release(key, owner) { return this.command(['EVAL', RELEASE_SCRIPT, '1', key, owner]); }
  async get(key) { return this.command(['GET', key]); }
  async mget(keys) { return this.command(['MGET', ...keys]); }
  async set(key, value, ttlMs) { return this.command(['SET', key, value, 'PX', String(ttlMs)]); }
  async del(key) { return this.command(['DEL', key]); }
  async getdel(key) { return this.command(['GETDEL', key]); }
}

class LocalStore {
  constructor() { this.values = new Map(); this.hashes = new Map(); }
  expired(key, now) {
    const entry = this.values.get(key);
    if (entry && entry.expires <= now) { this.values.delete(key); return true; }
    return false;
  }
  value(key, now) { this.expired(key, now); return this.values.get(key)?.value || null; }
  hash(key, now) {
    const entry = this.hashes.get(key);
    if (entry && entry.expires <= now) { this.hashes.delete(key); return null; }
    return entry?.value || null;
  }
  async reserve(keys, args) {
    const owner = String(args[1]);
    const [now, , lease, dayCap, monthCap, start, end, dayTtl, monthTtl] = args.map(Number);
    const active = this.hash(keys[2], now);
    if (active && active.expires > now && active.owner !== owner) return ['BUSY', active.expires, 0, 0, 0, now];
    if (now < start || now >= end) return ['OUTSIDE_HOURS', 0, 0, 0, 0, now];
    let dayUsed = Number(this.value(keys[0], now) || 0);
    let monthUsed = Number(this.value(keys[1], now) || 0);
    const remaining = Math.min(dayCap - dayUsed, monthCap - monthUsed, end - now);
    if (remaining < 1000) return [monthCap - monthUsed < 1000 ? 'MONTHLY_LIMIT' : dayCap - dayUsed < 1000 ? 'DAILY_LIMIT' : 'OUTSIDE_HOURS', 0, dayUsed, monthUsed, 0, now];
    const charge = Math.min(lease, remaining);
    if (active && active.expires - now > 15000) return ['OK', active.expires, dayUsed, monthUsed, 0, now];
    let expires = active && active.expires > now ? active.expires + charge : now + charge;
    expires = Math.min(expires, end);
    dayUsed += charge; monthUsed += charge;
    this.values.set(keys[0], { value: String(dayUsed), expires: now + dayTtl });
    this.values.set(keys[1], { value: String(monthUsed), expires: now + monthTtl });
    this.hashes.set(keys[2], { value: { owner, expires }, expires: expires + 10000 });
    return ['OK', expires, dayUsed, monthUsed, charge, now];
  }
  async hit(key, ttlMs) {
    const now = Date.now(); this.expired(key, now);
    const entry = this.values.get(key) || { value: '0', expires: now + ttlMs };
    entry.value = String(Number(entry.value) + 1); this.values.set(key, entry);
    return Number(entry.value);
  }
  async release(key, owner) { if (this.hash(key, Date.now())?.owner === owner) { this.hashes.delete(key); return 1; } return 0; }
  async get(key) { return this.value(key, Date.now()); }
  async mget(keys) { return keys.map(key => this.value(key, Date.now())); }
  async set(key, value, ttlMs) { this.values.set(key, { value, expires: Date.now() + ttlMs }); return 'OK'; }
  async del(key) { return this.values.delete(key) ? 1 : 0; }
  async getdel(key) { const value = await this.get(key); await this.del(key); return value; }
}

let localStore;
function getStore(env = process.env) {
  const url = env.UPSTASH_REDIS_REST_URL || env.KV_REST_API_URL || '';
  const token = env.UPSTASH_REDIS_REST_TOKEN || env.KV_REST_API_TOKEN || '';
  if (url && token) return new RedisStore(url, token);
  if (env.ONDA_LOCAL_DEV === '1' && !env.VERCEL) return localStore || (localStore = new LocalStore());
  throw new Error('Configurez UPSTASH_REDIS_REST_URL et UPSTASH_REDIS_REST_TOKEN (ou KV_REST_API_URL / KV_REST_API_TOKEN).');
}

module.exports = { getStore, RedisStore, LocalStore, RESERVE_SCRIPT, LOCK_KEY: 'onda:{budget}:viewer' };
