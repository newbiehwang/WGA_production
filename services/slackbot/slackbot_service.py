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
        
        # 기존 설정이 있는지 확인
        response = user_settings_table.get_item(Key={'user_id': user_id})
        existing_item = response.get('Item', {})
        
        # 기존 설정 유지하면서 processing 상태만 업데이트
        item = {
            'user_id': user_id,
            'processing_status': status,
            'processing_timestamp': current_time if status == 'processing' else 0,
            'updated_at': current_time
        }
        # 사용자가 고른 모델만 유지한다. 고른 적이 없으면 비워 두고 LLM 서비스의 기본 모델을 쓴다
        if existing_item.get('selected_model'):
            item['selected_model'] = existing_item['selected_model']
        
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
        # 기존 설정 유지하면서 processing 상태만 클리어
        response = user_settings_table.get_item(Key={'user_id': user_id})
        existing_item = response.get('Item', {})
        
        if existing_item:
            item = {
                'user_id': user_id,
                'processing_status': 'idle',
                'processing_timestamp': 0,
                'updated_at': int(time.time())
            }
            if existing_item.get('selected_model'):
                item['selected_model'] = existing_item['selected_model']
            
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

def get_models_from_api():
    """
    API에서 모델 목록을 가져오는 함수
    """
    try:
        res = requests.get(
            f"{CONFIG['api']['endpoint']}/health",
            headers={"Content-Type": "application/x-www-form-urlencoded"}
        )
        print(f"res: {res}\n")
        
        if res.status_code == 200:
            data = res.json()
            if data.get("status") == "ok" and "models" in data:
                return data["models"]

        return []

    except Exception as e:
        print(f"Error fetching models from API: {e}")
        return []


def get_default_model_from_api():
    """
    LLM 서비스가 정한 기본 모델 (지금 제공되는 Sonnet 중 가장 낮은 버전). 모델 ID를 여기 고정하지 않는다:
    고정한 모델이 퇴역하면 /req가 모두 실패한다. 받지 못하면 None (LLM 서비스가 다시 정한다)
    """
    try:
        res = requests.get(
            f"{CONFIG['api']['endpoint']}/health",
            headers={"Content-Type": "application/x-www-form-urlencoded"},
            timeout=10,
        )
        if res.status_code == 200:
            return res.json().get("default_model")
    except Exception as e:
        print(f"Error fetching default model from API: {e}")
    return None

def convert_to_slack_options(models):
    """
    API 응답을 Slack Block Kit 옵션 형태로 변환
    """
    options = []
    for model in models:
        options.append({
            "text": {
                "type": "plain_text",
                "text": model["display_name"]
            },
            "value": model["id"]
        })
    print(f"options: {options}\n")
    return options

def handle_models_command(slack_user_id):
    """
    /models 명령어 처리 - 모델 선택 드롭다운과 적용 버튼 제공
    """
    print("get_models_from_api 함수 실행\n")
    models = get_models_from_api()
    print(f"models: {models}\n")
    if not models:
        # Slack의 선택 목록은 항목이 하나도 없으면 보낼 수 없다
        clear_user_processing_status(slack_user_id)
        return {
            "statusCode": 200,
            "body": json.dumps({
                "text": "❌ 모델 목록을 가져오지 못했습니다. 잠시 뒤 다시 시도해 주세요.",
                "response_type": "ephemeral"
            })
        }
    print("convert_to_slack_options 함수 실행\n")
    available_models = convert_to_slack_options(models)
    print(f"available_models: {available_models}\n")

    blocks = [
        {
            "type": "section",
            "text": {
                "type": "mrkdwn",
                "text": "🤖 *AI 모델을 선택하세요*\n선택한 모델은 `/req` 명령어에서 사용됩니다."
            }
        },
        {
            "type": "section",
            "block_id": "model_selection_block",  # block_id는 여기에만
            "text": {
                "type": "mrkdwn",
                "text": "사용할 모델:"
            },
            "accessory": {
                "type": "static_select",
                "action_id": "model_select",
                # block_id 제거 - accessory 내부에서는 사용 불가
                "placeholder": {
                    "type": "plain_text",
                    "text": "모델을 선택하세요"
                },
                "options": available_models
            }
        },
        {
            "type": "actions",
            "block_id": "model_actions",
            "elements": [
                {
                    "type": "button",
                    "text": {
                        "type": "plain_text",
                        "text": "✅ 적용"
                    },
                    "style": "primary",
                    "action_id": "apply_model_btn",
                    "value": "apply_model"
                },
                {
                    "type": "button",
                    "text": {
                        "type": "plain_text",
                        "text": "❌ 취소"
                    },
                    "action_id": "cancel_model_btn",
                    "value": "cancel_model"
                }
            ]
        }
    ]

    print(f"Slack에 메세지 전송\n")
    client.chat_postMessage(
        channel=slack_user_id,
        blocks=blocks
    )
    clear_user_processing_status(slack_user_id)
    
    return {
        "statusCode": 200,
        "body": json.dumps({
            "blocks": blocks,
            "text": "AI 모델을 선택하세요",  # text 필드 추가 (경고 해결)
            "response_type": "ephemeral"
        })
    }


def get_selected_model_from_state(payload):
    """
    인터랙션 상태에서 선택된 모델 추출
    """
    try:
        print("get_selected_model_from_state 함수 진입")
        # state.values에서 선택된 값 찾기
        state_values = payload.get('state', {}).get('values', {})
        model_block = state_values.get('model_selection_block', {})
        model_select = model_block.get('model_select', {})
        
        if 'selected_option' in model_select:
            return model_select['selected_option']['value']
            
        # 현재 액션에서도 확인
        for action in payload.get('actions', []):
            if action.get('action_id') == 'model_select':
                return action.get('selected_option', {}).get('value')
                
    except Exception as e:
        print(f"Error extracting selected model: {e}")
    
    return None

def handle_interaction(payload):
    """
    Slack 인터랙션 처리 (드롭다운 선택, 버튼 클릭)
    """
    action_id = payload['actions'][0]['action_id']
    user_id = payload['user']['id']
    print(f"action_id: {action_id}\n")
    print(f"user_id: {user_id}\n")
    
    if action_id == "apply_model_btn":
        selected_model = get_selected_model_from_state(payload)
        print(f"selected_model: {selected_model}\n")
        if selected_model:
            save_user_model_setting(user_id, selected_model)
            model_name = get_model_display_name(selected_model)
            
            print(f"model_name: {model_name}\n")

            print(f"Slack에 메세지 전송\n")
            client.chat_postMessage(
                channel=user_id,
                blocks=[
                    {
                        "type": "section",
                        "text": {
                            "type": "mrkdwn",
                            "text": (
                                f"✅ 모델이 *{model_name}* 로 설정되었습니다!\n"
                                "이제 `/req 질문내용` 으로 사용하세요."
                            )
                        }
                    }
                ]
            )

            return {
                "statusCode": 200,
                "body": json.dumps({
                    "text": f"✅ 모델이 **{model_name}**로 설정되었습니다!\n이제 `/req 질문내용`으로 사용하세요.",
                    "response_type": "ephemeral",
                })
            }
        else:
            print(f"Slack에 메세지 전송\n")
            client.chat_postMessage(
                channel=user_id,
                text="❌ 모델을 먼저 선택해주세요."
            )
            return {
                "statusCode": 200,
                "body": json.dumps({
                    "text": "❌ 모델을 먼저 선택해주세요.",
                    "response_type": "ephemeral"
                })
            }
    
    elif action_id == "cancel_model_btn":
        print(f"Slack에 메세지 전송\n")
        client.chat_postMessage(
            channel=user_id,
            text="모델 선택이 취소되었습니다."
        )
        return {
            "statusCode": 200,
            "body": json.dumps({
                "text": "모델 선택이 취소되었습니다.",
                "response_type": "ephemeral",
                "replace_original": True
            })
        }
    
    elif action_id == "model_select":
        # 드롭다운 선택 시 상태만 업데이트
        return {"statusCode": 200}

def save_user_model_setting(user_id, model_id):
    """
    사용자별 모델 설정을 DynamoDB에 저장
    """
    print(f"save_user_model_setting 함수 진입\n")
    try:
        # 기존 processing 상태 확인
        response = user_settings_table.get_item(Key={'user_id': user_id})
        existing_item = response.get('Item', {})
        
        item = {
            'user_id': user_id,
            'selected_model': model_id,
            'processing_status': existing_item.get('processing_status', 'idle'),
            'processing_timestamp': existing_item.get('processing_timestamp', 0),
            'updated_at': int(time.time())
        }
        
        user_settings_table.put_item(Item=item)
    except Exception as e:
        print(f"Error saving user setting: {e}")

def get_user_model_setting(user_id):
    """
    사용자의 모델 설정을 DynamoDB에서 조회
    """
    try:
        response = user_settings_table.get_item(
            Key={'user_id': user_id}
        )
        return response.get('Item', {}).get('selected_model') or None   # 고른 적 없으면 None → 기본 모델
    except Exception as e:
        print(f"Error getting user setting: {e}")
        return None

def get_model_display_name(model_id):
    """
    모델 ID로 display_name 조회
    """
    try:
        print(f"get_model_display_name 함수 진입\n")
        models = get_models_from_api()
        for model in models:
            if model["id"] == model_id:
                return model["display_name"]
    except:
        pass
    return model_id

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

    model_id = get_user_model_setting(user_id)
    question = text.strip()

    # 고른 모델이 없거나 지금 목록에 없으면(퇴역 등) 기본 모델로 안내한다. 실제 모델은 LLM 서비스가 한 번 더 확인한다
    models = get_models_from_api()
    if not model_id or (models and model_id not in {m["id"] for m in models}):
        default = get_default_model_from_api()
        model_id = default["id"] if default else None
        model_name = default["display_name"] if default else "기본 모델"
    else:
        model_name = next((m["display_name"] for m in models if m["id"] == model_id), model_id)

    print(f"User: {user_id}, Model: {model_id}, Question: {question}")
    print(f"model_name: {model_name}\n")

    client.chat_postMessage(
        channel=user_id,
        blocks=[
            {
                "type": "section",
                "text": {
                    "type": "mrkdwn",
                    "text": (
                        f"⏳ {model_name}를 사용하여 답변을 생성중입니다.....\n 답변이 올때까지 다른 요청을 보내지마세요‼"
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
            "modelId": model_id,
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
