"""Tests for Category 1 bot detection."""

import pytest

from xenarch.detection import KNOWN_BOT_SIGNATURES, is_bot


class TestIsBot:
    """Test is_bot() against known AI crawler User-Agents."""

    @pytest.mark.parametrize("signature", KNOWN_BOT_SIGNATURES)
    def test_known_bot_signatures(self, signature: str):
        assert is_bot(signature) is True

    @pytest.mark.parametrize("signature", KNOWN_BOT_SIGNATURES)
    def test_case_insensitive(self, signature: str):
        assert is_bot(signature.upper()) is True
        assert is_bot(signature.lower()) is True

    @pytest.mark.parametrize(
        "ua",
        [
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0",
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Firefox/121.0",
            "Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) Safari/604.1",
        ],
    )
    def test_human_user_agents(self, ua: str):
        assert is_bot(ua) is False

    def test_none_returns_false(self):
        assert is_bot(None) is False

    def test_empty_string_returns_false(self):
        assert is_bot("") is False

    def test_partial_match_in_longer_string(self):
        ua = "Mozilla/5.0 (compatible; GPTBot/1.0; +https://openai.com/gptbot)"
        assert is_bot(ua) is True

    def test_signature_count(self):
        assert len(KNOWN_BOT_SIGNATURES) == 21
