"""Slack 요청 서명 검증과 Cognito ID 토큰 검증"""
import base64
import hashlib
import hmac
import time

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from jose import jwk, jwt

from conftest import load_service_module

SECRET = "test-signing-secret"
BODY = "token=x&user_id=U1&command=%2Fmodels"


@pytest.fixture
def ss():
    return load_service_module("services/slackbot", "slack_security")


def signed_event(body=BODY, ts=None, secret=SECRET):
    ts = str(int(ts if ts is not None else time.time()))
    sig = "v0=" + hmac.new(secret.encode(), f"v0:{ts}:{body}".encode(), hashlib.sha256).hexdigest()
    return {"headers": {"X-Slack-Request-Timestamp": ts, "X-Slack-Signature": sig}, "body": body}


def test_valid_signature(ss):
    assert ss.verify_slack_request(signed_event(), SECRET)


def test_base64_encoded_body(ss):
    ev = signed_event()
    ev.update(body=base64.b64encode(BODY.encode()).decode(), isBase64Encoded=True)
    assert ss.verify_slack_request(ev, SECRET)


@pytest.mark.parametrize("mutate", [
    lambda ev: ev.update(body=ev["body"] + "&x=1"),                     # 본문 변조
    lambda ev: ev["headers"].update({"X-Slack-Signature": "v0=00"}),    # 서명 위조
    lambda ev: ev["headers"].pop("X-Slack-Signature"),                  # 서명 누락
    lambda ev: ev["headers"].update({"X-Slack-Request-Timestamp": "abc"}),
])
def test_tampered_requests_are_rejected(ss, mutate):
    ev = signed_event()
    mutate(ev)
    assert not ss.verify_slack_request(ev, SECRET)


def test_replayed_request_older_than_5_minutes_is_rejected(ss):
    ev = signed_event(ts=time.time() - 301)
    assert not ss.verify_slack_request(ev, SECRET)


def test_missing_secret_fails_closed(ss):
    assert not ss.verify_slack_request(signed_event(), "")


# --- Cognito ID 토큰 ---------------------------------------------------------

ISSUER = "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_TEST"


@pytest.fixture
def signing_key(ss):
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    public = jwk.construct(key.public_key().public_bytes(
        serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo), "RS256").to_dict()
    public["kid"] = "k1"
    ss._jwks_cache[ISSUER] = {"keys": [public]}
    yield key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                            serialization.NoEncryption())
    ss._jwks_cache.clear()


def make_token(key, **overrides):
    now = int(time.time())
    claims = {"iss": ISSUER, "aud": "test-client-id", "iat": now, "exp": now + 300,
              "token_use": "id", "email": "user@example.com", **overrides}
    return jwt.encode(claims, key, algorithm="RS256", headers={"kid": "k1"})


def verify(ss, token):
    return ss.verify_cognito_id_token(token, None, "us-east-1", "us-east-1_TEST", "test-client-id")


def test_valid_id_token(ss, signing_key):
    assert verify(ss, make_token(signing_key))["email"] == "user@example.com"


@pytest.mark.parametrize("overrides", [
    {"aud": "other-client"},
    {"iss": "https://cognito-idp.us-east-1.amazonaws.com/other-pool"},
    {"exp": int(time.time()) - 10},
    {"token_use": "access"},
])
def test_invalid_claims_are_rejected(ss, signing_key, overrides):
    with pytest.raises(Exception):
        verify(ss, make_token(signing_key, **overrides))


def test_token_signed_with_other_key_is_rejected(ss, signing_key):
    other = rsa.generate_private_key(public_exponent=65537, key_size=2048).private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption())
    with pytest.raises(Exception):
        verify(ss, make_token(other))
