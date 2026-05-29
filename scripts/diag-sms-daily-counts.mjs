import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Redis } from '@upstash/redis';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function loadDotEnv(file) {
  const raw = fs.readFileSync(file, 'utf8');
  for (const line of raw.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (!(m[1] in process.env)) process.env[m[1]] = v;
  }
}

loadDotEnv(path.resolve(__dirname, '../.env.local'));

const url = String(process.env.UPSTASH_REDIS_REST_URL || '').trim();
const token = String(process.env.UPSTASH_REDIS_REST_TOKEN || '').trim();
if (!url || !token) {
  console.error('Missing UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN');
  process.exit(1);
}

const redis = new Redis({ url, token });
const dates = ['2026-05-16', '2026-05-17', '2026-05-18'];

console.log('-- GET sms-sent:<date> --');
for (const d of dates) {
  const v = await redis.get(`sms-sent:${d}`);
  if (v === null || v === undefined) {
    console.log(`${d}: missing`);
  } else {
    console.log(`${d}: ${v}`);
  }
}

console.log('\n-- SCAN MATCH sms-sent:* (up to 20) --');
const found = [];
let cursor = '0';
let iterations = 0;
do {
  const res = await redis.scan(cursor, { match: 'sms-sent:*', count: 200 });
  cursor = String(res[0]);
  for (const k of res[1] || []) {
    if (found.length < 20) found.push(k);
  }
  iterations += 1;
  if (iterations > 50) break;
} while (cursor !== '0' && found.length < 20);

if (found.length === 0) {
  console.log('(no keys found matching sms-sent:*)');
} else {
  for (const k of found) {
    const v = await redis.get(k);
    console.log(`${k} = ${v}`);
  }
}

console.log('\n-- SCAN MATCH *sms* (up to 20, sanity check for any near-miss prefix) --');
const nearMiss = [];
cursor = '0';
iterations = 0;
do {
  const res = await redis.scan(cursor, { match: '*sms*', count: 200 });
  cursor = String(res[0]);
  for (const k of res[1] || []) {
    if (nearMiss.length < 20) nearMiss.push(k);
  }
  iterations += 1;
  if (iterations > 50) break;
} while (cursor !== '0' && nearMiss.length < 20);

if (nearMiss.length === 0) {
  console.log('(no keys found matching *sms*)');
} else {
  for (const k of nearMiss) console.log(k);
}
