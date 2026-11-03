/* Conservative defaults. No environment variable can re-enable a Vercel video relay. */
const DEFAULTS = Object.freeze({ dailyMinutes: 120, monthlyMinutes: 2700, startHour: 6, endHour: 24, leaseSeconds: 60 });

function integerSetting(env, name, fallback, min, max) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} doit être un entier entre ${min} et ${max}.`);
  return value;
}

function readPolicy(env = process.env) {
  const policy = {
    dailyMinutes: integerSetting(env, 'DAILY_WATCH_MINUTES', DEFAULTS.dailyMinutes, 1, 180),
    monthlyMinutes: integerSetting(env, 'MONTHLY_WATCH_MINUTES', DEFAULTS.monthlyMinutes, 1, 3600),
    startHour: integerSetting(env, 'WATCH_START_HOUR_UTC', DEFAULTS.startHour, 0, 23),
    endHour: integerSetting(env, 'WATCH_END_HOUR_UTC', DEFAULTS.endHour, 1, 24),
    leaseSeconds: DEFAULTS.leaseSeconds,
    timezone: 'UTC', videoRoute: 'direct'
  };
  if (policy.endHour <= policy.startHour) throw new Error('La fin de la plage doit être après son début.');
  if (policy.monthlyMinutes < policy.dailyMinutes) throw new Error('Le quota mensuel doit être au moins égal au quota quotidien.');
  return Object.freeze(policy);
}

function quotaWindow(now, policy) {
  const date = new Date(now);
  const day = date.toISOString().slice(0, 10);
  const month = date.toISOString().slice(0, 7);
  const midnight = Date.parse(`${day}T00:00:00.000Z`);
  return {
    dayKey: `onda:{budget}:${day}`,
    monthKey: `onda:{budget}:${month}`,
    windowStart: midnight + policy.startHour * 3600000,
    windowEnd: Math.min(midnight + policy.endHour * 3600000, Date.parse(`${day}T00:00:00.000Z`) + 86400000),
    nextDay: midnight + 86400000,
    nextMonth: Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1)
  };
}

function publicUsage(dayMs, monthMs, policy, now = Date.now()) {
  const window = quotaWindow(now, policy);
  return {
    dayUsedSeconds: Math.floor(dayMs / 1000),
    monthUsedSeconds: Math.floor(monthMs / 1000),
    dayRemainingSeconds: Math.max(0, policy.dailyMinutes * 60 - Math.floor(dayMs / 1000)),
    monthRemainingSeconds: Math.max(0, policy.monthlyMinutes * 60 - Math.floor(monthMs / 1000)),
    inWindow: now >= window.windowStart && now < window.windowEnd,
    nextDayAt: window.nextDay, nextMonthAt: window.nextMonth,
    windowStartAt: window.windowStart, windowEndAt: window.windowEnd,
    serverNow: now
  };
}

module.exports = { DEFAULTS, readPolicy, quotaWindow, publicUsage };
