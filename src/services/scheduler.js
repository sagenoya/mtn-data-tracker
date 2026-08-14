'use strict';

function createCollectorScheduler({
  syncService,
  routerIp,
  password,
  intervalMs = 5 * 60 * 1000,
  collectorId = 'auto',
  logger = console
}) {
  let timer = null;
  let running = false;

  async function run(reason) {
    if (running) return;
    running = true;
    try {
      const result = await syncService.sync({ collectorId, routerIp, password });
      logger.log(`[AUTO-SYNC] ${reason} collection completed (${result.counterStatus}).`);
    } catch (error) {
      logger.log(`[AUTO-SYNC] ${reason} collection: ${error.message}`);
    } finally {
      running = false;
    }
  }

  return {
    enabled: Boolean(password),
    start() {
      if (!password || timer) return false;
      void run('startup');
      timer = setInterval(() => void run('scheduled'), intervalMs);
      return true;
    },
    stop() {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    },
    run
  };
}

module.exports = {
  createCollectorScheduler
};
