# llm/lambda_function.py
import requests
from llm_service import (parse_body, handle_llm1_with_mcp, handle_progress, handle_audit, available_models,
                         pick_default_model)
from common.config import get_config
from common.utils import cors_response


def lambda_handler(event, context):
    CONFIG = get_config()
    path = event.get("path", "")
    http_method = event.get("httpMethod", "")
    origin = event.get("headers", {}).get("origin", f"https://{CONFIG['amplify']['default_domain_with_env']}")

    if http_method == "OPTIONS":
        response = cors_response(200, "", origin)
        return response

    try:
        body = parse_body(event) or {}
        if path == "/health" and http_method == "GET":
            # Anthropic 모델 목록과 기본 모델 (웹과 Slack 봇이 처음 선택할 모델로 쓴다)
            models = available_models()

            response_data = {
                "status": "ok",
                "models": models,
                "default_model": pick_default_model(models),
            }

            return cors_response(200, response_data, origin)

        elif path == "/llm1" and http_method == "POST":
            claims = (event.get("requestContext") or {}).get("authorizer", {}).get("claims") or {}
            caller_id = claims.get("sub")
            if caller_id:
                # API Gateway(웹) 요청은 Slack 전용 필드를 사용할 수 없다 (임의 Slack 사용자에게 DM 전송 방지).
                # Slack 봇은 API Gateway를 거치지 않고 Lambda를 직접 호출한다.
                body.pop("user_id", None)
                body.pop("previous_questions", None)
            return handle_llm1_with_mcp(body, origin, caller_id, claims.get("email"))

        elif path.startswith("/llm1/progress/") and http_method == "GET":
            # 답변을 만드는 동안의 진행 상황 (화면이 /llm1 응답을 기다리며 1초마다 묻는다)
            claims = (event.get("requestContext") or {}).get("authorizer", {}).get("claims") or {}
            return handle_progress(path.rsplit("/", 1)[-1], claims.get("sub"), origin)

        elif path == "/audit" and http_method == "GET":
            # 감사 로그 (누가 어떤 도구를 불렀나). 관리자 여부는 ID 토큰의 cognito:groups로 판단한다
            claims = (event.get("requestContext") or {}).get("authorizer", {}).get("claims") or {}
            return handle_audit(event.get("queryStringParameters") or {}, claims.get("sub"), claims, origin)

        else:
            return cors_response(404, {"error": f"Route {http_method} {path} not found."}, origin)

    except Exception as e:
        return cors_response(500, {"error": "Internal server error", "detail": str(e)}, origin)