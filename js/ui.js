/**
 * ui.js — Backlog Champions SIH 2026 PS26178
 * DOM rendering + event wiring. Reads simulation state, writes to DOM only.
 */

'use strict';

import { Simulation, NodeAState, NodeBState, ZoneStatus, CONFIG } from './simulation.js';
import { CommsLink } from './comms.js';
import {
  TestStatus,
  runAllPillarTests,
  startFullProof,
  resumeFullProof,
  runPillar1Tests,
  runPillar2Tests,
  runPillar3Tests,
  runSingleTest,
} from './proof.js';

// ─── Bootstrap ────────────────────────────────────────────────────────────────
const sim = new Simulation();
const comms = new CommsLink();
sim.comms = comms;

// Packet animation queue
let tickerInterval = null;

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

// Clock
function updateClock() {
  const el = $('sim-clock');
  if (el) el.textContent = new Date().toLocaleTimeString('en-IN', { hour12: false });
}
setInterval(updateClock, 1000);
updateClock();

// ─── Render ───────────────────────────────────────────────────────────────────
function render() {
  const A = sim.nodeA;
  const B = sim.nodeB;
  const M = sim.metrics;
  const Z = sim.zones;

  // ── Node A ────────────────────────────────────────────────────────────────
  setStateChip('na-state', A.state, stateColorA(A.state));
  setNodeBoxClass('na-box', stateColorA(A.state));
  setText('na-sensor', fmt1(A.sensorDisplay) + ' mm');
  setMeter('na-meter', A.sensorDisplay, 0, 120, CONFIG.SLOPE_THRESHOLD);
  setText('na-confirm', `${A.aboveCount}/${CONFIG.CONFIRM_NEEDED}`);
  setLed('na-buzzer-led', A.buzzer, 'amber');
  setLed('na-alert-led', A.led, 'red');
  setText('na-noisy', A.noisy ? 'ON' : 'OFF');

  // Power interrupt display
  const piaEl = $('na-power');
  if (piaEl) {
    if (sim._powerInterruptA > 0) {
      piaEl.textContent = `OFFLINE (${Math.ceil(sim._powerInterruptA * CONFIG.TICK_MS / 1000)}s)`;
      piaEl.className = 'power-label fault';
    } else {
      piaEl.textContent = 'ONLINE';
      piaEl.className = 'power-label ok';
    }
  }

  // ── Communication link ────────────────────────────────────────────────────
  const linkHealth = Math.round(comms.health * 100);
  setText('link-health', linkHealth + '%');
  $('link-health').className = 'link-val ' + (linkHealth > 60 ? 'ok' : linkHealth > 30 ? 'warn' : 'fault');
  setText('link-loss', Math.round(comms.lossRate * 100) + '%');
  setText('link-latency', fmt1(M.latencyMs) + ' ms');
  setText('link-seq', comms._seq);
  setText('link-retries', M.retries);
  setText('link-drops', M.droppedPackets);

  // Link health bar
  const hbar = $('link-hbar');
  if (hbar) {
    hbar.style.width = linkHealth + '%';
    hbar.className = 'hbar-fill ' + (linkHealth > 60 ? 'ok' : linkHealth > 30 ? 'warn' : 'fault');
  }

  // Peer status badge
  const peerEl = $('peer-status');
  if (peerEl) {
    peerEl.textContent = B.peerConnected ? 'CONNECTED' : 'DISCONNECTED';
    peerEl.className = 'peer-badge ' + (B.peerConnected ? 'ok' : 'fault');
  }

  // ── Node B ────────────────────────────────────────────────────────────────
  setStateChip('nb-state', B.state, stateColorB(B.state));
  setNodeBoxClass('nb-box', stateColorB(B.state));
  setText('nb-sensor', fmt1(B.sensorDisplay) + ' %');
  setMeter('nb-meter', B.sensorDisplay, 0, 100, CONFIG.WATER_THRESHOLD);
  setLed('nb-relay1', B.relay1, 'cyan');
  setLed('nb-relay2', B.relay2, 'cyan');
  setLed('nb-fan', B.fan, 'blue');
  setLed('nb-lamp', B.lamp, 'amber');
  setLed('nb-buzzer-led', B.buzzer, 'amber');
  setLed('nb-zled-up', B.zoneLedUpstream, 'red');
  setLed('nb-zled-down', B.zoneLedDownstream, 'red');

  const pibEl = $('nb-power');
  if (pibEl) {
    if (sim._powerInterruptB > 0) {
      pibEl.textContent = `OFFLINE (${Math.ceil(sim._powerInterruptB * CONFIG.TICK_MS / 1000)}s)`;
      pibEl.className = 'power-label fault';
    } else {
      pibEl.textContent = 'ONLINE';
      pibEl.className = 'power-label ok';
    }
  }

  // ── Zones ─────────────────────────────────────────────────────────────────
  renderZone('zone-upstream', Z.upstream);
  renderZone('zone-downstream', Z.downstream);
  renderZone('zone-safe', Z.safe);

  // ── Metrics ───────────────────────────────────────────────────────────────
  setText('m-tx', M.txPackets);
  setText('m-rx', M.rxPackets);
  setText('m-ack', M.ackCount);
  setText('m-retry', M.retries);
  setText('m-drop', M.droppedPackets);
  setText('m-relay', M.relayActivations);
  setText('m-false', M.falseTripCount);
  setText('m-lat', fmt1(M.latencyAvg) + ' ms');

  // ── Timeline ─────────────────────────────────────────────────────────────
  renderTimeline();

  // ── Run controls ─────────────────────────────────────────────────────────
  $('btn-start').disabled = sim.running;
  $('btn-pause').disabled = !sim.running;

  // ── Packet animation ─────────────────────────────────────────────────────
  tickPacketAnimations();
}

// ─── Zone rendering ───────────────────────────────────────────────────────────
function renderZone(id, zone) {
  const el = $(id);
  if (!el) return;
  el.className = 'zone-card ' + zone.status.toLowerCase();
  const badge = el.querySelector('.zone-badge');
  if (badge) badge.textContent = zone.status;
}

// ─── Timeline ─────────────────────────────────────────────────────────────────
let lastTimelineLength = 0;
function renderTimeline() {
  if (sim.timeline.length === lastTimelineLength) return;
  lastTimelineLength = sim.timeline.length;
  const el = $('timeline');
  if (!el) return;
  el.innerHTML = sim.timeline.slice(0, 60).map(e => `
    <div class="tl-row">
      <span class="tl-tick">T+${e.tick}</span>
      <span class="tl-ts">${e.ts}</span>
      <span class="tl-event">${e.event}</span>
      ${e.detail ? `<span class="tl-detail">${e.detail}</span>` : ''}
    </div>`).join('');
}

// ─── Packet animation ─────────────────────────────────────────────────────────
function spawnPacket(dir = 'atob') {
  const svgEl = $('link-svg');
  if (!svgEl) return;
  const pkt = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  pkt.setAttribute('r', '5');
  pkt.setAttribute('fill', dir === 'atob' ? '#00e5ff' : '#00c853');
  pkt.setAttribute('opacity', '0.9');

  // Animate along path
  const pathEl = $('link-path');
  const len = pathEl ? pathEl.getTotalLength() : 200;

  let progress = dir === 'atob' ? 0 : 1;
  const speed = 0.015;

  svgEl.appendChild(pkt);

  function animate() {
    progress += dir === 'atob' ? speed : -speed;
    if (progress < 0 || progress > 1) {
      svgEl.removeChild(pkt);
      return;
    }
    if (!pathEl) return;
    const pt = pathEl.getPointAtLength(progress * len);
    pkt.setAttribute('cx', pt.x);
    pkt.setAttribute('cy', pt.y);
    requestAnimationFrame(animate);
  }
  requestAnimationFrame(animate);
}

function tickPacketAnimations() {
  // Spawn a packet occasionally when sim is running and a hazard alert was sent
  if (sim.running && sim.nodeA.state === NodeAState.DANGER && Math.random() < 0.06) {
    spawnPacket('atob');
  }
  if (sim.running && sim.nodeB.state === NodeBState.ACTUATING && Math.random() < 0.04) {
    spawnPacket('btoa');
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function setText(id, val) {
  const el = $(id);
  if (el) el.textContent = val;
}

function fmt1(v) {
  return (typeof v === 'number' ? v.toFixed(1) : '0.0');
}

function setStateChip(id, state, color) {
  const el = $(id);
  if (!el) return;
  el.textContent = state;
  el.className = 'state-chip ' + color;
}

function stateColorA(s) {
  return {
    IDLE: 'idle', MONITORING: 'ok', CONFIRMING: 'warn',
    DANGER: 'fault', RECOVERY_PENDING: 'warn', READY_TO_REOPEN: 'warn', RECOVERED: 'ok', SENSOR_FAULT: 'fault',
  }[s] || 'idle';
}

function stateColorB(s) {
  return {
    IDLE: 'idle', STANDBY: 'ok', ACTUATING: 'fault',
    PEER_FAULT: 'fault', RECOVERY_PENDING: 'warn', READY_TO_REOPEN: 'warn', RECOVERED: 'ok', SENSOR_FAULT: 'fault',
  }[s] || 'idle';
}

function setLed(id, on, color) {
  const el = $(id);
  if (!el) return;
  el.className = `led ${on ? 'on ' + color : 'off'}`;
}

function setNodeBoxClass(id, color) {
  const el = $(id);
  if (!el) return;
  el.className = 'node-box ' + (color === 'fault' ? 'danger' : color === 'warn' ? 'warn' : color === 'ok' ? 'ok' : '');
}

function setMeter(id, val, min, max, threshold) {
  const el = $(id);
  if (!el) return;
  const pct = Math.max(0, Math.min(100, ((val - min) / (max - min)) * 100));
  const tpct = ((threshold - min) / (max - min)) * 100;
  const fill = el.querySelector('.meter-fill');
  const tick = el.querySelector('.meter-threshold');
  const label = el.querySelector('.meter-label');
  if (fill) {
    fill.style.width = pct + '%';
    fill.className = 'meter-fill ' + (val >= threshold ? 'danger' : 'normal');
  }
  if (tick) tick.style.left = tpct + '%';
  if (label) label.textContent = fmt1(val);
}

// ─── Control wiring ───────────────────────────────────────────────────────────
function wireControls() {
  $('btn-start').addEventListener('click', () => { sim.start(); startTicker(); });
  $('btn-pause').addEventListener('click', () => sim.pause());
  $('btn-reset').addEventListener('click', () => {
    stopTicker();
    comms.cancelAll();
    sim.reset();
    render();
  });

  $('btn-inject-slope').addEventListener('click', () => sim.injectSlopeEvent());
  $('btn-inject-water').addEventListener('click', () => sim.injectWaterContact());
  $('btn-inject-spike').addEventListener('click', () => sim.injectSensorSpike());
  $('btn-begin-recovery').addEventListener('click', () => sim.beginRecovery());
  $('btn-confirm-recovery').addEventListener('click', () => sim.confirmRecovery());

  const noisyToggle = $('toggle-noisy');
  noisyToggle.addEventListener('change', () => sim.setNoisy(noisyToggle.checked));

  const delayAckToggle = $('toggle-delay-ack');
  delayAckToggle.addEventListener('change', () => comms.setDelayedAck(delayAckToggle.checked));

  const peerDisconnToggle = $('toggle-peer-disconnect');
  peerDisconnToggle.addEventListener('change', () => sim.setPeerDisconnected(peerDisconnToggle.checked));

  const lossSlider = $('slider-loss');
  const lossVal = $('loss-val');
  lossSlider.addEventListener('input', () => {
    const v = lossSlider.value / 100;
    comms.setLossRate(v);
    lossVal.textContent = lossSlider.value + '%';
  });

  $('btn-power-a').addEventListener('click', () => sim.powerInterrupt('A', 5));
  $('btn-power-b').addEventListener('click', () => sim.powerInterrupt('B', 5));
}

// ─── Ticker ───────────────────────────────────────────────────────────────────
function startTicker() {
  if (tickerInterval) return;
  tickerInterval = setInterval(() => {
    sim.step();
    render();
  }, CONFIG.TICK_MS);
}

function stopTicker() {
  clearInterval(tickerInterval);
  tickerInterval = null;
}

// ─── Init ─────────────────────────────────────────────────────────────────────
wireControls();
render();
initProofEnvironment();

// =============================================================================
// Three-Pillar Proof Environment Controller
// =============================================================================

function initProofEnvironment() {
  // Tab switcher
  const tabTwin = $('tab-btn-twin');
  const tabProof = $('tab-btn-proof');
  const viewTwin = $('view-digital-twin');
  const viewProof = $('view-three-pillar-proof');

  if (tabTwin && tabProof && viewTwin && viewProof) {
    tabTwin.addEventListener('click', () => {
      tabTwin.classList.add('active');
      tabProof.classList.remove('active');
      viewTwin.style.display = 'flex';
      viewProof.style.display = 'none';
    });
    tabProof.addEventListener('click', () => {
      tabProof.classList.add('active');
      tabTwin.classList.remove('active');
      viewProof.style.display = 'flex';
      viewTwin.style.display = 'none';
    });
  }

  // Stepper definition
  const PROOF_STEPS = [
    { num: 1,  name: 'Initialise States', desc: 'Verify starting states for both nodes & all zones' },
    { num: 2,  name: 'Slope Hazard',      desc: 'Inject confirmed slope hazard at Node A' },
    { num: 3,  name: 'Hazard Alert TX',   desc: 'Confirmed DANGER & transmit HAZARD_ALERT' },
    { num: 4,  name: 'Comms Delivery',    desc: 'Verify seq#, ACK, latency & retries' },
    { num: 5,  name: 'Node B Processing', desc: 'Node B validates and transitions to ACTUATING' },
    { num: 6,  name: 'Relay Actuation',   desc: 'Simulated relays, fan, lamp & buzzer ON' },
    { num: 7,  name: 'Begin Recovery',    desc: 'Operator initiates safe recovery' },
    { num: 8,  name: 'Clear Upstream',    desc: 'Node A stable: clear upstream & send RECOVERY_CLEAR' },
    { num: 9,  name: 'Verify Downstream', desc: 'Verify local stability & upstream clearance' },
    { num: 10, name: 'READY TO REOPEN',   desc: 'Pause downstream reopening for human confirmation' },
    { num: 11, name: 'Human Confirm',     desc: 'Explicit human operator authorization' },
    { num: 12, name: 'Verify Zones',      desc: 'Zones CLEARED, Safe Zone C remains SAFE' },
    { num: 13, name: 'Final Report',      desc: 'Multi-pillar audit report & overall verdict' },
  ];

  // Render initial stepper track
  const stepperTrack = $('stepper-track');
  function renderStepperTrack(activeStep = 0, isPaused = false) {
    if (!stepperTrack) return;
    stepperTrack.innerHTML = PROOF_STEPS.map(s => {
      let cls = 'stepper-step';
      if (s.num < activeStep) cls += ' passed';
      else if (s.num === activeStep) {
        cls += isPaused ? ' paused' : ' active';
      }
      return `
        <div class="${cls}" title="Step ${s.num}: ${s.name} — ${s.desc}">
          <span class="stepper-step-num">${s.num}</span>
          <div class="stepper-step-dot"></div>
          <span style="font-size:9px; color:var(--text-dim); text-align:center; line-height:1.1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:64px;">${s.name}</span>
        </div>`;
    }).join('');
  }
  renderStepperTrack(0);

  // Test suite state (18 unit / fault tests)
  let testResultsMap = new Map();

  // Test definitions for initial rendering
  const INITIAL_TESTS = [
    { id: 'P1-T1', name: 'P1-T1 Happy path: HAZARD_ALERT delivered with ACK', pillar: 1, desc: 'Normal hazard alert delivered to Node B with sequence #, round-trip latency and ACK recorded.' },
    { id: 'P1-T2', name: 'P1-T2 Fault: full packet loss → SIMULATION PASS (fault correctly detected)', pillar: 1, desc: 'Fault: 100% packet loss injected. Verifies drop detection and ensures Node B does NOT false trip.' },
    { id: 'P1-T3', name: 'P1-T3 Fault: duplicate message rejected, no extra relay activation', pillar: 1, desc: 'Fault: Duplicate sequence number packet transmitted. Verifies rejection and no duplicate actuation.' },
    { id: 'P1-T4', name: 'P1-T4 Fault: stale packet (older seq) rejected', pillar: 1, desc: 'Fault: Older sequence number transmitted. Verifies rejection and state monotonicity preserved.' },
    { id: 'P1-T5', name: 'P1-T5 Fault: invalid source field rejected', pillar: 1, desc: 'Fault: Packet with unknown source rejected immediately without relay state change.' },
    { id: 'P1-T6', name: 'P1-T6 Fault: peer timeout → PEER_FAULT, not safe/clear', pillar: 1, desc: 'Fault: Node A heartbeat stopped. Verifies Node B transitions to PEER_FAULT and never false-clears.' },
    { id: 'P1-T7', name: 'P1-T7 Recovery: peer reconnect restores STANDBY', pillar: 1, desc: 'Recovery: Heartbeat restored. Verifies transition from PEER_FAULT back to STANDBY.' },

    { id: 'P2-T1', name: 'P2-T1 Happy path: all relay outputs ON after sustained hazard', pillar: 2, desc: 'Hazard confirmation: CH1 siren power, CH2 barrier, fan, lamp and warning buzzer all activated.' },
    { id: 'P2-T2', name: 'P2-T2 Spike immunity: one spike never actuates relay', pillar: 2, desc: 'Fault immunity: Single displacement spike filtered by confirmation window; false trip prevented.' },
    { id: 'P2-T3', name: 'P2-T3 Noise: sustained hazard confirms despite ±40% noise', pillar: 2, desc: 'Noise tolerance: ±40% simulated noise injected. Sustained slope hazard confirms reliably.' },
    { id: 'P2-T4', name: 'P2-T4 Fault: sensor disconnect → SENSOR_FAULT, relays OFF', pillar: 2, desc: 'Fault: Sensor disconnected. Verifies explicit SENSOR_FAULT and fail-safe relay de-energisation.' },
    { id: 'P2-T5', name: 'P2-T5 Fault: power interrupt forces B outputs safe, preserves state', pillar: 2, desc: 'Fault: Power interruption forces physical outputs safe while latching state in memory.' },
    { id: 'P2-T6', name: 'P2-T6 Independence: local water hazard actuates B without Node A', pillar: 2, desc: 'Local autonomy: High water-contact at Node B actuates local barrier without Node A input.' },

    { id: 'P3-T1', name: 'P3-T1 Happy path: full recovery to RECOVERED + zones CLEARED', pillar: 3, desc: 'Full lifecycle: Sensor stabilization, upstream clearance, human confirmation gate, zones CLEARED.' },
    { id: 'P3-T2', name: 'P3-T2 Upstream dependency: downstream blocked without upstream clearance', pillar: 3, desc: 'Dependency: Downstream sensor is stable, but downstream remains CLOSED because upstream is uncleared.' },
    { id: 'P3-T3', name: 'P3-T3 Stability gate: unstable readings block READY_TO_REOPEN', pillar: 3, desc: 'Stability gate: Downstream water reading unstable; prevents entering READY_TO_REOPEN.' },
    { id: 'P3-T4', name: 'P3-T4 Human gate: READY_TO_REOPEN without confirmation stays pending', pillar: 3, desc: 'Human gate: System reaches READY_TO_REOPEN but remains closed until operator authorizes.' },
    { id: 'P3-T5', name: 'P3-T5 Immutability: Safe Zone C never changes through entire lifecycle', pillar: 3, desc: 'Zone integrity: Designated Safe Zone C remains SAFE through hazard, actuation, fault and recovery.' },
  ];

  INITIAL_TESTS.forEach(t => testResultsMap.set(t.name, { ...t, status: TestStatus.NOT_TESTED, assertions: [] }));

  let activeFilter = 'all';

  function renderTestCards() {
    const grid = $('test-cards-grid');
    if (!grid) return;
    const cards = [];

    INITIAL_TESTS.forEach(def => {
      if (activeFilter !== 'all' && String(def.pillar) !== String(activeFilter)) return;
      const res = testResultsMap.get(def.name) || def;
      const statusCls = res.status === TestStatus.SIMULATION_PASS ? 'sim-pass' :
                        res.status === TestStatus.SIMULATION_FAIL ? 'sim-fail' : 'not-tested';

      let assertionsHtml = '';
      if (res.assertions && res.assertions.length > 0) {
        assertionsHtml = `
          <div class="assertion-list" style="margin-top:6px; border-top:1px solid rgba(30,45,66,0.5); padding-top:6px;">
            ${res.assertions.map(a => `
              <div class="assertion-row">
                <span class="assertion-icon ${a.ok ? 'pass' : 'fail'}">${a.ok ? '✔' : '✖'}</span>
                <span style="font-size:10px; color:${a.ok ? 'var(--text)' : 'var(--red)'};">${a.label}</span>
              </div>`).join('')}
          </div>`;
      }

      let metricsHtml = '';
      if (res.metrics && Object.keys(res.metrics).length > 0) {
        metricsHtml = `
          <div style="font-family:var(--mono); font-size:10px; color:var(--cyan); margin-top:4px;">
            ${Object.entries(res.metrics).map(([k, v]) => `${k}: <strong>${v}</strong>`).join(' | ')}
          </div>`;
      }

      cards.push(`
        <div class="test-card" id="card-${def.id}">
          <div class="test-card-top">
            <div>
              <div style="display:flex; align-items:center; gap:6px;">
                <span class="tab-badge" style="font-size:9px;">Pillar ${def.pillar}</span>
                <span class="test-card-title">${def.name}</span>
              </div>
              <div style="font-size:11px; color:var(--text-dim); margin-top:4px; line-height:1.4;">${def.desc}</div>
            </div>
            <span class="proof-pill ${statusCls}" style="flex-shrink:0;">${res.status}</span>
          </div>
          ${assertionsHtml}
          ${metricsHtml}
          <div class="test-card-footer">
            <span style="font-size:10px; color:var(--text-dim); font-family:var(--mono);">
              ${res.assertions && res.assertions.length > 0 ? `${res.assertions.filter(a => a.ok).length}/${res.assertions.length} assertions passed` : 'Not run'}
            </span>
            <button class="btn-run-single" data-test="${def.name}">Run Scenario</button>
          </div>
        </div>`);
    });

    grid.innerHTML = cards.join('');

    // Wire individual run buttons
    grid.querySelectorAll('.btn-run-single').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const testName = e.currentTarget.getAttribute('data-test');
        runSingleScenario(testName);
      });
    });

    updateSuiteSummary();
  }

  function updateSuiteSummary() {
    const summaryText = $('test-suite-summary-text');
    if (!summaryText) return;
    const all = Array.from(testResultsMap.values());
    const pass = all.filter(t => t.status === TestStatus.SIMULATION_PASS).length;
    const fail = all.filter(t => t.status === TestStatus.SIMULATION_FAIL).length;
    const un = all.filter(t => t.status === TestStatus.NOT_TESTED).length;
    summaryText.innerHTML = `Tests: <strong style="color:var(--text-hi)">${all.length}</strong> | PASS: <strong style="color:var(--green)">${pass}</strong> | FAIL: <strong style="color:var(--red)">${fail}</strong> | Pending: <strong style="color:var(--text-dim)">${un}</strong>`;
  }

  // Filter pills
  ['all', '1', '2', '3'].forEach(f => {
    const btn = $(`btn-filter-${f === 'all' ? 'all' : 'p' + f}`);
    if (btn) {
      btn.addEventListener('click', () => {
        activeFilter = f;
        document.querySelectorAll('.filter-pill-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        renderTestCards();
      });
    }
  });

  // Run single scenario
  function runSingleScenario(testName) {
    const res = runSingleTest(testName);
    if (res) {
      testResultsMap.set(res.name, res);
      renderTestCards();
    }
  }

  // Run suite helpers
  function runSuite(fn) {
    const tests = fn();
    tests.forEach(t => testResultsMap.set(t.name, t));
    renderTestCards();
  }

  $('btn-run-p1').addEventListener('click', () => runSuite(runPillar1Tests));
  $('btn-run-p2').addEventListener('click', () => runSuite(runPillar2Tests));
  $('btn-run-p3').addEventListener('click', () => runSuite(runPillar3Tests));
  $('btn-run-all-tests').addEventListener('click', () => {
    const { pillar1, pillar2, pillar3 } = runAllPillarTests();
    [...pillar1, ...pillar2, ...pillar3].forEach(t => testResultsMap.set(t.name, t));
    renderTestCards();
  });

  renderTestCards();

  // ── Continuous Full Proof Scenario Runner ──────────────────
  let isFullProofRunning = false;
  let pendingResume = null;

  const btnRunFullProof = $('btn-run-full-proof');
  const humanGatePrompt = $('human-gate-prompt');
  const btnHumanConfirmProof = $('btn-human-confirm-proof');
  const streamTbody = $('proof-stream-tbody');
  const reportSection = $('proof-report-section');
  const bannerStatus = $('proof-banner-status');
  let lastProofReport = null;

  function getStepDelay() {
    const sel = $('proof-speed');
    return sel ? parseInt(sel.value, 10) : 350;
  }

  function setProofStatusPill(el, status) {
    if (!el) return;
    el.textContent = status;
    el.className = 'proof-pill ' + (
      status === TestStatus.SIMULATION_PASS ? 'sim-pass' :
      status === TestStatus.SIMULATION_FAIL ? 'sim-fail' : 'not-tested'
    );
  }

  btnRunFullProof.addEventListener('click', async () => {
    if (isFullProofRunning) return;
    isFullProofRunning = true;
    btnRunFullProof.disabled = true;
    reportSection.style.display = 'none';
    humanGatePrompt.style.display = 'none';
    streamTbody.innerHTML = '';

    const delayMs = getStepDelay();
    $('stepper-status-chip').textContent = 'RUNNING';
    $('stepper-status-chip').className = 'proof-pill not-tested';
    setProofStatusPill(bannerStatus, 'RUNNING');

    const { generator, sim, pillarAssertions } = startFullProof(delayMs);

    for await (const ev of generator) {
      handleStepEvent(ev);

      if (ev.pauseForHuman) {
        // Paused at step 10!
        $('stepper-step-counter').textContent = 'Step 10 / 13 (Paused)';
        $('stepper-status-chip').textContent = '⏸ READY TO REOPEN (PAUSED)';
        $('stepper-status-chip').className = 'proof-pill hw-pending';
        renderStepperTrack(10, true);
        humanGatePrompt.style.display = 'flex';
        pendingResume = { sim, pillarAssertions, delayMs };
        return; // generator yields, we wait for human click
      }
    }
  });

  btnHumanConfirmProof.addEventListener('click', async () => {
    if (!pendingResume) return;
    humanGatePrompt.style.display = 'none';
    const { sim, pillarAssertions, delayMs } = pendingResume;
    pendingResume = null;

    $('stepper-step-counter').textContent = 'Step 11 / 13';
    $('stepper-status-chip').textContent = 'CONFIRMED — RESUMING';
    $('stepper-status-chip').className = 'proof-pill not-tested';

    const resumeGen = resumeFullProof(sim, pillarAssertions, delayMs);

    for await (const ev of resumeGen) {
      if (ev.type === 'report') {
        renderFinalReport(ev);
      } else {
        handleStepEvent(ev);
      }
    }

    isFullProofRunning = false;
    btnRunFullProof.disabled = false;
  });

  function handleStepEvent(ev) {
    $('stepper-step-counter').textContent = `Step ${ev.step} / 13`;
    renderStepperTrack(ev.step, Boolean(ev.pauseForHuman));

    const statusBadge = `
      <span class="proof-pill ${ev.status === TestStatus.SIMULATION_PASS ? 'sim-pass' : 'sim-fail'}">
        ${ev.status}
      </span>`;

    const now = new Date();
    const ts = now.toTimeString().split(' ')[0] + '.' + String(now.getMilliseconds()).padStart(3, '0');

    const row = document.createElement('tr');
    row.className = 'current-step';
    row.innerHTML = `
      <td style="font-family:var(--mono); font-weight:700; color:var(--cyan);">T+${ev.step}</td>
      <td>${statusBadge}</td>
      <td>
        <div style="font-weight:600; color:var(--text-hi);">${ev.label}</div>
        <div style="font-family:var(--mono); font-size:11px; color:var(--text-dim); margin-top:2px;">${ev.detail}</div>
        <div style="font-size:10px; color:var(--text-dim); margin-top:2px;">Timestamp: ${ts}</div>
      </td>`;

    // Remove current-step class from previous rows
    streamTbody.querySelectorAll('tr').forEach(r => r.classList.remove('current-step'));
    streamTbody.appendChild(row);
    row.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function renderFinalReport(rep) {
    lastProofReport = rep;
    reportSection.style.display = 'flex';
    setProofStatusPill($('report-overall-badge'), rep.overallStatus);
    setProofStatusPill(bannerStatus, rep.overallStatus);
    $('stepper-status-chip').textContent = rep.overallStatus;
    $('stepper-status-chip').className = 'proof-pill ' + (rep.overallStatus === TestStatus.SIMULATION_PASS ? 'sim-pass' : 'sim-fail');
    renderStepperTrack(13, false);

    // Pillars 1, 2, 3
    rep.pillars.forEach(p => {
      setProofStatusPill($(`p${p.id}-report-status`), p.status);
      const listEl = $(`p${p.id}-assertions-list`);
      if (listEl) {
        listEl.innerHTML = p.assertions.map(a => `
          <div class="assertion-row">
            <span class="assertion-icon ${a.ok ? 'pass' : 'fail'}">${a.ok ? '✔' : '✖'}</span>
            <span>${a.label}</span>
          </div>`).join('');
      }
    });

    // Metrics
    const m = rep.metrics;
    if (m) {
      setText('rep-m-seq', m.seq ?? rep.metrics.txPackets);
      setText('rep-m-lat', m.latencyAvg);
      setText('rep-m-tx', m.txPackets);
      setText('rep-m-ack', m.ackCount);
      setText('rep-m-retry', m.retries);
      setText('rep-m-relay', m.relayActivations);
      setText('rep-m-false', m.falseTripCount);
      setText('rep-m-trans', m.transitionCount);
    }
    const summary = rep.summary || {};
    setText('proof-report-summary',
      `Assertions: ${summary.passed ?? 0} passed / ${summary.failed ?? 0} failed / ` +
      `${summary.incomplete ?? 0} incomplete / ${summary.untested ?? 0} untested | ` +
      `Seed: ${rep.seed ?? 'random'} | Hardware: ${summary.hardwareValidation || rep.hardwareNote}`);
  }

  function downloadText(filename, content, type) {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
  }

  function csvCell(value) {
    return `"${String(value ?? '').replaceAll('"', '""')}"`;
  }

  $('btn-download-proof-json').addEventListener('click', () => {
    if (!lastProofReport) return;
    downloadText('ares-proof-evidence.json', JSON.stringify(lastProofReport, null, 2), 'application/json');
  });

  $('btn-download-proof-csv').addEventListener('click', () => {
    if (!lastProofReport) return;
    const rows = [['kind', 'step', 'status', 'label', 'detail', 'tick', 'timestamp', 'event']];
    (lastProofReport.pillars || []).forEach(p => (p.assertions || []).forEach(a =>
      rows.push(['assertion', '', a.ok ? TestStatus.SIMULATION_PASS : TestStatus.SIMULATION_FAIL, a.label, '', '', '', ''])));
    (lastProofReport.timeline || []).forEach(e =>
      rows.push(['timeline', e.tick, '', '', e.detail, e.tick, e.ts, e.event]));
    downloadText('ares-proof-evidence.csv', rows.map(row => row.map(csvCell).join(',')).join('\n'), 'text/csv');
  });

  // Reset proof environment
  $('btn-reset-proof').addEventListener('click', () => {
    isFullProofRunning = false;
    pendingResume = null;
    btnRunFullProof.disabled = false;
    humanGatePrompt.style.display = 'none';
    reportSection.style.display = 'none';
    lastProofReport = null;
    setText('proof-report-summary', '');
    streamTbody.innerHTML = `
      <tr>
        <td colspan="3" style="text-align:center; padding:18px; color:var(--text-dim); font-family:var(--mono);">
          Click "▶ Run Full Proof" to execute the 13-step continuous verification sequence.
        </td>
      </tr>`;
    $('stepper-step-counter').textContent = 'Step 0 / 13';
    $('stepper-status-chip').textContent = 'NOT STARTED';
    $('stepper-status-chip').className = 'proof-pill not-tested';
    setProofStatusPill(bannerStatus, 'NOT TESTED');
    renderStepperTrack(0);
    INITIAL_TESTS.forEach(t => testResultsMap.set(t.name, { ...t, status: TestStatus.NOT_TESTED, assertions: [] }));
    renderTestCards();
  });
}

