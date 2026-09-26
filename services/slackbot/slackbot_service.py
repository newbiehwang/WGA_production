from common.slackbot_session import get_session
from slack_sdk import WebClient
from common.config import get_config
import requests
import json
import os
import boto3
import time
from botocore.config import Config

print("==== Lambda 호출됨 ====")

CONFIG = get_config()
client = WebClient(token=CONFIG["slackbot"]["token"])
dynamodb = boto3.resource('dynamodb')
user_settings_table = dynamodb.Table('slack_user_settings')
# LLM 호출이 오래 걸리므로 재시도(중복 실행)를 막고 읽기 타임아웃을 LLM Lambda 제한(180초)에 맞춘다
lambda_client = boto3.client('lambda', config=Config(read_timeout=180, retries={'total_max_attempts': 1}))


def invoke_llm(payload):
    """LLM Lambda를 API Gateway 프록시 이벤트 형식으로 직접 호출하고 (statusCode, body)를 반환"""
    event = {
        "path": "/llm1",
        "httpMethod": "POST",
        "headers": {"content-type": "application/json"},
        "body": json.dumps(payload),
    }
    response = lambda_client.invoke(
        FunctionName=os.environ["LLM_FUNCTION_NAME"],
        InvocationType="RequestResponse",
        Payload=json.dumps(event).encode(),
    )
    result = json.loads(response["Payload"].read() or b"{}")
    body = result.get("body") or "{}"
    return result.get("statusCode", 500), json.loads(body) if isinstance(body, str) else body

def set_user_processing_status(user_id, status):
    """사용자 처리 상태 설정"""
    try:
        current_time = int(time.time())
        # 사용자 설정 테이블에는 처리 상태만 있다 (모델 선택은 없앴다)
        item = {
            'user_id': user_id,
            'processing_status': status,
            'processing_timestamp': current_time if status == 'processing' else 0,
            'updated_at': current_time
        }
        
        user_settings_table.put_item(Item=item)
        print(f"User {user_id} processing status set to: {status}")
        
    except Exception as e:
        print(f"Error setting user processing status: {e}")

def get_user_processing_status(user_id):
    """사용자 처리 상태 확인"""
    try:
        response = user_settings_table.get_item(Key={'user_id': user_id})
        item = response.get('Item', {})
        
        status = item.get('processing_status', 'idle')
        processing_timestamp = item.get('processing_timestamp', 0)
        current_time = int(time.time())
        
        # 10분 이상 처리 중인 상태면 자동으로 초기화 (안전장치)
        if status == 'processing' and processing_timestamp > 0:
            if current_time - processing_timestamp > 600:  # 10분
                print(f"User {user_id} processing timeout detected, clearing status")
                clear_user_processing_status(user_id)
                return 'idle'
        
        print(f"User {user_id} processing status: {status}")
        return status
        
    except Exception as e:
        print(f"Error getting user processing status: {e}")
        return 'idle'

def clear_user_processing_status(user_id):
    """사용자 처리 상태 초기화"""
    try:
        # 처리 중 기록이 있을 때만 idle로 바꾼다
        response = user_settings_table.get_item(Key={'user_id': user_id})
        existing_item = response.get('Item', {})
        
        if existing_item:
            item = {
                'user_id': user_id,
                'processing_status': 'idle',
                'processing_timestamp': 0,
                'updated_at': int(time.time())
            }
            
            user_settings_table.put_item(Item=item)
            print(f"User {user_id} processing status cleared")
        
    except Exception as e:
        print(f"Error clearing user processing status: {e}")

def send_login_button(slack_user_id):
    login_url = (
        f"{CONFIG['cognito']['domain']}/oauth2/authorize"
        "?response_type=code"
        f"&client_id={CONFIG['cognito']['client_id']}"
        f"&redirect_uri={CONFIG['api']['endpoint']}/callback"
        f"&scope=openid+email+profile&state={slack_user_id}"
    )

    client.chat_postMessage(
        channel=slack_user_id,
        blocks=[
            {
                "type": "section",
                "text": {"type": "mrkdwn", "text": "🔐 AWS 로그인을 위해 아래 버튼을 클릭하세요."}
            },
            {
                "type": "actions",
                "elements": [
                    {
                        "type": "button",
                        "text": {"type": "plain_text", "text": "로그인"},
                        "url": login_url
                    }
                ]
            }
        ]
    )

def handle_interaction(payload):
    """
    Slack 인터랙션 (버튼 클릭 등). 모델 선택 기능을 없애 처리할 동작이 없다.
    로그인 버튼 같은 링크 버튼도 인터랙션을 보내므로, Slack이 경고를 띄우지 않게 200으로 받기만 한다.
    """
    return {"statusCode": 200}


def filter_analysis_results(history):
    """':brain: 분석 결과:'로 시작하는 메시지만 필터링"""
    filtered_messages = []
    
    for message in history['messages']:
        text = message.get('text', '')
        if text.startswith(':hourglass_flowing_sand:') or text.startswith(':robot_face:') or text.startswith(':x:') or text.startswith(':white_check_mark:') or text.startswith(':closed_lock_with_key:'):
            # 해당 메시지는 유저도 분석결과 아님으로 필터링
            continue
        # 메시지의 role은 'user' 또는 'assistant'로 설정
        elif "error" in text:
            continue
        elif text.startswith(':brain: 분석 결과:'):
            role = 'assistant'
            text = text.split(':brain: 분석 결과:')[1].strip()
            filtered_messages.append({'role': role, 'content': text})
        else:
            role = 'user'
            text = text.strip()
            filtered_messages.append({'role': role, 'content': text})

        print(f"filtered_messages: {filtered_messages}\n")

    return filtered_messages

def handle_req_command(payload):
    """
    /req 명령어 처리 - 저장된 모델로 질문 처리
    """
    print("handle_req_command 함수 실행")
    event = payload.get("event", {})
    
    text = event.get("text", "")
    print(f"text: {text}\n")
    user_id = event.get("user", "")
    print(f"user_id: {user_id}\n")
    channel_id = event.get("channel", "")
    print(f"channel_id: {channel_id}\n")

    # 현재 처리 상태 확인
    current_status = get_user_processing_status(user_id)
    if current_status == "processing":
        # 이미 처리 중인 경우 차단
        client.chat_postMessage(
            channel=user_id,
            blocks=[
                {
                    "type": "section",
                    "text": {
                        "type": "mrkdwn",
                        "text": "⚠️ 이미 처리 중인 요청이 있습니다.\n이전 요청이 완료될 때까지 기다려주세요."
                    }
                }
            ]
        )
        return {
            'statusCode': 200,
            'body': json.dumps({
                'text': "이미 처리 중인 요청이 있습니다.",
                'response_type': 'ephemeral'
            })
        }


    if not text or not text.strip():
        return {
            'statusCode': 200,
            'body': json.dumps({
                'text': "❌ 질문을 입력해주세요.\n사용법: `/req 질문내용`\n예시: `/req 안녕하세요?`",
                'response_type': 'ephemeral'
            })
        }
    
    set_user_processing_status(user_id, "processing")

    question = text.strip()
    # 모델은 LLM 서비스가 요청할 때의 최신 Sonnet으로 정한다 (llm_service.current_model). 고르는 기능은 없다
    print(f"User: {user_id}, Question: {question}")

    client.chat_postMessage(
        channel=user_id,
        blocks=[
            {
                "type": "section",
                "text": {
                    "type": "mrkdwn",
                    "text": (
                        "⏳ 답변을 생성중입니다.....\n 답변이 올때까지 다른 요청을 보내지마세요‼"
                    )
                }
            }
        ]
    )

    print("history 불러오기")
    print(f"slack_channel_id: {channel_id}\n")
    history = client.conversations_history(
        channel=channel_id,
        limit=10
    )

    print(f"history: {history}\n")
    analysis_messages = filter_analysis_results(history)
    print(f"analysis_messages: {analysis_messages}\n")
    print(f"분석 결과 메시지 개수: {len(analysis_messages)}")
    try:
        status_code, response_data = invoke_llm({
            "question": question,
            "user_id": user_id,
            "previous_questions": analysis_messages,
        })

        if status_code == 200:
            llm_status = response_data.get("llm_processing_status", "unknown")
            if llm_status == "success":
                # 처리 완료 - 상태 초기화
                clear_user_processing_status(user_id)
                print(f"LLM 처리 완료 - User: {user_id}, Status: {llm_status}")
            else:
                # 처리 실패 시에도 상태 초기화
                clear_user_processing_status(user_id)
                print(f"LLM 처리 실패 - User: {user_id}, Status: {llm_status}")

    except Exception as e:
        print(f"res 처리 오류: {e}")
        clear_user_processing_status(user_id)
        return {
            'statusCode': 200,  # 에러여도 200 반환
            'body': json.dumps({
                'response_type': 'ephemeral',
                'text': 'Error occurred, please try again'
            })
        }

    clear_user_processing_status(user_id)
    print(f"get_user_processing_status(user_id): {get_user_processing_status(user_id)}")
    return {
        'statusCode': 200,
    }

def handle_slack_events(event, context):
    event_body = event.get("body") or ""
    headers = event.get('headers', {})
    retry_num = headers.get('X-Slack-Retry-Num')
    retry_reason = headers.get('X-Slack-Retry-Reason')

    # 재시도 요청인 경우 즉시 200 응답
    if retry_num:
        print(f"재시도 요청 감지: {retry_reason} (retry #{retry_num})")
        return {
            'statusCode': 200,
            'body': json.dumps({
                'response_type': 'ephemeral',
                'text': f'Already processing (retry #{retry_num})'
            })
        }
    
    try:
        quick_response = {
            'statusCode': 200,
            'body': json.dumps({
                'response_type': 'ephemeral', 
                'text': 'Processing your request...'
            })
        }

        payload = json.loads(event_body)
        
        # URL 검증
        if payload.get("type") == "url_verification":
            print("URL 검증 진입")
            return {
                "statusCode": 200,
                "headers": {"Content-Type": "text/plain"},
                "body": payload["challenge"]
            }
        
        # 이벤트 콜백 처리
        if payload.get("type") == "event_callback":
            print("이벤트 콜백 진입")
            event_data = payload.get("event", {})
            print(f"event_data: {event_data}\n")

            # 봇 메시지 필터링 (중요!)
            if event_data.get("bot_id"):
                print(f"봇 메시지 감지: {event_data.get('bot_id')}")
                print("봇 메시지이므로 무시")
                return {"statusCode": 200}
            
            # 사용자 메시지만 처리
            if event_data.get("type") == "message" and "user" in event_data:
                user_id = event_data.get("user", "")
                
                # DynamoDB에서 처리 상태 확인
                clear_user_processing_status(user_id)
                current_status = get_user_processing_status(user_id)
                if current_status == "processing":
                    # 처리 중인 경우 차단 메시지 전송
                    client.chat_postMessage(
                        channel=user_id,
                        blocks=[
                            {
                                "type": "section",
                                "text": {
                                    "type": "mrkdwn",
                                    "text": "⚠️ 현재 이전 요청을 처리 중입니다.\n잠시만 기다려주세요."
                                }
                            }
                        ]
                    )
                    return {"statusCode": 200}
                
                return handle_req_command(payload)
        
        return quick_response
        
    except Exception as e:
        print(f"이벤트 처리 오류: {e}")
        return {
            'statusCode': 200,  # 에러여도 200 반환
            'body': json.dumps({
                'response_type': 'ephemeral',
                'text': 'Error occurred, please try again'
            })
        }
