/**
 * comms.js — Backlog Champions SIH 2026 PS26178
 * Virtual wireless link simulator between Node A and Node B.
 * Models: packet loss, ACK delay jitter, retries, heartbeats.
 */

'use strict';

export class CommsLink {
  constructor() {
    this._seq = 0;
    this.lossRate = 0;          // 0–1 probability of packet drop
    this.delayMs = 120;         // base one-way latency (ms)
    this.jitterMs = 40;
    this.delayedAck = false;    // adds extra 2000–5000 ms ACK delay
    this.maxRetries = 3;
    this._queue = [];           // pending tx callbacks
    this.health = 1.0;          // 0–1 link quality (derived)
  }

  reset() {
    this._seq = 0;
    this._queue = [];
    this.lossRate = 0;
    this.delayMs = 120;
    this.delayedAck = false;
    this.health = 1.0;
  }

  nextSeq() {
    return ++this._seq;
  }

  /**
   * Send a packet with retry logic.
   * callback(delivered: bool, latencyMs: number, retries: number)
   */
  send(packet, callback) {
    this._attemptSend(packet, 0, 0, callback);
  }

  _attemptSend(packet, attempt, accLatency, callback) {
    const loss = Math.random() < this.lossRate;
    const oneWay = this.delayMs + (Math.random() - 0.5) * this.jitterMs * 2;
    const ackDelay = this.delayedAck ? 2000 + Math.random() * 3000 : 0;
    const totalLatency = accLatency + oneWay * 2 + ackDelay;

    const id = setTimeout(() => {
      if (loss) {
        // Packet lost – retry?
        if (attempt < this.maxRetries) {
          this._attemptSend(packet, attempt + 1, totalLatency, callback);
        } else {
          callback(false, totalLatency, attempt);
        }
      } else {
        callback(true, totalLatency, attempt);
      }
      this._queue = this._queue.filter(x => x !== id);
      this._updateHealth();
    }, Math.max(50, oneWay + ackDelay));

    this._queue.push(id);
    this._updateHealth();
  }

  _updateHealth() {
    this.health = Math.max(0, 1 - this.lossRate * 1.5 - (this.delayedAck ? 0.3 : 0));
  }

  setLossRate(v) {
    this.lossRate = Math.max(0, Math.min(1, v));
    this._updateHealth();
  }

  setDelayedAck(v) {
    this.delayedAck = v;
    this._updateHealth();
  }

  /** Cancel all pending timers (called on reset) */
  cancelAll() {
    this._queue.forEach(id => clearTimeout(id));
    this._queue = [];
  }
}
