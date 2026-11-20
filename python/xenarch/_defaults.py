"""Defaults shared across the SDK.

The Xenarch API lives at ``https://api.xenarch.dev``. The bare ``xenarch.dev``
host answers every request with a 301 to the xenarch.com homepage, so a client
pointed at it never reaches the API: gates fail open, receipts never arrive and
a tokened agent's preflight reads the redirect as "control plane unreachable"
and refuses every payment.
"""

DEFAULT_API_BASE = "https://api.xenarch.dev"
