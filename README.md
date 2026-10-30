# Backlog Champions — SIH 2026 PS26178  
## Digital Twin Simulation — Offline-First Two-Node Disaster-Response System

> **This is a simulation only.** Sensor values, thresholds, and communication metrics are  
> simulated for demonstration and testing. No real-world safety decisions should be based on this tool.

---

## Project Context

**Problem Statement:** PS26178  
**Team:** Backlog Champions  
**Domain:** Hillside infrastructure disaster response  

A low-cost, offline-first, two-node system:
- **Node A** monitors slope displacement with a simulated sensor.  
- **Node B** monitors water contact and controls physical outputs (relays, fan, lamp, buzzer, zone LEDs).  
- A confirmed hazard at Node A triggers its local DANGER state and sends a wireless message to Node B.  
- Node B validates the message and evaluates its own sensor independently before actuating.  

---

## Running the App

### Option 1 — Direct file (simplest)

Just open `index.html` in any modern browser:

```powershell
# From the project directory:
start index.html
```

> ⚠ Chrome may block ES Modules over `file://`. If the UI loads but controls don't work, use Option 2.

---

### Option 2 — Local dev server (recommended for Chrome)

Requires Node.js (any recent version):

```powershell
npx -y serve .
```

Then open the URL shown (usually `http://localhost:3000`).

Alternatively with Python:

```powershell
python -m http.server 8080
# Then open http://localhost:8080
```

---

## File Structure

```
backlog-champions/
├── index.html          # UI shell
├── css/
│   └── style.css       # Dark control-room theme
├── js/
│   ├── simulation.js   # State machines & core logic (no DOM)
│   ├── comms.js        # Virtual wireless link simulator
│   └── ui.js           # DOM rendering & control wiring
└── README.md           # This file
```

---

## Controls Reference

| Control | Description |
|---|---|
| **▶ Start** | Start monitoring. Node A → MONITORING, Node B → STANDBY |
| **⏸ Pause** | Freeze simulation tick (state preserved) |
| **↺ Reset** | Return everything to IDLE |
| **⚡ Inject Slope Event** | Ramps Node A sensor above threshold → triggers confirmation window |
| **💧 Inject Water Contact** | Raises Node B moisture sensor |
| **〜 Sensor Spike** | One-shot spike — must NOT trigger DANGER (tests confirmation window) |
| **🔌 Power Cut A/B (5s)** | Freezes a node for 5 seconds — simulates power interruption |
| **⬆ Begin Recovery** | Operator initiates recovery sequence (DANGER → RECOVERY_PENDING) |
| **✔ Confirm Recovery** | Human authorisation step — required for final RECOVERED transition |
| **Packet Loss slider** | 0–100% probability of a packet being dropped |
| **Delayed ACK toggle** | Adds 2–5 s ACK delay to messages |
| **Peer Disconnect toggle** | Stops Node A heartbeat → Node B enters PEER_FAULT after timeout |
| **Noisy Readings toggle** | Adds ±20% noise to Node A sensor display |

---

## State Machine Summary

### Node A
```
IDLE → MONITORING → CONFIRMING → DANGER → RECOVERY_PENDING → RECOVERED
```
- Requires `CONFIRM_NEEDED` consecutive above-threshold readings in a rolling window of `CONFIRM_WINDOW` samples before entering DANGER.  
- DANGER latches — cannot exit without explicit operator action.  
- Recovery requires `RECOVER_NEEDED` stable readings **and** human confirmation.

### Node B
```
IDLE → STANDBY → ACTUATING → RECOVERY_PENDING → RECOVERED
                           ↘ PEER_FAULT
```
- Only actuates on a validated `HAZARD_ALERT` from Node A.
- Peer silence (heartbeat timeout) → PEER_FAULT (never treated as safe).
- Safe Zone C never changes regardless of any input.

---

## Design Decisions

- **No single-sample triggers:** A sensor spike (one sample above threshold) is absorbed by the confirmation window and does not cause DANGER.  
- **Peer silence is a fault:** If Node A goes offline without sending an explicit message, Node B transitions to PEER_FAULT and may maintain actuated outputs — it does not assume safe conditions.  
- **Hysteresis on recovery:** Node A must have `RECOVER_NEEDED` stable readings below threshold before recovery is even possible.  
- **Human confirmation required:** The final transition to RECOVERED always requires an operator to press "Confirm Recovery".  
- **Safe Zone C immutable:** Enforced at the data model level — zone status is never set on Zone C.

---

## Architecture and source of truth

`js/simulation.js` is the deterministic source of truth for node state, sensor confirmation,
hysteresis, message acceptance, relays, zones, transitions and simulated metrics. `js/comms.js`
only models asynchronous delivery, loss and bounded retries. `js/ui.js` renders state and runs
animation; packet animation is not evidence of packet delivery.

Node B independently confirms local water hazards. Messages require `source=NODE_A`, a known
type, and a strictly increasing sequence number; duplicate and stale messages are rejected.
Recovery has a distinct `READY_TO_REOPEN` state: local stable readings, upstream clearance and
explicit human confirmation are all required before `RECOVERED`/`CLEARED`.

The simulation does not validate ESP-NOW hardware, electrical relay behaviour, sensor calibration,
radio range, or field safety. Timestamps, latency, retries, drops and relay changes are simulated
metrics only. `falseTripCount` counts injected single-sample spikes; it is not a claim of zero
false positives without a stated test count.

Power interruption currently freezes the interrupted node for the requested duration; volatile
state is not persisted or reset automatically. Real firmware restart persistence, brownout timing,
watchdog behaviour and relay hardware default levels remain unimplemented.

### Test command

```powershell
npm test
```

The suite is dependency-free and uses Node's built-in test runner (`node --test`), executing 44 tests across:
- `test/simulation.test.js` (core state machine, confirmation window, hysteresis, safe zone immutability)
- `test/proof.test.js` (Three-Pillar Proof suite, fault injection tests, and 13-step continuous proof scenario)

---

## Three-Pillar Proof Environment

The application includes a dedicated **Three-Pillar Proof Environment** accessible via the top-level tab switcher. It verifies the three core pillars working together at the software simulation level:

### Pillar 1 — Reliable Node-to-Node Signalling
- Node A slope hazard alert transmission with strictly increasing sequence numbers.
- Delivery verification with simulated ACK, round-trip latency, and bounded retries.
- Fault tolerance: 100% packet loss handling, duplicate packet rejection, stale packet rejection, invalid packet source rejection, peer heartbeat timeout (`PEER_FAULT`), and peer reconnect recovery.

### Pillar 2 — Correct Relay Actuation
- Validated hazard event processing at Node B.
- Actuation of physical simulated outputs: Relay CH1 (siren power), Relay CH2 (barrier actuator), cooling fan, warning lamp, buzzer, and zone alert LEDs.
- Fault immunity: Single-sample sensor spike immunity (confirmation window prevents false trips), ±40% noise injection tolerance, sensor disconnection explicit `SENSOR_FAULT` with outputs forced OFF, power interruption fail-safe output de-energisation, and local water hazard autonomous actuation.

### Pillar 3 — Zone-by-Zone Safe Recovery
- Sensor stabilization with configurable hysteresis (`RECOVER_NEEDED`).
- Upstream clearance rule: Node A clears upstream zone and transmits `RECOVERY_CLEAR` to Node B.
- Downstream safety dependency: Downstream zone remains closed if local moisture is unstable or upstream is uncleared.
- Human confirmation gate: Transitions to `READY_TO_REOPEN` and halts, requiring explicit operator authorization before final `RECOVERED` transition and downstream reopening.
- Safe Zone C immutability: Designated refuge zone remains permanently `SAFE` across all lifecycle events.

### Continuous 13-Step Automated Proof Scenario
Executes the continuous sequence from initialization to hazard injection, signalling, relay actuation, stabilization, upstream clearance, downstream verification, human-gated reopening, safe zone verification, and final multi-pillar report generation.

Proof runs use fixed seed `20261030` for repeatable simulated sensor readings. The final report
contains assertion counts, measured metrics, state-transition timeline, simulation seed, and a
hardware-validation-pending status. After a completed run, the UI can download the report as JSON
or CSV evidence. The spike metric counts injected spikes; it does not claim zero false positives.

### Status Presentation
- `SIMULATION PASS`: software assertions passed.
- `SIMULATION FAIL`: an assertion failed.
- `NOT TESTED`: no evidence is available.
- `HARDWARE VALIDATION PENDING`: physical confirmation remains outstanding.

### Launch helper

Do not double-click `index.html`; browser module imports can be blocked from `file://`.
Run `run-local.bat`, or execute:

```powershell
powershell -ExecutionPolicy Bypass -File .\run-local.ps1
```

Then open `http://localhost:8080/`.

## Dependencies

None. Plain HTML, CSS and JavaScript with ES Modules.  
Uses Google Fonts (JetBrains Mono, Inter) via CDN — these load over the internet; the app still works offline but will fall back to system monospace fonts.
