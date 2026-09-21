"""LLM 서비스: 웹 요청의 Slack 전용 필드 제거, 세션 히스토리 소유자 확인, CORS 허용 목록"""
import json

import boto3
import pytest

from conftest import load_service_module


@pytest.fixture
def llm_lambda(monkeypatch):
    module = load_service_module("services/llm", "lambda_function")
    calls = []
    monkeypatch.setattr(module, "handle_llm1_with_mcp",
                        lambda body, origin, caller_id=None: calls.append((body, caller_id)) or {"statusCode": 200})
    module.calls = calls
    return module


def llm1_event(sub=None):
    ev = {"path": "/llm1", "httpMethod": "POST", "headers": {"content-type": "application/json"},
          "body": json.dumps({"question": "q", "user_id": "U_VICTIM", "previous_questions": ["x"]})}
    if sub:
        ev["requestContext"] = {"authorizer": {"claims": {"sub": sub}}}
    return ev


def test_web_request_cannot_use_slack_fields(llm_lambda):
    llm_lambda.lambda_handler(llm1_event(sub="alice"), None)
    body, caller = llm_lambda.calls[-1]
    assert caller == "alice"
    assert "user_id" not in body and "previous_questions" not in body


def test_direct_invoke_from_slackbot_keeps_slack_fields(llm_lambda):
    llm_lambda.lambda_handler(llm1_event(), None)
    body, caller = llm_lambda.calls[-1]
    assert caller is None and body["user_id"] == "U_VICTIM"


@pytest.fixture
def llm_service(aws):
    boto3.client("dynamodb").create_table(
        TableName="wga-chat-history-test",
        AttributeDefinitions=[{"AttributeName": "sessionId", "AttributeType": "S"}],
        KeySchema=[{"AttributeName": "sessionId", "KeyType": "HASH"}],
        BillingMode="PAY_PER_REQUEST",
    )
    boto3.resource("dynamodb").Table("wga-chat-history-test").put_item(Item={
        "sessionId": "s1", "userId": "alice",
        "messages": [{"sender": "user", "text": "비밀 질문", "timestamp": "1"},
                     {"sender": "assistant", "text": "비밀 답변", "timestamp": "2"}],
    })
    return load_service_module("services/llm", "llm_service")


def test_session_history_loaded_for_owner(llm_service):
    messages = llm_service.get_session_messages_as_array("s1", "alice")
    assert [m["content"] for m in messages] == ["비밀 질문", "비밀 답변"]


@pytest.mark.parametrize("caller", ["mallory", None])
def test_session_history_hidden_from_others(llm_service, caller):
    assert llm_service.get_session_messages_as_array("s1", caller) == []


@pytest.mark.parametrize("origin,expected", [
    ("https://test.abc.amplifyapp.com", "https://test.abc.amplifyapp.com"),
    ("https://evil.example.com", "https://test.abc.amplifyapp.com"),
    ("http://localhost:5173", "https://test.abc.amplifyapp.com"),  # dev 환경에서만 허용
])
def test_cors_reflects_only_allowed_origins(origin, expected):
    from common.utils import cors_headers
    assert cors_headers(origin)["Access-Control-Allow-Origin"] == expected


def test_cors_allows_localhost_in_dev(test_config, monkeypatch):
    from common.utils import cors_headers
    monkeypatch.setitem(test_config, "env", "dev")
    assert cors_headers("http://localhost:5173")["Access-Control-Allow-Origin"] == "http://localhost:5173"
