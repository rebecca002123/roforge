'use strict';

// Is Roblox Studio actually open?
//
// The plugin bridge only tells us whether *the plugin* is talking to us. That
// leaves the most confusing case invisible: Studio wide open on the other
// monitor while the app insists "Studio offline". Watching the process closes
// that gap, so the UI can say "Studio is open but the plugin isn't loaded —
// restart it" instead of implying Studio isn't running.

const { execFile } = require('child_process');

const STUDIO_PROCESS = /roblox\s*studio/i;
const CACHE_MS = 4000;

let cached = { running: false, at: 0 };
let inFlight = null;

function queryTaskList() {
  return new Promise((resolve) => {
    // /NH drops the header rows; CSV keeps names quoted and easy to scan.
    execFile('tasklist', ['/FO', 'CSV', '/NH'], { windowsHide: true, timeout: 5000 }, (err, stdout) => {
      if (err) return resolve(null); // non-Windows, or tasklist unavailable
      resolve(STUDIO_PROCESS.test(stdout));
    });
  });
}

/**
 * Cached so a 4-second UI poll doesn't spawn a process every tick. Returns the
 * last known answer while a query is in flight rather than piling up calls.
 */
async function isStudioRunning() {
  if (process.platform !== 'win32') return false;
  if (Date.now() - cached.at < CACHE_MS) return cached.running;
  if (inFlight) return cached.running;

  inFlight = queryTaskList();
  const result = await inFlight;
  inFlight = null;
  if (result !== null) cached = { running: result, at: Date.now() };
  else cached = { running: false, at: Date.now() };
  return cached.running;
}

module.exports = { isStudioRunning };
