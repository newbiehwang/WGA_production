"""모델 고정: 모든 요청(웹·Slack)이 최신 Sonnet 하나를 쓰고, 사용자가 모델을 고르는 기능은 없다.

- 요청에 modelId가 있어도(예전 화면·Slack 설정) 무시하고 고정한 모델을 쓴다
- 모델 목록을 조회하지 않는다 (Anthropic Models API를 부르지 않는다)
- /health는 쓰는 모델 하나만 알려 준다
- Slack 봇에는 /models 명령이 없다
"""
import json

import pytest

from conftest import ROOT, load_service_module


@pytest.fixture
def llm(aws):
    return load_service_module("services/llm", "llm_service")


def test_model_is_the_latest_sonnet_with_adaptive_thinking(llm):
    assert llm.MODEL_ID == "claude-sonnet-5" and llm.MODEL_NAME == "Claude Sonnet 5"
    # Sonnet 5는 adaptive만 받는다 (budget_tokens를 보내면 400). 사고 요약은 요청해야 온다
    assert llm.THINKING == {"type": "adaptive", "display": "summarized"}
    # 모델 목록·선택 코드가 남아 있지 않다
    for name in ("available_models", "pick_default_model", "resolve_model_id", "get_anthropic_models"):
        assert not hasattr(llm, name), name


def test_requested_model_is_ignored(llm, monkeypatch):
    asked = []

    def get_client(model_id=llm.MODEL_ID):
        asked.append(model_id)
        raise RuntimeError("모델만 확인하고 멈춘다")

    monkeypatch.setattr(llm, "get_client", get_client)
    llm.handle_llm1_with_mcp({"text": "안녕", "modelId": "claude-haiku-4-5"}, "https://x", caller_id="alice")
    assert asked == [llm.MODEL_ID]  # 요청한 모델이 아니라 고정한 모델


def test_client_uses_the_fixed_model_and_thinking(llm, monkeypatch):
    made = []

    class FakeClient:
        def __init__(self, **kwargs):
            made.append(kwargs)

        def initialize(self):
            pass

    import mcp_anthropic_client
    monkeypatch.setattr(mcp_anthropic_client, "AnthropicMCPClient", FakeClient)
    monkeypatch.setattr(llm, "client_cache", {})
    llm.get_client()
    assert made[0]["model_id"] == llm.MODEL_ID and made[0]["thinking"] == llm.THINKING


def test_health_reports_the_fixed_model(aws, monkeypatch):
    module = load_service_module("services/llm", "lambda_function")
    import requests
    monkeypatch.setattr(requests, "get", lambda *a, **k: pytest.fail("모델 목록을 조회하지 않는다"))
    response = module.lambda_handler({"path": "/health", "httpMethod": "GET", "headers": {}}, None)
    body = json.loads(response["body"])
    assert body == {"status": "ok", "model": {"id": "claude-sonnet-5", "display_name": "Claude Sonnet 5"}}


def test_anthropic_client_requires_a_model(aws):
    load_service_module("services/llm", "llm_service")
    from mcp_anthropic_client import AnthropicMCPClient
    with pytest.raises(ValueError, match="model_id"):
        AnthropicMCPClient(mcp_url="https://example.invalid", api_key="k")


def test_no_model_selection_anywhere():
    # Slack: /models 명령·경로·모델 선택 저장이 없다
    slack = (ROOT / "services" / "slackbot" / "slackbot_service.py").read_text(encoding="utf-8")
    routes = (ROOT / "services" / "slackbot" / "lambda_function.py").read_text(encoding="utf-8")
    template = (ROOT / "cloudformation" / "slackbot.yaml").read_text(encoding="utf-8")
    assert "selected_model" not in slack and "modelId" not in slack and "handle_models_command" not in slack
    assert '"/models"' not in routes and "PathPart: \"models\"" not in template
    # 화면: 모델 목록 저장소와 고르는 칸이 없고, 요청에 modelId를 보내지 않는다
    frontend = ROOT / "frontend" / "src"
    assert not (frontend / "stores" / "modelsStore.ts").exists()
    for path in (frontend / "features" / "chat" / "Composer.tsx", frontend / "stores" / "chatStore.ts"):
        text = path.read_text(encoding="utf-8")
        assert "modelId" not in text and "useModelsStore" not in text, path
