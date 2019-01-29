const prepareIoredis = require('./prepare-ioredis.js');
prepareIoredis();

const IORedis = require('ioredis');
const lodash = require('lodash');

const { ReplyError } = require('redis-errors');
const { TimeoutError } = require('./errors');

const defaults = require('./defaults');

class Consumer {
  constructor(qname, workerFn, { consumerOptions, redisOptions, loggingOptions }) {
    this.QNAME = `${defaults.NAMESPACE}:${qname}`;
    this.GRPNAME = `${defaults.NAMESPACE}:${qname}:cg`;

    this.workerFn = workerFn;
    this.pendingTasks = [];
    this.totalTasks = 0;

    this.consumerOptions = lodash.merge({}, defaults.consumer, consumerOptions);
    this.redisOptions = lodash.merge({}, defaults.redis, redisOptions);
    this.loggingOptions = lodash.merge({}, defaults.logging, loggingOptions);

    this.redis = new IORedis(this.redisOptions);
    this.redis.on('connect', this.register.bind(this));
  }

  async createConsumerGroup() {
    try {
      // XGROUP CREATE mystream mygroup 0 MKSTREAM
      await this.redis.xgroup('CREATE', this.QNAME, this.GRPNAME, 0, 'MKSTREAM');
    } catch (e) {
      // BUSYGROUP -> the consumer group is already present, ignore
      if (!(e instanceof ReplyError && e.message.includes('BUSYGROUP'))) {
        throw e;
      }
    }
  }

  async register() {
    if (this.name) {
      // We already have a name? Reconnecting in this case
      await this.redis.client('SETNAME', this.name);
      return;
    }

    const id = await this.redis.client('id');
    this.name = this.GRPNAME + ':c:' + id; // TODO: Append a GUID just to be safe since we are reusing names upon client reconnect
    await this.redis.client('SETNAME', this.name);

    await this.createConsumerGroup();

    if (!this.loopStarted) {
      this.loopStarted = true;
      this.processLoop();
    }
  }

  async getPendingTasks() {
    console.log('🔍', this.name, ' :: Checking pending tasks');

    const taskObj = await this.redis.xreadgroup(
      'GROUP',
      this.GRPNAME,
      this.name,
      'COUNT',
      this.consumerOptions.taskBufferSize,
      'STREAMS',
      this.QNAME,
      '0'
    );
    const tasks = [].concat(...Object.values(taskObj));

    console.dir({ taskObj, tasks, pendingTasks: this.pendingTasks }, { depth: null });

    this.pendingTasks.push(...tasks);
  }

  async waitForTask() {
    console.log('📭 ', this.name, ` :: Waiting for tasks. Processed so far: ${this.totalTasks}`);

    await this.redis.xreadgroup('GROUP', this.GRPNAME, this.name, 'BLOCK', 0, 'COUNT', 1, 'STREAMS', this.QNAME, '>');

    console.log('🔔 ', this.name, ' :: Got new task!');
  }

  async cleanUp() {
    function difference(setA, setB) {
      var _difference = new Set(setA);
      for (var elem of setB) {
        _difference.delete(elem);
      }
      return _difference;
    }

    const info = await this.redis.xinfo('CONSUMERS', this.QNAME, this.GRPNAME);
    const consumerInfo = {};
    for (const inf of info) {
      const data = {};
      for (let i = 0; i < inf.length; i += 2) {
        data[inf[i]] = inf[i + 1];
      }
      consumerInfo[inf[1]] = data;
    }
    console.dir({ consumerInfo }, { depth: null });
    const consumerNames = Object.keys(consumerInfo);
    const pendingConsumerNames = new Set();
    const emptyConsumerNames = new Set();
    for (const con of consumerNames) {
      if (consumerInfo[con].pending) {
        pendingConsumerNames.add(con);
      } else {
        if (consumerInfo[con].idle > this.consumerOptions.workerFnTimeoutMs * 5) {
          // Just to be safe, only delete really world consumers
          emptyConsumerNames.add(con);
        }
      }
    }
    console.log({ pendingConsumerNames });

    const clients = (await this.redis.client('LIST')).split('\n');
    const activeWorkers = new Set();
    for (const cli of clients) {
      cli.split(' ').map(v => {
        if (v.startsWith('name=')) {
          const namePair = v.split('=');
          if (namePair.length > 1 && namePair[1].length) {
            activeWorkers.add(namePair[1]);
          }
        }
      });
    }

    console.log({ clients, activeWorkers });

    const orphanWorkers = difference(pendingConsumerNames, activeWorkers);
    const orphanEmptyWorkers = difference(emptyConsumerNames, activeWorkers);

    for (const w of orphanWorkers) {
      const pendingTasks = await this.redis.xpending(this.QNAME, this.GRPNAME, '-', '+', 1000, w);
      const ids = pendingTasks.map(t => t.id);
      const claim = await this.redis.xclaim(
        this.QNAME,
        this.GRPNAME,
        this.name,
        this.consumerOptions.workerFnTimeoutMs * 2,
        ...ids,
        'JUSTID'
      );
      console.log(`🤝 ${this.name} :: Claimed ${claim.length} pending tasks from worker ${w}`);
    }

    for (const w of orphanEmptyWorkers) {
      // TODO: Possible candidate for Lua scripting?
      // Check one more time that it has no pending tasks and then delete
      await this.redis.xgroup('DELCONSUMER', this.QNAME, this.GRPNAME, w);
      console.log(`🧹 ${this.name} :: Deleted old consumer ${w}`);
    }
  }

  async processLoop() {
    do {
      await this.cleanUp();
      await this.getPendingTasks();

      if (!this.pendingTasks.length) {
        await this.waitForTask();
      }

      while (this.pendingTasks.length) {
        await this.processTask();
      }
    } while (true);
  }

  async processTask() {
    if (!this.pendingTasks.length) {
      return;
    }

    const task = this.pendingTasks.shift();
    console.log(this.name, ' :: Staring to process task', task);
    this.totalTasks++;
    await this.wrapWorkerFn(task.id, task.data)
      .then(val => {
        // TODO: store returned result in a capped list
        console.log('✅ ', this.name, ` :: DONE!! Worker ${task.id} done working`, val);
        return this.redis.xack(this.QNAME, this.GRPNAME, task.id);
      })
      .catch(e => {
        if (e instanceof TimeoutError) {
          console.log('⏰ ', this.name, `:: Worker ${task.id} timed out`, e);
        } else {
          console.log('💣 ', this.name, ` :: Worker ${task.id} crashed`, e);
        }

        // FIXME: Temporarily removing from the queue
        // TODO: store error in a capped list or
        // TODO: retry until retry limit, move to retry queue
        return this.redis.xack(this.QNAME, this.GRPNAME, task.id);
      });
  }

  wrapWorkerFn(taskId, taskData) {
    const timeoutP = new Promise((resolve, reject) => {
      const to = setTimeout(() => {
        clearTimeout(to);
        reject(new TimeoutError());
      }, this.consumerOptions.workerFnTimeoutMs);
    });

    const workerP = Promise.resolve(this.workerFn(taskId, taskData));

    return Promise.race([timeoutP, workerP]);
  }

  pause() {
    // TODO: Implement
  }

  resume() {
    // TODO: Implement
  }
}

module.exports = Consumer;
