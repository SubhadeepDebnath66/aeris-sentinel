/**
 * proof.js — Ares · SIH 2026 PS26178
 *
 * Three-Pillar Proof engine.
 * Pure logic: no DOM, no timers. All tests are synchronous and deterministic.
 * The async "Full Proof" orchestrator yields step events for the UI to display.
 */

'use strict';

import { Simulation, NodeAState, NodeBState, ZoneStatus, CONFIG } from './simulation.js';

// ─── Status constants (matches spec) ─────────────────────────────────────────
export const TestStatus = Object.freeze({
  SIMULATION_PASS:              'SIMULATION PASS',
  SIMULATION_FAIL:              'SIMULATION FAIL',
  NOT_TESTED:                   'NOT TESTED',
  HARDWARE_VALIDATION_PENDING:  'HARDWARE VALIDATION PENDING',
});

export const PROOF_SEED = 20261030;

// ─── Synchronous comms stub — zero delay, always delivers ────────────────────
class ImmediateComms {
  constructor(opts = {}) {
    this._seq = 0;
    this.lossRate    = opts.lossRate ?? 0;
    this.maxRetries  = opts.maxRetries ?? 3;
  }
  reset() { this._seq = 0; }
  nextSeq() { return ++this._seq; }
  send(packet, callback) {
    if (this.lossRate >= 1) {
      // Simulate full loss with all retries exhausted
      callback(false, 1, this.maxRetries);
    } else {
      callback(true, 10 + Math.floor(this._seq * 2.5) % 30, 0);
    }
  }
  cancelAll() {}
}

// ─── Assertion helper ─────────────────────────────────────────────────────────
class AssertionError extends Error {}

function assert(condition, message) {
  if (!condition) throw new AssertionError(message || 'Assertion failed');
}

// ─── Test result builder ──────────────────────────────────────────────────────
function makeTestResult(name, pillar, fn) {
  const assertions = [];
  let status = TestStatus.SIMULATION_PASS;
  let errorMsg = '';
  let metrics = {};

  const check = (cond, label) => {
    const ok = Boolean(cond);
    assertions.push({ label, ok });
    if (!ok) throw new AssertionError(label);
  };

  try {
    const result = fn(check);
    if (result && result.metrics) metrics = result.metrics;
  } catch (e) {
    status = TestStatus.SIMULATION_FAIL;
    errorMsg = e.message;
    // Add the failed assertion if not already captured
    if (!assertions.some(a => !a.ok)) {
      assertions.push({ label: errorMsg, ok: false });
    }
  }

  return {
    name,
    pillar,
    status,
    errorMsg,
    assertions,
    metrics,
  };
}

// ─── Pillar 1: Reliable Node-to-Node Signalling ───────────────────────────────
function runPillar1Tests() {
  const results = [];

  // P1-T1: Happy path — hazard alert delivered, seq/latency/ACK recorded
  results.push(makeTestResult('P1-T1 Happy path: HAZARD_ALERT delivered with ACK', 1, (check) => {
    const sim = new Simulation({ seed: PROOF_SEED });
    sim.comms = new ImmediateComms();
    sim.start();
    sim.injectSlopeEvent();
    for (let i = 0; i < 10; i++) sim.step();
    check(sim.nodeA.state === NodeAState.DANGER, `Node A reached DANGER (was: ${sim.nodeA.state})`);
    check(sim.nodeB.state === NodeBState.ACTUATING, `Node B reached ACTUATING (was: ${sim.nodeB.state})`);
    check(sim.metrics.txPackets >= 1, `txPackets ≥ 1 (was: ${sim.metrics.txPackets})`);
    check(sim.metrics.ackCount >= 1, `ackCount ≥ 1 (was: ${sim.metrics.ackCount})`);
    check(sim.comms._seq >= 1, `sequence number ≥ 1 (was: ${sim.comms._seq})`);
    check(sim.metrics.latencyAvg > 0, `latency recorded (was: ${sim.metrics.latencyAvg})`);
    return { metrics: { seq: sim.comms._seq, latencyAvg: sim.metrics.latencyAvg.toFixed(1) + ' ms', ackCount: sim.metrics.ackCount } };
  }));

  // P1-T2: Packet loss → explicit failure, B does NOT actuate
  results.push(makeTestResult('P1-T2 Fault: full packet loss → SIMULATION PASS (fault correctly detected)', 1, (check) => {
    const sim = new Simulation({ seed: PROOF_SEED });
    sim.comms = new ImmediateComms({ lossRate: 1 });
    sim.start();
    sim.injectSlopeEvent();
    for (let i = 0; i < 10; i++) sim.step();
    check(sim.nodeA.state === NodeAState.DANGER, `Node A still reaches DANGER locally`);
    check(sim.nodeB.state !== NodeBState.ACTUATING, `Node B did NOT actuate (message lost)`);
    check(sim.metrics.retries >= sim.comms.maxRetries,
      `bounded retries recorded (retries=${sim.metrics.retries}, expected >=${sim.comms.maxRetries})`);
    check(sim.metrics.droppedPackets >= 1, `droppedPackets ≥ 1 (was: ${sim.metrics.droppedPackets})`);
    return { metrics: { retries: sim.metrics.retries, droppedPackets: sim.metrics.droppedPackets } };
  }));

  // P1-T3: Duplicate message rejection
  results.push(makeTestResult('P1-T3 Fault: duplicate message rejected, no extra relay activation', 1, (check) => {
    const sim = new Simulation({ seed: PROOF_SEED });
    sim.comms = new ImmediateComms();
    sim.start();
    const msg1 = { type: 'HAZARD_ALERT', source: 'NODE_A', seq: 7 };
    const first = sim._onNodeBReceive(msg1);
    check(first === true, 'First delivery accepted');
    const activations = sim.metrics.relayActivations;
    const dup = sim._onNodeBReceive(msg1);
    check(dup === false, 'Duplicate rejected');
    check(sim.metrics.relayActivations === activations, 'No extra relay activation from duplicate');
    return { metrics: { relayActivations: sim.metrics.relayActivations } };
  }));

  // P1-T4: Stale packet (lower seq number)
  results.push(makeTestResult('P1-T4 Fault: stale packet (older seq) rejected', 1, (check) => {
    const sim = new Simulation({ seed: PROOF_SEED });
    sim.comms = new ImmediateComms();
    sim.start();
    sim._onNodeBReceive({ type: 'HAZARD_ALERT', source: 'NODE_A', seq: 10 });
    const stale = sim._onNodeBReceive({ type: 'HAZARD_ALERT', source: 'NODE_A', seq: 3 });
    check(stale === false, 'Stale packet (seq=3, last=10) rejected');
    check(sim.nodeB.lastMsgSeq === 10, `lastMsgSeq still 10 (was: ${sim.nodeB.lastMsgSeq})`);
  }));

  // P1-T5: Invalid source rejected
  results.push(makeTestResult('P1-T5 Fault: invalid source field rejected', 1, (check) => {
    const sim = new Simulation({ seed: PROOF_SEED });
    sim.comms = new ImmediateComms();
    sim.start();
    const result = sim._onNodeBReceive({ type: 'HAZARD_ALERT', source: 'UNKNOWN', seq: 1 });
    check(result === false, 'Invalid source rejected');
    check(sim.nodeB.relay1 === false, 'Relay1 stayed OFF');
  }));

  // P1-T6: Peer timeout → PEER_FAULT, never clearance
  results.push(makeTestResult('P1-T6 Fault: peer timeout → PEER_FAULT, not safe/clear', 1, (check) => {
    const sim = new Simulation({ seed: PROOF_SEED });
    sim.comms = new ImmediateComms();
    sim.start();
    sim.setPeerDisconnected(true);
    for (let i = 0; i < CONFIG.PEER_TIMEOUT_TICKS + 2; i++) sim.step();
    check(sim.nodeB.state === NodeBState.PEER_FAULT, `B in PEER_FAULT (was: ${sim.nodeB.state})`);
    check(sim.nodeB.state !== NodeBState.RECOVERED, 'B is NOT recovered (peer silence ≠ clearance)');
    return { metrics: { timedOutAfterTicks: CONFIG.PEER_TIMEOUT_TICKS } };
  }));

  // P1-T7: Peer reconnect clears PEER_FAULT → STANDBY
  results.push(makeTestResult('P1-T7 Recovery: peer reconnect restores STANDBY', 1, (check) => {
    const sim = new Simulation({ seed: PROOF_SEED });
    sim.comms = new ImmediateComms();
    sim.start();
    sim.setPeerDisconnected(true);
    for (let i = 0; i < CONFIG.PEER_TIMEOUT_TICKS + 2; i++) sim.step();
    check(sim.nodeB.state === NodeBState.PEER_FAULT, 'PEER_FAULT confirmed');
    sim.setPeerDisconnected(false);
    sim.step();
    check(sim.nodeB.state === NodeBState.STANDBY, `B returned to STANDBY (was: ${sim.nodeB.state})`);
  }));

  return results;
}

// ─── Pillar 2: Correct Relay Actuation ───────────────────────────────────────
function runPillar2Tests() {
  const results = [];

  // P2-T1: Happy path — all relay outputs actuated after confirmed hazard
  results.push(makeTestResult('P2-T1 Happy path: all relay outputs ON after sustained hazard', 2, (check) => {
    const sim = new Simulation({ seed: PROOF_SEED });
    sim.comms = new ImmediateComms();
    sim.start();
    sim.injectSlopeEvent();
    for (let i = 0; i < 10; i++) sim.step();
    check(sim.nodeB.relay1 === true,  'Relay CH1 (siren power) ON');
    check(sim.nodeB.relay2 === true,  'Relay CH2 (barrier actuator) ON');
    check(sim.nodeB.fan   === true,   'Fan ON');
    check(sim.nodeB.lamp  === true,   'Lamp ON');
    check(sim.nodeB.buzzer === true,  'Buzzer ON');
    check(sim.metrics.relayActivations >= 1, `relayActivations ≥ 1 (was: ${sim.metrics.relayActivations})`);
    return { metrics: { relayActivations: sim.metrics.relayActivations, relayStateChanges: sim.metrics.relayStateChanges } };
  }));

  // P2-T2: Single sensor spike does NOT actuate relays
  results.push(makeTestResult('P2-T2 Spike immunity: one spike never actuates relay', 2, (check) => {
    const sim = new Simulation({ seed: PROOF_SEED });
    sim.comms = new ImmediateComms();
    sim.start();
    sim.injectSensorSpike();
    sim.step();
    check(sim.nodeA.state !== NodeAState.DANGER, `A did not enter DANGER (was: ${sim.nodeA.state})`);
    check(sim.nodeB.relay1 === false, 'Relay CH1 stayed OFF after spike');
    check(sim.nodeB.relay2 === false, 'Relay CH2 stayed OFF after spike');
    check(sim.metrics.falseTripCount >= 1, 'Spike counted as false trip metric');
    return { metrics: { falseTripCount: sim.metrics.falseTripCount } };
  }));

  // P2-T3: Noisy readings — sustained hazard still confirms despite noise
  results.push(makeTestResult('P2-T3 Noise: sustained hazard confirms despite ±40% noise', 2, (check) => {
    const sim = new Simulation({ seed: PROOF_SEED });
    sim.comms = new ImmediateComms();
    sim.start();
    sim.setNoisy(true);
    sim.injectSlopeEvent();
    // Give extra ticks for noise to potentially delay confirmation
    for (let i = 0; i < 20; i++) sim.step();
    check(sim.nodeA.state === NodeAState.DANGER, `A reached DANGER despite noise (was: ${sim.nodeA.state})`);
    check(sim.nodeB.relay1 === true, 'Relay CH1 ON after noisy confirmation');
  }));

  // P2-T4: Sensor disconnect → SENSOR_FAULT, relays stay OFF
  results.push(makeTestResult('P2-T4 Fault: sensor disconnect → SENSOR_FAULT, relays OFF', 2, (check) => {
    const sim = new Simulation({ seed: PROOF_SEED });
    sim.comms = new ImmediateComms();
    sim.start();
    sim.setSensorConnected('B', false);
    sim.step();
    check(sim.nodeB.state === NodeBState.SENSOR_FAULT, `B in SENSOR_FAULT (was: ${sim.nodeB.state})`);
    check(sim.nodeB.relay1 === false, 'Relay CH1 OFF on fault');
    check(sim.nodeB.relay2 === false, 'Relay CH2 OFF on fault');
  }));

  // P2-T5: Power interrupt B → outputs forced safe; state preserved
  results.push(makeTestResult('P2-T5 Fault: power interrupt forces B outputs safe, preserves state', 2, (check) => {
    const sim = new Simulation({ seed: PROOF_SEED });
    sim.comms = new ImmediateComms();
    sim.start();
    // Actuate first, then power interrupt
    sim.nodeB.state = NodeBState.ACTUATING;
    sim.nodeB.relay1 = true;
    sim.nodeB.relay2 = true;
    sim.powerInterrupt('B', 1);
    sim.step();
    check(sim.nodeB.state === NodeBState.ACTUATING, 'State preserved as ACTUATING through power interrupt');
    check(sim.nodeB.relay1 === false, 'Relay CH1 forced OFF by power interrupt');
    check(sim.nodeB.relay2 === false, 'Relay CH2 forced OFF by power interrupt');
  }));

  // P2-T6: Local water hazard independently actuates relays
  results.push(makeTestResult('P2-T6 Independence: local water hazard actuates B without Node A', 2, (check) => {
    const sim = new Simulation({ seed: PROOF_SEED });
    sim.comms = new ImmediateComms();
    sim.start();
    // Do NOT inject slope or send any A message
    sim.injectWaterContact();
    for (let i = 0; i < 25; i++) sim.step();
    check(sim.nodeB.state === NodeBState.ACTUATING, `B=ACTUATING from local water (was: ${sim.nodeB.state})`);
    check(sim.nodeB.relay2 === true, 'Relay CH2 (barrier) ON');
    check(sim.nodeA.state !== NodeAState.DANGER, 'Node A stayed clear (local-only scenario)');
    return { metrics: { relayActivations: sim.metrics.relayActivations } };
  }));

  return results;
}

// ─── Pillar 3: Zone-by-Zone Safe Recovery ─────────────────────────────────────
function runPillar3Tests() {
  const results = [];

  // P3-T1: Full end-to-end recovery path
  results.push(makeTestResult('P3-T1 Happy path: full recovery to RECOVERED + zones CLEARED', 3, (check) => {
    const sim = new Simulation({ seed: PROOF_SEED });
    sim.comms = new ImmediateComms();
    sim.start();
    sim.injectSlopeEvent();
    for (let i = 0; i < 10; i++) sim.step();
    check(sim.nodeA.state === NodeAState.DANGER, 'A=DANGER confirmed');
    check(sim.nodeB.state === NodeBState.ACTUATING, 'B=ACTUATING confirmed');
    sim.beginRecovery();
    // Drive Node A sensor down
    sim.nodeA._rampActive = false;
    for (let i = 0; i < CONFIG.RECOVER_NEEDED + 2; i++) {
      // Force sensor below threshold for A
      sim.nodeA.sensorRaw = 5;
      sim.step();
    }
    check(sim.nodeA.state === NodeAState.RECOVERED, `A=RECOVERED (was: ${sim.nodeA.state})`);
    // Node B needs upstream clearance and stable sensor
    sim.nodeB.upstreamCleared = true;
    sim.nodeB._waterActive = false;
    for (let i = 0; i < CONFIG.RECOVER_NEEDED + 2; i++) sim.step();
    check(sim.nodeB.state === NodeBState.READY_TO_REOPEN, `B=READY_TO_REOPEN (was: ${sim.nodeB.state})`);
    sim.confirmRecovery();
    sim.step();
    check(sim.nodeB.state === NodeBState.RECOVERED, `B=RECOVERED (was: ${sim.nodeB.state})`);
    check(sim.zones.upstream.status === ZoneStatus.CLEARED, `Upstream CLEARED`);
    check(sim.zones.downstream.status === ZoneStatus.CLEARED, `Downstream CLEARED`);
    check(sim.zones.safe.status === ZoneStatus.SAFE, 'Safe Zone C unchanged');
  }));

  // P3-T2: Upstream dependency — downstream stays pending without clearance
  results.push(makeTestResult('P3-T2 Upstream dependency: downstream blocked without upstream clearance', 3, (check) => {
    const sim = new Simulation({ seed: PROOF_SEED });
    sim.comms = new ImmediateComms();
    sim.start();
    sim.nodeB.state = NodeBState.RECOVERY_PENDING;
    sim.nodeB.sensorRaw = 0;
    sim.nodeB.upstreamCleared = false;   // upstream NOT cleared
    for (let i = 0; i < CONFIG.RECOVER_NEEDED + 4; i++) sim.step();
    check(sim.nodeB.state === NodeBState.RECOVERY_PENDING,
      `B stays RECOVERY_PENDING without upstream (was: ${sim.nodeB.state})`);
    check(sim.nodeB.state !== NodeBState.READY_TO_REOPEN, 'B did NOT reach READY_TO_REOPEN');
  }));

  // P3-T3: Unstable downstream never reaches READY_TO_REOPEN
  results.push(makeTestResult('P3-T3 Stability gate: unstable readings block READY_TO_REOPEN', 3, (check) => {
    const sim = new Simulation({ seed: PROOF_SEED });
    sim.comms = new ImmediateComms();
    sim.start();
    sim.nodeB.state = NodeBState.RECOVERY_PENDING;
    sim.nodeB.upstreamCleared = true;
    sim.nodeB._waterActive = true;        // moisture still active
    sim.nodeB.sensorRaw = CONFIG.WATER_THRESHOLD + 5;
    for (let i = 0; i < CONFIG.RECOVER_NEEDED + 4; i++) sim.step();
    check(sim.nodeB.state === NodeBState.RECOVERY_PENDING,
      `B stays RECOVERY_PENDING while water active (was: ${sim.nodeB.state})`);
  }));

  // P3-T4: Human confirmation gate
  results.push(makeTestResult('P3-T4 Human gate: READY_TO_REOPEN without confirmation stays pending', 3, (check) => {
    const sim = new Simulation({ seed: PROOF_SEED });
    sim.comms = new ImmediateComms();
    sim.start();
    sim.nodeB.state = NodeBState.READY_TO_REOPEN;
    sim.nodeB.humanConfirmReceived = false;
    sim.step();
    check(sim.nodeB.state === NodeBState.READY_TO_REOPEN,
      `B stays READY_TO_REOPEN without human confirm (was: ${sim.nodeB.state})`);
    // Now confirm
    sim.confirmRecovery();
    sim.step();
    check(sim.nodeB.state === NodeBState.RECOVERED,
      `B=RECOVERED after confirmation (was: ${sim.nodeB.state})`);
  }));

  // P3-T5: Safe zone immutable throughout
  results.push(makeTestResult('P3-T5 Immutability: Safe Zone C never changes through entire lifecycle', 3, (check) => {
    const sim = new Simulation({ seed: PROOF_SEED });
    sim.comms = new ImmediateComms();
    sim.start();
    check(sim.zones.safe.status === ZoneStatus.SAFE, 'Safe zone SAFE at start');
    sim.injectSlopeEvent();
    for (let i = 0; i < 10; i++) sim.step();
    check(sim.zones.safe.status === ZoneStatus.SAFE, 'Safe zone SAFE during DANGER');
    sim.beginRecovery();
    sim.nodeA._rampActive = false;
    sim.nodeA.sensorRaw = 5;
    sim.confirmRecovery();
    for (let i = 0; i < CONFIG.RECOVER_NEEDED + 4; i++) sim.step();
    check(sim.zones.safe.status === ZoneStatus.SAFE, 'Safe zone SAFE after recovery');
    // Water event
    sim.injectWaterContact();
    for (let i = 0; i < 10; i++) sim.step();
    check(sim.zones.safe.status === ZoneStatus.SAFE, 'Safe zone SAFE during water event');
  }));

  return results;
}

// ─── Full Proof Orchestrator ───────────────────────────────────────────────────
/**
 * Runs the 13-step scripted proof.
 * Returns an async iterator of step events:
 *   { step, label, status, detail, assertions, pauseForHuman? }
 * After all steps, yields a final { type:'report', pillars, overall, metrics } event.
 */
export async function* runFullProof() {
  const sim = new Simulation({ seed: PROOF_SEED });
  sim.comms = new ImmediateComms();

  // Per-pillar assertion tracking
  const pillarAssertions = { 1: [], 2: [], 3: [] };
  const stepEvents = [];
  const fullMetrics = {};

  function pillarCheck(pillar, cond, label) {
    const ok = Boolean(cond);
    pillarAssertions[pillar].push({ label, ok });
    return ok;
  }

  function emit(step, label, status, detail, extras = {}) {
    return { step, label, status, detail, ...extras };
  }

  // STEP 1 — Initialise
  sim.start();
  const s1ok =
    pillarCheck(1, sim.nodeA.state === NodeAState.MONITORING, `A=MONITORING`) &&
    pillarCheck(1, sim.nodeB.state === NodeBState.STANDBY, `B=STANDBY`) &&
    pillarCheck(3, sim.zones.upstream.status === ZoneStatus.NORMAL, `Upstream NORMAL`) &&
    pillarCheck(3, sim.zones.downstream.status === ZoneStatus.NORMAL, `Downstream NORMAL`) &&
    pillarCheck(3, sim.zones.safe.status === ZoneStatus.SAFE, `Safe Zone C=SAFE`);
  yield emit(1, 'Initialise both nodes', s1ok ? TestStatus.SIMULATION_PASS : TestStatus.SIMULATION_FAIL,
    `A=${sim.nodeA.state} | B=${sim.nodeB.state} | Zones: UP=${sim.zones.upstream.status} DN=${sim.zones.downstream.status} SAFE=${sim.zones.safe.status}`);
  await _delay(0);

  // STEP 2 — Inject slope hazard
  sim.injectSlopeEvent();
  for (let i = 0; i < 4; i++) sim.step();
  const s2ok = pillarCheck(2, sim.nodeA.state === NodeAState.CONFIRMING || sim.nodeA.state === NodeAState.DANGER,
    `A entering confirmation (was: ${sim.nodeA.state})`);
  yield emit(2, 'Inject sustained slope hazard', s2ok ? TestStatus.SIMULATION_PASS : TestStatus.SIMULATION_FAIL,
    `Node A sensor: ${sim.nodeA.sensorDisplay.toFixed(1)} mm | Threshold: ${CONFIG.SLOPE_THRESHOLD} mm | State: ${sim.nodeA.state}`);
  await _delay(0);

  // STEP 3 — Wait for DANGER
  for (let i = 0; i < 8; i++) sim.step();
  const s3ok =
    pillarCheck(1, sim.nodeA.state === NodeAState.DANGER, `A=DANGER`) &&
    pillarCheck(1, sim.metrics.txPackets >= 1, `HAZARD_ALERT sent (txPackets=${sim.metrics.txPackets})`);
  fullMetrics.dangerConfirmedTick = sim.tick;
  yield emit(3, 'Node A confirmed DANGER, HAZARD_ALERT transmitted',
    s3ok ? TestStatus.SIMULATION_PASS : TestStatus.SIMULATION_FAIL,
    `Node A: ${sim.nodeA.state} | txPackets: ${sim.metrics.txPackets} | Confirm window: ${sim.nodeA.aboveCount}/${CONFIG.CONFIRM_NEEDED}`);
  await _delay(0);

  // STEP 4 — Comms delivery metrics
  const s4ok =
    pillarCheck(1, sim.metrics.ackCount >= 1, `ACK received (ackCount=${sim.metrics.ackCount})`) &&
    pillarCheck(1, sim.comms._seq >= 1, `seq#=${sim.comms._seq}`) &&
    pillarCheck(1, sim.metrics.latencyAvg > 0, `latency=${sim.metrics.latencyAvg.toFixed(1)}ms`);
  fullMetrics.seq = sim.comms._seq;
  fullMetrics.latencyAvg = sim.metrics.latencyAvg.toFixed(1);
  fullMetrics.retries = sim.metrics.retries;
  yield emit(4, 'Comms delivery: seq, latency, ACK, retries recorded',
    s4ok ? TestStatus.SIMULATION_PASS : TestStatus.SIMULATION_FAIL,
    `seq#=${sim.comms._seq} | latency=${sim.metrics.latencyAvg.toFixed(1)}ms | ACKs=${sim.metrics.ackCount} | retries=${sim.metrics.retries}`);
  await _delay(0);

  // STEP 5 — Node B receives and actuates
  const s5ok =
    pillarCheck(2, sim.nodeB.state === NodeBState.ACTUATING, `B=ACTUATING (was: ${sim.nodeB.state})`) &&
    pillarCheck(1, sim.nodeB.lastMsgType === 'HAZARD_ALERT', `B processed HAZARD_ALERT`);
  yield emit(5, 'Node B received HAZARD_ALERT and transitioned to ACTUATING',
    s5ok ? TestStatus.SIMULATION_PASS : TestStatus.SIMULATION_FAIL,
    `Node B: ${sim.nodeB.state} | lastMsgSeq=${sim.nodeB.lastMsgSeq} | lastMsgType=${sim.nodeB.lastMsgType}`);
  await _delay(0);

  // STEP 6 — Relay outputs verified
  const s6ok =
    pillarCheck(2, sim.nodeB.relay1 === true,  'relay1 ON') &&
    pillarCheck(2, sim.nodeB.relay2 === true,  'relay2 ON') &&
    pillarCheck(2, sim.nodeB.fan    === true,  'fan ON') &&
    pillarCheck(2, sim.nodeB.lamp   === true,  'lamp ON') &&
    pillarCheck(2, sim.nodeB.buzzer === true,  'buzzer ON') &&
    pillarCheck(2, sim.metrics.relayActivations >= 1, `relayActivations=${sim.metrics.relayActivations}`);
  fullMetrics.relayActivations = sim.metrics.relayActivations;
  yield emit(6, 'Relay outputs: CH1, CH2, fan, lamp, buzzer all activated',
    s6ok ? TestStatus.SIMULATION_PASS : TestStatus.SIMULATION_FAIL,
    `relay1=${sim.nodeB.relay1} relay2=${sim.nodeB.relay2} fan=${sim.nodeB.fan} lamp=${sim.nodeB.lamp} buzzer=${sim.nodeB.buzzer} | activations=${sim.metrics.relayActivations}`);
  await _delay(0);

  // STEP 7 — Begin recovery
  sim.beginRecovery();
  sim.step();
  const s7ok =
    pillarCheck(3, sim.nodeA.state === NodeAState.RECOVERY_PENDING, `A=RECOVERY_PENDING`) &&
    pillarCheck(3, sim.nodeB.state === NodeBState.RECOVERY_PENDING, `B=RECOVERY_PENDING`);
  yield emit(7, 'Recovery initiated — both nodes enter RECOVERY_PENDING',
    s7ok ? TestStatus.SIMULATION_PASS : TestStatus.SIMULATION_FAIL,
    `Node A: ${sim.nodeA.state} | Node B: ${sim.nodeB.state}`);
  await _delay(0);

  // STEP 8 — Upstream stabilises and recovers according to defined rules
  sim.nodeA._rampActive = false;
  sim.nodeA.sensorRaw = 5;
  sim.nodeA.sensorDisplay = 5;
  for (let i = 0; i < CONFIG.RECOVER_NEEDED + 2; i++) sim.step();
  const s8ok = pillarCheck(3, sim.nodeA.state === NodeAState.RECOVERED, `A=RECOVERED (was: ${sim.nodeA.state})`);
  fullMetrics.upstreamRecoveredTick = sim.tick;
  yield emit(8, 'Node A sensor stable — upstream RECOVERED, RECOVERY_CLEAR sent to B',
    s8ok ? TestStatus.SIMULATION_PASS : TestStatus.SIMULATION_FAIL,
    `Node A: ${sim.nodeA.state} | upstreamCleared signal: ${sim.nodeB.upstreamCleared}`);
  await _delay(0);

  // STEP 9 — Downstream stability check
  sim.nodeB._waterActive = false;
  sim.nodeB.sensorRaw = 0;
  for (let i = 0; i < CONFIG.RECOVER_NEEDED + 2; i++) sim.step();
  const s9ok =
    pillarCheck(3, sim.nodeB.waterBelowStreak >= CONFIG.RECOVER_NEEDED,
      `waterBelowStreak=${sim.nodeB.waterBelowStreak} ≥ ${CONFIG.RECOVER_NEEDED}`) &&
    pillarCheck(3, sim.nodeB.upstreamCleared === true, `upstreamCleared=${sim.nodeB.upstreamCleared}`);
  yield emit(9, 'Downstream local stability verified, upstream clearance confirmed',
    s9ok ? TestStatus.SIMULATION_PASS : TestStatus.SIMULATION_FAIL,
    `B water: ${sim.nodeB.sensorDisplay.toFixed(1)}% | belowStreak: ${sim.nodeB.waterBelowStreak}/${CONFIG.RECOVER_NEEDED} | upstreamCleared: ${sim.nodeB.upstreamCleared}`);
  await _delay(0);

  // STEP 10 — READY_TO_REOPEN — pause for human confirmation
  const s10ok =
    pillarCheck(3, sim.nodeB.state === NodeBState.READY_TO_REOPEN, `B=READY_TO_REOPEN (was: ${sim.nodeB.state})`) &&
    pillarCheck(3, sim.zones.safe.status === ZoneStatus.SAFE, 'Safe Zone C still SAFE');
  yield emit(10, 'READY TO REOPEN — system paused awaiting human confirmation',
    s10ok ? TestStatus.SIMULATION_PASS : TestStatus.SIMULATION_FAIL,
    `Node B: ${sim.nodeB.state} | Safe Zone: ${sim.zones.safe.status} | Zones: UP=${sim.zones.upstream.status} DN=${sim.zones.downstream.status}`,
    { pauseForHuman: true });
  // Caller must send {type:'resume'} before we continue
  return;  // <-- generator yields here; the UI continues with confirmFullProof()
}

/**
 * Resumes the full proof after human confirmation (Steps 11–13).
 * Takes the sim object (pre-built) and already-collected pillarAssertions.
 * Returns a summary object.
 */
export async function* resumeFullProof(sim, pillarAssertions, delayMs = 0) {
  function pillarCheck(pillar, cond, label) {
    const ok = Boolean(cond);
    pillarAssertions[pillar].push({ label, ok });
    return ok;
  }
  function emit(step, label, status, detail, extras = {}) {
    return { step, label, status, detail, ...extras };
  }

  // STEP 11 — Human confirmation
  sim.confirmRecovery();
  sim.step();
  const s11ok = pillarCheck(3, sim.nodeB.state === NodeBState.RECOVERED, `B=RECOVERED (was: ${sim.nodeB.state})`);
  yield emit(11, 'Human confirmation received — downstream reopening',
    s11ok ? TestStatus.SIMULATION_PASS : TestStatus.SIMULATION_FAIL,
    `Node B: ${sim.nodeB.state}`);
  await _delay(delayMs);

  // STEP 12 — Zones cleared, safe zone unchanged
  const s12ok =
    pillarCheck(3, sim.zones.upstream.status === ZoneStatus.CLEARED,   `Upstream CLEARED`) &&
    pillarCheck(3, sim.zones.downstream.status === ZoneStatus.CLEARED, `Downstream CLEARED`) &&
    pillarCheck(3, sim.zones.safe.status === ZoneStatus.SAFE,           'Safe Zone C SAFE');
  yield emit(12, 'Zones cleared — upstream CLEARED, downstream CLEARED, Safe Zone C unchanged',
    s12ok ? TestStatus.SIMULATION_PASS : TestStatus.SIMULATION_FAIL,
    `UP=${sim.zones.upstream.status} DN=${sim.zones.downstream.status} SAFE=${sim.zones.safe.status}`);
  await _delay(delayMs);

  // STEP 13 — Final report
  // Derive pillar statuses from assertions
  function derivePillarStatus(arr) {
    if (arr.length === 0) return TestStatus.NOT_TESTED;
    return arr.every(a => a.ok) ? TestStatus.SIMULATION_PASS : TestStatus.SIMULATION_FAIL;
  }
  const p1Status = derivePillarStatus(pillarAssertions[1]);
  const p2Status = derivePillarStatus(pillarAssertions[2]);
  const p3Status = derivePillarStatus(pillarAssertions[3]);
  const allPassed = [p1Status, p2Status, p3Status].every(s => s === TestStatus.SIMULATION_PASS);
  const overallStatus = allPassed ? TestStatus.SIMULATION_PASS : TestStatus.SIMULATION_FAIL;
  const allAssertions = Object.values(pillarAssertions).flat();
  const passed = allAssertions.filter(a => a.ok).length;
  const failed = allAssertions.filter(a => !a.ok).length;

  yield {
    step: 13,
    type: 'report',
    label: 'Final Proof Report',
    overallStatus,
    seed: sim.seed,
    summary: {
      passed,
      failed,
      incomplete: 0,
      untested: 0,
      total: allAssertions.length,
      hardwareValidation: TestStatus.HARDWARE_VALIDATION_PENDING,
    },
    pillars: [
      { id: 1, name: 'Reliable Signalling',  status: p1Status, assertions: pillarAssertions[1] },
      { id: 2, name: 'Correct Actuation',    status: p2Status, assertions: pillarAssertions[2] },
      { id: 3, name: 'Zone-by-Zone Recovery',status: p3Status, assertions: pillarAssertions[3] },
    ],
    metrics: {
      txPackets:         sim.metrics.txPackets,
      ackCount:          sim.metrics.ackCount,
      retries:           sim.metrics.retries,
      droppedPackets:    sim.metrics.droppedPackets,
      relayActivations:  sim.metrics.relayActivations,
      relayStateChanges: sim.metrics.relayStateChanges,
      latencyAvg:        sim.metrics.latencyAvg.toFixed(1) + ' ms',
      transitionCount:   sim.metrics.transitionCount,
      falseTripCount:    sim.metrics.falseTripCount,
    },
    timeline: sim.timeline.slice().reverse(),
    hardwareNote: TestStatus.HARDWARE_VALIDATION_PENDING,
  };
}

function _delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Run all individual pillar tests synchronously.
 * Returns { pillar1, pillar2, pillar3, summary }
 */
export function runAllPillarTests() {
  const p1 = runPillar1Tests();
  const p2 = runPillar2Tests();
  const p3 = runPillar3Tests();
  const all = [...p1, ...p2, ...p3];
  const passed = all.filter(r => r.status === TestStatus.SIMULATION_PASS).length;
  const failed = all.filter(r => r.status === TestStatus.SIMULATION_FAIL).length;
  return {
    pillar1: p1,
    pillar2: p2,
    pillar3: p3,
    summary: { total: all.length, passed, failed },
  };
}

export { runPillar1Tests, runPillar2Tests, runPillar3Tests };

export function runSingleTest(testName) {
  const all = [...runPillar1Tests(), ...runPillar2Tests(), ...runPillar3Tests()];
  return all.find(t => t.name === testName || t.name.includes(testName));
}

/**
 * Build a fresh sim and start the full proof generator.
 * Returns { generator, sim, pillarAssertions }
 * The generator runs steps 1–10 then stops (pauseForHuman=true).
 * After human confirmation, call resumeFullProof(sim, pillarAssertions, delayMs).
 */
export function startFullProof(delayMs = 0) {
  const sim = new Simulation({ seed: PROOF_SEED });
  sim.comms = new ImmediateComms();
  const pillarAssertions = { 1: [], 2: [], 3: [] };

  // Wrap the generator so it captures sim and pillarAssertions
  const generator = _runFullProofInternal(sim, pillarAssertions, delayMs);
  return { generator, sim, pillarAssertions };
}

// Internal full proof — same logic as above but self-contained with captured state
async function* _runFullProofInternal(sim, pillarAssertions, delayMs = 0) {
  function pillarCheck(pillar, cond, label) {
    const ok = Boolean(cond);
    pillarAssertions[pillar].push({ label, ok });
    return ok;
  }
  function emit(step, label, status, detail, extras = {}) {
    return { step, label, status, detail, ...extras };
  }

  // STEP 1
  sim.start();
  const s1ok =
    pillarCheck(1, sim.nodeA.state === NodeAState.MONITORING, `A=MONITORING`) &&
    pillarCheck(1, sim.nodeB.state === NodeBState.STANDBY, `B=STANDBY`) &&
    pillarCheck(3, sim.zones.upstream.status === ZoneStatus.NORMAL, `Upstream NORMAL`) &&
    pillarCheck(3, sim.zones.downstream.status === ZoneStatus.NORMAL, `Downstream NORMAL`) &&
    pillarCheck(3, sim.zones.safe.status === ZoneStatus.SAFE, `Safe Zone C=SAFE`);
  yield emit(1, 'Initialise both nodes — verify starting states', s1ok ? TestStatus.SIMULATION_PASS : TestStatus.SIMULATION_FAIL,
    `A=${sim.nodeA.state} | B=${sim.nodeB.state} | UP=${sim.zones.upstream.status} DN=${sim.zones.downstream.status} SAFE=${sim.zones.safe.status}`);
  await _delay(delayMs);

  // STEP 2
  sim.injectSlopeEvent();
  for (let i = 0; i < 4; i++) sim.step();
  const s2aState = sim.nodeA.state;
  const s2ok = pillarCheck(2, s2aState === NodeAState.CONFIRMING || s2aState === NodeAState.DANGER,
    `A entering confirmation (${s2aState})`);
  yield emit(2, 'Inject sustained slope hazard', s2ok ? TestStatus.SIMULATION_PASS : TestStatus.SIMULATION_FAIL,
    `Sensor: ${sim.nodeA.sensorDisplay.toFixed(1)} mm | Threshold: ${CONFIG.SLOPE_THRESHOLD} mm | A=${sim.nodeA.state} | aboveCount: ${sim.nodeA.aboveCount}/${CONFIG.CONFIRM_NEEDED}`);
  await _delay(delayMs);

  // STEP 3
  for (let i = 0; i < 8; i++) sim.step();
  const s3ok =
    pillarCheck(1, sim.nodeA.state === NodeAState.DANGER, `A=DANGER`) &&
    pillarCheck(1, sim.metrics.txPackets >= 1, `HAZARD_ALERT sent`);
  yield emit(3, 'DANGER confirmed — HAZARD_ALERT transmitted to Node B', s3ok ? TestStatus.SIMULATION_PASS : TestStatus.SIMULATION_FAIL,
    `A=${sim.nodeA.state} | txPackets=${sim.metrics.txPackets} | confirmWindow: ${sim.nodeA.aboveCount}/${CONFIG.CONFIRM_NEEDED}`);
  await _delay(delayMs);

  // STEP 4
  const s4ok =
    pillarCheck(1, sim.metrics.ackCount >= 1, `ACK received`) &&
    pillarCheck(1, sim.comms._seq >= 1, `seq#=${sim.comms._seq}`) &&
    pillarCheck(1, sim.metrics.latencyAvg > 0, `latency recorded`);
  yield emit(4, 'Comms verified — sequence number, latency, retries recorded', s4ok ? TestStatus.SIMULATION_PASS : TestStatus.SIMULATION_FAIL,
    `seq#=${sim.comms._seq} | latency=${sim.metrics.latencyAvg.toFixed(1)}ms | ACKs=${sim.metrics.ackCount} | retries=${sim.metrics.retries} | drops=${sim.metrics.droppedPackets}`);
  await _delay(delayMs);

  // STEP 5
  const s5ok =
    pillarCheck(2, sim.nodeB.state === NodeBState.ACTUATING, `B=ACTUATING`) &&
    pillarCheck(1, sim.nodeB.lastMsgType === 'HAZARD_ALERT', 'B processed HAZARD_ALERT');
  yield emit(5, 'Node B processed HAZARD_ALERT — transitioned to ACTUATING', s5ok ? TestStatus.SIMULATION_PASS : TestStatus.SIMULATION_FAIL,
    `B=${sim.nodeB.state} | lastMsgSeq=${sim.nodeB.lastMsgSeq} | lastMsgType=${sim.nodeB.lastMsgType}`);
  await _delay(delayMs);

  // STEP 6
  const s6ok =
    pillarCheck(2, sim.nodeB.relay1 === true, 'relay1 ON') &&
    pillarCheck(2, sim.nodeB.relay2 === true, 'relay2 ON') &&
    pillarCheck(2, sim.nodeB.fan   === true,  'fan ON') &&
    pillarCheck(2, sim.nodeB.lamp  === true,  'lamp ON') &&
    pillarCheck(2, sim.nodeB.buzzer === true, 'buzzer ON');
  yield emit(6, 'Relay outputs activated — CH1, CH2, fan, lamp, buzzer ON', s6ok ? TestStatus.SIMULATION_PASS : TestStatus.SIMULATION_FAIL,
    `relay1=${sim.nodeB.relay1} relay2=${sim.nodeB.relay2} fan=${sim.nodeB.fan} lamp=${sim.nodeB.lamp} buzzer=${sim.nodeB.buzzer} | activations=${sim.metrics.relayActivations}`);
  await _delay(delayMs);

  // STEP 7
  sim.beginRecovery();
  sim.step();
  const s7ok =
    pillarCheck(3, sim.nodeA.state === NodeAState.RECOVERY_PENDING, `A=RECOVERY_PENDING`) &&
    pillarCheck(3, sim.nodeB.state === NodeBState.RECOVERY_PENDING, `B=RECOVERY_PENDING`);
  yield emit(7, 'Recovery initiated — nodes enter RECOVERY_PENDING', s7ok ? TestStatus.SIMULATION_PASS : TestStatus.SIMULATION_FAIL,
    `A=${sim.nodeA.state} | B=${sim.nodeB.state}`);
  await _delay(delayMs);

  // STEP 8
  sim.nodeA._rampActive = false;
  sim.nodeA.sensorRaw = 5;
  sim.nodeA.sensorDisplay = 5;
  for (let i = 0; i < CONFIG.RECOVER_NEEDED + 2; i++) sim.step();
  const s8ok = pillarCheck(3, sim.nodeA.state === NodeAState.RECOVERED, `A=RECOVERED`);
  yield emit(8, 'Node A stable — upstream RECOVERED, RECOVERY_CLEAR sent', s8ok ? TestStatus.SIMULATION_PASS : TestStatus.SIMULATION_FAIL,
    `A=${sim.nodeA.state} | upstreamCleared signal delivered: ${sim.nodeB.upstreamCleared}`);
  await _delay(delayMs);

  // STEP 9
  sim.nodeB._waterActive = false;
  sim.nodeB.sensorRaw = 0;
  for (let i = 0; i < CONFIG.RECOVER_NEEDED + 2; i++) sim.step();
  const s9ok =
    pillarCheck(3, sim.nodeB.waterBelowStreak >= CONFIG.RECOVER_NEEDED, `waterBelowStreak ≥ ${CONFIG.RECOVER_NEEDED}`) &&
    pillarCheck(3, sim.nodeB.upstreamCleared === true, 'upstreamCleared=true');
  yield emit(9, 'Downstream local stability verified, upstream clearance confirmed', s9ok ? TestStatus.SIMULATION_PASS : TestStatus.SIMULATION_FAIL,
    `water=${sim.nodeB.sensorDisplay.toFixed(1)}% | belowStreak=${sim.nodeB.waterBelowStreak}/${CONFIG.RECOVER_NEEDED} | upstreamCleared=${sim.nodeB.upstreamCleared}`);
  await _delay(delayMs);

  // STEP 10 — PAUSE
  const s10ok =
    pillarCheck(3, sim.nodeB.state === NodeBState.READY_TO_REOPEN, `B=READY_TO_REOPEN`) &&
    pillarCheck(3, sim.zones.safe.status === ZoneStatus.SAFE, 'Safe Zone C still SAFE');
  yield emit(10, '⏸ READY TO REOPEN — awaiting human confirmation to proceed',
    s10ok ? TestStatus.SIMULATION_PASS : TestStatus.SIMULATION_FAIL,
    `B=${sim.nodeB.state} | UP=${sim.zones.upstream.status} DN=${sim.zones.downstream.status} SAFE=${sim.zones.safe.status}`,
    { pauseForHuman: true });
  // Generator ends here; caller drives steps 11–13 via resumeFullProof
}
