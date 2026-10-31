/**
 * ============================================================================
 * WOKWI CUSTOM CHIP: Capacitive Soil Moisture Sensor v2.0 Emulation
 * ============================================================================
 * Implements:
 * - Analog DAC Voltage injection using pin_dac_write()
 * - Translates relative permittivity shifts (dry soil eps_r in [2, 6] vs water eps_r ≈ 80)
 * - Sweeps analog output from 3.00V (dry, 0% moisture) down to 1.80V (saturated, 100% moisture)
 * ============================================================================
 */

#include "wokwi-api.h"
#include <stdio.h>
#include <stdlib.h>

typedef struct {
  pin_t pin_vcc;
  pin_t pin_gnd;
  pin_t pin_aout;
  uint32_t moisture_attr;
  timer_t update_timer;
} chip_state_t;

static void update_analog_output(void *user_data) {
  chip_state_t *chip = (chip_state_t *)user_data;
  float moisture_pct = attr_read_float(chip->moisture_attr);

  if (moisture_pct < 0.0f) moisture_pct = 0.0f;
  if (moisture_pct > 100.0f) moisture_pct = 100.0f;

  // Permittivity: dry soil eps_r ≈ 4.0, water eps_r ≈ 80.0
  float eps_r = 4.0f + (moisture_pct / 100.0f) * 76.0f;

  // Voltage sweep: 3.00V (dry) down to 1.80V (saturated)
  float voltage = 3.00f - (moisture_pct / 100.0f) * 1.20f;

  // Inject DAC voltage to AOUT pin
  pin_dac_write(chip->pin_aout, voltage);
}

void chip_init() {
  chip_state_t *chip = (chip_state_t *)malloc(sizeof(chip_state_t));

  chip->pin_vcc = pin_init("VCC", INPUT_PULLUP);
  chip->pin_gnd = pin_init("GND", INPUT_PULLDOWN);
  chip->pin_aout = pin_init("AOUT", ANALOG);

  chip->moisture_attr = attr_init_float("moisture_pct", 22.0f);

  const timer_config_t timer_cfg = {
    .callback = update_analog_output,
    .user_data = chip,
  };
  chip->update_timer = timer_init(&timer_cfg);
  timer_start(chip->update_timer, 50000, true); // Update every 50ms (20 Hz)

  // Initial injection
  update_analog_output(chip);

  printf("[SOIL.CHIP] Capacitive Soil Sensor v2.0 initialized on AOUT.\n");
}
