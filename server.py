#!/usr/bin/env python3
"""
TX100 Industrial IoT Hazard Detection Probe — Local HTTP Web Server
Zero external dependencies, self-contained server on port 8080.
"""

import sys
import os
import http.server
import socketserver

PORT = 8080

def run():
    web_dir = os.path.dirname(os.path.abspath(__file__))
    os.chdir(web_dir)

    Handler = http.server.SimpleHTTPRequestHandler

    # Enable address reuse so restarts don't hit address already in use errors
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(("", PORT), Handler) as httpd:
        print(f"==================================================================")
        print(f" TX100 INDUSTRIAL IoT DIGITAL TWIN & HIL SIMULATOR ACTIVE")
        print(f" Serving directory: {web_dir}")
        print(f" Local Web Server URL: http://localhost:{PORT}/")
        print(f" Open http://localhost:{PORT}/ in your browser to interact!")
        print(f"==================================================================")
        sys.stdout.flush()
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nShutting down server...")
            sys.stdout.flush()

if __name__ == "__main__":
    run()
