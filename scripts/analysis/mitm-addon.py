"""
mitmproxy addon — Capture api.anthropic.com traffic to JSON files.
Usage: mitmdump -s mitm-addon.py --set output_dir=./captures
"""

import json
import os
import time

from mitmproxy import ctx, http


class AnthropicCapture:
    def __init__(self):
        self.output_dir = "./captures"

    def load(self, loader):
        loader.add_option(
            "output_dir", str, "./captures", "Output directory for captures"
        )

    def configure(self, updates):
        self.output_dir = ctx.options.output_dir
        os.makedirs(self.output_dir, exist_ok=True)

    def response(self, flow: http.HTTPFlow):
        if "api.anthropic.com" not in (flow.request.host or ""):
            return
        capture = {
            "timestamp": time.time(),
            "url": flow.request.pretty_url,
            "method": flow.request.method,
            "headers": dict(flow.request.headers),
            "body": flow.request.get_text(),
            "response": {
                "status": flow.response.status_code,
                "headers": dict(flow.response.headers),
                "body": flow.response.get_text()[:10000],
            },
        }
        filename = f"{int(time.time() * 1000)}.json"
        filepath = os.path.join(self.output_dir, filename)
        with open(filepath, "w") as f:
            json.dump(capture, f, indent=2)
        ctx.log.info(
            f"Captured: {flow.request.method} {flow.request.pretty_url} -> {filepath}"
        )


addons = [AnthropicCapture()]
