"""
Unit tests for the security primitives. No database, no network — these run
in milliseconds and are the first thing to check if auth starts misbehaving.
"""
from app.auth.crypto import (
    create_session_token,
    generate_api_key,
    hash_api_key,
    hash_password,
    read_session_token,
    verify_api_key,
    verify_password,
)


class TestPasswords:
    def test_hash_is_not_the_password(self):
        hashed = hash_password("hunter2")
        assert "hunter2" not in hashed
        assert hashed.startswith("$2b$")          # bcrypt's format marker

    def test_correct_password_verifies(self):
        assert verify_password("hunter2", hash_password("hunter2"))

    def test_wrong_password_rejected(self):
        assert not verify_password("wrong", hash_password("hunter2"))

    def test_same_password_gives_different_hashes(self):
        """The salt is what makes this true — without it, identical passwords
        would produce identical hashes and be spottable in a leaked database."""
        assert hash_password("same") != hash_password("same")

    def test_malformed_stored_hash_is_a_failed_login_not_a_crash(self):
        assert verify_password("anything", "not-a-real-bcrypt-hash") is False


class TestSessionTokens:
    def test_roundtrip_carries_the_ids(self):
        token = create_session_token("user-1", "org-1")
        payload = read_session_token(token)
        assert payload["sub"] == "user-1"
        assert payload["org"] == "org-1"

    def test_tampered_token_is_rejected(self):
        """Flipping any character breaks the signature, which is the entire
        security property of a JWT — the payload is readable, not forgeable."""
        token = create_session_token("user-1", "org-1")
        tampered = token[:-4] + ("aaaa" if not token.endswith("aaaa") else "bbbb")
        assert read_session_token(tampered) is None

    def test_garbage_is_rejected(self):
        assert read_session_token("not.a.jwt") is None


class TestApiKeys:
    def test_shape(self):
        raw, prefix, hashed = generate_api_key()
        assert raw.startswith("sl_live_")
        assert raw.startswith(prefix)             # prefix is the visible head of the key
        assert raw not in hashed                  # the raw key is never recoverable

    def test_keys_are_unique(self):
        assert generate_api_key()[0] != generate_api_key()[0]

    def test_correct_key_verifies(self):
        raw, _, hashed = generate_api_key()
        assert verify_api_key(raw, hashed)

    def test_wrong_key_rejected(self):
        _, _, hashed = generate_api_key()
        other_raw, _, _ = generate_api_key()
        assert not verify_api_key(other_raw, hashed)

    def test_hash_is_deterministic(self):
        """Same key must always hash the same way, or lookups would never match."""
        raw, _, _ = generate_api_key()
        assert hash_api_key(raw) == hash_api_key(raw)
