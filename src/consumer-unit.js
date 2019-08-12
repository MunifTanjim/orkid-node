const IORedis = require('ioredis');
const lodash = require('lodash');
const shortid = require('shortid');

const { ReplyError } = require('redis-errors');
const initScripts = require('./commands');
const { waitUntilInitialized, parseStreamResponse, parseXPendingResponse } = require('./common');
const Task = require('./task');
const { TimeoutError } = require('./errors');

const defaults = require('./defaults');

class ConsumerUnit {
  constructor(qname, workerFn, { consumerOptions, redisOptions, redisClient, loggingOptions } = {}) {
    this._paused = true;

    this._QNAME = `${defaults.NAMESPACE}:queue:${qname}`;
    this._DEDUPSET = `${defaults.NAMESPACE}:queue:${qname}:dedupset`;
    this.qname = qname;
    this._GRPNAME = `${defaults.NAMESPACE}:queue:${qname}:cg`;

    this.workerFn = workerFn;
    this._pendingTasks = [];
    this._totalTasks = 0;

    this.consumerOptions = lodash.merge({}, defaults.consumerOptions, consumerOptions);
    this.loggingOptions = lodash.merge({}, defaults.loggingOptions, loggingOptions);

    if (redisClient) {
      this._redis = redisClient.duplicate();
    } else {
      this.redisOptions = lodash.merge({}, defaults.redisOptions, redisOptions);
      this._redis = new IORedis(this.redisOptions);
    }

    this._initialize();
  }

  start() {
    waitUntilInitialized(this, '_isInitialized').then(() => {
      this._paused = false;
      this._processLoop();
    });
  }

  pause() {
    // TODO: Update globally `${orkidDefaults.NAMESPACE}:queue:${this.qname}:settings`
    // Also inform other queues via pub/sub
    this._paused = true;
  }

  resume() {
    this.start();
  }

  _log(...msg) {
    if (this.loggingOptions.enabled) {
      this.loggingOptions.loggerFn(`Orkid :: ${this._name}`, ...msg);
    }
  }

  async _ensureConsumerGroupExists() {
    try {
      // XGROUP CREATE mystream mygroup 0 MKSTREAM
      this._log('Ensuring consumer group exists', { QNAME: this._QNAME, GRPNAME: this._GRPNAME });

      // xgroup: https://redis.io/commands/xgroup
      await this._redis.xgroup('CREATE', this._QNAME, this._GRPNAME, 0, 'MKSTREAM');
    } catch (e) {
      // BUSYGROUP -> the consumer group is already present, ignore
      if (!(e instanceof ReplyError && e.message.includes('BUSYGROUP'))) {
        throw e;
      }
    }
  }

  async _initialize() {
    if (this._name) {
      // We already have a name? Reconnecting in this case
      // https://redis.io/commands/client-setname
      await this._redis.client('SETNAME', this._name);
      return;
    }

    await initScripts(this._redis);

    const id = await this._redis.client('id');
    this._name = `${this._GRPNAME}:c:${id}-${shortid.generate()}`;
    await this._redis.client('SETNAME', this._name);

    await this._ensureConsumerGroupExists();

    this._isInitialized = true;
  }

  async _getPendingTasks() {
    this._log('Checking pending tasks');

    // xreadgroup: https://redis.io/commands/xreadgroup
    const redisReply = await this._redis.xreadgroup(
      'GROUP',
      this._GRPNAME,
      this._name,
      'COUNT',
      this.consumerOptions.taskBufferSize,
      'STREAMS',
      this._QNAME,
      '0'
    );

    const taskObj = parseStreamResponse(redisReply);
    const tasks = [].concat(...Object.values(taskObj));

    for (const t of tasks) {
      const task = new Task(t.id, t.data);
      this._pendingTasks.push(task);
    }

    // Used for testing
    return tasks.length;
  }

  async _waitForTask() {
    this._log(`Waiting for tasks. Processed so far: ${this._totalTasks}`);

    // xreadgroup: https://redis.io/commands/xreadgroup
    await this._redis.xreadgroup(
      'GROUP',
      this._GRPNAME,
      this._name,
      'BLOCK',
      0,
      'COUNT',
      1,
      'STREAMS',
      this._QNAME,
      '>'
    );

    this._log('Got new task');
  }

  /*
    Cleanup does the following things:
    - Get list of all consumers in current group
    - Find out which consumers are not active anymore in redis but have tasks
    - Find out which consumers are not active anymore in redis and empty
    - Claim ownership of tasks from inactive and non-empty consumers to process
    - Delete inactive and empty consumers to keep things tidy
  */
  async _cleanUp() {
    /* Returns items that are present in setA but not in setB */
    function difference(setA, setB) {
      const _difference = new Set(setA);
      for (const elem of setB) {
        _difference.delete(elem);
      }
      return _difference;
    }

    // xinfo: https://redis.io/commands/xinfo
    // Get the list of every consumer in a specific consumer group
    const info = await this._redis.xinfo('CONSUMERS', this._QNAME, this._GRPNAME);
    const consumerInfo = {};
    for (const inf of info) {
      const data = {};
      for (let i = 0; i < inf.length; i += 2) {
        data[inf[i]] = inf[i + 1];
      }
      consumerInfo[inf[1]] = data;
    }

    const consumerNames = Object.keys(consumerInfo);
    const pendingConsumerNames = new Set();
    const emptyConsumerNames = new Set();

    // Separate consumers with some pending tasks and no pending tasks
    for (const con of consumerNames) {
      if (consumerInfo[con].pending) {
        pendingConsumerNames.add(con);
      } else if (consumerInfo[con].idle > this.consumerOptions.workerFnTimeoutMs * 5) {
        // Just to be safe, only delete really old consumers
        emptyConsumerNames.add(con);
      }
    }

    // https://redis.io/commands/client-list
    const clients = (await this._redis.client('LIST')).split('\n');
    const activeWorkers = new Set();

    // Orkid consumers always set a name to redis connection
    // Filter active connections those have names
    for (const cli of clients) {
      const values = cli.split(' ');
      for (const v of values) {
        if (v.startsWith('name=')) {
          const namePair = v.split('=');
          if (namePair.length > 1 && namePair[1].length) {
            activeWorkers.add(namePair[1]);
          }
        }
      }
    }

    // Workers that have pending tasks but are not active anymore in redis
    const orphanWorkers = difference(pendingConsumerNames, activeWorkers);

    // Workers that have not pending tasks and also  are not active anymore in redis
    const orphanEmptyWorkers = difference(emptyConsumerNames, activeWorkers);

    const claimInfo = {};
    for (const w of orphanWorkers) {
      // xpending: https://redis.io/commands/xpending
      const redisXPendingReply = await this._redis.xpending(this._QNAME, this._GRPNAME, '-', '+', 1000, w);
      const pendingTasks = parseXPendingResponse(redisXPendingReply);

      const ids = pendingTasks.map(t => t.id);

      // xclaim: https://redis.io/commands/xclaim
      const claim = await this._redis.xclaim(
        this._QNAME,
        this._GRPNAME,
        this._name,
        this.consumerOptions.workerFnTimeoutMs * 2,
        ...ids,
        'JUSTID'
      );

      claimInfo[w] = claim.length;
      this._log(`Claimed ${claim.length} pending tasks from worker ${w}`);
    }

    // Housecleaning. Remove empty and inactive consumers since redis doesn't do that itself
    const deleteInfo = [];
    for (const w of orphanEmptyWorkers) {
      // Our custom lua script to recheck and delete consumer atomically and safely
      await this._redis.delconsumer(this._QNAME, this._GRPNAME, w);
      deleteInfo.push(w);
      this._log(`Deleted old consumer ${w}`);
    }

    // Return value used for testing
    const retval = {
      consumerNames,
      pendingConsumerNames: Array.from(pendingConsumerNames),
      emptyConsumerNames: Array.from(emptyConsumerNames),
      activeWorkers: Array.from(activeWorkers),
      orphanWorkers: Array.from(orphanWorkers),
      orphanEmptyWorkers: Array.from(orphanEmptyWorkers),
      claimInfo,
      deleteInfo
    };

    this._log(`Cleanup result:`, retval);

    return retval;
  }

  async _processLoop() {
    if (this._loopStarted) {
      return;
    }

    this._loopStarted = true;

    while (!this._paused) {
      await this._cleanUp();
      await this._getPendingTasks();

      if (!this._pendingTasks.length) {
        await this._waitForTask();
      }

      while (this._pendingTasks.length && !this._paused) {
        await this._processTask();
      }
    }

    this._loopStarted = false;
  }

  async _processTask() {
    if (!this._pendingTasks.length) {
      return;
    }

    const task = this._pendingTasks.shift();
    this._log('Starting to process task', task);
    this._totalTasks++;

    // TODO: Update queue specific total processed stat
    await this._redis.hincrby(defaults.STAT, 'processed', 1);

    const metadata = { id: task.id, qname: this.qname, retryCount: task.retryCount, consumerName: this._name };
    try {
      const result = await this._wrapWorkerFn(task.dataObj, metadata);
      await this._processSuccess(task, result);
    } catch (e) {
      if (e instanceof TimeoutError) {
        this._log(`Worker ${task.id} timed out`, e);
      } else {
        this._log(`Worker ${task.id} crashed`, e);
      }

      await this._processFailure(task, e);
    }
  }

  async _processSuccess(task, result) {
    this._log(`Worker ${task.id} returned`, result);

    const resultVal = JSON.stringify({
      id: task.id,
      qname: this.qname,
      data: task.dataObj,
      dedupKey: task.dedupKey,
      retryCount: task.retryCount,
      result,
      at: new Date().toISOString()
    });

    // Add to success list
    await this._redis
      .pipeline()
      .dequeue(this._QNAME, this._DEDUPSET, this._GRPNAME, task.id, task.dedupKey) // Remove from queue
      .lpush(defaults.RESULTLIST, resultVal)
      .ltrim(defaults.RESULTLIST, 0, defaults.queueOptions.maxResultListSize - 1)
      .exec();
  }

  async _processFailure(task, error) {
    const info = JSON.stringify({
      id: task.id,
      qname: this.qname,
      data: task.dataObj,
      dedupKey: task.dedupKey,
      retryCount: task.retryCount,
      error: {
        name: error.name,
        message: error.message,
        stack: error.stack
      },
      at: new Date().toISOString()
    });

    if (task.retryCount < this.consumerOptions.maxRetry) {
      task.incrRetry();
      // Send again to the queue
      await this._redis
        .pipeline()
        .requeue(this._QNAME, this._DEDUPSET, this._GRPNAME, task.id, task.dataString, task.dedupKey, task.retryCount)
        .hincrby(defaults.STAT, 'retries', 1)
        .exec();
      // TODO: Update queue specific total retries stat
    } else {
      // Move to deadlist
      await this._redis
        .pipeline()
        .dequeue(this._QNAME, this._DEDUPSET, this._GRPNAME, task.id, task.dedupKey) // Remove from queue
        .lpush(defaults.DEADLIST, info)
        .ltrim(defaults.DEADLIST, 0, defaults.queueOptions.maxDeadListSize - 1)
        .hincrby(defaults.STAT, 'dead', 1)
        .exec();
      // TODO: Update queue specific total dead stat
    }

    // Add to failed list in all cases
    await this._redis
      .pipeline()
      .lpush(defaults.FAILEDLIST, info)
      .ltrim(defaults.FAILEDLIST, 0, defaults.queueOptions.maxFailedListSize - 1)
      .hincrby(defaults.STAT, 'failed', 1)
      .exec();
    // TODO: Update queue specific total failed stat
  }

  _wrapWorkerFn(data, metadata) {
    const timeoutMs = this.consumerOptions.workerFnTimeoutMs;
    const timeoutP = new Promise((resolve, reject) => {
      const to = setTimeout(() => {
        clearTimeout(to);
        reject(new TimeoutError(`Task timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });

    const workerP = this.workerFn(data, metadata);

    return Promise.race([timeoutP, workerP]);
  }

  async _disconnect() {
    this._paused = true;
    await waitUntilInitialized(this, '_isInitialized');
    await this._redis.disconnect();
  }
}

module.exports = ConsumerUnit;
