/**
 * turns.js — Serial turn queue for a single browser peer.
 *
 * A claude.ai conversation can only be doing one thing at a time: you cannot
 * type a second prompt while the first is still streaming. This queue enforces
 * that per peer while letting the hub accept messages for it at any rate.
 *
 * Callers get a promise per turn, so a blocking ask() still resolves with the
 * right reply even when the turn sat in a queue first. Peers run independently
 * of one another — the serialization is per instance, not global.
 *
 * Used by: src/browser/relay.js
 */

const { EventEmitter } = require('events');

class TurnQueue extends EventEmitter {
  /**
   * @param {object} options
   * @param {Function} options.onCancelRunning - Abort whatever is in flight.
   */
  constructor({ onCancelRunning } = {}) {
    super();
    this.pending = [];
    this.running = null;
    this.onCancelRunning = onCancelRunning || (() => {});
    this.state = 'idle'; // idle | running
  }

  /** Queued turns plus the one in flight. */
  get depth() {
    return this.pending.length + (this.running ? 1 : 0);
  }

  /**
   * Add a turn. `run` is an async function executed when the peer is free.
   * Resolves or rejects with that function's outcome.
   */
  enqueue({ id, run, meta = {} }) {
    return new Promise((resolve, reject) => {
      this.pending.push({ id, run, meta, resolve, reject });
      this.emit('queued', { id, meta, depth: this.depth });
      this._drain();
    });
  }

  /** Start the next turn if nothing is currently running. */
  async _drain() {
    if (this.running || !this.pending.length) return;

    const turn = this.pending.shift();
    this.running = turn;
    this.state = 'running';
    this.emit('started', { id: turn.id, meta: turn.meta });

    try {
      const result = await turn.run();
      turn.resolve(result);
      this.emit('finished', { id: turn.id, meta: turn.meta, result });
    } catch (error) {
      turn.reject(error);
      this.emit('failed', { id: turn.id, meta: turn.meta, error });
    } finally {
      this.running = null;
      this.state = this.pending.length ? 'running' : 'idle';
      this._drain();
    }
  }

  /**
   * Abort the in-flight turn and discard everything queued behind it.
   * Returns how many turns were dropped, including the running one.
   */
  cancelAll(reason = 'cancelled') {
    const dropped = this.depth;

    for (const turn of this.pending) {
      turn.reject(new Error(reason));
      this.emit('cancelled', { id: turn.id, meta: turn.meta });
    }
    this.pending = [];

    if (this.running) {
      // The running turn rejects through its own error path once the page
      // acknowledges the abort; this only signals it.
      this.onCancelRunning(reason);
      this.emit('cancelled', { id: this.running.id, meta: this.running.meta });
    }

    return dropped;
  }
}

module.exports = { TurnQueue };
