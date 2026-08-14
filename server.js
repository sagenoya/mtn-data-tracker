'use strict';

const path = require('path');
const { createApplication } = require('./src/app');
const { createCollectorScheduler } = require('./src/services/scheduler');

const port = Number(process.env.PORT || 3000);
const routerIp = process.env.ROUTER_IP || '192.168.0.1';
const routerPassword = process.env.ROUTER_PASSWORD || '';
const intervalMinutes = Math.max(1, Number(process.env.AUTO_SYNC_INTERVAL_MINUTES || 5));

const { app, syncService } = createApplication({
  dbFile: path.join(__dirname, 'data_history.json'),
  routerIp,
  routerPassword
});

const scheduler = createCollectorScheduler({
  syncService,
  routerIp,
  password: routerPassword,
  intervalMs: intervalMinutes * 60 * 1000
});

function listen(requestedPort) {
  const server = app.listen(requestedPort, () => {
    console.log(`WiFiWatch local service running on http://localhost:${requestedPort}`);
    console.log(`Collector scheduler: ${scheduler.enabled ? `enabled every ${intervalMinutes} minute(s)` : 'disabled (set ROUTER_PASSWORD to enable)'}`);
    scheduler.start();
  });

  server.on('error', error => {
    if (error.code === 'EADDRINUSE') {
      console.error(`Port ${requestedPort} is already in use. Stop the existing WiFiWatch service or set PORT to another port; refusing to start a second service against the same JSON store.`);
      process.exitCode = 1;
      return;
    }
    throw error;
  });
  return server;
}

listen(port);
