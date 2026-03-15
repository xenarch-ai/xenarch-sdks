"""Tests for HMAC-SHA256 access token verification."""

from tests.conftest import ACCESS_TOKEN_SECRET, SITE_ID, generate_test_token

from xenarch.token import verify_access_token


class TestVerifyAccessToken:

    def test_valid_token(self):
        token = generate_test_token()
        result = verify_access_token(token, SITE_ID, ACCESS_TOKEN_SECRET)
        assert result is not None
        assert result["site_id"] == SITE_ID
        assert "gate_id" in result
        assert "exp" in result
        assert "iat" in result

    def test_expired_token(self):
        token = generate_test_token(expired=True)
        result = verify_access_token(token, SITE_ID, ACCESS_TOKEN_SECRET)
        assert result is None

    def test_wrong_site_id(self):
        token = generate_test_token()
        result = verify_access_token(token, "wrong-site-id", ACCESS_TOKEN_SECRET)
        assert result is None

    def test_tampered_signature(self):
        token = generate_test_token()
        parts = token.split(".")
        # Flip a character in the signature
        tampered_sig = parts[1][:-1] + ("A" if parts[1][-1] != "A" else "B")
        tampered_token = f"{parts[0]}.{tampered_sig}"
        result = verify_access_token(tampered_token, SITE_ID, ACCESS_TOKEN_SECRET)
        assert result is None

    def test_wrong_secret(self):
        token = generate_test_token()
        result = verify_access_token(token, SITE_ID, "wrong-secret")
        assert result is None

    def test_malformed_no_dot(self):
        result = verify_access_token("nodothere", SITE_ID, ACCESS_TOKEN_SECRET)
        assert result is None

    def test_malformed_too_many_dots(self):
        result = verify_access_token("a.b.c", SITE_ID, ACCESS_TOKEN_SECRET)
        assert result is None

    def test_malformed_empty_parts(self):
        result = verify_access_token(".", SITE_ID, ACCESS_TOKEN_SECRET)
        assert result is None

    def test_malformed_invalid_base64(self):
        result = verify_access_token("!!!.???", SITE_ID, ACCESS_TOKEN_SECRET)
        assert result is None

    def test_cross_validates_with_platform_token_generation(self):
        """Verify that tokens generated with the same logic as the platform
        are correctly verified by the SDK."""
        token = generate_test_token(
            site_id=SITE_ID,
            secret=ACCESS_TOKEN_SECRET,
            gate_id="770e8400-e29b-41d4-a716-446655440002",
        )
        result = verify_access_token(token, SITE_ID, ACCESS_TOKEN_SECRET)
        assert result is not None
        assert result["gate_id"] == "770e8400-e29b-41d4-a716-446655440002"
