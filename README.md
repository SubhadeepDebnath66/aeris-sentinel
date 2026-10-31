# TX100 Industrial IoT Hazard Detection Probe
## Complete Digital Twin & Hardware-in-the-Loop (HIL) Simulation Suite

An industrial-grade digital twin and simulation environment for the **TX100 Hazard Detection Probe** — an autonomous flood and landslide monitoring system powered by an ESP32 microcontroller, dual-core FreeRTOS firmware, ultrasonic water-level detection, soil saturation monitoring, 6-DoF tilt/landslide sensing, LoRa long-range telemetry, and sub-10ms hardware emergency safety trip relays.

---

## 🚀 Quick Start Guide

### GitHub Pages

The TX100 digital twin is published at [Aeris Sentinel](https://subhadeepdebnath66.github.io/aeris-sentinel/).
Updates pushed to `main` are published automatically.

### Option 1: Instant Single-File Run (No Dependencies)
Double-click and open **`standalone_tx100_twin.html`** in any web browser (Chrome, Edge, Firefox, Safari).
- Contains the full interactive telemetry dashboard, physics simulation engine, fault injection suite, and SVG circuit visualization bundled into a single standalone file.

### Option 2: Local Web Server
If you prefer running via a local HTTP server:
```bash
# Using Python
python server.py
# Or using npm (requires Python on PATH)
npm start
```
Then navigate to: **`http://localhost:8080`**

---

## 📁 Repository Structure

```
tx100_probe/
│
├── standalone_tx100_twin.html   # Zero-dependency, single-file interactive digital twin
├── index.html                   # Modular digital twin UI layout
├── styles.css                 # High-contrast industrial scada HUD styling
├── sim_engine.js              # Core telemetry, physics loop, state machine & SVG renderer
├── server.py                    # Lightweight Python HTTP server (port 8080)
├── build_standalone.py          # Compiler script that merges index.html + CSS + JS into standalone
├── package.json                 # Project metadata & npm script shortcuts
├── platformio.ini               # PlatformIO build configuration for ESP32 DevKit V1
├── ares-dashboard.html          # Previous ARES simulation dashboard
│
└── wokwi/                       # Complete Wokwi Hardware-in-the-Loop (HIL) simulation suite
    ├── diagram.json             # Circuit schematic and wire routing (ESP32, sensors, relays)
    ├── main.cpp                 # Production C++ FreeRTOS firmware state machine
    ├── wokwi.toml               # Wokwi simulator entry point & configuration
    ├── scenario.yaml            # Automated testing scenarios and fault injection vectors
    ├── bridge.py                # Bidirectional HIL WebSocket bridge connecting firmware to Web Twin
    ├── README.md                # Comprehensive hardware pinout, electrical analysis & equations
    │
    ├── max485.chip.c / .json    # Custom Wokwi chip: RS-485 transceiver model
    ├── shifter.chip.c / .json   # Custom Wokwi chip: 5V-to-3.3V bidirectional level shifter
    ├── soil.chip.c / .json      # Custom Wokwi chip: Capacitive analog soil moisture sensor
    └── sx1278.chip.c / .json    # Custom Wokwi chip: Semtech SX1278 SPI LoRa RF frontend
```

---

## ⚡ Technical Specifications & Architecture

- **Microcontroller**: ESP32 DevKit V1 (30-pin, 240 MHz dual-core Xtensa LX6)
- **Firmware OS**: FreeRTOS with separate tasks for sensor acquisition (10 Hz), LoRa/RS-485 packet serialization, and safety trip execution (<10 ms interrupt latency)
- **Power Management**:
  - Industrial 24V DC input stepped down to 5.0V via MP1584 buck converter for relays and MAX485
  - 3.3V logic rail regulated via low-dropout AMS1117-3.3
  - Ultrasonic echo pulse conditioned via $1\text{ k}\Omega / 2\text{ k}\Omega$ voltage divider
- **Sensors & Peripherals**:
  - JSN-SR04T waterproof ultrasonic transducer ($20\text{ cm} - 600\text{ cm}$)
  - Analog capacitive soil saturation sensor (v2.0 corrosion resistant)
  - MPU6050 6-DoF I2C IMU (accelerometer & gyroscope tilt tracking)
  - Semtech SX1278 SPI LoRa transceiver ($433\text{ MHz} / 868\text{ MHz} / 915\text{ MHz}$)
  - MAX485 half-duplex RS-485 industrial bus
  - Dual safety trip relays + hardware latching cutoff switch

---

## 🛠️ Rebuilding the Standalone Twin
If you make changes to `index.html`, `styles.css`, or `sim_engine.js`, update the single-file distribution with:
```bash
python build_standalone.py
# or
npm run bundle
```

---

## 📜 License
MIT License. Created by the Antigravity Embedded Systems Team.
