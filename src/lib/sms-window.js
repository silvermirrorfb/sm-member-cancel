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

function getTimePartsInZone(now, timeZone) {
  const date = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(date.getTime())) return null;
  const formatter = new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone: String(timeZone || 'America/New_York'),
  });
  const parts = formatter.formatToParts(date);
  const read = type => {
    const part = parts.find(p => p.type === type);
    return part ? Number(part.value) : null;
  };
  const year = read('year');
  const month = read('month');
  const day = read('day');
  const hour = read('hour');
  const minute = read('minute');
  if (![year, month, day, hour, minute].every(Number.isInteger)) return null;
  return { year, month, day, hour, minute };
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

function getNextWindowStartIso(now, config = {}) {
  const base = now instanceof Date ? new Date(now.getTime()) : new Date(now || Date.now());
  if (Number.isNaN(base.getTime())) return null;
  const timeZone = String(config.timeZone || 'America/New_York');
  const startHour = parseHour(config.startHour, 9);
  const endHour = parseHour(config.endHour, 17);
  const probe = new Date(base.getTime() + 60 * 1000);
  for (let i = 0; i < 8 * 24 * 60; i++) {
    const parts = getTimePartsInZone(probe, timeZone);
    if (!parts) return null;
    const inWindow = isHourInsideWindow(parts.hour, startHour, endHour);
    if (inWindow && parts.hour === startHour && parts.minute === 0) {
      return probe.toISOString();
    }
    probe.setUTCMinutes(probe.getUTCMinutes() + 1);
  }
  return null;
}

export {
  parseHour,
  getHourInTimeZone,
  getTimePartsInZone,
  isHourInsideWindow,
  isWithinSendWindow,
  getNextWindowStartIso,
};
