import { Repeater } from '@repeaterjs/repeater';
/**
 * @internal
 */
export class Consolidator extends Repeater {
  constructor(asyncIterables, processor = (value) => value) {
    super(async (push, stop) => {
      this._push = push;
      this._stop = stop;
      this._started = true;
      // eslint-disable-next-line @typescript-eslint/no-floating-promises
      stop.then(() => {
        this._stopped = true;
        for (const advance of this._advances.values()) {
          advance();
        }
      });
      // eslint-disable-next-line no-constant-condition
      while (true) {
        while (this._asyncIterators.size > 0) {
          const promises = [];
          for (const asyncIterator of this._asyncIterators) {
            promises.push(this._addAsyncIterator(asyncIterator));
          }
          // eslint-disable-next-line no-await-in-loop
          await Promise.all(promises);
        }
        if (this._closed) {
          stop();
          return this._finalIteration?.value;
        }
        // eslint-disable-next-line no-await-in-loop
        await this._signal;
        this._signal = this._resetSignal();
      }
    });
    this._processor = processor;
    this._asyncIterators = new Set();
    if (asyncIterables) {
      for (const asyncIterable of asyncIterables) {
        this._asyncIterators.add(asyncIterable[Symbol.asyncIterator]());
      }
    }
    this._started = false;
    this._stopped = false;
    this._closed = false;
    this._advances = new Map();
    this._signal = this._resetSignal();
  }
  _resetSignal() {
    return new Promise((resolve) => {
      this._trigger = resolve;
    });
  }
  close() {
    this._closed = true;
    if (this._started) {
      this._trigger();
    }
  }
  add(value) {
    if (this._closed) {
      return;
    }
    this._asyncIterators.add(value[Symbol.asyncIterator]());
    if (this._started) {
      this._trigger();
    }
  }
  async _addAsyncIterator(asyncIterator) {
    try {
      while (!this._stopped) {
        asyncIterator.next().then(
          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
          (iteration) => this._advances.get(asyncIterator)(iteration),
          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
          (err) => this._stop(err),
        );
        const iteration =
          // eslint-disable-next-line no-await-in-loop
          await new Promise((resolve) =>
            this._advances.set(asyncIterator, resolve),
          );
        if (iteration !== undefined) {
          if (iteration.done) {
            this._finalIteration = iteration;
            return;
          }
          const processed = this._processor(iteration.value);
          if (processed !== undefined) {
            // eslint-disable-next-line no-await-in-loop, @typescript-eslint/no-non-null-assertion
            await this._push(processed);
          }
        }
      }
    } finally {
      this._advances.delete(asyncIterator);
      this._asyncIterators.delete(asyncIterator);
      if (this._closed && this._asyncIterators.size === 0) {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        this._stop();
      }
      await asyncIterator.return?.();
    }
  }
}
