'use strict';

const { createApplication } = require('../src/app');

const { app } = createApplication({
  dbFile: '/tmp/wifiwatch-data-history.json',
  publicDir: null,
  routerIp: process.env.ROUTER_IP || '192.168.0.1',
  routerPassword: '',
  allowPrivateRouterSync: false
});

module.exports = app;
