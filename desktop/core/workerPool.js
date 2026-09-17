// ═══════════════════════════════════════════════════════════════
//  workerPool.js — Worker 并行调度池（ES Module）
//  4 Worker 并行，背压控制
// ═══════════════════════════════════════════════════════════════

export class WorkerPool {
  constructor(workerUrl, size = 4) {
    this.size = size;
    this.workers = [];
    this.queue = [];
    this.idle = [];
    this.callbacks = new Map();
    this._activeCount = 0;

    for (let i = 0; i < size; i++) {
      const w = new Worker(workerUrl);
      w.onmessage = (e) => this._done(w, e);
      w.onerror = (err) => this._error(w, err);
      this.workers.push(w);
      this.idle.push(w);
    }
  }

  run(task) {
    return new Promise((resolve, reject) => {
      this.queue.push({ task, resolve, reject });
      // 背压控制
      if (this.queue.length > 50) {
        this.queue = this.queue.slice(-50);
      }
      this._dispatch();
    });
  }

  _dispatch() {
    while (this.queue.length > 0 && this.idle.length > 0) {
      const w = this.idle.pop();
      const job = this.queue.shift();
      this.callbacks.set(w, job);
      this._activeCount++;
      w.postMessage(job.task);
    }
  }

  _done(w, e) {
    const job = this.callbacks.get(w);
    this.callbacks.delete(w);
    this.idle.push(w);
    this._activeCount--;
    if (job) job.resolve(e.data);
    this._dispatch();
  }

  _error(w, err) {
    const job = this.callbacks.get(w);
    this.callbacks.delete(w);
    this.idle.push(w);
    this._activeCount--;
    if (job) job.reject(err);
    this._dispatch();
  }

  get activeCount() { return this._activeCount; }

  terminate() {
    this.workers.forEach(w => w.terminate());
    this.workers = [];
    this.idle = [];
    this.queue = [];
    this.callbacks.clear();
    this._activeCount = 0;
  }
}
