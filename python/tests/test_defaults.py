"""Every client default points at the API host.

The bare ``xenarch.dev`` host 301-redirects every request to the xenarch.com
homepage. A default left on it made gates fail open and made a tokened agent's
preflight read the redirect as "control plane unreachable", refusing every
payment. One check over every public default keeps a new one from drifting.
"""

import inspect

from xenarch._defaults import DEFAULT_API_BASE
from xenarch._payer import XenarchPayer
from xenarch.client import XenarchClient
from xenarch.decorator import require_payment
from xenarch.middleware import XenarchMiddleware


def test_default_api_base_is_the_api_host():
    assert DEFAULT_API_BASE == "https://api.xenarch.dev"


def test_every_public_default_uses_the_api_host():
    defaults = {
        "XenarchClient.api_base": inspect.signature(XenarchClient).parameters["api_base"].default,
        "require_payment.api_base": inspect.signature(require_payment).parameters["api_base"].default,
        "XenarchMiddleware.api_base": inspect.signature(XenarchMiddleware).parameters["api_base"].default,
        "XenarchPayer.facilitator_url": inspect.signature(XenarchPayer).parameters["facilitator_url"].default,
        "XenarchPayer.agent_control_plane_url": inspect.signature(XenarchPayer)
        .parameters["agent_control_plane_url"]
        .default,
    }
    assert defaults == dict.fromkeys(defaults, DEFAULT_API_BASE)
