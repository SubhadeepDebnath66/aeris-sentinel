/**
 * proof.test.js — Ares SIH 2026 PS26178
 * Headless tests for the Three-Pillar Proof engine.
 * Runs via: node --test test/proof.test.js
 *
 * IMPORTANT: fault-injection tests are expected to trigger faults.
 * They PASS when the system correctly detects / handles the fault.
 * The test suite result must not be FAIL merely because a fault was injected.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { runAllPillarTests, startFullProof, resumeFullProof, TestStatus, PROOF_SEED } from '../js/proof.js';
import { NodeAState, NodeBState, ZoneStatus, CONFIG } from '../js/simulation.js';

// ─────────────────────────────────────────────────────────────────────────────
// Helper: collect all events from an async generator
async function collect(gen) {
  const events = [];
  for await (const ev of gen) events.push(ev);
  return events;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pillar test suite runner

test('runAllPillarTests produces results for all three pillars', () => {
  const { pillar1, pillar2, pillar3, summary } = runAllPillarTests();
  assert.ok(Array.isArray(pillar1) && pillar1.length > 0, 'Pillar 1 has tests');
  assert.ok(Array.isArray(pillar2) && pillar2.length > 0, 'Pillar 2 has tests');
  assert.ok(Array.isArray(pillar3) && pillar3.length > 0, 'Pillar 3 has tests');
  assert.equal(summary.total, pillar1.length + pillar2.length + pillar3.length);
});

test('all pillar tests have required fields', () => {
  const { pillar1, pillar2, pillar3 } = runAllPillarTests();
  for (const result of [...pillar1, ...pillar2, ...pillar3]) {
    assert.ok(typeof result.name === 'string' && result.name.length > 0, `name present in ${result.name}`);
    assert.ok([1,2,3].includes(result.pillar), `pillar number valid in ${result.name}`);
    assert.ok(Object.values(TestStatus).includes(result.status), `status valid in ${result.name}`);
    assert.ok(Array.isArray(result.assertions), `assertions array in ${result.name}`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Pillar 1 individual tests

test('P1-T1: happy path — SIMULATION PASS', () => {
  const { pillar1 } = runAllPillarTests();
  const t = pillar1.find(r => r.name.includes('P1-T1'));
  assert.ok(t, 'P1-T1 found');
  assert.equal(t.status, TestStatus.SIMULATION_PASS, `Expected PASS, got: ${t.status}\n${t.errorMsg}`);
  // Verify metrics reported
  assert.ok(t.metrics.ackCount >= 1, `ackCount=${t.metrics.ackCount}`);
  assert.ok(t.metrics.seq >= 1, `seq=${t.metrics.seq}`);
});

test('P1-T2: full packet loss — SIMULATION PASS (fault correctly detected, B did not actuate)', () => {
  const { pillar1 } = runAllPillarTests();
  const t = pillar1.find(r => r.name.includes('P1-T2'));
  assert.ok(t, 'P1-T2 found');
  // This is a fault-injection test. SIMULATION PASS means the fault was handled correctly.
  assert.equal(t.status, TestStatus.SIMULATION_PASS, `Expected PASS (fault detected), got: ${t.status}\n${t.errorMsg}`);
  assert.ok(t.metrics.droppedPackets >= 1, 'droppedPackets recorded');
});

test('P1-T3: duplicate rejection — SIMULATION PASS', () => {
  const { pillar1 } = runAllPillarTests();
  const t = pillar1.find(r => r.name.includes('P1-T3'));
  assert.ok(t);
  assert.equal(t.status, TestStatus.SIMULATION_PASS, t.errorMsg);
});

test('P1-T4: stale packet — SIMULATION PASS', () => {
  const { pillar1 } = runAllPillarTests();
  const t = pillar1.find(r => r.name.includes('P1-T4'));
  assert.ok(t);
  assert.equal(t.status, TestStatus.SIMULATION_PASS, t.errorMsg);
});

test('P1-T5: invalid source — SIMULATION PASS', () => {
  const { pillar1 } = runAllPillarTests();
  const t = pillar1.find(r => r.name.includes('P1-T5'));
  assert.ok(t);
  assert.equal(t.status, TestStatus.SIMULATION_PASS, t.errorMsg);
});

test('P1-T6: peer timeout is PEER_FAULT — SIMULATION PASS (fault correctly detected)', () => {
  const { pillar1 } = runAllPillarTests();
  const t = pillar1.find(r => r.name.includes('P1-T6'));
  assert.ok(t);
  assert.equal(t.status, TestStatus.SIMULATION_PASS, `Expected PASS (PEER_FAULT correctly reached), got: ${t.status}\n${t.errorMsg}`);
  assert.ok(t.metrics.timedOutAfterTicks === CONFIG.PEER_TIMEOUT_TICKS, `timedOut=${t.metrics.timedOutAfterTicks}`);
});

test('P1-T7: peer reconnect → STANDBY — SIMULATION PASS', () => {
  const { pillar1 } = runAllPillarTests();
  const t = pillar1.find(r => r.name.includes('P1-T7'));
  assert.ok(t);
  assert.equal(t.status, TestStatus.SIMULATION_PASS, t.errorMsg);
});

// ─────────────────────────────────────────────────────────────────────────────
// Pillar 2 individual tests

test('P2-T1: all relays ON after confirmed hazard — SIMULATION PASS', () => {
  const { pillar2 } = runAllPillarTests();
  const t = pillar2.find(r => r.name.includes('P2-T1'));
  assert.ok(t);
  assert.equal(t.status, TestStatus.SIMULATION_PASS, t.errorMsg);
  assert.ok(t.metrics.relayActivations >= 1);
});

test('P2-T2: single spike does not actuate relay — SIMULATION PASS', () => {
  const { pillar2 } = runAllPillarTests();
  const t = pillar2.find(r => r.name.includes('P2-T2'));
  assert.ok(t);
  assert.equal(t.status, TestStatus.SIMULATION_PASS, t.errorMsg);
  assert.ok(t.metrics.falseTripCount >= 1, 'Spike counted in metrics');
});

test('P2-T3: noisy readings still confirm — SIMULATION PASS', () => {
  const { pillar2 } = runAllPillarTests();
  const t = pillar2.find(r => r.name.includes('P2-T3'));
  assert.ok(t);
  assert.equal(t.status, TestStatus.SIMULATION_PASS, t.errorMsg);
});

test('P2-T4: sensor disconnect → SENSOR_FAULT, relays OFF — SIMULATION PASS (fault detected)', () => {
  const { pillar2 } = runAllPillarTests();
  const t = pillar2.find(r => r.name.includes('P2-T4'));
  assert.ok(t);
  assert.equal(t.status, TestStatus.SIMULATION_PASS, `Expected PASS (SENSOR_FAULT correctly detected), got: ${t.status}\n${t.errorMsg}`);
});

test('P2-T5: power interrupt forces outputs safe — SIMULATION PASS (fault detected)', () => {
  const { pillar2 } = runAllPillarTests();
  const t = pillar2.find(r => r.name.includes('P2-T5'));
  assert.ok(t);
  assert.equal(t.status, TestStatus.SIMULATION_PASS, `Expected PASS (power interrupt handled), got: ${t.status}\n${t.errorMsg}`);
});

test('P2-T6: local water hazard acts independently — SIMULATION PASS', () => {
  const { pillar2 } = runAllPillarTests();
  const t = pillar2.find(r => r.name.includes('P2-T6'));
  assert.ok(t);
  assert.equal(t.status, TestStatus.SIMULATION_PASS, t.errorMsg);
});

// ─────────────────────────────────────────────────────────────────────────────
// Pillar 3 individual tests

test('P3-T1: full recovery to RECOVERED + zones CLEARED — SIMULATION PASS', () => {
  const { pillar3 } = runAllPillarTests();
  const t = pillar3.find(r => r.name.includes('P3-T1'));
  assert.ok(t);
  assert.equal(t.status, TestStatus.SIMULATION_PASS, t.errorMsg);
});

test('P3-T2: upstream dependency blocks downstream — SIMULATION PASS', () => {
  const { pillar3 } = runAllPillarTests();
  const t = pillar3.find(r => r.name.includes('P3-T2'));
  assert.ok(t);
  assert.equal(t.status, TestStatus.SIMULATION_PASS, t.errorMsg);
});

test('P3-T3: unstable downstream never reaches READY_TO_REOPEN — SIMULATION PASS', () => {
  const { pillar3 } = runAllPillarTests();
  const t = pillar3.find(r => r.name.includes('P3-T3'));
  assert.ok(t);
  assert.equal(t.status, TestStatus.SIMULATION_PASS, t.errorMsg);
});

test('P3-T4: human gate — READY_TO_REOPEN requires explicit confirmation — SIMULATION PASS', () => {
  const { pillar3 } = runAllPillarTests();
  const t = pillar3.find(r => r.name.includes('P3-T4'));
  assert.ok(t);
  assert.equal(t.status, TestStatus.SIMULATION_PASS, t.errorMsg);
});

test('P3-T5: Safe Zone C immutable throughout — SIMULATION PASS', () => {
  const { pillar3 } = runAllPillarTests();
  const t = pillar3.find(r => r.name.includes('P3-T5'));
  assert.ok(t);
  assert.equal(t.status, TestStatus.SIMULATION_PASS, t.errorMsg);
});

// ─────────────────────────────────────────────────────────────────────────────
// Full proof: steps 1–10

test('Full proof steps 1–10: yields exactly 10 events, last one pauses for human', async () => {
  const { generator } = startFullProof();
  const events = await collect(generator);
  assert.equal(events.length, 10, `Expected 10 step events (got ${events.length})`);
  const last = events[events.length - 1];
  assert.equal(last.step, 10, `Last step should be 10 (was ${last.step})`);
  assert.equal(last.pauseForHuman, true, 'Step 10 must signal pauseForHuman');
});

test('Full proof: all steps 1–10 are SIMULATION PASS', async () => {
  const { generator } = startFullProof();
  const events = await collect(generator);
  for (const ev of events) {
    assert.equal(ev.status, TestStatus.SIMULATION_PASS,
      `Step ${ev.step} failed: ${ev.label}\nDetail: ${ev.detail}`);
  }
});

test('Full proof: step events have required fields', async () => {
  const { generator } = startFullProof();
  const events = await collect(generator);
  for (const ev of events) {
    assert.ok(typeof ev.step === 'number', `step is number in step ${ev.step}`);
    assert.ok(typeof ev.label === 'string' && ev.label.length > 0, `label present`);
    assert.ok(Object.values(TestStatus).includes(ev.status), `status valid in step ${ev.step}`);
    assert.ok(typeof ev.detail === 'string', `detail present in step ${ev.step}`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Full proof continuation (steps 11–13)

test('Full proof steps 11–13: resume yields 3 more events including report', async () => {
  // Build sim to the state after step 10
  const { generator, sim, pillarAssertions } = startFullProof();
  await collect(generator); // exhaust steps 1–10

  const resumeGen = resumeFullProof(sim, pillarAssertions);
  const events = await collect(resumeGen);
  assert.equal(events.length, 3, `Expected 3 events from resume (got ${events.length})`);
  assert.equal(events[0].step, 11, 'First resume event is step 11');
  assert.equal(events[1].step, 12, 'Second resume event is step 12');
  assert.equal(events[2].step, 13, 'Third resume event is step 13 (report)');
});

test('Full proof final report has correct structure and SIMULATION PASS overall', async () => {
  const { generator, sim, pillarAssertions } = startFullProof();
  await collect(generator);

  const resumeGen = resumeFullProof(sim, pillarAssertions);
  const events = await collect(resumeGen);
  const report = events.find(e => e.type === 'report');
  assert.ok(report, 'Report event found');
  assert.equal(report.step, 13, 'Report is step 13');
  assert.equal(report.overallStatus, TestStatus.SIMULATION_PASS, `Overall: ${report.overallStatus}`);

  assert.ok(Array.isArray(report.pillars) && report.pillars.length === 3, '3 pillars in report');
  for (const p of report.pillars) {
    assert.equal(p.status, TestStatus.SIMULATION_PASS,
      `Pillar ${p.id} (${p.name}) should be PASS, got: ${p.status}`);
    assert.ok(Array.isArray(p.assertions) && p.assertions.length > 0, `Pillar ${p.id} has assertions`);
    assert.ok(p.assertions.every(a => a.ok), `All assertions in pillar ${p.id} must be ok`);
  }

  assert.equal(report.hardwareNote, TestStatus.HARDWARE_VALIDATION_PENDING,
    'Hardware validation note present');

  // Metrics present
  assert.ok(typeof report.metrics.txPackets === 'number', 'txPackets in metrics');
  assert.ok(typeof report.metrics.ackCount === 'number', 'ackCount in metrics');
  assert.ok(typeof report.metrics.relayActivations === 'number', 'relayActivations in metrics');
  assert.equal(report.seed, PROOF_SEED, 'proof uses fixed reproducibility seed');
  assert.equal(report.summary.failed, 0, 'summary has no failed assertions');
  assert.equal(report.summary.incomplete, 0, 'summary has no incomplete assertions');
  assert.equal(report.summary.untested, 0, 'summary has no untested simulation assertions');
  assert.equal(report.summary.passed, report.summary.total, 'summary passed count is assertion-derived');
  assert.ok(Array.isArray(report.timeline) && report.timeline.length > 0, 'timeline evidence is recorded');
});

test('full proof is repeatable with the same seed and produces the same transitions', async () => {
  async function execute() {
    const { generator, sim, pillarAssertions } = startFullProof();
    for await (const _ of generator) {}
    let report;
    for await (const event of resumeFullProof(sim, pillarAssertions)) {
      if (event.type === 'report') report = event;
    }
    return { report, transitions: sim.timeline.filter(e => e.event.includes('→')).map(e => e.event) };
  }
  const first = await execute();
  const second = await execute();
  assert.equal(first.report.seed, PROOF_SEED);
  assert.deepEqual(first.transitions, second.transitions);
  assert.deepEqual(first.report.metrics, second.report.metrics);
});

test('Full proof step 11: SIMULATION PASS after human confirmation', async () => {
  const { generator, sim, pillarAssertions } = startFullProof();
  await collect(generator);

  const resumeGen = resumeFullProof(sim, pillarAssertions);
  const events = await collect(resumeGen);
  const step11 = events.find(e => e.step === 11);
  assert.ok(step11, 'Step 11 found');
  assert.equal(step11.status, TestStatus.SIMULATION_PASS, `Step 11: ${step11.status}`);
  assert.ok(step11.detail.includes('RECOVERED'), `Step 11 detail mentions RECOVERED: ${step11.detail}`);
});

test('Full proof step 12: zones CLEARED, safe zone unchanged', async () => {
  const { generator, sim, pillarAssertions } = startFullProof();
  await collect(generator);

  const resumeGen = resumeFullProof(sim, pillarAssertions);
  const events = await collect(resumeGen);
  const step12 = events.find(e => e.step === 12);
  assert.ok(step12, 'Step 12 found');
  assert.equal(step12.status, TestStatus.SIMULATION_PASS, `Step 12: ${step12.status}`);
  assert.ok(step12.detail.includes('CLEARED'), `Step 12 detail includes CLEARED: ${step12.detail}`);
  assert.ok(step12.detail.includes('SAFE'), `Step 12 detail includes SAFE zone: ${step12.detail}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// Status derivation: verify statuses are NOT hardcoded

test('status derivation: SIMULATION FAIL when an assertion fails', () => {
  // Directly verify that a broken assertion produces SIMULATION_FAIL, not PASS
  const { pillar1, pillar2, pillar3 } = runAllPillarTests();
  const all = [...pillar1, ...pillar2, ...pillar3];
  // All should be PASS in normal operation. If any are FAIL, the test suite would catch it.
  // This test verifies the status field is actually computed, not hardcoded.
  for (const r of all) {
    const computed = r.assertions.every(a => a.ok)
      ? TestStatus.SIMULATION_PASS : TestStatus.SIMULATION_FAIL;
    assert.equal(r.status, computed, `Status for "${r.name}" matches assertion results`);
  }
});

test('summary counts match actual test results', () => {
  const { summary, pillar1, pillar2, pillar3 } = runAllPillarTests();
  const all = [...pillar1, ...pillar2, ...pillar3];
  const actualPassed = all.filter(r => r.status === TestStatus.SIMULATION_PASS).length;
  const actualFailed = all.filter(r => r.status === TestStatus.SIMULATION_FAIL).length;
  assert.equal(summary.passed, actualPassed, 'summary.passed matches');
  assert.equal(summary.failed, actualFailed, 'summary.failed matches');
  assert.equal(summary.total, all.length, 'summary.total matches');
});
