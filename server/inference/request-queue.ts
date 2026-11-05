interface PendingRequest { start(): void; }

/** Limits inference requests only; simulation tool waits never occupy a slot. */
export class RequestQueue {
  private active = 0;
  private pending: PendingRequest[] = [];
  constructor(private parallel = true) {}

  setParallel(enabled: boolean) { this.parallel = enabled; this.drain(); }

  run<T>(request: () => Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      signal.throwIfAborted();
      const cancel = () => {
        const index = this.pending.indexOf(entry);
        if (index < 0) return;
        this.pending.splice(index, 1);
        signal.removeEventListener('abort', cancel);
        reject(signal.reason);
        this.drain();
      };
      const finish = () => { this.active--; this.drain(); };
      const entry: PendingRequest = {
        start: () => {
          signal.removeEventListener('abort', cancel);
          this.active++;
          try {
            request().then(value => { finish(); resolve(value); }, error => { finish(); reject(error); });
          } catch (error) { finish(); reject(error); }
        },
      };
      signal.addEventListener('abort', cancel, { once: true });
      this.pending.push(entry);
      this.drain();
    });
  }

  private drain() {
    while (this.pending.length && (this.parallel || this.active === 0)) this.pending.shift()!.start();
  }
}
