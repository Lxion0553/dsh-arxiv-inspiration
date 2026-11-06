/**
 * Date helpers (UTC+8) for the arXiv weekday window.
 *
 * A UTC+8 calendar day D spans UTC [D-1 16:00, D 16:00). arXiv submittedDate
 * filters are UTC, so we convert each target UTC+8 day to that UTC range.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const UTC8_OFFSET_MS = 8 * 60 * 60 * 1000;

const WEEKDAY_INDEX = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

/** Floor an instant to its UTC+8 calendar-day start, returned as a UTC timestamp. */
function utc8DayStart(utcMs) {
  const shifted = utcMs + UTC8_OFFSET_MS;
  const dayStartShifted = Math.floor(shifted / DAY_MS) * DAY_MS;
  return dayStartShifted - UTC8_OFFSET_MS;
}

/** UTC+8 calendar-day string (YYYYMMDD) of a UTC+8 day-start timestamp. */
function utc8DayString(utc8StartMs) {
  return new Date(utc8StartMs + UTC8_OFFSET_MS).toISOString().slice(0, 10).replace(/-/g, '');
}

/**
 * Matching UTC+8 calendar days within the past 7 days for the requested
 * weekday names. Returns [{ day: 'YYYYMMDD', utcStartMs, utcEndMs }] in
 * ascending order (7 days back, including today).
 */
export function targetDays(weekdays, now = Date.now()) {
  const wanted = new Set(
    weekdays
      .map((w) => String(w || '').trim().toLowerCase())
      .filter((w) => w in WEEKDAY_INDEX)
      .map((w) => WEEKDAY_INDEX[w]),
  );
  if (wanted.size === 0) return [];
  const todayStart = utc8DayStart(now);
  const days = [];
  for (let back = 0; back < 7; back++) {
    const start = todayStart - back * DAY_MS;
    // In UTC+8 space the weekday of `start`:
    const weekday = new Date(start + UTC8_OFFSET_MS).getUTCDay();
    if (wanted.has(weekday)) {
      days.push({ day: utc8DayString(start), utcStartMs: start, utcEndMs: start + DAY_MS });
    }
  }
  return days.reverse();
}

/** arXiv submittedDate range token for one UTC+8 day, expressed in UTC. */
export function submittedDateRange(day) {
  const stamp = (ms) => new Date(ms).toISOString().replace(/[-:TZ.]/g, '').slice(0, 12);
  return `[${stamp(day.utcStartMs)} TO ${stamp(day.utcEndMs - 1)}]`;
}

/** Today's UTC+8 date as YYYY-MM-DD (for the digest header). */
export function utc8Today(now = Date.now()) {
  return new Date(now + UTC8_OFFSET_MS).toISOString().slice(0, 10);
}
