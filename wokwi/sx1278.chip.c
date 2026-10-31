/**
 * ============================================================================
 * WOKWI CUSTOM CHIP: Ai-Thinker Ra-02 SX1278 LoRa Module Emulation
 * ============================================================================
 * Implements:
 * - SPI Slave Device (MOSI, MISO, SCK, NSS)
 * - REG_VERSION (0x42) = 0x12
 * - REG_OP_MODE (0x01), REG_FIFO (0x00), REG_IRQ_FLAGS (0x12)
 * - DIO0 TXDone Interrupt Pulse
 * - DIO1 CAD (Channel Activity Detection) timer emulation using get_sim_nanos()
 * - Hexadecimal packet console output
 * ============================================================================
 */

#include "wokwi-api.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define REG_FIFO            0x00
#define REG_OP_MODE         0x01
#define REG_IRQ_FLAGS       0x12
#define REG_DIO_MAPPING_1   0x40
#define REG_VERSION         0x42

typedef struct {
  pin_t pin_nss;
  pin_t pin_rst;
  pin_t pin_dio0;
  pin_t pin_dio1;
  spi_dev_t spi;

  uint8_t registers[0x80];
  uint8_t fifo[256];
  uint8_t fifo_head;
  uint8_t fifo_len;

  bool spi_active;
  bool is_write;
  uint8_t current_reg;
  bool addr_received;

  timer_t tx_timer;
  timer_t cad_timer;
  uint64_t last_cad_nanos;
} chip_state_t;

static void on_tx_complete(void *user_data) {
  chip_state_t *chip = (chip_state_t *)user_data;
  chip->registers[REG_IRQ_FLAGS] |= 0x08; // Set TxDone flag
  pin_write(chip->pin_dio0, HIGH);
  printf("[SX1278.CHIP] TX Completed. Fired DIO0 IRQ (HIGH).\n");
}

static void on_cad_complete(void *user_data) {
  chip_state_t *chip = (chip_state_t *)user_data;
  chip->registers[REG_IRQ_FLAGS] |= 0x01; // Set CadDetected / CadDone flag
  pin_write(chip->pin_dio1, HIGH);
  printf("[SX1278.CHIP] CAD Activity Evaluated at %llu ns. Fired DIO1 (HIGH).\n",
    (unsigned long long)get_sim_nanos());
}

static void on_spi_done(void *user_data, uint8_t *buffer, uint32_t count) {
  chip_state_t *chip = (chip_state_t *)user_data;
  if (count == 0) return;

  uint8_t rx_byte = buffer[0];
  uint8_t tx_byte = 0x00;

  if (!chip->addr_received) {
    chip->current_reg = rx_byte & 0x7F;
    chip->is_write = (rx_byte & 0x80) != 0;
    chip->addr_received = true;

    if (!chip->is_write) {
      tx_byte = chip->registers[chip->current_reg];
    }
  } else {
    if (chip->is_write) {
      if (chip->current_reg == REG_FIFO) {
        if (chip->fifo_len < 255) {
          chip->fifo[chip->fifo_len++] = rx_byte;
        }
      } else {
        chip->registers[chip->current_reg] = rx_byte;

        // Check if transition to TX mode
        if (chip->current_reg == REG_OP_MODE && (rx_byte & 0x07) == 0x03) {
          printf("[SX1278.CHIP] [LORA-TX-START] Emitting %d bytes payload: [HEX: ", chip->fifo_len);
          for (int i = 0; i < chip->fifo_len; i++) {
            printf("%02X ", chip->fifo[i]);
          }
          printf("]\n");

          chip->fifo_len = 0;
          timer_start(chip->tx_timer, 25000, false); // 25ms simulated packet transmission
        }

        // Check if transition to CAD mode
        if (chip->current_reg == REG_OP_MODE && (rx_byte & 0x07) == 0x07) {
          chip->last_cad_nanos = get_sim_nanos();
          timer_start(chip->cad_timer, 12000, false); // 12ms CAD scan
        }
      }
    } else {
      if (chip->current_reg == REG_FIFO) {
        tx_byte = (chip->fifo_head < chip->fifo_len) ? chip->fifo[chip->fifo_head++] : 0x00;
      } else {
        tx_byte = chip->registers[chip->current_reg];
      }
      chip->current_reg = (chip->current_reg + 1) & 0x7F; // Auto-increment address
    }
  }

  // Ready for next byte
  uint8_t out_buf = tx_byte;
  spi_start(chip->spi, &out_buf, 1);
}

static void on_nss_change(void *user_data, pin_t pin, uint32_t value) {
  chip_state_t *chip = (chip_state_t *)user_data;
  if (value == LOW) {
    // SPI Transaction Begin
    chip->spi_active = true;
    chip->addr_received = false;
    uint8_t dummy = 0;
    spi_start(chip->spi, &dummy, 1);
  } else {
    // SPI Transaction End
    chip->spi_active = false;
    chip->addr_received = false;
    spi_stop(chip->spi);
    // Clear IRQ flags on NSS release if needed
    pin_write(chip->pin_dio0, LOW);
    pin_write(chip->pin_dio1, LOW);
  }
}

static void on_rst_change(void *user_data, pin_t pin, uint32_t value) {
  chip_state_t *chip = (chip_state_t *)user_data;
  if (value == LOW) {
    printf("[SX1278.CHIP] Hardware Reset Triggered.\n");
    chip->registers[REG_VERSION] = 0x12;
    chip->registers[REG_OP_MODE] = 0x09;
    chip->registers[REG_IRQ_FLAGS] = 0x00;
    chip->fifo_len = 0;
    chip->fifo_head = 0;
    pin_write(chip->pin_dio0, LOW);
    pin_write(chip->pin_dio1, LOW);
  }
}

void chip_init() {
  chip_state_t *chip = (chip_state_t *)malloc(sizeof(chip_state_t));
  memset(chip, 0, sizeof(chip_state_t));

  chip->pin_nss = pin_init("NSS", INPUT_PULLUP);
  chip->pin_rst = pin_init("RST", INPUT_PULLUP);
  chip->pin_dio0 = pin_init("DIO0", OUTPUT);
  chip->pin_dio1 = pin_init("DIO1", OUTPUT);

  pin_write(chip->pin_dio0, LOW);
  pin_write(chip->pin_dio1, LOW);

  // Initialize Silicon Version register (0x42 = 0x12)
  chip->registers[REG_VERSION] = 0x12;
  chip->registers[REG_OP_MODE] = 0x09; // Standby default

  const spi_config_t spi_config = {
    .sck = pin_init("SCK", INPUT),
    .mosi = pin_init("MOSI", INPUT),
    .miso = pin_init("MISO", OUTPUT),
    .done = on_spi_done,
    .user_data = chip,
  };
  chip->spi = spi_init(&spi_config);

  const pin_watch_config_t nss_watch = {
    .edge = BOTH,
    .pin_change = on_nss_change,
    .user_data = chip,
  };
  pin_watch(chip->pin_nss, &nss_watch);

  const pin_watch_config_t rst_watch = {
    .edge = BOTH,
    .pin_change = on_rst_change,
    .user_data = chip,
  };
  pin_watch(chip->pin_rst, &rst_watch);

  const timer_config_t tx_timer_cfg = {
    .callback = on_tx_complete,
    .user_data = chip,
  };
  chip->tx_timer = timer_init(&tx_timer_cfg);

  const timer_config_t cad_timer_cfg = {
    .callback = on_cad_complete,
    .user_data = chip,
  };
  chip->cad_timer = timer_init(&cad_timer_cfg);

  printf("[SX1278.CHIP] Initialized. REG_VERSION = 0x12, SPI ready.\n");
}
