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
        import base64

        token = generate_test_token()
        parts = token.split(".")
        sig_b64 = parts[1]
        # Decode, flip a byte in the middle (guaranteed to change bytes,
        # unlike swapping the last char which can collide on base64 padding bits),
        # re-encode without padding to match the original format.
        padded = sig_b64 + "=" * ((4 - len(sig_b64) % 4) % 4)
        sig_bytes = bytearray(base64.urlsafe_b64decode(padded))
        sig_bytes[len(sig_bytes) // 2] ^= 0xFF
        tampered_sig = base64.urlsafe_b64encode(bytes(sig_bytes)).rstrip(b"=").decode("ascii")
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
        token = generate_test_token(
            site_id=SITE_ID,
            secret=ACCESS_TOKEN_SECRET,
            gate_id="770e8400-e29b-41d4-a716-446655440002",
        )
        result = verify_access_token(token, SITE_ID, ACCESS_TOKEN_SECRET)
        assert result is not None
        assert result["gate_id"] == "770e8400-e29b-41d4-a716-446655440002"

    # --- gate_id scoping ---

    def test_wrong_gate_id_rejected(self):
        token = generate_test_token(gate_id="aaa00000-0000-0000-0000-000000000001")
        result = verify_access_token(
            token, SITE_ID, ACCESS_TOKEN_SECRET,
            gate_id="bbb00000-0000-0000-0000-000000000002",
        )
        assert result is None

    def test_correct_gate_id_accepted(self):
        gid = "aaa00000-0000-0000-0000-000000000001"
        token = generate_test_token(gate_id=gid)
        result = verify_access_token(
            token, SITE_ID, ACCESS_TOKEN_SECRET, gate_id=gid,
        )
        assert result is not None

    # --- page scope ---

    def test_page_scope_exact_url_accepted(self):
        token = generate_test_token(url="/docs/intro", scope="page")
        result = verify_access_token(
            token, SITE_ID, ACCESS_TOKEN_SECRET, url="/docs/intro",
        )
        assert result is not None

    def test_page_scope_wrong_url_rejected(self):
        token = generate_test_token(url="/docs/intro", scope="page")
        result = verify_access_token(
            token, SITE_ID, ACCESS_TOKEN_SECRET, url="/docs/api",
        )
        assert result is None

    # --- path scope ---

    def test_path_scope_matching_url_accepted(self):
        token = generate_test_token(
            url="/docs/intro", scope="path", path_pattern="/docs/*",
        )
        result = verify_access_token(
            token, SITE_ID, ACCESS_TOKEN_SECRET, url="/docs/api-reference",
        )
        assert result is not None

    def test_path_scope_non_matching_url_rejected(self):
        token = generate_test_token(
            url="/docs/intro", scope="path", path_pattern="/docs/*",
        )
        result = verify_access_token(
            token, SITE_ID, ACCESS_TOKEN_SECRET, url="/blog/post",
        )
        assert result is None

    # --- url not checked when not provided ---

    def test_url_not_checked_when_not_provided(self):
        token = generate_test_token(url="/specific-page", scope="page")
        result = verify_access_token(token, SITE_ID, ACCESS_TOKEN_SECRET)
        assert result is not None
