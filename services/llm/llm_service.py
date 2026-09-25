import json
import urllib.parse
import requests
import boto3
import os
import re
import time
from datetime import datetime, timezone
from common.config import get_config
from common.utils import invoke_bedrock_nova, cors_headers, cors_response
from slack_sdk import WebClient
from llm_progress import REQUEST_ID, ProgressReporter, read_progress

# Lambda 환경에서 효율적인 재사용을 위한 클라이언트 캐싱
client = None

# 클라이언트 캐시 저장을 위한 전역 변수
client_cache = {}

# DynamoDB 설정 (안전하게 초기화)
try:
    CONFIG = get_config()
    CHAT_HISTORY_TABLE = CONFIG.get('db', {}).get('chat_history_table')

    if CHAT_HISTORY_TABLE:
        dynamodb = boto3.resource('dynamodb')
        chat_table = dynamodb.Table(CHAT_HISTORY_TABLE)
        print(f"DynamoDB 테이블 연결 성공: {CHAT_HISTORY_TABLE}")
    else:
        chat_table = None
        print("DynamoDB 테이블 설정이 없습니다. 캐싱 기능을 비활성화합니다.")
except Exception as e:
    print(f"DynamoDB 초기화 오류: {str(e)}")
    chat_table = None

# 답변을 만드는 동안의 진행 상황 (llm_progress.py). 테이블이 없으면 진행 상황 없이 답변만 만든다
LLM_PROGRESS_TABLE = os.environ.get("LLM_PROGRESS_TABLE")
progress_table = boto3.resource("dynamodb").Table(LLM_PROGRESS_TABLE) if LLM_PROGRESS_TABLE else None


# ---------------------------------------------------------------- 모델 선택
# 기본 모델은 코드에 모델 ID를 적지 않고, Anthropic이 지금 제공하는 모델 목록에서 고른다.
# 모델 ID를 고정해 두면 그 모델이 퇴역(retire)하는 날부터 모든 요청이 실패한다
# (예전 기본값 claude-3-5-sonnet-20241022는 2025-10-28, claude-3-7-sonnet-20250219는 2026-02-19에 퇴역).
DEFAULT_MODEL_FAMILY = "sonnet"      # 이 계열 중에서
# 가장 최근에 나온(최신) 모델을 고른다. 새 모델이 나오면 저절로 그 모델로 넘어간다
# (최신 Sonnet이 이전 버전보다 싸다: Sonnet 5 $2/$10, Sonnet 4.x $3/$15 per MTok. 지원 중단 예고와도 거리가 멀다)
MODELS_CACHE_SECONDS = 3600          # 모델 목록은 자주 바뀌지 않는다. Lambda 컨테이너마다 한 시간 재사용
_models_cache = {"at": 0.0, "models": []}


def get_anthropic_models():
    """
    Anthropic Models API(GET /v1/models)에서 지금 사용할 수 있는 모델 목록을 끝까지 조회한다.

    Returns:
        list: [{"id", "display_name", "created_at", "thinking"}] (실패하면 빈 목록)
    """
    try:
        CONFIG = get_config()
        anthropic_api_key = os.environ.get('ANTHROPIC_API_KEY') or CONFIG.get('anthropic', {}).get('api_key')

        if not anthropic_api_key:
            print("Anthropic API 키가 설정되지 않았습니다.")
            return []

        headers = {
            "x-api-key": anthropic_api_key,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json"
        }

        # 목록 순서(최신부터)에 기대지 않도록 마지막 페이지까지 받는다. 모델 선택 화면에도 전체 목록이 필요하다
        model_list = []
        params = {"limit": 1000}
        while True:
            response = requests.get("https://api.anthropic.com/v1/models", headers=headers, params=params,
                                    timeout=10)
            if response.status_code != 200:
                print(f"Anthropic Models API 오류: {response.status_code} - {response.text}")
                return []
            page = response.json()
            for model in page.get('data', []):
                model_list.append({
                    "id": model.get("id", ""),
                    "display_name": model.get("display_name", model.get("id", "")),
                    "created_at": model.get("created_at", ""),   # 출시일 (RFC 3339). 기본 모델 선택에 쓴다
                    "thinking": thinking_mode(model),             # 지원하는 사고 방식 (thinking_config에 쓴다)
                })
            if not page.get('has_more') or not page.get('last_id'):
                break
            params = {"limit": 1000, "after_id": page['last_id']}

        print(f"Anthropic 모델 {len(model_list)}개 조회 완료")
        return model_list

    except Exception as e:
        print(f"Anthropic 모델 조회 중 오류: {str(e)}")
        return []


def thinking_mode(model):
    """
    Models API가 알려 주는 모델의 사고(extended thinking) 지원 방식: "adaptive" | "enabled" | None.

    모델마다 받는 설정이 다르다. 최신 모델(Sonnet 5, Opus 4.6 이후 등)은 adaptive만 받고 budget_tokens를
    보내면 400이다. 예전 모델(Haiku 4.5 등)은 enabled + budget_tokens만 받는다. 모델 ID로 나누면 새 모델이
    나올 때마다 고쳐야 하므로, Models API의 capabilities를 그대로 따른다.
    """
    types = (((model.get("capabilities") or {}).get("thinking") or {}).get("types")) or {}
    if (types.get("adaptive") or {}).get("supported"):
        return "adaptive"
    if (types.get("enabled") or {}).get("supported"):
        return "enabled"
    return None


THINKING_BUDGET_TOKENS = 4000  # enabled 방식(예전 모델)의 사고 예산. MAX_TOKENS(16000)보다 작아야 한다


def thinking_config(model_id):
    """
    요청에 넣을 사고 설정. 화면에 사고 과정을 보여 주려면 사고 요약을 받아야 한다.
    - adaptive: 사고 요약은 요청해야 온다(display: summarized). 없으면 최신 모델은 빈 사고 블록을 준다
    - enabled: 예전 모델은 사고 요약을 기본으로 준다
    - 모델이 사고를 지원하지 않거나 모델 정보를 모르면 넣지 않는다
    """
    model = next((m for m in available_models() if m.get("id") == model_id), None)
    mode = model.get("thinking") if model else None
    if mode == "adaptive":
        return {"type": "adaptive", "display": "summarized"}
    if mode == "enabled":
        return {"type": "enabled", "budget_tokens": THINKING_BUDGET_TOKENS}
    return None


def available_models():
    """모델 목록 (캐시). 새로 받지 못하면 마지막으로 받은 목록을 계속 쓴다 (일시적인 오류로 채팅이 멈추지 않게)."""
    now = time.time()
    if _models_cache["models"] and now - _models_cache["at"] < MODELS_CACHE_SECONDS:
        return _models_cache["models"]
    models = get_anthropic_models()
    if models:
        _models_cache.update(at=now, models=models)
    return _models_cache["models"]


def pick_default_model(models):
    """
    DEFAULT_MODEL_FAMILY(sonnet) 계열 중 가장 최근에 나온 모델을 고른다.

    출시일(created_at)로 비교한다. 모델 ID 형식이 세대마다 달라서(claude-3-5-sonnet-20241022,
    claude-sonnet-4-5-20250929, claude-sonnet-5 …) ID를 잘라 버전을 비교하면 틀리기 쉽다.

    Returns:
        dict | None: {"id", "display_name", "created_at"} (해당 계열이 없으면 None)
    """
    candidates = [m for m in models if DEFAULT_MODEL_FAMILY in m.get("id", "")]
    if not candidates:
        return None
    # 출시일이 없는 항목은 고르지 않도록 가장 이른 값("")으로 둔다. 같은 날이면 ID 순으로 정해 결과가 매번 같게 한다
    return max(candidates, key=lambda m: (m.get("created_at") or "", m["id"]))


def resolve_model_id(requested=None):
    """
    요청한 모델을 실제로 쓸 모델 ID로 바꾼다.

    - 요청이 없으면 기본 모델
    - 요청한 모델이 지금 목록에 없으면(퇴역 등) 기본 모델. 웹 브라우저(localStorage)와 Slack 사용자 설정
      (DynamoDB)에 예전 모델 ID가 남아 있어도 채팅이 실패하지 않는다
    - 목록을 받지 못했으면 요청한 모델을 그대로 쓴다 (판단할 근거가 없다)
    """
    models = available_models()
    ids = {m["id"] for m in models}
    if requested and (not ids or requested in ids):
        return requested

    default = pick_default_model(models)
    if default is None:
        raise RuntimeError("사용할 모델을 정하지 못했습니다: Anthropic 모델 목록을 가져오지 못했거나 "
                           f"'{DEFAULT_MODEL_FAMILY}' 계열 모델이 없습니다")
    if requested:
        print(f"요청한 모델 {requested}은(는) 지금 제공되지 않아 {default['id']}(으)로 바꿉니다")
    return default["id"]


def tool_step(entry):
    """
    디버그 로그 항목 하나를 화면에 보여 줄 도구 호출 한 건으로 바꾼다. 해당하지 않으면 None.

    AnthropicMCPClient는 도구 한 번 호출에 항목을 두 개 남긴다: 호출 직전의 tool_result(output 없음)와
    끝난 뒤의 tool_result(output 있음) 또는 tool_error. 끝난 쪽만 쓰면 호출 한 번이 한 건이 된다
    (예전에는 둘 다 넣어서 같은 도구가 두 번씩 보였다).

    Returns:
        dict | None: {"tool_name", "input", "status": "ok"|"error", "error"?}
    """
    entry_type = entry.get("type")
    if entry_type == "tool_error":
        return {"tool_name": entry.get("tool_name"), "input": entry.get("input"),
                "status": "error", "error": entry.get("error")}
    if entry_type == "tool_result" and "output" in entry:
        output = entry.get("output")
        # MCP 도구는 실패를 예외 대신 결과의 isError로 알리기도 한다
        failed = isinstance(output, dict) and output.get("isError") is True
        return {"tool_name": entry.get("tool_name"), "input": entry.get("input"),
                "status": "error" if failed else "ok"}
    return None


def get_session_messages_as_array(session_id: str, user_id: str) -> list:
    """
    DynamoDB에서 세션의 메시지 히스토리를 messages 배열 형식으로 가져옴

    Args:
        session_id: 채팅 세션 ID
        user_id: 요청자(Cognito sub). 세션 소유자와 다르면 히스토리를 사용하지 않음

    Returns:
        messages 배열 형식의 대화 기록
    """
    try:
        if not chat_table:
            print("DynamoDB 테이블이 초기화되지 않았습니다.")
            return []

        response = chat_table.get_item(
            Key={'sessionId': session_id}
        )

        session = response.get('Item')
        if not session or not user_id or session.get('userId') != user_id:
            print(f"세션을 찾을 수 없거나 요청자 소유가 아닙니다: {session_id}")
            return []

        messages = session.get('messages', [])

        # 메시지를 시간순으로 정렬
        messages.sort(key=lambda x: x.get('timestamp', ''))

        # Claude/Anthropic API 형식으로 변환
        formatted_messages = []
        for msg in messages:
            sender = msg.get('sender', 'user')
            text = msg.get('text', '')

            if sender == 'user':
                formatted_messages.append({
                    "role": "user",
                    "content": text
                })
            elif sender == 'assistant':
                formatted_messages.append({
                    "role": "assistant",
                    "content": text
                })

        print(f"세션 {session_id}에서 {len(formatted_messages)}개 메시지를 배열 형식으로 로드됨")
        return formatted_messages

    except Exception as e:
        print(f"세션 메시지 조회 실패: {str(e)}")
        return []


def get_client(model_id: str = None):
    """
    MCP 클라이언트 인스턴스를 가져오거나 생성
    모델 ID별로 클라이언트를 캐싱
    """
    global client_cache

    # 사용할 클라이언트 유형 결정 (Bedrock 또는 Anthropic)
    use_anthropic = os.environ.get('USE_ANTHROPIC_API', 'true').lower() == 'true'
    if use_anthropic:
        # 요청이 없거나 지금 제공되지 않는 모델이면 기본 모델(최신 Sonnet)로 정한다
        model_id = resolve_model_id(model_id)
    # Bedrock은 모델 ID 형식이 달라(anthropic.claude-…) Anthropic 목록으로 고르지 않는다.
    # 비어 있으면 BedrockMCPClient의 기본값을 쓴다

    # 캐시에 해당 모델 ID의 클라이언트가 없으면 생성
    if model_id not in client_cache:
        # 환경 변수에서 구성 가져오기
        CONFIG = get_config()
        mcp_url = os.environ.get('MCP_URL') or CONFIG.get('mcp', {}).get('function_url')

        if use_anthropic:
            # Anthropic API 설정
            anthropic_api_key = os.environ.get('ANTHROPIC_API_KEY') or CONFIG.get('anthropic', {}).get('api_key')

            # Anthropic 클라이언트 초기화
            from mcp_anthropic_client import AnthropicMCPClient
            client_cache[model_id] = AnthropicMCPClient(
                mcp_url=mcp_url,
                api_key=anthropic_api_key,
                model_id=model_id,
                thinking=thinking_config(model_id),
            )
        else:
            # Bedrock 설정
            mcp_token = os.environ.get('MCP_TOKEN', '')
            region = os.environ.get('AWS_REGION', 'ap-northeast-2')

            # Bedrock 클라이언트 초기화
            from mcp_bedrock_client import BedrockMCPClient
            client_cache[model_id] = BedrockMCPClient(
                mcp_url=mcp_url,
                region=region,
                auth_token=mcp_token,
                model_id=model_id
            )

        # 세션 초기화 및 도구 로드
        client_cache[model_id].initialize()

        print(f"클라이언트 초기화 완료 - 모델 ID: {model_id}")

    return client_cache[model_id]


def handle_llm1_with_mcp(body, origin, caller_id=None):
    """
    MCP 클라이언트를 사용하여 llm1 요청을 처리하고 도구 사용 과정 및 결과 포함
    세션 기반 메시지 캐싱 지원 (개선된 messages 배열 방식)

    Args:
        body: 요청 본문
        origin: CORS origin
        caller_id: Cognito Authorizer가 검증한 요청자 sub (웹 요청), Slack 봇 직접 호출은 None

    Returns:
        응답 객체 (도구 사용 과정 및 결과 포함)
    """
    try:
        # 요청 데이터 추출
        user_input = body.get('question') or body.get('text') or body.get('input', {}).get('text', '')
        session_id = body.get('sessionId')
        is_cached = body.get('isCached', False)
        model_id = body.get('modelId')
        slack_user_id = body.get("user_id")
        slack_previous_questions = body.get("previous_questions")
        # 현재시간(한국)
        now = datetime.now(timezone.utc)
        print(f"=== 요청 분석 ===")
        print(f"user_input: {user_input}")
        print(f"session_id: {session_id}")
        print(f"is_cached: {is_cached}")
        print(f"model_id: {model_id}")
        print(f"slack_user_id: {slack_user_id}")
        print(f"slack 과거 기록: {len(slack_previous_questions) if slack_previous_questions else '없음'}")
        print(f"chat_table 상태: {chat_table is not None}")
        print(f"전체 body: {json.dumps(body, ensure_ascii=False)}")

        if not user_input:
            return cors_response(400, {"error": "사용자 입력이 제공되지 않았습니다."}, origin)


        # 시스템 프롬프트 설정
        system_prompt = f"""You are "AWS Cloud Agent" - an AWS-specialized AI assistant. Always respond in Korean.
        The current time is UTC {now.strftime('%Y-%m-%d %H:%M:%S')}.
        Korean time is UTC+9.
        <Tools>
        1. Log Analysis (AWS official CloudWatch MCP tools):
            Step1: describe_log_groups (find the actual log group name, e.g. prefix "/aws/lambda")
            Step2: execute_log_insights_query (Logs Insights query on that log group; poll get_logs_insight_query_results if it is still running)
            Optional: analyze_log_group (anomalies and common patterns of one log group)
        2. Metrics & Alarms: get_metric_metadata → get_metric_data / analyze_metric, get_active_alarms, get_alarm_history
        3. Dashboards: listCloudwatchDashboards → getDashboardSummary
        4. Documentation Search (AWS official documentation MCP tools): search_documentation → read_documentation (recommend for related pages)
        5. Cost Analysis (AWS official Cost Explorer MCP tool): cost-explorer (operation "getCostAndUsage" etc.)
        6. Visualization: Generate charts/AWS diagrams (only if the user explicitly requests visualization)
        </Tools>

        <Critical Rules - Response Generation Order>
        **Absolutely do not interrupt the response midway. Strictly follow this sequence:**

        1. **Data Collection Phase**: Collect all necessary data using all required tools.
        2. **Visualization Generation Phase**: Generate all necessary charts/graphs **only if visualization is requested by the user.**
        3. **Final Response Phase**: Provide a complete answer in one go after all tool usage is complete.

        **Response Format (Must adhere to):**
        - Never provide a partial answer while using tools.
        - Visualization must only proceed when explicitly requested by the user.
        - When generating visualizations, the final text response should only be written after all visualizations are complete.
        - When generating images, always include them at the top of the final response in the format: ![Title](URL).
        - The final response must include both the analysis results and the image ![Title](URL).

        <Response Rules>
        - For log analysis questions, first use describe_log_groups to confirm the actual log group name.
        - Do not guess log group names like "/aws/cloudtrail"; use the actual log group name.
        - If visualization is needed: First, generate all charts → then, provide the final analysis.
        - Time zone: UTC+9
        </Rules>
        """

        # 진행 상황: 화면이 보낸 requestId로 단계마다 기록한다 (웹 요청만. Slack 봇은 기록할 곳 없이 단계만 모은다)
        request_id = body.get('requestId')
        can_save = bool(progress_table is not None and caller_id and REQUEST_ID.match(request_id or ""))
        progress = ProgressReporter(progress_table if can_save else None, request_id, caller_id)

        # MCP 클라이언트 가져오기
        client = get_client(model_id)
        client.progress = progress

        # 사용자 입력 처리 시작 시간 기록
        question_time = datetime.now(timezone.utc)

        # 세션 기반 처리 (개선된 방식 - messages 배열 사용)
        if slack_user_id and slack_previous_questions:
            print("=== slack 유저 확인 ===")
            response_text = client.process_user_input_with_history(
                user_input,
                system_prompt,
                slack_previous_questions
            )
        elif is_cached and session_id and chat_table:
            try:
                print(f"=== 세션 캐싱 모드 시작 (개선된 방식) ===")
                print(f"세션 ID: {session_id}")

                # 세션 메시지 히스토리를 messages 배열로 로드
                previous_messages = get_session_messages_as_array(session_id, caller_id)

                if previous_messages:
                    print(f"=== 히스토리 발견 ===")
                    print(f"로드된 메시지 수: {len(previous_messages)}")

                    # 메시지 샘플 출력 (디버깅용)
                    for i, msg in enumerate(previous_messages[-3:]):  # 마지막 3개만
                        print(f"최근 메시지 {i + 1}: {msg.get('role')} - {msg.get('content', '')[:50]}...")

                    # 이전 대화 + 새 사용자 입력으로 처리
                    response_text = client.process_user_input_with_history(
                        user_input,
                        system_prompt,
                        previous_messages
                    )
                
                else:
                    print("=== 세션 메시지 없음 ===")
                    print("일반 모드로 처리")
                    response_text = client.process_user_input(user_input, system_prompt)

            except Exception as e:
                print(f"=== 세션 캐싱 오류 ===")
                print(f"오류: {str(e)}")
                print("일반 모드로 폴백")
                response_text = client.process_user_input(user_input, system_prompt)
        else:
            # 일반 처리 (기존 방식)
            print("=== 일반 모드 ===")
            print(f"is_cached: {is_cached}, session_id: {session_id}, chat_table: {chat_table is not None}")
            response_text = client.process_user_input(user_input, system_prompt)

        # 디버그 로그 가져오기 (추가된 get_debug_log 메서드 사용)
        debug_log = client.get_debug_log() if hasattr(client, "get_debug_log") else []

        # 도구 사용 및 사고 과정 정리
        tools_used = []
        reasoning_steps = []
        token_usage = {"input_tokens": 0, "output_tokens": 0, "total_tokens": 0}

        for entry in debug_log:
            entry_type = entry.get("type")

            if entry_type == "model_reasoning":
                reasoning_steps.append({
                    "content": entry.get("content"),
                    "input_tokens": entry.get("input_tokens", 0),
                    "output_tokens": entry.get("output_tokens", 0),
                    "timestamp": entry.get("timestamp")
                })
            elif entry_type in ("tool_result", "tool_error"):
                step = tool_step(entry)
                if step:
                    tools_used.append(step)
            elif entry_type in ["final_response", "final_response_with_history"]:
                # 최종 응답에서 총 토큰 사용량 추출
                token_usage = {
                    "input_tokens": entry.get("input_tokens", 0),
                    "output_tokens": entry.get("output_tokens", 0),
                }
                print(f"최종 토큰 사용량 추출: {token_usage}")

        # 시간 순으로 정렬
        reasoning_steps.sort(key=lambda x: x.get("timestamp", 0))
        tools_used.sort(key=lambda x: x.get("timestamp", 0))

        # 타임스탬프 정보는 제거
        for step in reasoning_steps:
            if "timestamp" in step:
                del step["timestamp"]

        for tool in tools_used:
            if "timestamp" in tool:
                del tool["timestamp"]

        reasoning_content = []
        for step in reasoning_steps:
            reasoning_content.append({
                "content": step.get("content"),
                "input_tokens": step.get("input_tokens", 0),
                "output_tokens": step.get("output_tokens", 0)
            })

        progress.finished(True)
        debug_info = {
            "tools_used": tools_used,
            # 사고 요약과 도구 호출을 일어난 순서대로 (화면이 Claude Code처럼 순서대로 보여 준다)
            "steps": progress.saved_steps(),
            "reasoning": reasoning_content,
            "session_cached": is_cached and session_id is not None and chat_table is not None,
            "session_id": session_id if is_cached else None,
            "token_usage": token_usage
        }

        # 응답 시간 기록 및 경과 시간 계산
        response_time = datetime.now(timezone.utc)
        elapsed = response_time - question_time
        minutes, seconds = divmod(elapsed.total_seconds(), 60)
        elapsed_str = f"{int(minutes)}분 {int(seconds)}초" if minutes else f"{int(seconds)}초"

        # 최종 결과를 Slack으로 전송
        if slack_user_id:
            try:
                send_slack_dm(slack_user_id, response_text)
                # 성공 응답 반환 (도구 사용 과정 및 결과 포함)
                return cors_response(200, {
                    "answer": response_text,
                    "elapsed_time": elapsed_str,
                    "inference": debug_info,  # 디버그 정보 추가
                    "llm_processing_status": "success"
                }, origin)
            except Exception as e:
                print(f"Slack 전송 실패: {str(e)}")
                return cors_response(500, {
                    "error": "Slack 전송 실패",
                    "answer": str(e),
                    "llm_processing_status": "success"
                }, origin)

        # 성공 응답 반환 (도구 사용 과정 및 결과 포함)
        return cors_response(200, {
            "answer": response_text,
            "elapsed_time": elapsed_str,
            "inference": debug_info  # 디버그 정보 추가
        }, origin)

    except Exception as e:
        print(f"MCP 처리 중 오류: {str(e)}")
        if 'progress' in locals():
            progress.finished(False)
        return cors_response(500, {
            "error": "MCP 처리 중 오류 발생",
            "answer": str(e)
        }, origin)


def handle_progress(request_id, caller_id, origin):
    """GET /llm1/progress/{requestId}: 답변을 만드는 동안의 진행 상황 (요청한 사람만 볼 수 있다)."""
    try:
        progress = read_progress(progress_table, request_id, caller_id)
    except Exception as e:
        print(f"진행 상황 조회 오류: {str(e)}")
        progress = None
    if progress is None:
        # 아직 시작 전이거나(첫 기록 전) 남의 것이다. 화면은 404면 조금 뒤 다시 묻는다
        return cors_response(404, {"error": "진행 상황이 없습니다."}, origin)
    return cors_response(200, progress, origin)


def get_table_registry():
    dynamodb = boto3.resource("dynamodb")
    table_name = os.environ.get("ATHENA_TABLE_REGISTRY_TABLE")
    table = dynamodb.Table(table_name)
    response = table.scan()
    return {item["log_type"]: item for item in response.get("Items", [])}


def trans_eng_to_kor(text):
    prompt = f"""
You are a professional translator.
The following text may include a list of citations in dictionary-like format.
Translate only the explanation sentences into Korean.

- Remove any technical field names like 'rank_order', 'context', 'title', 'url'.
- Preserve any URLs and titles.
- Do NOT translate URLs or titles.
- Format the result cleanly so that each citation appears as:

한국어 번역된 설명
원래 제목
원래 URL

Translate the text below accordingly.
Only Generate Translate.

Text to translate:
{text}
"""
    response = invoke_bedrock_nova(prompt)
    trans_response = response["output"]["message"]["content"][0]["text"]
    return trans_response


def build_llm1_prompt(user_input):
    registry = get_table_registry()
    # 레지스트리에 정보가 있는지 확인
    if "cloudtrail" in registry and "guardduty" in registry:
        ct_table = registry["cloudtrail"]["table_name"]
        ct_location = registry["cloudtrail"]["s3_path"]
        gd_table = registry["guardduty"]["table_name"]
        gd_location = registry["guardduty"]["s3_path"]

        # 테이블 정보를 프롬프트에 명시적으로 포함
        tables_info = f"""
Available tables:
1. {ct_table} - CloudTrail logs at {ct_location}
2. {gd_table} - GuardDuty logs at {gd_location}
        """
    else:
        # 테이블 정보가 없는 경우에 대한 기본값
        print("WARNING: Table registry information missing")
        tables_info = """
Available tables:
1. cloudtrail_logs - CloudTrail logs 
2. guardduty_logs - GuardDuty logs
        """

    return f'''
You are a SQL generation expert for AWS Athena (Presto SQL).
Generate ONLY SQL code that is valid in Athena with no explanation.

{tables_info}

Task:
Convert the following natural language question into an SQL query using the available tables.

Model Instructions:
    # Output Requirements:
        - Return only the SQL code, no explanations.
        - If filtering by date, use the `"partition_date"` field only.
        - If counting unique users, use `COUNT(DISTINCT userIdentity.userName)`.
        - If you use a field that is not aggregated (like username), you must include it in the GROUP BY clause.
        - Avoid using non-aggregated expressions in SELECT unless they are grouped.
        - If filtering by user name, exclude records where useridentity.username is null or empty string.
	    - Use IS NOT NULL AND useridentity.username != '' to ensure only valid user names are considered.
	    - If partition_date is a string like yyyy/MM/dd, use date_parse(partition_date, '%Y/%m/%d') to convert it before filtering by date.


User Question:
{user_input}
'''


def build_llm2_prompt(user_input, query_result):
    return f'''
You are an assistant that provides clear and accurate natural language explanations based on database query results.

Task:
Generate a human-readable answer based on the original user question and the SQL query result.

Original User Question:
{user_input}

SQL Query Result (as JSON):
{json.dumps(query_result, indent=2)}

Instructions:
- Be specific using the data.
- Use concise, professional language.
- Answer in Korean
- Do not ask user for clarification.
- If the original query includes grouping or aggregation, make sure to reflect the logic accurately.
- Highlight any anomalies or low counts if the data is sparse.
'''


def parse_body(event):
    content_type = event.get("headers", {}).get("Content-Type", "") or \
                   event.get("headers", {}).get("content-type", "")

    raw_body = event.get("body") or ""

    if "application/json" in content_type:
        try:
            return json.loads(raw_body)
        except json.JSONDecodeError:
            print("❗ 잘못된 JSON body:", raw_body)
            return {}

    elif "application/x-www-form-urlencoded" in content_type:
        return {k: v[0] for k, v in urllib.parse.parse_qs(raw_body).items()}

    return {}


def markdown_to_slack_mrkdwn(text):
    # 헤더를 볼드로 치환 (모든 헤더 레벨)
    text = re.sub(r'^(#{1,6})\s*(.*)', r'*\2*', text, flags=re.MULTILINE)

    # 볼드: **텍스트** → *텍스트*
    text = re.sub(r'\*\*(\S(.*?\S)?)\*\*', r'*\1*', text)

    # 이탤릭: *텍스트* 또는 _텍스트_ → _텍스트_
    text = re.sub(r'\*(\S(.*?\S)?)\*', r'_\1_', text)

    # 취소선: ~~텍스트~~ → ~텍스트~
    text = re.sub(r'~~(.*?)~~', r'~\1~', text)

    # 인라인 코드(`code`) 및 코드블록(``````)은 그대로 유지

    # 링크: [텍스트](URL) → <URL|텍스트>
    text = re.sub(r'\[(.*?)\]\((.*?)\)', r'<\2|\1>', text)

    # 표: Slack mrkdwn에서 지원하지 않으므로 제거
    text = re.sub(r'\|.*\|', '', text)

    # 블록 인용: > 인용문은 그대로 유지

    # 이미지: Slack mrkdwn에서 지원하지 않으므로 제거
    text = re.sub(r'!\[(.*?)\]\((.*?)\)', '', text)

    return text


def send_slack_dm(user_id, response_text):
    CONFIG = get_config()
    client = WebClient(token=CONFIG['slackbot']['token'])  # 여기에 Slack Bot Token
    response_text = markdown_to_slack_mrkdwn(response_text)

    response = client.chat_postMessage(
        channel=user_id,  # 여기서 user_id 그대로 DM 채널로 사용 가능
        blocks=[
            {
                "type": "section",
                "text": {
                    "type": "mrkdwn",
                    "text": (
                        f"🧠 분석 결과:\n{response_text}"
                    )
                }
            }
        ]
    )
    if not response["ok"]:
        print("❌ Slack 메시지 실패 사유:", response["error"])
    return response