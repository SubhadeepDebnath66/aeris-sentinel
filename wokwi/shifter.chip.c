/**
 * ============================================================================
 * WOKWI CUSTOM CHIP: 1kΩ / 2kΩ Voltage Divider & Fast Logic Shifter
 * ============================================================================
 * Implements:
 * - Drops 5V ECHO pulses to 3.33V safe logic levels for ESP32 GPIO 35
 * - pin_init with INPUT on 5V side, OUTPUT on 3.3V side
 * - pin_watch on BOTH edges to preserve exact microsecond pulse timing
 * ============================================================================
 */

#include "wokwi-api.h"
#include <stdio.h>
#include <stdlib.h>

typedef struct {
  pin_t pin_gnd;
  pin_t pin_in_5v;
  pin_t pin_out_3v3;
} chip_state_t;

static void on_pin_5v_changed(void *user_data, pin_t pin, uint32_t value) {
  chip_state_t *chip = (chip_state_t *)user_data;
  // Translate 5V digital level to 3.3V digital level
  // V_out = 5V * (2k / (1k + 2k)) = 3.33V
  pin_write(chip->pin_out_3v3, value);
}

void chip_init() {
  chip_state_t *chip = (chip_state_t *)malloc(sizeof(chip_state_t));

  chip->pin_gnd = pin_init("GND", INPUT_PULLDOWN);
  chip->pin_in_5v = pin_init("IN_5V", INPUT);
  chip->pin_out_3v3 = pin_init("OUT_3V3", OUTPUT);

  pin_write(chip->pin_out_3v3, LOW);

  const pin_watch_config_t watch_cfg = {
    .edge = BOTH,
    .pin_change = on_pin_5v_changed,
    .user_data = chip,
  };
  pin_watch(chip->pin_in_5v, &watch_cfg);

  printf("[SHIFTER.CHIP] 1k/2k Level Shifter active. 5V -> 3.33V microsecond passthrough.\n");
}
