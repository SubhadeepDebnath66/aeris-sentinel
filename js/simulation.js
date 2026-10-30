/**
 * simulation.js — Backlog Champions SIH 2026 PS26178
 * Pure simulation logic. No DOM access. No side-effects beyond state mutation.
 *
 * State machines:
 *   Node A: IDLE → MONITORING → CONFIRMING → DANGER → RECOVERY_PENDING → RECOVERED
 *   Node B: IDLE → STANDBY → ACTUATING → PEER_FAULT | RECOVERY_PENDING → RECOVERED
 */

'use strict';

// ─── Configuration (all adjustable) ──────────────────────────────────────────
export const CONFIG = {
  // Confirmation window: need CONFIRM_NEEDED consecutive above-threshold readings
  // within a rolling window of CONFIRM_WINDOW samples
  CONFIRM_NEEDED: 5,
  CONFIRM_WINDOW: 8,

  // Hysteresis: must have RECOVER_NEEDED consecutive below-threshold readings
  RECOVER_NEEDED: 6,

  // Sensor thresholds (simulated units, NOT real field values)
  SLOPE_THRESHOLD: 70,   // mm simulated displacement
  WATER_THRESHOLD: 60,   // % simulated moisture

  // Peer heartbeat timeout (simulation ticks)
  PEER_TIMEOUT_TICKS: 30,

  // Node B uses the same confirmation discipline as Node A for local water hazard.
  WATER_CONFIRM_NEEDED: 5,

  // Tick rate in ms (set externally by runner)
  TICK_MS: 200,
};

// ─── Node states ─────────────────────────────────────────────────────────────
export const NodeAState = Object.freeze({
  IDLE:             'IDLE',
  MONITORING:       'MONITORING',
  CONFIRMING:       'CONFIRMING',
  DANGER:           'DANGER',
  RECOVERY_PENDING: 'RECOVERY_PENDING',
  RECOVERED:        'RECOVERED',
  SENSOR_FAULT:     'SENSOR_FAULT',
});

export const NodeBState = Object.freeze({
  IDLE:             'IDLE',
  STANDBY:          'STANDBY',
  ACTUATING:        'ACTUATING',
  PEER_FAULT:       'PEER_FAULT',
  RECOVERY_PENDING: 'RECOVERY_PENDING',
  READY_TO_REOPEN:  'READY_TO_REOPEN',
  RECOVERED:        'RECOVERED',
  SENSOR_FAULT:     'SENSOR_FAULT',
});

export const ZoneStatus = Object.freeze({
  NORMAL:    'NORMAL',
  EVACUATE:  'EVACUATE',
  CLEARED:   'CLEARED',
  READY_TO_REOPEN: 'READY_TO_REOPEN',
  SAFE:      'SAFE',   // permanent – never changes
});

// ─── Initial state factory ────────────────────────────────────────────────────
function makeNodeA() {
  return {
    state: NodeAState.IDLE,
    sensorRaw: 0,         // raw simulated value (mm displacement)
    sensorDisplay: 0,     // displayed value (with noise)
    confirmBuffer: [],    // rolling window of boolean (above/below threshold)
    aboveCount: 0,        // above-threshold count in buffer
    belowStreak: 0,       // consecutive below-threshold count (for recovery)
    buzzer: false,
    led: false,
    noisy: false,
    sensorConnected: true,
    _spikeNext: false,
    _rampActive: false,
    _rampValue: 0,
  };
}

function makeNodeB() {
  return {
    state: NodeBState.IDLE,
    sensorRaw: 0,         // simulated water-contact %
    sensorDisplay: 0,
    waterAbove: false,
    waterConfirmCount: 0,
    waterBelowStreak: 0,
    relay1: false,        // Channel 1 – evacuation siren power
    relay2: false,        // Channel 2 – barrier actuator
    fan: false,
    lamp: false,
    buzzer: false,
    zoneLedUpstream: false,
    zoneLedDownstream: false,
    peerHeartbeatTimer: 0,
    peerConnected: true,
    lastMsgSeq: -1,
    lastMsgType: null,
    upstreamCleared: false,
    humanConfirmReceived: false,
    _waterActive: false,
    sensorConnected: true,
  };
}

function makeZones() {
  return {
    upstream:   { status: ZoneStatus.NORMAL,   label: 'Upstream Zone A' },
    downstream: { status: ZoneStatus.NORMAL,   label: 'Downstream Zone B' },
    safe:       { status: ZoneStatus.SAFE,     label: 'Safe Zone C' },
  };
}

function makeMetrics() {
  return {
    txPackets: 0,
    rxPackets: 0,
    ackCount: 0,
    retries: 0,
    droppedPackets: 0,
    relayActivations: 0,
    falseTripCount: 0,
    latencyMs: 0,
    latencyAvg: 0,
    latencySamples: 0,
    transitionCount: 0,
    relayStateChanges: 0,
  };
}

// ─── Simulation class ─────────────────────────────────────────────────────────
export class Simulation {
  constructor(options = {}) {
    this.seed = Number.isInteger(options.seed) ? options.seed >>> 0 : null;
    this._rngState = this.seed;
    this.running = false;
    this.tick = 0;
    this.nodeA = makeNodeA();
    this.nodeB = makeNodeB();
    this.zones = makeZones();
    this.metrics = makeMetrics();
    this.timeline = [];            // [{tick, ts, event, detail}]
    this.comms = null;             // injected externally
    this._pendingHumanConfirm = false;
    this._powerInterruptA = 0;     // ticks remaining for Node A power cut
    this._powerInterruptB = 0;     // ticks remaining for Node B power cut
    this._peerDisconnected = false;
  }

  /** Deterministic sensor noise for proof runs; normal UI runs remain random. */
  _random() {
    if (this._rngState === null) return Math.random();
    this._rngState = (1664525 * this._rngState + 1013904223) >>> 0;
    return this._rngState / 0x100000000;
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  start() {
    if (this.nodeA.state === NodeAState.IDLE) {
      this._transitionA(NodeAState.MONITORING, 'System started – monitoring slope');
      this._transitionB(NodeBState.STANDBY, 'Node B online – awaiting Node A');
    }
    this.running = true;
  }

  pause() {
    this.running = false;
  }

  reset() {
    this.running = false;
    this.tick = 0;
    this._rngState = this.seed;
    this.nodeA = makeNodeA();
    this.nodeB = makeNodeB();
    this.zones = makeZones();
    this.metrics = makeMetrics();
    this.timeline = [];
    this._pendingHumanConfirm = false;
    this._powerInterruptA = 0;
    this._powerInterruptB = 0;
    this._peerDisconnected = false;
    if (this.comms) this.comms.reset();
    this._log('System reset to IDLE', '');
  }

  /** Ramp slope sensor above threshold over next ~10 ticks */
  injectSlopeEvent() {
    if (!this.running) return;
    this.nodeA._rampActive = true;
    this.nodeA._rampValue = CONFIG.SLOPE_THRESHOLD - 10;
    this._log('⚡ Slope event injected', 'Sensor value will ramp above threshold');
  }

  /** Set water sensor high on Node B */
  injectWaterContact() {
    if (!this.running) return;
    this.nodeB._waterActive = true;
    this._log('💧 Water-contact event injected', 'Node B moisture sensor rising');
  }

  /** Single sample spike – should NOT trigger confirmation */
  injectSensorSpike() {
    if (!this.running) return;
    this.nodeA._spikeNext = true;
    this._log('⚡ Sensor spike injected', 'One-shot spike – confirmation window must absorb this');
  }

  /** Toggle noisy readings on Node A */
  setNoisy(val) {
    this.nodeA.noisy = val;
    this._log(val ? '〜 Noisy readings ON' : '〜 Noisy readings OFF', '');
  }

  /** Simulate a disconnected sensor. Faults latch until Reset. */
  setSensorConnected(node, connected) {
    const target = node === 'A' ? this.nodeA : this.nodeB;
    target.sensorConnected = Boolean(connected);
    this._log(`Sensor ${node}: ${connected ? 'connected' : 'disconnected'}`,
      connected ? 'Readings restored; reset is required to clear a latched fault' : 'Explicit SENSOR_FAULT; no safe reading substituted');
  }

  /** Power interrupt: freeze node for given seconds */
  powerInterrupt(node, seconds) {
    const ticks = Math.round(seconds * 1000 / CONFIG.TICK_MS);
    if (node === 'A') {
      this._powerInterruptA = ticks;
      this._log(`🔌 Power interrupt: Node A (~${seconds}s)`, '');
    } else {
      this._powerInterruptB = ticks;
      this._log(`🔌 Power interrupt: Node B (~${seconds}s)`, '');
    }
  }

  /** Disconnect / reconnect peer heartbeat */
  setPeerDisconnected(val) {
    this._peerDisconnected = val;
    if (val) {
      this._log('📡 Peer disconnect simulated', 'Node A heartbeat stopped – Node B will fault');
    } else {
      this._log('📡 Peer reconnected', 'Heartbeat resumed');
      this.nodeB.peerHeartbeatTimer = 0;
      if (this.nodeB.state === NodeBState.PEER_FAULT) {
        this._transitionB(NodeBState.STANDBY, 'Peer reconnected – returning to STANDBY');
      }
    }
  }

  /** Human presses "Confirm Recovery" button */
  confirmRecovery() {
    if (!this.running) return;
    this._pendingHumanConfirm = true;
    this.nodeB.humanConfirmReceived = true;
    this._log('👤 Human confirmation received', 'Recovery authorised by operator');
  }

  /** Begin recovery sequence (operator action) */
  beginRecovery() {
    if (!this.running) return;
    this._pendingHumanConfirm = false;
    this.nodeB.humanConfirmReceived = false;
    if (this.nodeA.state === NodeAState.DANGER) {
      this._transitionA(NodeAState.RECOVERY_PENDING, 'Recovery initiated by operator');
    }
    if (this.nodeB.state === NodeBState.ACTUATING || this.nodeB.state === NodeBState.PEER_FAULT) {
      this._transitionB(NodeBState.RECOVERY_PENDING, 'Recovery initiated by operator');
    }
  }

  // ── Main tick ───────────────────────────────────────────────────────────────

  step() {
    if (!this.running) return;
    this.tick++;

    // Power interrupt check
    if (this._powerInterruptA > 0) {
      this._powerInterruptA--;
      // Node A is offline; skip its logic
      this._tickNodeB(); // Node B still runs, will sense peer silence
      return;
    }
    if (this._powerInterruptB > 0) {
      this._powerInterruptB--;
      this._safeBOutputs();
      this._tickNodeA();
      return;
    }

    this._tickNodeA();
    this._tickNodeB();
    // comms layer is async (setTimeout-based), no per-tick poll needed
  }

  // ── Node A logic ────────────────────────────────────────────────────────────

  _tickNodeA() {
    const A = this.nodeA;

    if (!A.sensorConnected) {
      if (A.state !== NodeAState.SENSOR_FAULT) {
        A.buzzer = true;
        A.led = true;
        this._transitionA(NodeAState.SENSOR_FAULT, 'Slope sensor disconnected – fault, not clear');
      }
      return;
    }

    // Update sensor reading
    A.sensorRaw = this._computeSensorA();
    A.sensorDisplay = A.noisy
      ? Math.max(0, A.sensorRaw + (this._random() - 0.5) * A.sensorRaw * 0.4)
      : A.sensorRaw;

    const above = A.sensorDisplay >= CONFIG.SLOPE_THRESHOLD;

    switch (A.state) {
      case NodeAState.MONITORING:
      case NodeAState.CONFIRMING:
        this._updateConfirmBuffer(above);

        if (A.state === NodeAState.MONITORING && A.aboveCount >= 1) {
          this._transitionA(NodeAState.CONFIRMING, 'Threshold crossed – starting confirmation window');
        }

        if (A.aboveCount >= CONFIG.CONFIRM_NEEDED) {
          // Confirmed hazard – stop the ramp so sensor starts showing steady danger value
          A._rampActive = false;
          A.buzzer = true;
          A.led = true;
          this._transitionA(NodeAState.DANGER, `HAZARD CONFIRMED after ${CONFIG.CONFIRM_NEEDED} readings`);
          this._sendHazardAlert();
          this._actuateZones();
        }
        break;

      case NodeAState.DANGER:
        A.buzzer = true;
        A.led = true;
        // Latch – do not leave without explicit recovery
        break;

      case NodeAState.RECOVERY_PENDING:
        A.belowStreak = above ? 0 : A.belowStreak + 1;
        if (A.belowStreak >= CONFIG.RECOVER_NEEDED) {
          A.buzzer = false;
          A.led = false;
          this._transitionA(NodeAState.RECOVERED, `Stable for ${CONFIG.RECOVER_NEEDED} readings – recovered`);
          this.zones.upstream.status = ZoneStatus.CLEARED;
          this._sendRecoveryMessage();
          this._pendingHumanConfirm = false;
        }
        break;

      case NodeAState.RECOVERED:
      case NodeAState.IDLE:
        break;
    }
  }

  _computeSensorA() {
    const A = this.nodeA;
    if (A._spikeNext) {
      A._spikeNext = false;
      this.metrics.falseTripCount++;
      return CONFIG.SLOPE_THRESHOLD + 30; // spike – single sample
    }
    if (A._rampActive) {
      A._rampValue = Math.min(A._rampValue + 4, CONFIG.SLOPE_THRESHOLD + 25);
      if (A._rampValue >= CONFIG.SLOPE_THRESHOLD + 25) {
        // Stay latched high until manually reset
      }
      return A._rampValue;
    }
    if (A.state === NodeAState.RECOVERED) return 10;
    if (A.state === NodeAState.DANGER || A.state === NodeAState.RECOVERY_PENDING) {
      // Slowly decrease if recovery started
      return A.state === NodeAState.RECOVERY_PENDING
        ? Math.max(5, A.sensorRaw - 2)
        : A.sensorRaw || CONFIG.SLOPE_THRESHOLD + 10;
    }
    // Idle baseline
    return 5 + this._random() * 8;
  }

  _updateConfirmBuffer(above) {
    const A = this.nodeA;
    A.confirmBuffer.push(above);
    if (A.confirmBuffer.length > CONFIG.CONFIRM_WINDOW) {
      const removed = A.confirmBuffer.shift();
      if (removed) A.aboveCount--;
    }
    if (above) A.aboveCount++;
  }

  // ── Node B logic ────────────────────────────────────────────────────────────

  _tickNodeB() {
    const B = this.nodeB;

    if (!B.sensorConnected) {
      if (B.state !== NodeBState.SENSOR_FAULT) {
        this._safeBOutputs();
        B.buzzer = true;
        this._transitionB(NodeBState.SENSOR_FAULT, 'Water sensor disconnected – fault, not clear');
      }
      return;
    }

    // Peer heartbeat timer
    if (!this._peerDisconnected && this._powerInterruptA === 0) {
      B.peerHeartbeatTimer = 0;
      B.peerConnected = true;
    } else {
      B.peerHeartbeatTimer++;
      if (B.peerHeartbeatTimer >= CONFIG.PEER_TIMEOUT_TICKS && B.state !== NodeBState.PEER_FAULT) {
        this._transitionB(NodeBState.PEER_FAULT,
          `No heartbeat from Node A for ${CONFIG.PEER_TIMEOUT_TICKS} ticks – PEER FAULT (not safe)`);
        B.peerConnected = false;
        B.buzzer = true; // alert on peer fault
      }
    }

    // Water sensor
    if (B._waterActive) {
      B.sensorRaw = Math.min(B.sensorRaw + 3, 95);
    } else if (B.state === NodeBState.RECOVERY_PENDING || B.state === NodeBState.RECOVERED) {
      B.sensorRaw = Math.max(0, B.sensorRaw - 2);
    } else {
      B.sensorRaw = 5 + this._random() * 6;
    }
    B.sensorDisplay = B.sensorRaw;
    B.waterAbove = B.sensorDisplay >= CONFIG.WATER_THRESHOLD;
    if (B.waterAbove) {
      B.waterConfirmCount++;
      B.waterBelowStreak = 0;
    } else {
      B.waterConfirmCount = 0;
      B.waterBelowStreak++;
    }

    // Node B is independently safety-critical; it does not wait for Node A.
    if (B.waterConfirmCount >= CONFIG.WATER_CONFIRM_NEEDED &&
        (B.state === NodeBState.STANDBY || B.state === NodeBState.PEER_FAULT)) {
      this._transitionB(NodeBState.ACTUATING, 'Local water hazard confirmed – independent response');
      this.metrics.relayActivations++;
      this._actuateBOutputs();
      this._actuateZones();
    }

    switch (B.state) {
      case NodeBState.ACTUATING:
        this._actuateBOutputs();
        break;

      case NodeBState.RECOVERY_PENDING:
        if (!B.waterAbove && B.waterBelowStreak >= CONFIG.RECOVER_NEEDED && B.upstreamCleared) {
          this._transitionB(NodeBState.READY_TO_REOPEN,
            'Local water stable and upstream clearance received – ready to reopen');
        }
        break;

      case NodeBState.READY_TO_REOPEN:
        if (B.humanConfirmReceived) {
          this._transitionB(NodeBState.RECOVERED, 'Human confirmation received – downstream reopened');
          this.zones.downstream.status = ZoneStatus.CLEARED;
          B.humanConfirmReceived = false;
        }
        break;

      case NodeBState.RECOVERED:
        this._safeBOutputs();
        break;

      case NodeBState.PEER_FAULT:
        // Fault outputs are deliberately de-energised. A later validated hazard
        // or local water confirmation must explicitly re-actuate them.
        this._safeBOutputs();
        break;
    }
  }

  // ── Message sending (via comms layer) ───────────────────────────────────────

  _sendHazardAlert() {
    if (!this.comms) return;
    const packet = {
      type: 'HAZARD_ALERT',
      source: 'NODE_A',
      seq: this.comms.nextSeq(),
      sensorValue: this.nodeA.sensorDisplay,
      tick: this.tick,
    };
    this.comms.send(packet, (delivered, latency, retries) => {
      this.metrics.txPackets++;
      if (delivered) {
        this.metrics.rxPackets++;
        this.metrics.ackCount++;
        this.metrics.retries += retries;
        this._updateLatency(latency);
        this._onNodeBReceive({ type: 'HAZARD_ALERT', source: 'NODE_A', seq: packet.seq });
      } else {
        this.metrics.retries += retries;
        this.metrics.droppedPackets++;
        this._log('❌ HAZARD_ALERT packet dropped!', 'Node B did not receive alert');
      }
    });
  }

  _sendRecoveryMessage() {
    if (!this.comms) return;
    const packet = {
      type: 'RECOVERY_CLEAR',
      source: 'NODE_A',
      seq: this.comms.nextSeq(),
      tick: this.tick,
    };
    this.comms.send(packet, (delivered, latency, retries) => {
      this.metrics.txPackets++;
      if (delivered) {
        this.metrics.rxPackets++;
        this.metrics.ackCount++;
        this.metrics.retries += retries;
        this._updateLatency(latency);
        this._onNodeBReceive({ type: 'RECOVERY_CLEAR', source: 'NODE_A', seq: packet.seq });
      } else {
        this.metrics.retries += retries;
        this.metrics.droppedPackets++;
        this._log('❌ RECOVERY_CLEAR packet dropped!', 'Node B did not receive upstream clearance');
      }
    });
  }

  _onNodeBReceive(msg) {
    const B = this.nodeB;
    if (!msg || msg.source !== 'NODE_A' || !Number.isInteger(msg.seq) || !msg.type) {
      this._log('⚠ Invalid message rejected', 'Node B requires source, type and integer sequence');
      return false;
    }
    if (msg.seq <= B.lastMsgSeq) {
      this._log('⚠ Duplicate/stale message rejected', `seq=${msg.seq}, last=${B.lastMsgSeq}`);
      return false;
    }
    B.lastMsgSeq = msg.seq;
    B.lastMsgType = msg.type;
    if (msg.type === 'HAZARD_ALERT') {
      if (B.state === NodeBState.STANDBY || B.state === NodeBState.IDLE) {
        this._transitionB(NodeBState.ACTUATING, 'HAZARD_ALERT received from Node A – actuating relays');
        this.metrics.relayActivations++;
        this._actuateBOutputs();
      }
      this._actuateZones();
      return true;
    }
    if (msg.type === 'RECOVERY_CLEAR') {
      B.upstreamCleared = true;
      return true;
    }
    this._log('⚠ Unknown message rejected', msg.type);
    return false;
  }

  _actuateBOutputs() {
    const B = this.nodeB;
    const before = [B.relay1, B.relay2, B.fan, B.lamp, B.buzzer].join('|');
    B.relay1 = B.relay2 = B.fan = B.lamp = B.buzzer = true;
    B.zoneLedUpstream = B.zoneLedDownstream = true;
    const after = [B.relay1, B.relay2, B.fan, B.lamp, B.buzzer].join('|');
    if (before !== after) {
      this.metrics.relayStateChanges++;
      this._log('Relay outputs changed', 'Node B safety outputs ON');
    }
  }

  _safeBOutputs() {
    const B = this.nodeB;
    const before = [B.relay1, B.relay2, B.fan, B.lamp, B.buzzer].join('|');
    B.relay1 = B.relay2 = B.fan = B.lamp = B.buzzer = false;
    B.zoneLedUpstream = B.zoneLedDownstream = false;
    if (before !== [B.relay1, B.relay2, B.fan, B.lamp, B.buzzer].join('|')) {
      this.metrics.relayStateChanges++;
      this._log('Relay outputs changed', 'Node B safe outputs OFF');
    }
  }

  // ── Zone management ──────────────────────────────────────────────────────────

  _actuateZones() {
    const changed = this.zones.upstream.status !== ZoneStatus.EVACUATE ||
      this.zones.downstream.status !== ZoneStatus.EVACUATE;
    this.zones.upstream.status = ZoneStatus.EVACUATE;
    this.zones.downstream.status = ZoneStatus.EVACUATE;
    // safe zone NEVER changes
    if (changed) this._log('🚨 Zones UPSTREAM + DOWNSTREAM: EVACUATE', 'Safe Zone C unchanged');
  }

  _clearZones() {
    this.zones.upstream.status = ZoneStatus.CLEARED;
    this.zones.downstream.status = ZoneStatus.CLEARED;
    this._log('✅ Zones UPSTREAM + DOWNSTREAM: CLEARED', 'Safe Zone C unchanged');
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────

  _transitionA(newState, reason) {
    const old = this.nodeA.state;
    this.nodeA.state = newState;
    this.metrics.transitionCount++;
    this._log(`Node A: ${old} → ${newState}`, reason);
  }

  _transitionB(newState, reason) {
    const old = this.nodeB.state;
    this.nodeB.state = newState;
    this.metrics.transitionCount++;
    this._log(`Node B: ${old} → ${newState}`, reason);
  }

  _log(event, detail) {
    const now = new Date();
    const ts = now.toTimeString().split(' ')[0] + '.' +
      String(now.getMilliseconds()).padStart(3, '0');
    this.timeline.unshift({ tick: this.tick, ts, event, detail });
    if (this.timeline.length > 200) this.timeline.pop();
  }

  _updateLatency(ms) {
    const m = this.metrics;
    m.latencyMs = ms;
    m.latencySamples++;
    m.latencyAvg = (m.latencyAvg * (m.latencySamples - 1) + ms) / m.latencySamples;
  }
}
