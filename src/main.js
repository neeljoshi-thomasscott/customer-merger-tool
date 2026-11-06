// Production entry point (Railway): runs the dashboard AND the automatic merger in one process.
// Both share one data folder on one Railway Volume, which is why they must be one service.

import { config } from './config.js';

if (config.onRailway && !config.hasRailwayVolume && !process.env.DATA_DIR) {
  const msg = 'No Railway Volume is attached. Without it, the record of points already moved is wiped on '
    + 'every redeploy, which could move points twice. Attach a Volume (mount path /data) to this service.';
  if (!config.dryRun) {
    console.error(`STOPPED: ${msg}`);
    process.exit(1);
  }
  console.warn(`WARNING (practice mode only): ${msg}`);
}

console.log(`Data folder: ${config.dataDir}`);
await import('./server.js');   // dashboard + /health for Railway
await import('./run.js');      // automatic merge after new orders + points after delivery
