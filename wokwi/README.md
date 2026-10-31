# TX100 Industrial IoT Hazard Detection Probe
## Complete Digital Twin & Hardware-in-the-Loop (HIL) Simulation Suite

### 1. Architectural Overview
The **TX100** is an industrial-grade, mission-critical Autonomous Hazard Detection Probe designed for zero-failure flood and landslide monitoring. It is powered by an **ESP32 DevKit V1 (30-pin, 3.3V logic)** executing a dual-core FreeRTOS firmware state machine at a **10.0 Hz telemetry synchronization rate**, with a dedicated sub-10ms hardware interrupt loop for life-safety relay actuation.

---

### 2. Multi-Stage Power Tree & Logic Level Shifting
- **24V DC Industrial Main Supply**: Stepped down via an **MP1584 Buck Converter** to provide clean **5.0V DC** for relay coils, the MAX485 transceiver, and the JSN-SR04T sensor.
- **AMS1117-3.3V Low-Dropout (LDO) Regulator**: Steps down 5.0V to **3.3V DC** to power the ESP32 logic rail, MPU6050 IMU, capacitive soil sensor, and SX1278 LoRa transceiver.
- **ECHO Level Shifter / Voltage Divider**:
  - The JSN-SR04T ultrasonic sensor operates on a 5.0V rail and outputs a 5.0V digital ECHO pulse.
  - A $1\text{ k}\Omega / 2\text{ k}\Omega$ precision voltage divider steps down the 5.0V signal to $3.33\text{ V}$ before reaching ESP32 input-only **GPIO 35**:
    $$V_{\text{out}} = 5.0\text{ V} \times \frac{2\text{ k}\Omega}{1\text{ k}\Omega + 2\text{ k}\Omega} = 3.33\text{ V}$$
  - The level shifter preserves microsecond pulse fidelity for accurate time-of-flight measurements.

---

### 3. Pinout & Bus Allocation Matrix

| ESP32 Pin | Component / Function | Logic / Rail | Protocol / Details |
|---|---|---|---|
| **GPIO 27** | JSN-SR04T Waterproof TRIG | 3.3V Out | $10\ \mu\text{s}$ acoustic trigger pulse |
| **GPIO 35** | JSN-SR04T Level-Shifted ECHO | 3.33V In | Level-shifted from 5V via $1\text{k}\Omega / 2\text{k}\Omega$ |
| **GPIO 21** | I2C SDA Bus | 3.3V Open-Drain | Shared between MPU6050 (`0x68`) & PCF8574 (`0x20`) |
| **GPIO 22** | I2C SCL Bus | 3.3V Open-Drain | 400 kHz Fast-Mode Clock |
| **GPIO 34** | Capacitive Soil Moisture v2.0 | 0–3.3V Analog | ADC1_CH6 ($3.00\text{V}$ dry down to $1.80\text{V}$ saturated) |
| **GPIO 25** | Direct Safety Relay 1 | 3.3V Out | Sub-$10\text{ ms}$ Hardware Emergency Cutoff |
| **GPIO 32** | Direct Safety Relay 2 | 3.3V Out | Secondary Containment Cutoff |
| **GPIO 33** | Direct Latching Relay | 3.3V Out | Physical Lock-out Requiring Reset |
| **GPIO 18** | SX1278 LoRa VSPI SCK | 3.3V Out | Serial Clock |
| **GPIO 19** | SX1278 LoRa VSPI MISO | 3.3V In | Master In Slave Out |
| **GPIO 23** | SX1278 LoRa VSPI MOSI | 3.3V Out | Master Out Slave In |
| **GPIO 5** | SX1278 LoRa NSS | 3.3V Out | Active-LOW Chip Select |
| **GPIO 14** | SX1278 LoRa RST | 3.3V Out | Hardware Reset Line |
| **GPIO 26** | SX1278 LoRa DIO0 | 3.3V In | TXDone / RXDone Interrupt |
| **GPIO 13** | SX1278 LoRa DIO1 | 3.3V In | Channel Activity Detection (CAD) Timeout |
| **GPIO 16** | MAX485 RS485 RX | 3.3V In | UART2 Receive |
| **GPIO 17** | MAX485 RS485 TX | 3.3V Out | UART2 Transmit |
| **GPIO 4** | MAX485 DE / RE | 3.3V Out | Half-Duplex Direction (HIGH=TX, LOW=RX) |
| **GPIO 39** | 2-Position Key Switch | 3.3V In | $10\text{ k}\Omega$ Pull-up, $20\text{ ms}$ Software Debounce |
| **3V3** | AMS1117-3.3V Output | 3.3V Rail | Clean Logic Power |
| **VIN** | MP1584 Buck Output | 5.02V Rail | Sensor & Relay Coil Power |
| **GND** | Star Ground Bus | 0.0V Rail | Common Ground Reference |

---

### 4. Hazard Detection & Physics Equations

#### A. Flood Detection (JSN-SR04T Waterproof Ultrasonic Transducer)
- **Speed of sound in air**: $c = 343\text{ m/s} = 0.0343\text{ cm}/\mu\text{s}$.
- **Round-trip time-of-flight**:
  $$\Delta t = \frac{2 \times d}{0.0343\text{ cm}/\mu\text{s}} \approx d \times 58.309\ \mu\text{s}$$
- **Threshold**:
  - Distance $d \in [10, 200]\text{ cm}$.
  - $d < 50.0\text{ cm} \implies$ **Critical Flood State** ($\Delta t < 2,915\ \mu\text{s}$). Energizes Sump Pump 1 (P0) and Sump Pump 2 (P1) via PCF8574 address `0x20`.

#### B. Landslide Phase 1 — Soil Moisture Saturation ($\theta_v$)
- Capacitance of the sensor depends on soil relative permittivity $\epsilon_r$:
  - Dry soil: $\epsilon_r \in [2, 6]$, calibrated at $\epsilon_r \approx 4.0 \implies V_{\text{out}} = 3.00\text{ V}$.
  - Saturated soil / free water: $\epsilon_r \approx 80.0 \implies V_{\text{out}} = 1.80\text{ V}$.
- **Calibration function**:
  $$V_{\text{adc}} = 3.00 - \left(\frac{\theta_v}{100}\right) \times 1.20\text{ V}$$
  $$\epsilon_r = 4.0 + \left(\frac{\theta_v}{100}\right) \times 76.0$$
- **Pre-Landslide Warning Threshold**:
  $$V_{\text{adc}} < 2.20\text{ V} \quad (\theta_v > 66.7\%)$$

#### C. Landslide Phase 2 — Kinematic Shear Acceleration & Slope Tilt
- **MPU6050 3-Axis Acceleration**: $A_x, A_y, A_z$ in $g$.
- **Total Acceleration Magnitude**:
  $$|A| = \sqrt{A_x^2 + A_y^2 + A_z^2}$$
- **Terrain Tilt Angle**:
  $$\theta = \arccos\left(\frac{A_z}{|A|}\right) \times \frac{180^\circ}{\pi}$$
- **Emergency Landslide Trip Condition**:
  $$|A| > 1.50g \quad \text{OR} \quad \theta > 45.0^\circ$$
- **Trip Response Time**: Sub-$10\text{ ms}$ hardware actuation via direct GPIOs 25, 32, and 33.

---

### 5. Online vs. Offline Fail-Safe Operation

```
+-------------------------------------------------------------------------+
|                              TX100 PROBE                                |
|                                                                         |
|  [Sensors] --> [ESP32 FreeRTOS <10ms Task]                              |
|                         |                                               |
|           +-------------+-------------+                                 |
|           |                           |                                 |
|     (ONLINE MODE)               (OFFLINE MODE)                          |
|           |                           |                                 |
|     [MQTT 10Hz Feed]            [Local Autonomous Edge Fail-Safe]       |
|     [LoRa Hex Stream]           [Direct Safety Relays Tripped <10ms]    |
|     [RS485 Modbus RTU]          [Local Hardware Siren & Strobe]         |
|           |                     [Spool packets into NVS Ring Buffer]    |
|           v                     [LoRa CAD DIO1 Retries]                 |
|     [Remote SCADA OK]                 |                                 |
|                                       v                                 |
|                         [Remote LWT Watchdog Trips]                     |
|                         [Frozen Last-Known Values]                      |
|                                       |                                 |
|                               (ON RECONNECT)                            |
|                                       v                                 |
|                         [Auto NVS Buffer Flush & Sync]                  |
+-------------------------------------------------------------------------+
```

---

### 6. Running the Simulation
1. **Interactive Web Digital Twin**:
   Open `index.html` in any web browser, or launch the included python server:
   ```bash
   python wokwi/bridge.py
   ```
   Navigate to `http://localhost:8080/`.

2. **Automated Verification**:
   Click the **"Run Full Verification Suite"** button on the dashboard to run the 4 automated assertion stages.
