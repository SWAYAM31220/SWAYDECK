const os = require("os");
const si = require("systeminformation");

const CACHE_MS = 1000;
const TIMEOUT_MS = 3000;
const GB = 1024 ** 3;

function round(value, digits) {
  if (!Number.isFinite(value)) return null;
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

function tempOrNull(temp) {
  // systeminformation reports -1 (or 0) when no sensor is exposed, which is common on Windows
  if (!temp || !Number.isFinite(temp.main) || temp.main <= 0) return null;
  return temp.main;
}

async function sample() {
  const [load, mem, temp] = await Promise.all([
    si.currentLoad(),
    si.mem(),
    si.cpuTemperature().catch(() => null),
  ]);

  const total = mem && Number.isFinite(mem.total) ? mem.total : NaN;
  // total - available excludes cache and other reclaimable memory, which is what Task Manager shows
  const used = mem && Number.isFinite(mem.total) && Number.isFinite(mem.available) ? mem.total - mem.available : NaN;

  return {
    cpuPercent: round(load && load.currentLoad, 0),
    ramPercent: round(total > 0 ? (used / total) * 100 : NaN, 0),
    ramUsedGB: round(used / GB, 1),
    ramTotalGB: round(total / GB, 1),
    uptimeSeconds: round(os.uptime(), 0),
    tempC: round(tempOrNull(temp), 0),
  };
}

function withTimeout(promise) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out reading system stats")), TIMEOUT_MS);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); }
    );
  });
}

let cache = null; // { at, value }
let inflight = null;

function getStats() {
  if (cache && Date.now() - cache.at < CACHE_MS) return Promise.resolve(cache.value);
  if (inflight) return inflight;
  inflight = withTimeout(sample())
    .then((value) => {
      cache = { at: Date.now(), value };
      return value;
    })
    .finally(() => { inflight = null; });
  return inflight;
}

module.exports = { getStats };
