module.exports = {
  NAMESPACE: 'orkid',
  redis: {},
  producer: {
    deduplicate: false
  },
  consumer: {
    workerFnTimeoutMs: 7 * 24 * 60 * 60 * 1000,
    taskBufferSize: 10,
    maxRetry: 0
  },
  logging: {
    enabled: true,
    loggerFn: console.log
  }
};
