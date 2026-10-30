import test from 'node:test';
import assert from 'node:assert/strict';
import { Simulation, NodeAState, NodeBState, ZoneStatus, CONFIG } from '../js/simulation.js';
import { CommsLink } from '../js/comms.js';

class ImmediateComms {
  constructor() { this.seq = 0; }
  nextSeq() { return ++this.seq; }
  send(packet, callback) { callback(true, 10, 0); }
}

function runningSim() {
  const sim = new Simulation();
  sim.comms = new ImmediateComms();
  sim.start();
  return sim;
}

test('A: confirmed slope hazard actuates B after validated delivery', () => {
  const sim = runningSim();
  sim.injectSlopeEvent();
  for (let i = 0; i < 8; i++) sim.step();
  assert.equal(sim.nodeA.state, NodeAState.DANGER);
  assert.equal(sim.nodeB.state, NodeBState.ACTUATING);
  assert.equal(sim.nodeB.relay1, true);
  assert.equal(sim.zones.safe.status, ZoneStatus.SAFE);
});

test('B: one slope spike does not actuate or latch', () => {
  const sim = runningSim();
  sim.injectSensorSpike();
  sim.step();
  assert.notEqual(sim.nodeA.state, NodeAState.DANGER);
  assert.equal(sim.nodeB.relay1, false);
});

test('B: local water hazard independently confirms and actuates', () => {
  const sim = runningSim();
  sim.injectWaterContact();
  for (let i = 0; i < 25; i++) sim.step();
  assert.equal(sim.nodeB.state, NodeBState.ACTUATING);
  assert.equal(sim.nodeB.relay2, true);
});

test('B: duplicate and stale messages are rejected without another activation', () => {
  const sim = runningSim();
  const first = { type: 'HAZARD_ALERT', source: 'NODE_A', seq: 4 };
  assert.equal(sim._onNodeBReceive(first), true);
  const activations = sim.metrics.relayActivations;
  assert.equal(sim._onNodeBReceive(first), false);
  assert.equal(sim._onNodeBReceive({ ...first, seq: 3 }), false);
  assert.equal(sim.metrics.relayActivations, activations);
  assert.equal(sim._onNodeBReceive({ type: 'HAZARD_ALERT', source: 'UNKNOWN', seq: 5 }), false);
});

test('peer timeout is a fault and never clearance', () => {
  const sim = runningSim();
  sim.setPeerDisconnected(true);
  for (let i = 0; i < CONFIG.PEER_TIMEOUT_TICKS; i++) sim.step();
  assert.equal(sim.nodeB.state, NodeBState.PEER_FAULT);
  assert.notEqual(sim.nodeB.state, NodeBState.RECOVERED);
});

test('sensor disconnect is explicit fault, not a safe reading', () => {
  const sim = runningSim();
  sim.setSensorConnected('B', false);
  sim.step();
  assert.equal(sim.nodeB.state, NodeBState.SENSOR_FAULT);
  assert.equal(sim.nodeB.relay1, false);
});

test('downstream recovery needs local stability, upstream clearance, then human confirmation', () => {
  const sim = runningSim();
  sim.nodeB.state = NodeBState.RECOVERY_PENDING;
  sim.nodeB.sensorRaw = 0;
  for (let i = 0; i < CONFIG.RECOVER_NEEDED + 1; i++) sim.step();
  assert.equal(sim.nodeB.state, NodeBState.RECOVERY_PENDING);
  sim.nodeB.upstreamCleared = true;
  sim.step();
  assert.equal(sim.nodeB.state, NodeBState.READY_TO_REOPEN);
  sim.confirmRecovery();
  sim.step();
  assert.equal(sim.nodeB.state, NodeBState.RECOVERED);
  assert.equal(sim.zones.downstream.status, ZoneStatus.CLEARED);
});

test('unstable downstream readings never become ready to reopen', () => {
  const sim = runningSim();
  sim.nodeB.state = NodeBState.RECOVERY_PENDING;
  sim.nodeB.upstreamCleared = true;
  sim.nodeB._waterActive = true;
  sim.nodeB.sensorRaw = CONFIG.WATER_THRESHOLD;
  for (let i = 0; i < CONFIG.RECOVER_NEEDED + 2; i++) sim.step();
  assert.equal(sim.nodeB.state, NodeBState.RECOVERY_PENDING);
});

test('unaffected safe zone remains immutable', () => {
  const sim = runningSim();
  sim.injectWaterContact();
  for (let i = 0; i < 25; i++) sim.step();
  assert.equal(sim.zones.safe.status, ZoneStatus.SAFE);
});

test('bounded retry reports explicit communication failure after packet loss', async () => {
  const link = new CommsLink();
  link.delayMs = 1;
  link.jitterMs = 0;
  link.lossRate = 1;
  const result = await new Promise(resolve => link.send({ type: 'HAZARD_ALERT' },
    (delivered, latency, retries) => resolve({ delivered, latency, retries })));
  assert.equal(result.delivered, false);
  assert.equal(result.retries, link.maxRetries);
  assert.ok(result.latency > 0);
  link.cancelAll();
});

test('simulation records retries and drops when the real CommsLink loses the alert', async () => {
  const sim = runningSim();
  const link = new CommsLink();
  link.delayMs = 1;
  link.jitterMs = 0;
  link.lossRate = 1;
  sim.comms = link;
  sim.injectSlopeEvent();
  for (let i = 0; i < 10; i++) sim.step();
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.equal(sim.nodeA.state, NodeAState.DANGER);
  assert.equal(sim.nodeB.state, NodeBState.STANDBY);
  assert.equal(sim.metrics.droppedPackets, 1);
  assert.equal(sim.metrics.retries, link.maxRetries);
  link.cancelAll();
});

test('power interruption preserves documented state but forces B outputs safe', () => {
  const sim = runningSim();
  sim.nodeB.state = NodeBState.ACTUATING;
  sim.nodeB.relay1 = true;
  sim.powerInterrupt('B', 1);
  sim.step();
  assert.equal(sim.nodeB.state, NodeBState.ACTUATING);
  assert.equal(sim.nodeB.relay1, false);
});

test('reset clears state, outputs, sequence and measured metrics', () => {
  const sim = runningSim();
  sim.nodeB.state = NodeBState.ACTUATING;
  sim.nodeB.relay1 = true;
  sim.metrics.txPackets = 4;
  sim.comms = new CommsLink();
  sim.comms.nextSeq();
  sim.reset();
  assert.equal(sim.nodeA.state, NodeAState.IDLE);
  assert.equal(sim.nodeB.state, NodeBState.IDLE);
  assert.equal(sim.nodeB.relay1, false);
  assert.equal(sim.metrics.txPackets, 0);
  assert.equal(sim.comms._seq, 0);
});

test('seeded simulation reset restarts the deterministic sensor stream', () => {
  const sim = new Simulation({ seed: 77 });
  const first = sim._random();
  sim.reset();
  assert.equal(sim._random(), first);
});
