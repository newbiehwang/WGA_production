"""기본 모델 선택: 모델 ID를 고정하지 않고, 지금 제공되는 최신 Sonnet을 고른다.

모델 목록과 출시일은 테스트용 예시다 (Anthropic Models API 응답과 같은 모양).
"""
import json

import pytest

from conftest import load_service_module

# 목록은 최신 모델부터 온다 (Models API와 같은 순서)
MODELS = [
    {"id": "claude-sonnet-5", "display_name": "Claude Sonnet 5", "created_at": "2026-05-01T00:00:00Z"},
    {"id": "claude-opus-4-8", "display_name": "Claude Opus 4.8", "created_at": "2026-04-01T00:00:00Z"},
    {"id": "claude-sonnet-4-6", "display_name": "Claude Sonnet 4.6", "created_at": "2026-02-01T00:00:00Z"},
    {"id": "claude-haiku-4-5-20251001", "display_name": "Claude Haiku 4.5", "created_at": "2025-10-01T00:00:00Z"},
    {"id": "claude-sonnet-4-5-20250929", "display_name": "Claude Sonnet 4.5", "created_at": "2025-09-29T00:00:00Z"},
    {"id": "claude-opus-4-1-20250805", "display_name": "Claude Opus 4.1", "created_at": "2025-08-05T00:00:00Z"},
]
NEWEST_SONNET = "claude-sonnet-5"


class FakeResponse:
    def __init__(self, status, payload):
        self.status_code = status
        self._payload = payload
        self.text = json.dumps(payload)

    def json(self):
        return self._payload


@pytest.fixture
def llm(aws, monkeypatch):
    module = load_service_module("services/llm", "llm_service")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    module._models_cache.update(at=0.0, models=[])
    return module


def serve(module, monkeypatch, pages, status=200):
    """requests.get을 가짜로 바꾼다. pages: 차례로 돌려줄 페이지들"""
    calls = []

    def fake_get(url, headers=None, params=None, timeout=None):
        calls.append(dict(params or {}))
        payload = pages[min(len(calls) - 1, len(pages) - 1)]
        return FakeResponse(status, payload)

    monkeypatch.setattr(module.requests, "get", fake_get)
    return calls


def test_default_is_the_newest_sonnet(llm):
    assert llm.pick_default_model(MODELS)["id"] == NEWEST_SONNET


def test_default_ignores_other_families_and_id_formats(llm):
    # ID 형식이 세대마다 달라(날짜가 붙거나 안 붙음, 계열 이름의 위치) ID가 아니라 출시일로 비교한다.
    # 다른 계열(Haiku·Opus)이 더 최근이어도 고르지 않는다
    models = [{"id": "claude-sonnet-4-5-20250929", "created_at": "2025-09-29T00:00:00Z"},
              {"id": "claude-haiku-4-5-20251001", "created_at": "2025-10-01T00:00:00Z"},
              {"id": "claude-sonnet-4-6", "created_at": "2026-02-01T00:00:00Z"},
              {"id": "claude-opus-4-8", "created_at": "2026-04-01T00:00:00Z"}]
    assert llm.pick_default_model(models)["id"] == "claude-sonnet-4-6"


def test_model_without_release_date_is_not_picked(llm):
    models = [{"id": "claude-sonnet-4-6", "created_at": "2026-02-01T00:00:00Z"},
              {"id": "claude-sonnet-unknown", "created_at": ""}]
    assert llm.pick_default_model(models)["id"] == "claude-sonnet-4-6"


def test_no_sonnet_means_no_default(llm):
    assert llm.pick_default_model([m for m in MODELS if "sonnet" not in m["id"]]) is None
    assert llm.pick_default_model([]) is None


def test_models_are_listed_across_all_pages(llm, monkeypatch):
    # 목록 순서에 기대지 않도록 마지막 페이지까지 받는다
    calls = serve(llm, monkeypatch, [
        {"data": MODELS[:3], "has_more": True, "last_id": MODELS[2]["id"]},
        {"data": MODELS[3:], "has_more": False, "last_id": MODELS[-1]["id"]},
    ])
    models = llm.get_anthropic_models()
    assert [m["id"] for m in models] == [m["id"] for m in MODELS]
    assert calls == [{"limit": 1000}, {"limit": 1000, "after_id": "claude-sonnet-4-6"}]
    assert models[0]["created_at"] == "2026-05-01T00:00:00Z"


def test_models_api_error_gives_empty_list(llm, monkeypatch):
    serve(llm, monkeypatch, [{"error": {"type": "authentication_error"}}], status=401)
    assert llm.get_anthropic_models() == []


@pytest.mark.parametrize("requested, expected", [
    (None, NEWEST_SONNET),                          # 요청이 없으면 기본 모델
    ("", NEWEST_SONNET),                            # 웹에서 목록을 받기 전 (빈 ID)
    ("claude-sonnet-4-6", "claude-sonnet-4-6"),     # 지금 제공되는 모델은 사용자가 고른 그대로
    ("claude-3-5-sonnet-20241022", NEWEST_SONNET),  # 퇴역한 모델 (예전 기본값이 저장돼 있던 경우)
])
def test_resolve_model_id(llm, monkeypatch, requested, expected):
    serve(llm, monkeypatch, [{"data": MODELS, "has_more": False}])
    assert llm.resolve_model_id(requested) == expected


def test_resolve_keeps_request_when_list_is_unavailable(llm, monkeypatch):
    # 목록을 받지 못하면 판단할 근거가 없으므로 요청한 모델을 그대로 쓴다
    serve(llm, monkeypatch, [{}], status=500)
    assert llm.resolve_model_id("claude-sonnet-5") == "claude-sonnet-5"
    with pytest.raises(RuntimeError, match="사용할 모델을 정하지 못했습니다"):
        llm.resolve_model_id(None)


def test_model_list_is_cached_and_survives_errors(llm, monkeypatch):
    calls = serve(llm, monkeypatch, [{"data": MODELS, "has_more": False}])
    llm.available_models()
    llm.available_models()
    assert len(calls) == 1   # 한 시간 안에는 다시 조회하지 않는다

    # 캐시가 오래됐는데 새로 받지 못하면, 마지막으로 받은 목록을 계속 쓴다
    llm._models_cache["at"] = 0.0
    serve(llm, monkeypatch, [{}], status=503)
    assert llm.resolve_model_id(None) == NEWEST_SONNET


def test_health_reports_the_default_model(aws, monkeypatch):
    module = load_service_module("services/llm", "lambda_function")
    import llm_service
    monkeypatch.setattr(llm_service, "available_models", lambda: MODELS)
    monkeypatch.setattr(module, "available_models", lambda: MODELS)
    response = module.lambda_handler({"path": "/health", "httpMethod": "GET", "headers": {}}, None)
    body = json.loads(response["body"])
    assert body["models"] == MODELS
    assert body["default_model"]["id"] == NEWEST_SONNET


def test_anthropic_client_requires_a_model(aws):
    load_service_module("services/llm", "llm_service")
    from mcp_anthropic_client import AnthropicMCPClient
    with pytest.raises(ValueError, match="model_id"):
        AnthropicMCPClient(mcp_url="https://example.invalid", api_key="k")
