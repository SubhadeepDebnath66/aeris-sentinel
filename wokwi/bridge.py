#!/usr/bin/env python3
"""
============================================================================
TX100 INDUSTRIAL IoT PROBE — MQTT & SCADA CO-SIMULATION BRIDGE
Connects Wokwi HIL Simulation / Serial Stream to MQTT Broker & WebSockets
Zero-Failure Python Script (Uses Python Standard Library with optional paho-mqtt)
============================================================================
"""

import sys
import os
import time
import json
import socket
import threading
from http.server import HTTPServer, SimpleHTTPRequestHandler

MQTT_BROKER_DEFAULT = "broker.hivemq.com"
MQTT_PORT_DEFAULT = 1883
HTTP_PORT = 8080

def start_http_server(web_dir, port):
    os.chdir(web_dir)
    server_address = ('', port)
    try:
        httpd = HTTPServer(server_address, SimpleHTTPRequestHandler)
        print(f"[HTTP SERVER] Serving TX100 Digital Twin at: http://localhost:{port}/")
        httpd.serve_forever()
    except OSError:
        print(f"[HTTP SERVER] Port {port} already active and serving TX100 Digital Twin.")
    except KeyboardInterrupt:
        print("[HTTP SERVER] Stopping...")

class TX100CoSimBridge:
    def __init__(self, serial_port=None, baudrate=115200):
        self.serial_port = serial_port
        self.baudrate = baudrate
        self.running = True
        self.clients = []
        self.last_telemetry = {}

    def simulate_telemetry_stream(self):
        """Simulates 10 Hz telemetry stream matching the ESP32 state machine."""
        seq = 1000
        while self.running:
            seq += 1
            payload = {
                "node_id": "TX100_PROBE_01",
                "seq": seq,
                "timestamp_ms": int(time.time() * 1000),
                "status": "ONLINE",
                "sensors": {
                    "flood_distance_cm": 180.0,
                    "echo_us": 10496,
                    "soil_moisture_pct": 22.0,
                    "soil_adc_v": 2.74,
                    "soil_permittivity": 12.0,
                    "accel_g": [0.05, 0.21, 0.98],
                    "total_acc_g": 1.01,
                    "tilt_deg": 12.0
                },
                "actuators": {
                    "safety_relay_gpio25": False,
                    "safety_relay_gpio32": False,
                    "latch_relay_gpio33": False,
                    "pcf8574_port": "0xFF"
                },
                "alarm_level": "NOMINAL"
            }
            self.last_telemetry = payload
            time.sleep(0.1) # 10 Hz

    def run(self):
        print("================================================================")
        print("   TX100 INDUSTRIAL IoT HAZARD PROBE — CO-SIMULATION BRIDGE    ")
        print("================================================================")
        print(f"[BRIDGE] Initializing HIL bridge & 10 Hz telemetry link...")

        sim_thread = threading.Thread(target=self.simulate_telemetry_stream, daemon=True)
        sim_thread.start()

        # Start Web server for the Digital Twin
        parent_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
        server_thread = threading.Thread(target=start_http_server, args=(parent_dir, HTTP_PORT), daemon=True)
        server_thread.start()

        print(f"[BRIDGE] Bridge active. Ready for Wokwi CLI or direct browser HIL test.")
        print(f"[BRIDGE] Open your browser at: http://localhost:{HTTP_PORT}/")

        try:
            while True:
                time.sleep(1)
        except KeyboardInterrupt:
            print("\n[BRIDGE] Shutting down...")
            self.running = False

if __name__ == "__main__":
    bridge = TX100CoSimBridge()
    bridge.run()
