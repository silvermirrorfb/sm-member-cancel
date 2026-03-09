function parseHour(value, fallback) {
  const n = Number(value);
  if (!Number.isInteger(n)) return fallback;
  if (n < 0 || n > 23) return fallback;
  return n;
}

function getHourInTimeZone(now, timeZone) {
  const date = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(date.getTime())) return null;
  const formatter = new Intl.DateTimeFormat('en-US', {
    hour: '2-digit',
    hourCycle: 'h23',
    timeZone: String(timeZone || 'America/New_York'),
  });
  const parts = formatter.formatToParts(date);
  const hourPart = parts.find(part => part.type === 'hour');
  if (!hourPart) return null;
  const hour = Number(hourPart.value);
  return Number.isInteger(hour) ? hour : null;
}

function isHourInsideWindow(hour, startHour, endHour) {
  if (!Number.isInteger(hour)) return false;
  if (!Number.isInteger(startHour) || !Number.isInteger(endHour)) return false;
  if (startHour === endHour) return true; // 24h window
  if (startHour < endHour) return hour >= startHour && hour < endHour;
  return hour >= startHour || hour < endHour; // overnight window
}

function isWithinSendWindow(now, config = {}) {
  const timeZone = String(config.timeZone || 'America/New_York');
  const startHour = parseHour(config.startHour, 9);
  const endHour = parseHour(config.endHour, 17);
  const hour = getHourInTimeZone(now, timeZone);
  return {
    allowed: isHourInsideWindow(hour, startHour, endHour),
    hour,
    startHour,
    endHour,
    timeZone,
  };
}

export {
  parseHour,
  getHourInTimeZone,
  isHourInsideWindow,
  isWithinSendWindow,
};
