import base64
import hashlib
import hmac
import time
import requests
from jose import jwt

# Slack 권장값: 5분보다 오래된 요청은 재전송(replay) 공격으로 간주
MAX_REQUEST_AGE_SECONDS = 60 * 5

_jwks_cache = {}


def get_raw_body(event):
    body = event.get("body") or ""
    if event.get("isBase64Encoded"):
        body = base64.b64decode(body).decode("utf-8")
    return body


def verify_slack_request(event, signing_secret, now=None):
    """Slack Signing Secret으로 요청 서명(X-Slack-Signature)을 검증한다.

    https://api.slack.com/authentication/verifying-requests-from-slack
    """
    if not signing_secret:
        # 비밀 값이 없으면 검증할 수 없으므로 요청을 거부한다 (fail closed)
        print("SlackSigningSecret이 설정되지 않아 요청을 거부합니다.")
        return False

    headers = {k.lower(): v for k, v in (event.get("headers") or {}).items()}
    timestamp = headers.get("x-slack-request-timestamp", "")
    signature = headers.get("x-slack-signature", "")
    if not timestamp.isdigit() or not signature:
        return False

    now = now if now is not None else time.time()
    if abs(now - int(timestamp)) > MAX_REQUEST_AGE_SECONDS:
        return False

    base_string = f"v0:{timestamp}:{get_raw_body(event)}".encode("utf-8")
    expected = "v0=" + hmac.new(signing_secret.encode("utf-8"), base_string, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, signature)


def _get_jwks(issuer):
    if issuer not in _jwks_cache:
        res = requests.get(f"{issuer}/.well-known/jwks.json", timeout=5)
        res.raise_for_status()
        _jwks_cache[issuer] = res.json()
    return _jwks_cache[issuer]


def verify_cognito_id_token(id_token, access_token, region, user_pool_id, client_id):
    """Cognito ID 토큰의 서명(JWKS), 발급자, 대상(aud), 만료, at_hash를 검증하고 클레임을 반환한다."""
    issuer = f"https://cognito-idp.{region}.amazonaws.com/{user_pool_id}"
    claims = jwt.decode(
        id_token,
        _get_jwks(issuer),
        algorithms=["RS256"],
        audience=client_id,
        issuer=issuer,
        access_token=access_token,
    )
    if claims.get("token_use") != "id":
        raise ValueError("ID 토큰이 아닙니다.")
    return claims
