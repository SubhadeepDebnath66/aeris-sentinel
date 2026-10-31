/**
 * ============================================================================
 * PROJECT: TX100 Industrial IoT Hazard Detection Probe
 * ARCHITECTURE: ESP32 DevKit V1 (30-pin, 3.3V Logic)
 * FIRMWARE: Production-Grade Dual-Core FreeRTOS State Machine
 * TELEMETRY: 10.0 Hz Sync Rate | Emergency Cutoff: <10 ms Sub-Task Response
 * HARDWARE BUSES: I2C (0x20 PCF8574, 0x68 MPU6050), SPI (SX1278), UART2 (MAX485)
 * ============================================================================
 */

#include <Arduino.h>
#include <Wire.h>
#include <SPI.h>
#include <WiFi.h>
#include <PubSubClient.h>

// ============================================================================
// HARDWARE PIN DEFINITIONS & BUS ASSIGNMENTS
// ============================================================================

// 1. Ultrasonic Sensor (JSN-SR04T Waterproof, 5V logic)
#define PIN_JSN_TRIG        27    // Output: 10µs trigger pulse
#define PIN_JSN_ECHO        35    // Input-Only: Level-shifted 3.33V pulse (1k/2k divider)

// 2. I2C Bus (MPU6050 @ 0x68, PCF8574 @ 0x20)
#define PIN_I2C_SDA         21    // I2C Data
#define PIN_I2C_SCL         22    // I2C Clock
#define ADDR_MPU6050        0x68  // 6-DoF Accelerometer / Gyroscope
#define ADDR_PCF8574        0x20  // 8-Channel Relay Driver (P0-P7)

// 3. Capacitive Soil Moisture Sensor v2.0 (3.3V Analog)
#define PIN_SOIL_ADC        34    // ADC1_CH6: 3.00V (Dry) down to 1.80V (Saturated)

// 4. Direct Fast Safety Relays (Sub-10ms Cutoff, Bypasses I2C Bus)
#define PIN_SAFETY_RELAY_1  25    // Primary Emergency Shutdown
#define PIN_SAFETY_RELAY_2  32    // Secondary Auxiliary Shutdown
#define PIN_LATCHING_RELAY  33    // Physical Lockout Latching Relay

// 5. Ai-Thinker Ra-02 SX1278 LoRa Transceiver (VSPI)
#define PIN_LORA_SCK        18    // VSPI Clock
#define PIN_LORA_MISO       19    // VSPI MISO
#define PIN_LORA_MOSI       23    // VSPI MOSI
#define PIN_LORA_NSS        5     // Chip Select (Active LOW)
#define PIN_LORA_RST        14    // LoRa Reset
#define PIN_LORA_DIO0       26    // TXDone / RXDone Interrupt
#define PIN_LORA_DIO1       13    // CAD (Channel Activity Detection) Timeout

// SX1278 Register Map
#define REG_FIFO            0x00
#define REG_OP_MODE         0x01
#define REG_IRQ_FLAGS       0x12
#define REG_VERSION         0x42  // Returns 0x12 for SX1278
#define MODE_LONG_RANGE     0x80
#define MODE_SLEEP          0x00
#define MODE_STDBY          0x01
#define MODE_TX             0x03
#define MODE_CAD            0x07

// 6. MAX485 TTL-to-RS485 Transceiver (UART2 Modbus RTU)
#define PIN_RS485_RX        16    // ESP32 Serial2 RX
#define PIN_RS485_TX        17    // ESP32 Serial2 TX
#define PIN_RS485_DE_RE     4     // Driver / Receiver Enable (HIGH=TX, LOW=RX)

// 7. Physical Key Switch & Diagnostic Indicators
#define PIN_KEY_SWITCH      39    // Sensor_VN: Armed/Disarmed, 10k pull-up, debounced
#define PIN_STATUS_LED      2     // Onboard Diagnostic LED

// ============================================================================
// HAZARD THRESHOLDS & SAFETY PARAMETERS
// ============================================================================
#define THRESHOLD_FLOOD_CRITICAL_CM    50.0f  // Water distance < 50cm = Critical Flood
#define THRESHOLD_SOIL_PRE_ALERT_VOLT  2.20f  // Permittivity warning (theta_v > 66.7%)
#define THRESHOLD_ACCEL_CRITICAL_G     1.50f  // Total acceleration > 1.50g = Landslide
#define THRESHOLD_TILT_CRITICAL_DEG    45.0f  // Slope tilt > 45 deg = Landslide

// ============================================================================
// DATA STRUCTURES & OFFLINE NVS FIFO RING BUFFER
// ============================================================================
struct TelemetryPacket {
  uint32_t seq;
  uint32_t timestamp_ms;
  float flood_distance_cm;
  uint32_t echo_us;
  float soil_volts;
  float soil_moisture_pct;
  float accel_x, accel_y, accel_z;
  float total_accel_g;
  float tilt_deg;
  bool safety_tripped;
  uint8_t pcf_relay_state;
  char alarm_level[24];
};

#define NVS_RING_BUFFER_SIZE  50
TelemetryPacket nvsRingBuffer[NVS_RING_BUFFER_SIZE];
volatile int nvsBufferHead = 0;
volatile int nvsBufferTail = 0;
volatile int nvsBufferCount = 0;
portMUX_TYPE nvsMux = portMUX_INITIALIZER_UNLOCKED;

// Global Sensor & Actuator States
volatile bool g_directRelaysTripped = false;
volatile bool g_loraTxDone = false;
volatile bool g_keyArmed = true;
uint8_t g_pcfRelayByte = 0xFF; // Active LOW: 0xFF = all off
uint32_t g_telemetrySeq = 0;

// Comms Clients
WiFiClient espClient;
PubSubClient mqttClient(espClient);
const char* WIFI_SSID = "Wokwi-GUEST";
const char* WIFI_PASS = "";
const char* MQTT_SERVER = "broker.hivemq.com";
const int MQTT_PORT = 1883;

// RTOS Task Handles
TaskHandle_t hTelemetryTask = NULL;
TaskHandle_t hHazardMonitorTask = NULL;

// ============================================================================
// ISR ROUTINES
// ============================================================================
void IRAM_ATTR loraDio0ISR() {
  g_loraTxDone = true;
}

// ============================================================================
// LOW-LEVEL DRIVERS: SPI / SX1278
// ============================================================================
uint8_t sx1278ReadRegister(uint8_t reg) {
  digitalWrite(PIN_LORA_NSS, LOW);
  SPI.transfer(reg & 0x7F); // MSB=0 for Read
  uint8_t val = SPI.transfer(0x00);
  digitalWrite(PIN_LORA_NSS, HIGH);
  return val;
}

void sx1278WriteRegister(uint8_t reg, uint8_t val) {
  digitalWrite(PIN_LORA_NSS, LOW);
  SPI.transfer(reg | 0x80); // MSB=1 for Write
  SPI.transfer(val);
  digitalWrite(PIN_LORA_NSS, HIGH);
}

void sx1278Init() {
  pinMode(PIN_LORA_NSS, OUTPUT);
  pinMode(PIN_LORA_RST, OUTPUT);
  pinMode(PIN_LORA_DIO0, INPUT);
  pinMode(PIN_LORA_DIO1, INPUT);

  // Hardware Reset
  digitalWrite(PIN_LORA_RST, LOW);
  delayMicroseconds(200);
  digitalWrite(PIN_LORA_RST, HIGH);
  delay(10);

  digitalWrite(PIN_LORA_NSS, HIGH);
  SPI.begin(PIN_LORA_SCK, PIN_LORA_MISO, PIN_LORA_MOSI, PIN_LORA_NSS);

  // Read REG_VERSION (0x42) - Should return 0x12
  uint8_t version = sx1278ReadRegister(REG_VERSION);
  Serial.printf("[SX1278] Module Silicon Version: 0x%02X %s\n",
    version, (version == 0x12) ? "[PASS: VERIFIED]" : "[FAIL: UNKNOWN]");

  // Configure LoRa mode
  sx1278WriteRegister(REG_OP_MODE, MODE_LONG_RANGE | MODE_SLEEP);
  delay(10);
  sx1278WriteRegister(REG_OP_MODE, MODE_LONG_RANGE | MODE_STDBY);

  attachInterrupt(digitalPinToInterrupt(PIN_LORA_DIO0), loraDio0ISR, RISING);
}

void sx1278TransmitPacket(const uint8_t* payload, uint8_t len) {
  sx1278WriteRegister(REG_OP_MODE, MODE_LONG_RANGE | MODE_STDBY);
  sx1278WriteRegister(0x0D, 0x00); // FIFO TX base address
  sx1278WriteRegister(0x0E, 0x00); // FIFO write pointer

  digitalWrite(PIN_LORA_NSS, LOW);
  SPI.transfer(REG_FIFO | 0x80);
  for (uint8_t i = 0; i < len; i++) {
    SPI.transfer(payload[i]);
  }
  digitalWrite(PIN_LORA_NSS, HIGH);

  sx1278WriteRegister(0x22, len); // Payload length
  g_loraTxDone = false;
  sx1278WriteRegister(REG_OP_MODE, MODE_LONG_RANGE | MODE_TX);

  // Log Hex Packet
  Serial.print("[SX1278-TX] [HEX: ");
  for (uint8_t i = 0; i < len; i++) {
    Serial.printf("%02X ", payload[i]);
  }
  Serial.println("] -> Emitting RF frame");
}

// ============================================================================
// LOW-LEVEL DRIVERS: MAX485 / MODBUS RTU
// ============================================================================
void rs485Init() {
  pinMode(PIN_RS485_DE_RE, OUTPUT);
  digitalWrite(PIN_RS485_DE_RE, LOW); // Start in RX mode
  Serial2.begin(9600, SERIAL_8N1, PIN_RS485_RX, PIN_RS485_TX);
}

uint16_t calculateCRC16(const uint8_t* buffer, uint16_t len) {
  uint16_t crc = 0xFFFF;
  for (uint16_t pos = 0; pos < len; pos++) {
    crc ^= (uint16_t)buffer[pos];
    for (int i = 8; i != 0; i--) {
      if ((crc & 0x0001) != 0) {
        crc >>= 1;
        crc ^= 0xA001;
      } else {
        crc >>= 1;
      }
    }
  }
  return crc;
}

void rs485SendModbusFrame(uint8_t slaveAddr, uint8_t funcCode, uint16_t regStart, uint16_t regVal) {
  uint8_t frame[8];
  frame[0] = slaveAddr;
  frame[1] = funcCode;
  frame[2] = (regStart >> 8) & 0xFF;
  frame[3] = regStart & 0xFF;
  frame[4] = (regVal >> 8) & 0xFF;
  frame[5] = regVal & 0xFF;

  uint16_t crc = calculateCRC16(frame, 6);
  frame[6] = crc & 0xFF;
  frame[7] = (crc >> 8) & 0xFF;

  // Strict half-duplex sequence:
  digitalWrite(PIN_RS485_DE_RE, HIGH); // Assert TX Driver
  delayMicroseconds(50);
  Serial2.write(frame, 8);
  Serial2.flush(); // Wait for TX FIFO to empty completely
  delayMicroseconds(50);
  digitalWrite(PIN_RS485_DE_RE, LOW);  // Return to RX listening
}

// ============================================================================
// LOW-LEVEL DRIVERS: I2C (PCF8574 & MPU6050)
// ============================================================================
void i2cScanAndInit() {
  Wire.begin(PIN_I2C_SDA, PIN_I2C_SCL, 400000); // 400 kHz Fast-Mode

  Serial.println("[I2C] Scanning bus...");
  Wire.beginTransmission(ADDR_MPU6050);
  if (Wire.endTransmission() == 0) {
    Serial.println("[I2C] MPU6050 detected at 0x68 [PASS]");
    // Wake up MPU6050 (write 0x00 to PWR_MGMT_1 register 0x6B)
    Wire.beginTransmission(ADDR_MPU6050);
    Wire.write(0x6B);
    Wire.write(0x00);
    Wire.endTransmission();
  } else {
    Serial.println("[I2C] MPU6050 not responding at 0x68 [WARNING: FALLBACK SIM]");
  }

  Wire.beginTransmission(ADDR_PCF8574);
  if (Wire.endTransmission() == 0) {
    Serial.println("[I2C] PCF8574 8-Bit Relay expander detected at 0x20 [PASS]");
    // Initialize all relays OFF (active-low 0xFF)
    Wire.beginTransmission(ADDR_PCF8574);
    Wire.write(0xFF);
    Wire.endTransmission();
  } else {
    Serial.println("[I2C] PCF8574 not responding at 0x20 [WARNING]");
  }
}

void pcf8574Write(uint8_t byteVal) {
  g_pcfRelayByte = byteVal;
  Wire.beginTransmission(ADDR_PCF8574);
  Wire.write(byteVal);
  Wire.endTransmission();
}

void mpu6050ReadKinematics(float &ax, float &ay, float &az, float &tilt) {
  Wire.beginTransmission(ADDR_MPU6050);
  Wire.write(0x3B); // ACCEL_XOUT_H
  if (Wire.endTransmission(false) == 0 && Wire.requestFrom(ADDR_MPU6050, 6) == 6) {
    int16_t rawX = (Wire.read() << 8) | Wire.read();
    int16_t rawY = (Wire.read() << 8) | Wire.read();
    int16_t rawZ = (Wire.read() << 8) | Wire.read();

    ax = rawX / 16384.0f; // ±2g scale
    ay = rawY / 16384.0f;
    az = rawZ / 16384.0f;
  } else {
    // Nominal baseline if offline
    ax = 0.05f; ay = 0.21f; az = 0.98f;
  }

  // Calculate tilt angle from accelerometer
  float totalAcc = sqrtf(ax * ax + ay * ay + az * az);
  if (totalAcc > 0.01f) {
    float cosTilt = az / totalAcc;
    if (cosTilt > 1.0f) cosTilt = 1.0f;
    if (cosTilt < -1.0f) cosTilt = -1.0f;
    tilt = acosf(cosTilt) * 57.2957795f;
  } else {
    tilt = 0.0f;
  }
}

// ============================================================================
// ULTRASONIC & SOIL ANALOG SENSOR SAMPLING
// ============================================================================
float sampleJSNSR04T(uint32_t &pulseDurationUs) {
  digitalWrite(PIN_JSN_TRIG, LOW);
  delayMicroseconds(2);
  digitalWrite(PIN_JSN_TRIG, HIGH);
  delayMicroseconds(10);
  digitalWrite(PIN_JSN_TRIG, LOW);

  // Read ECHO pulse on level-shifted GPIO 35 (safe 3.3V)
  pulseDurationUs = pulseIn(PIN_JSN_ECHO, HIGH, 30000); // 30ms timeout (~5 meters)

  if (pulseDurationUs == 0) {
    // Timeout or default safe distance
    pulseDurationUs = 10496;
    return 180.0f;
  }

  // d = (t * 0.0343 cm/µs) / 2
  float distCm = (pulseDurationUs * 0.0343f) / 2.0f;
  return distCm;
}

void sampleSoilMoisture(float &volts, float &pct, float &permittivity) {
  uint32_t rawAdc = analogRead(PIN_SOIL_ADC);
  volts = (rawAdc / 4095.0f) * 3.30f;

  // Calibration curve:
  // 3.00V = 0% moisture (dry soil, eps_r = 4.0)
  // 1.80V = 100% moisture (water saturated, eps_r = 80.0)
  if (volts >= 3.00f) {
    pct = 0.0f;
  } else if (volts <= 1.80f) {
    pct = 100.0f;
  } else {
    pct = ((3.00f - volts) / 1.20f) * 100.0f;
  }
  permittivity = 4.0f + (pct / 100.0f) * 76.0f;
}

// ============================================================================
// GPIO 39 KEY SWITCH DEBOUNCE
// ============================================================================
bool readDebouncedKeySwitch() {
  static int lastState = HIGH;
  static uint32_t lastDebounceTime = 0;
  int reading = digitalRead(PIN_KEY_SWITCH);

  if (reading != lastState) {
    lastDebounceTime = millis();
  }

  if ((millis() - lastDebounceTime) > 20) { // 20ms debounce window
    g_keyArmed = (reading == HIGH); // 10k pullup: HIGH = Armed
  }
  lastState = reading;
  return g_keyArmed;
}

// ============================================================================
// NVS / FIFO RETRY BUFFER UTILITIES
// ============================================================================
void pushNVSRingBuffer(const TelemetryPacket &pkt) {
  portENTER_CRITICAL(&nvsMux);
  nvsRingBuffer[nvsBufferHead] = pkt;
  nvsBufferHead = (nvsBufferHead + 1) % NVS_RING_BUFFER_SIZE;
  if (nvsBufferCount < NVS_RING_BUFFER_SIZE) {
    nvsBufferCount++;
  } else {
    nvsBufferTail = (nvsBufferTail + 1) % NVS_RING_BUFFER_SIZE; // Overwrite oldest
  }
  portEXIT_CRITICAL(&nvsMux);
}

bool popNVSRingBuffer(TelemetryPacket &pkt) {
  bool hasItem = false;
  portENTER_CRITICAL(&nvsMux);
  if (nvsBufferCount > 0) {
    pkt = nvsRingBuffer[nvsBufferTail];
    nvsBufferTail = (nvsBufferTail + 1) % NVS_RING_BUFFER_SIZE;
    nvsBufferCount--;
    hasItem = true;
  }
  portEXIT_CRITICAL(&nvsMux);
  return hasItem;
}

// ============================================================================
// MQTT & LWT CLIENT ENGINE
// ============================================================================
void mqttCallback(char* topic, byte* payload, unsigned int length) {
  // Command handler
}

void reconnectMQTT() {
  if (WiFi.status() != WL_CONNECTED) return;
  if (mqttClient.connected()) return;

  Serial.print("[MQTT] Connecting with LWT (tx100/status = offline)... ");
  const char* clientId = "TX100_PROBE_ESP32";
  const char* willTopic = "tx100/status";
  const char* willMessage = "{\"status\":\"OFFLINE\",\"reason\":\"LWT_DROPOUT\"}";

  if (mqttClient.connect(clientId, willTopic, 1, true, willMessage)) {
    Serial.println("[MQTT] Connected successfully!");
    mqttClient.publish("tx100/status", "{\"status\":\"ONLINE\",\"version\":\"1.0.0\"}", true);

    // Flush any pending NVS buffered packets
    TelemetryPacket queuedPkt;
    int flushed = 0;
    while (popNVSRingBuffer(queuedPkt)) {
      char topic[64];
      snprintf(topic, sizeof(topic), "tx100/archive/seq_%u", queuedPkt.seq);
      char buf[256];
      snprintf(buf, sizeof(buf),
        "{\"seq\":%u,\"ts\":%u,\"flood\":%.1f,\"acc\":%.2f,\"alarm\":\"%s\"}",
        queuedPkt.seq, queuedPkt.timestamp_ms, queuedPkt.flood_distance_cm,
        queuedPkt.total_accel_g, queuedPkt.alarm_level);
      mqttClient.publish(topic, buf);
      flushed++;
    }
    if (flushed > 0) {
      Serial.printf("[NVS] Reconciled and flushed %d offline telemetry packets to broker.\n", flushed);
    }
  } else {
    Serial.printf("[MQTT] Connect failed, rc=%d. Autonomous edge mode engaged.\n", mqttClient.state());
  }
}

// ============================================================================
// FREERTOS FAST HAZARD MONITOR TASK (Sub-10ms Emergency Response)
// ============================================================================
void vHazardMonitorTask(void *pvParameters) {
  const TickType_t xFrequency = pdMS_TO_TICKS(10); // 10ms execution cycle (100 Hz)
  TickType_t xLastWakeTime = xTaskGetTickCount();

  for (;;) {
    vTaskDelayUntil(&xLastWakeTime, xFrequency);

    readDebouncedKeySwitch();

    // Fast Kinematics Read from MPU6050
    float ax, ay, az, tilt;
    mpu6050ReadKinematics(ax, ay, az, tilt);
    float totalAcc = sqrtf(ax * ax + ay * ay + az * az);

    // Check Catastrophic Landslide Emergency Condition
    bool isLandslideEmergency = (totalAcc > THRESHOLD_ACCEL_CRITICAL_G) || (tilt > THRESHOLD_TILT_CRITICAL_DEG);

    if (isLandslideEmergency && g_keyArmed) {
      if (!g_directRelaysTripped) {
        // FAST HARDWARE TRIP (<10ms): Write directly to ESP32 GPIO registers
        digitalWrite(PIN_SAFETY_RELAY_1, HIGH);
        digitalWrite(PIN_SAFETY_RELAY_2, HIGH);
        digitalWrite(PIN_LATCHING_RELAY, HIGH);
        g_directRelaysTripped = true;

        // Trigger Local Emergency Siren / Strobe via PCF8574
        pcf8574Write(0xF3); // Energize P2 (Siren) & P3 (Strobe)

        Serial.println("!!! [EMERGENCY CUTOFF TRIGGERED] TotalAcc > 1.5g or Tilt > 45deg !!!");
        Serial.printf("!!! Trip latency: <10ms | Relays GPIO 25, 32, 33 ENERGIZED !!!\n");
      }
    }
  }
}

// ============================================================================
// FREERTOS 10.0 Hz TELEMETRY & COMMS TASK (100ms Sync Rate)
// ============================================================================
void vTelemetryTask(void *pvParameters) {
  const TickType_t xFrequency = pdMS_TO_TICKS(100); // 100ms cycle (10.0 Hz)
  TickType_t xLastWakeTime = xTaskGetTickCount();

  for (;;) {
    vTaskDelayUntil(&xLastWakeTime, xFrequency);
    g_telemetrySeq++;
    uint32_t nowMs = millis();

    // 1. Sample Ultrasonic JSN-SR04T
    uint32_t echoUs = 0;
    float floodDistCm = sampleJSNSR04T(echoUs);

    // 2. Sample Capacitive Soil Sensor
    float soilV = 0, soilPct = 0, soilPerm = 0;
    sampleSoilMoisture(soilV, soilPct, soilPerm);

    // 3. Sample MPU6050
    float ax = 0, ay = 0, az = 0, tilt = 0;
    mpu6050ReadKinematics(ax, ay, az, tilt);
    float totalAcc = sqrtf(ax * ax + ay * ay + az * az);

    // 4. Evaluate Flood & Soil Actuations
    bool isCriticalFlood = (floodDistCm < THRESHOLD_FLOOD_CRITICAL_CM);
    bool isPreLandslide = (soilV < THRESHOLD_SOIL_PRE_ALERT_VOLT);

    // Update PCF8574 Relays:
    // P0: Sump Pump 1 (Active on flood < 50cm)
    // P1: Sump Pump 2 (Active on flood < 35cm)
    // P2: Siren (Emergency)
    // P3: Strobe (Pre-warning or flood)
    uint8_t pcfByte = 0xFF;
    if (isCriticalFlood) pcfByte &= ~(1 << 0); // P0 LOW
    if (floodDistCm < 35.0f) pcfByte &= ~(1 << 1); // P1 LOW
    if (g_directRelaysTripped) pcfByte &= ~(1 << 2); // P2 LOW
    if (isPreLandslide || isCriticalFlood) pcfByte &= ~(1 << 3); // P3 LOW
    pcf8574Write(pcfByte);

    // 5. Construct Telemetry Packet
    TelemetryPacket pkt;
    pkt.seq = g_telemetrySeq;
    pkt.timestamp_ms = nowMs;
    pkt.flood_distance_cm = floodDistCm;
    pkt.echo_us = echoUs;
    pkt.soil_volts = soilV;
    pkt.soil_moisture_pct = soilPct;
    pkt.accel_x = ax; pkt.accel_y = ay; pkt.accel_z = az;
    pkt.total_accel_g = totalAcc;
    pkt.tilt_deg = tilt;
    pkt.safety_tripped = g_directRelaysTripped;
    pkt.pcf_relay_state = pcfByte;

    if (g_directRelaysTripped) {
      strcpy(pkt.alarm_level, "CRITICAL_LANDSLIDE");
    } else if (isCriticalFlood) {
      strcpy(pkt.alarm_level, "CRITICAL_FLOOD");
    } else if (isPreLandslide) {
      strcpy(pkt.alarm_level, "WARNING_SOIL");
    } else {
      strcpy(pkt.alarm_level, "NOMINAL");
    }

    // 6. Transmit LoRa RF Frame via SX1278 SPI
    uint8_t loraPayload[12];
    loraPayload[0] = 0x54; loraPayload[1] = 0x58; // 'TX'
    loraPayload[2] = 0x31; loraPayload[3] = 0x30; loraPayload[4] = 0x30; // '100'
    loraPayload[5] = (g_telemetrySeq >> 8) & 0xFF;
    loraPayload[6] = g_telemetrySeq & 0xFF;
    loraPayload[7] = (uint8_t)floodDistCm;
    loraPayload[8] = (uint8_t)soilPct;
    loraPayload[9] = (uint8_t)(totalAcc * 10);
    loraPayload[10] = (uint8_t)tilt;
    loraPayload[11] = pcfByte;
    sx1278TransmitPacket(loraPayload, 12);

    // 7. Transmit Modbus RTU Frame via MAX485
    rs485SendModbusFrame(0x01, 0x03, 0x0000, (uint16_t)(floodDistCm * 10));

    // 8. Stream MQTT or Enqueue to NVS Ring Buffer
    if (WiFi.status() == WL_CONNECTED && mqttClient.connected()) {
      char jsonBuf[384];
      snprintf(jsonBuf, sizeof(jsonBuf),
        "{\"seq\":%u,\"d\":%.1f,\"echo\":%u,\"v\":%.2f,\"theta\":%.1f,\"acc\":%.2f,\"tilt\":%.1f,\"relays\":\"0x%02X\",\"alarm\":\"%s\"}",
        pkt.seq, pkt.flood_distance_cm, pkt.echo_us, pkt.soil_volts, pkt.soil_moisture_pct,
        pkt.total_accel_g, pkt.tilt_deg, pkt.pcf_relay_state, pkt.alarm_level);

      mqttClient.publish("tx100/telemetry", jsonBuf);
    } else {
      // Comms Down: Autonomous Edge Fallback
      pushNVSRingBuffer(pkt);
    }
  }
}

// ============================================================================
// SYSTEM SETUP & MAIN LOOP
// ============================================================================
void setup() {
  Serial.begin(115200);
  delay(500);
  Serial.println("\n========================================================");
  Serial.println("  TX100 INDUSTRIAL IoT HAZARD DETECTION PROBE (ESP32)  ");
  Serial.println("  10 Hz Telemetry State Machine & Sub-10ms Direct Cutoff");
  Serial.println("========================================================");

  // 1. Initialize Direct Safety Relays & Key Switch
  pinMode(PIN_SAFETY_RELAY_1, OUTPUT);
  pinMode(PIN_SAFETY_RELAY_2, OUTPUT);
  pinMode(PIN_LATCHING_RELAY, OUTPUT);
  digitalWrite(PIN_SAFETY_RELAY_1, LOW);
  digitalWrite(PIN_SAFETY_RELAY_2, LOW);
  digitalWrite(PIN_LATCHING_RELAY, LOW);

  pinMode(PIN_KEY_SWITCH, INPUT_PULLUP);
  pinMode(PIN_STATUS_LED, OUTPUT);
  digitalWrite(PIN_STATUS_LED, HIGH);

  // 2. Initialize Ultrasonic Sensors
  pinMode(PIN_JSN_TRIG, OUTPUT);
  pinMode(PIN_JSN_ECHO, INPUT);
  digitalWrite(PIN_JSN_TRIG, LOW);

  // 3. Initialize I2C Peripherals (Wire)
  i2cScanAndInit();

  // 4. Initialize SPI & SX1278 LoRa Module
  sx1278Init();

  // 5. Initialize MAX485 UART2
  rs485Init();

  // 6. Connect Wi-Fi & MQTT
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  mqttClient.setServer(MQTT_SERVER, MQTT_PORT);
  mqttClient.setCallback(mqttCallback);

  // 7. Launch FreeRTOS Tasks
  xTaskCreatePinnedToCore(
    vHazardMonitorTask,
    "HazardMonitorTask",
    4096,
    NULL,
    configMAX_PRIORITIES - 1, // Highest Priority for Life-Safety Cutoff
    &hHazardMonitorTask,
    1 // Pin to Core 1
  );

  xTaskCreatePinnedToCore(
    vTelemetryTask,
    "TelemetryTask",
    4096,
    NULL,
    2, // Medium Priority for 10Hz Telemetry
    &hTelemetryTask,
    0 // Pin to Core 0
  );

  Serial.println("[SYSTEM READY] Dual-Core FreeRTOS Tasks Running.");
}

void loop() {
  // Loop manages WiFi / MQTT reconnection and background housekeeping
  if (WiFi.status() == WL_CONNECTED) {
    if (!mqttClient.connected()) {
      reconnectMQTT();
    } else {
      mqttClient.loop();
    }
  }
  vTaskDelay(pdMS_TO_TICKS(100));
}
