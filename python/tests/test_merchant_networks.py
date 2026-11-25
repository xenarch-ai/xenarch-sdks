"""LinksAPI networks / set_networks / wallet_scan / available_networks (XEN-719)."""
from __future__ import annotations

import json

import httpx

from xenarch.merchant import MerchantClient


def _client(calls: list[httpx.Request], reply: dict) -> MerchantClient:
    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        return httpx.Response(200, json=reply)

    c = MerchantClient("sess_abc", api_base="https://api.test")
    c._transport._client = httpx.Client(
        base_url="https://api.test/v1",
        cookies={"xen_session": "sess_abc"},
        transport=httpx.MockTransport(handler),
    )
    return c


def test_networks_gets_owner_choice():
    calls: list[httpx.Request] = []
    c = _client(calls, {"link_id": "lnk_1", "accepted_networks": None, "networks": [], "available": []})
    res = c.links.networks("lnk_1")
    assert calls[0].method == "GET"
    assert str(calls[0].url) == "https://api.test/v1/links/lnk_1/networks"
    assert res["link_id"] == "lnk_1"


def test_set_networks_puts_whole_choice():
    calls: list[httpx.Request] = []
    c = _client(calls, {"link_id": "lnk_1"})
    choice = {"ethereum": {"tokens": ["USDC", "USDT"]}, "tron": {"tokens": ["USDT"], "pay_to": "TXYZ"}}
    c.links.set_networks("lnk_1", choice)
    assert calls[0].method == "PUT"
    assert str(calls[0].url) == "https://api.test/v1/links/lnk_1/networks"
    assert json.loads(calls[0].content) == {"networks": choice}


def test_wallet_scan_passes_address():
    calls: list[httpx.Request] = []
    c = _client(calls, {"address": "0xAb", "balances": [], "unavailable": []})
    c.links.wallet_scan("lnk_1", "0xab")
    assert calls[0].method == "GET"
    assert str(calls[0].url) == "https://api.test/v1/links/lnk_1/wallet-scan?address=0xab"


def test_available_networks_reads_registry():
    calls: list[httpx.Request] = []
    c = _client(calls, {"networks": [{"network": "base", "always_on": True}]})
    res = c.links.available_networks()
    assert str(calls[0].url) == "https://api.test/v1/networks"
    assert res["networks"][0]["always_on"] is True


def test_link_id_is_path_escaped():
    calls: list[httpx.Request] = []
    c = _client(calls, {})
    c.links.networks("../payments/received")
    assert calls[0].url.raw_path == b"/v1/links/..%2Fpayments%2Freceived/networks"
