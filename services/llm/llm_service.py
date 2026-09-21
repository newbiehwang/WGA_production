import json
import urllib.parse
import requests
import boto3
import os
import re
from datetime import datetime, timezone
from common.config import get_config
from common.utils import invoke_bedrock_nova, cors_headers, cors_response
from slack_sdk import WebClient

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


def get_anthropic_models():
    """
    Anthropic API에서 사용 가능한 모델 목록을 조회

    Returns:
        list: 모델 정보 배열 (display_name과 id만 포함)
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

        response = requests.get(
            "https://api.anthropic.com/v1/models",
            headers=headers
        )

        if response.status_code != 200:
            print(f"Anthropic Models API 오류: {response.status_code} - {response.text}")
            return []

        models_data = response.json()
        models = models_data.get('data', [])

        # display_name과 id만 추출하여 배열로 반환
        model_list = []
        for model in models:
            model_info = {
                "id": model.get("id", ""),
                "display_name": model.get("display_name", model.get("id", ""))
            }
            model_list.append(model_info)

        print(f"Anthropic 모델 {len(model_list)}개 조회 완료")
        return model_list

    except Exception as e:
        print(f"Anthropic 모델 조회 중 오류: {str(e)}")
        return []


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

    # 기본 모델 ID 설정
    model_id = model_id or 'claude-3-7-sonnet-20250219'

    # 캐시에 해당 모델 ID의 클라이언트가 없으면 생성
    if model_id not in client_cache:
        # 환경 변수에서 구성 가져오기
        CONFIG = get_config()
        mcp_url = os.environ.get('MCP_URL') or CONFIG.get('mcp', {}).get('function_url')

        # 사용할 클라이언트 유형 결정 (Bedrock 또는 Anthropic)
        use_anthropic = os.environ.get('USE_ANTHROPIC_API', 'true').lower() == 'true'

        if use_anthropic:
            # Anthropic API 설정
            anthropic_api_key = os.environ.get('ANTHROPIC_API_KEY') or CONFIG.get('anthropic', {}).get('api_key')

            # Anthropic 클라이언트 초기화
            from mcp_anthropic_client import AnthropicMCPClient
            client_cache[model_id] = AnthropicMCPClient(
                mcp_url=mcp_url,
                api_key=anthropic_api_key,
                model_id=model_id
            )
        else:
            # Bedrock 설정
            mcp_token = os.environ.get('MCP_TOKEN', '')
            region = os.environ.get('AWS_REGION', 'us-east-1')

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
        1. Log Analysis (2 steps required):
            Step1: fetch_cloudwatch_logs_for_service("cloudtrail"|"guardduty"|"etc") 
            Step2: analyze_log_groups_insights(actual_log_group_name)
        2. Monitoring: list_cloudwatch_dashboards → get_dashboard_summary
        3. Documentation Search: search_documentation → recommend_documentation → read_documentation
        4. Cost Analysis: get_detailed_breakdown_by_day
        5. Visualization: Generate charts/AWS diagrams (only if the user explicitly requests visualization)
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
        - For log analysis questions, first use the 'fetch' tool to confirm the actual log group name.
        - Do not guess log group names like "/aws/cloudtrail"; use the actual log group name.
        - If visualization is needed: First, generate all charts → then, provide the final analysis.
        - Time zone: UTC+9
        </Rules>
        """

        # MCP 클라이언트 가져오기
        client = get_client(model_id)

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
            elif entry_type == "tool_result":
                tools_used.append({
                    "tool_name": entry.get("tool_name"),
                    "input": entry.get("input")
                })
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

        debug_info = {
            "tools_used": tools_used,
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
        return cors_response(500, {
            "error": "MCP 처리 중 오류 발생",
            "answer": str(e)
        }, origin)


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