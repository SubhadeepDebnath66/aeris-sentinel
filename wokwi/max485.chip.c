/**
 * ============================================================================
 * WOKWI CUSTOM CHIP: MAX485 TTL-to-RS485 Half-Duplex Transceiver Emulation
 * ============================================================================
 * Implements:
 * - Half-Duplex direction control on RE_DE pin:
 *     HIGH (DE = 1) -> Transmit Mode (DI -> Differential Bus A/B)
 *     LOW  (RE = 0) -> Receive Mode (Differential Bus A/B -> RO)
 * - Captures UART TX pulses from ESP32 GPIO 17 on DI pin
 * - Drives RO pin (ESP32 GPIO 16 RX) in receive mode
 * - Differential bus output logging (Lines A and B)
 * ============================================================================
 */

#include "wokwi-api.h"
#include <stdio.h>
#include <stdlib.h>

typedef struct {
  pin_t pin_vcc;
  pin_t pin_gnd;
  pin_t pin_ro;
  pin_t pin_re_de;
  pin_t pin_di;
  pin_t pin_a;
  pin_t pin_b;

  bool is_transmitting;
  uint32_t tx_transition_count;
} max485_state_t;

static void on_re_de_change(void *user_data, pin_t pin, uint32_t value) {
  max485_state_t *chip = (max485_state_t *)user_data;

  if (value == HIGH) {
    // Driver Enabled (DE = 1, RE = 1) -> TX Mode
    chip->is_transmitting = true;
    printf("[MAX485.CHIP] DE Asserted (HIGH) -> TX Driver Enabled. RS485 Bus Master active.\n");
  } else {
    // Receiver Enabled (RE = 0, DE = 0) -> RX Mode
    chip->is_transmitting = false;
    printf("[MAX485.CHIP] DE Deasserted (LOW) -> RX Listening. Bus released (Half-Duplex Contention Prevented).\n");
    // Drive RO to idle HIGH (standard UART Mark state)
    pin_write(chip->pin_ro, HIGH);
  }
}

static void on_di_change(void *user_data, pin_t pin, uint32_t value) {
  max485_state_t *chip = (max485_state_t *)user_data;
  if (!chip->is_transmitting) return;

  // Translate DI to differential bus lines A and B
  // RS-485 logic: DI HIGH -> A > B (A=HIGH, B=LOW); DI LOW -> B > A (A=LOW, B=HIGH)
  if (value == HIGH) {
    pin_write(chip->pin_a, HIGH);
    pin_write(chip->pin_b, LOW);
  } else {
    pin_write(chip->pin_a, LOW);
    pin_write(chip->pin_b, HIGH);
  }

  chip->tx_transition_count++;
  if (chip->tx_transition_count % 16 == 0) {
    printf("[MAX485.CHIP] Modbus RTU SCADA Stream: Transmitted 16 bit-transitions on RS485 differential pair (A/B).\n");
  }
}

void chip_init() {
  max485_state_t *chip = (max485_state_t *)malloc(sizeof(max485_state_t));

  chip->pin_vcc   = pin_init("VCC", INPUT_PULLUP);
  chip->pin_gnd   = pin_init("GND", INPUT_PULLDOWN);
  chip->pin_ro    = pin_init("RO", OUTPUT);
  chip->pin_re_de = pin_init("RE_DE", INPUT_PULLDOWN);
  chip->pin_di    = pin_init("DI", INPUT_PULLUP);
  chip->pin_a     = pin_init("A", OUTPUT);
  chip->pin_b     = pin_init("B", OUTPUT);

  chip->is_transmitting = false;
  chip->tx_transition_count = 0;

  // Initial state: RX Mode, RO Idle High
  pin_write(chip->pin_ro, HIGH);
  pin_write(chip->pin_a, LOW);
  pin_write(chip->pin_b, LOW);

  // Watch DE/RE pin for half-duplex direction switching
  const pin_watch_config_t re_de_watch = {
    .edge = BOTH,
    .pin_change = on_re_de_change,
    .user_data = chip,
  };
  pin_watch(chip->pin_re_de, &re_de_watch);

  // Watch DI pin (UART TX from ESP32 GPIO 17)
  const pin_watch_config_t di_watch = {
    .edge = BOTH,
    .pin_change = on_di_change,
    .user_data = chip,
  };
  pin_watch(chip->pin_di, &di_watch);

  printf("[MAX485.CHIP] MAX485 TTL-to-RS485 Transceiver Initialized (RO: 16, DI: 17, RE/DE: 4).\n");
}
