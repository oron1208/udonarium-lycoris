#!/usr/bin/env python3
"""Udonarium Lily web server with signaling reverse proxy on same port."""

import http.server
import json
import socketserver
import urllib.request
import urllib.error
import os
import sys

PORT = 18794
SIGNALING_BACKEND = "http://127.0.0.1:18793"
WEB_ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "dist", "udonarium_lily")


class ProxyHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=WEB_ROOT, **kwargs)

    def do_GET(self):
        if self.path == "/signaling" or self.path.startswith("/signaling?"):
            self._proxy_error("Use WebSocket for /signaling")
            return
        if self.path == "/health":
            self._proxy_get(f"{SIGNALING_BACKEND}/health")
            return
        super().do_GET()

    def do_POST(self):
        if self.path == "/signaling":
            self._proxy_request(SIGNALING_BACKEND)
            return
        self.send_error(404)

    def do_OPTIONS(self):
        if self.path == "/signaling":
            self.send_response(204)
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.end_headers()
            return
        super().do_OPTIONS()

    def _proxy_get(self, url):
        try:
            req = urllib.request.Request(url)
            with urllib.request.urlopen(req) as resp:
                data = resp.read()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", len(data))
                self.end_headers()
                self.wfile.write(data)
        except Exception as e:
            self.send_error(502, str(e))

    def _proxy_request(self, backend):
        try:
            content_length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(content_length) if content_length > 0 else None
            req = urllib.request.Request(
                f"{backend}{self.path}",
                data=body,
                headers={"Content-Type": self.headers.get("Content-Type", "application/json")},
                method="POST",
            )
            with urllib.request.urlopen(req) as resp:
                data = resp.read()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", len(data))
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                self.wfile.write(data)
        except Exception as e:
            self.send_error(502, str(e))

    def _proxy_error(self, msg):
        self.send_response(400)
        self.send_header("Content-Type", "application/json")
        data = json.dumps({"error": msg}).encode()
        self.send_header("Content-Length", len(data))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, format, *args):
        sys.stderr.write(f"[udonarium-web] {args[0]} {args[1]} {args[2]}\n")


if __name__ == "__main__":
    with socketserver.TCPServer(("", PORT), ProxyHandler) as httpd:
        print(f"Udonarium Lily web server on :{PORT} (with /signaling proxy)")
        httpd.serve_forever()
