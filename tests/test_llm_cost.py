"""LLM 예상 비용 (services/llm/llm_cost.py)

- 단가는 공식 가격표 (USD / 백만 토큰). 모델 ID 뒤의 날짜는 떼고 찾는다
- 토큰 네 종류(입력·출력·캐시 쓰기·캐시 읽기)를 모두 더한다. 비용은 마이크로달러 정수
- 모르는 모델은 비용을 비운다 (0이 아니다)
"""
import pytest

from conftest import load_service_module


@pytest.fixture
def llm_cost():
    load_service_module("services/llm", "llm_service")
    import llm_cost
    return llm_cost


@pytest.mark.parametrize("model_id, expected", [
    ("claude-sonnet-5", "2"),
    ("claude-sonnet-4-5-20250929", "3"),  # 날짜가 붙은 ID
    ("claude-sonnet-4-20250514", "3"),
])
def test_price_of_known_models(llm_cost, model_id, expected):
    assert llm_cost.price_of(model_id)["input"] == expected


@pytest.mark.parametrize("model_id", [None, "", "claude-sonnet-9", "anthropic.claude-3-haiku-20240307-v1:0"])
def test_unknown_models_have_no_price(llm_cost, model_id):
    # 새 모델·Bedrock 모델 ID는 단가표에 없다: 비용을 0으로 적지 않고 비운다
    assert llm_cost.price_of(model_id) is None
    assert llm_cost.cost_micro_usd(model_id, {"input": 1000}) is None


def test_sonnet_4_5_is_not_mistaken_for_sonnet_4(llm_cost):
    llm_cost.PRICES["claude-sonnet-4"] = {**llm_cost.PRICES["claude-sonnet-4"], "input": "99"}
    try:
        assert llm_cost.price_of("claude-sonnet-4-5")["input"] == "3"
    finally:
        llm_cost.PRICES["claude-sonnet-4"] = {**llm_cost.PRICES["claude-sonnet-4"], "input": "3"}


def test_cost_adds_all_four_kinds(llm_cost):
    # Sonnet 5: 입력 $2, 출력 $10, 캐시 쓰기 $2.50, 캐시 읽기 $0.20 (백만 토큰당)
    tokens = {"input": 1000, "output": 500, "cacheWrite": 2000, "cacheRead": 10000}
    # 1000×2 + 500×10 + 2000×2.5 + 10000×0.2 = 14,000 마이크로달러 = $0.014
    assert llm_cost.cost_micro_usd("claude-sonnet-5", tokens) == 14000


def test_cost_rounds_to_the_nearest_micro_dollar(llm_cost):
    assert llm_cost.cost_micro_usd("claude-sonnet-5", {"cacheRead": 3}) == 1  # 0.6 → 1
    assert llm_cost.cost_micro_usd("claude-sonnet-5", {"cacheRead": 2}) == 0  # 0.4 → 0
    assert llm_cost.cost_micro_usd("claude-sonnet-5", {}) == 0
