import requests
import urllib.parse
import json
from common.config import get_config
from common.slackbot_session import get_session, save_session, send_slack_dm
from slackbot_service import send_login_button, handle_interaction, handle_req_command, handle_slack_events
from slack_security import get_raw_body, verify_slack_request, verify_cognito_id_token

# Slack이 호출하는 경로: Signing Secret 서명 검증 대상 (/callback은 Cognito 리다이렉트라 제외)
SLACK_SIGNED_PATHS = {"/login", "/slack-interactions", "/events"}

def lambda_handler(event, context):
    path = event.get("path", "")
    http_method = event.get("httpMethod", "")
    CONFIG = get_config()

    if path in SLACK_SIGNED_PATHS and not verify_slack_request(event, CONFIG["slackbot"].get("signing_secret")):
        print(f"Slack 서명 검증 실패: {http_method} {path}")
        return {"statusCode": 401, "body": "invalid signature"}

    body = get_raw_body(event)

    if path == "/login" and http_method == "POST":
        body = urllib.parse.parse_qs(body)
        slack_user_id = body.get("user_id", [""])[0]
        send_login_button(slack_user_id)
        return {
            "statusCode": 200,
            "body": "🔐 로그인 링크를 Slack DM으로 전송했습니다!"
        }
    
    elif path == "/callback" and http_method == "GET":
        params = event.get("queryStringParameters") or {}
        code = params.get("code")
        slack_user_id = params.get("state")

        if not code or not slack_user_id:
            return {
                "statusCode": 200,
                "body": "<h3>❗ Access Deined. Please login in slack first.</h3>",
                "headers": {"Content-Type": "text/html"}
            }

        # Cognito 토큰 교환
        res = requests.post(
            f"{CONFIG['cognito']['domain']}/oauth2/token",
            data={
                "grant_type": "authorization_code",
                "client_id": CONFIG['cognito']['client_id'],
                "code": code,
                "redirect_uri": f"{CONFIG['api']['endpoint']}/callback" # Api ENDPOINT/callback URL 입력
            },
            headers={"Content-Type": "application/x-www-form-urlencoded"}
        )
        
        if res.status_code != 200:
            return {
                "statusCode": 500,
                "body": "Token Exchange Failed",
                "headers": {"Content-Type": "text/html"}
            }

        tokens = res.json()
        # 여기에 access_token, id_token 저장 or 검증

        try:
            user_info = verify_cognito_id_token(
                tokens["id_token"],
                tokens["access_token"],
                region=CONFIG["aws_region"],
                user_pool_id=CONFIG["cognito"]["user_pool_id"],
                client_id=CONFIG["cognito"]["client_id"],
            )
        except Exception as e:
            print(f"ID 토큰 검증 실패: {e}")
            return {
                "statusCode": 401,
                "body": "<h3>Invalid token.</h3>",
                "headers": {"Content-Type": "text/html"}
            }
        email = user_info.get("email")

        save_session(
            slack_user_id=slack_user_id,
            access_token=tokens["access_token"],
            id_token=tokens["id_token"],
            email=email
        )

        return {
            "statusCode": 200,
            "body": "<h3>Login Complete!!.</h3>",
            "headers": {"Content-Type": "text/html"}
        }
    # 모델 선택(/models)은 없앴다: 모델은 LLM 서비스가 요청할 때의 최신 Sonnet으로 정한다
    elif path == "/slack-interactions" and http_method == "POST":
        parsed_data = urllib.parse.parse_qs(body)
        payload_str = parsed_data.get('payload', [''])[0]
        payload = json.loads(payload_str)

        print(f"Interaction payload: {payload}")
        return handle_interaction(payload)

    elif path =="/events" and http_method == "POST":
        print("events 진입")
        return handle_slack_events(event, context)

    else:
        return {
            "statusCode": 404,
            "body": json.dumps({"error": f"Route {http_method} {path} not found."})
        }