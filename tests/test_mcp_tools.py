"""MCP 서버 도구와 세션 저장소 (moto CloudWatch Logs, CloudWatch, DynamoDB)"""
import json
import time

import boto3
import pytest

from conftest import load_service_module

SESSION_TABLE = "wga-mcp-sessions-test"


@pytest.fixture
def app(aws, monkeypatch):
    monkeypatch.setenv("MCP_SESSION_TABLE", SESSION_TABLE)
    boto3.client("dynamodb").create_table(
        TableName=SESSION_TABLE,
        AttributeDefinitions=[{"AttributeName": "session_id", "AttributeType": "S"}],
        KeySchema=[{"AttributeName": "session_id", "KeyType": "HASH"}],
        BillingMode="PAY_PER_REQUEST",
    )
    return load_service_module("mcp", "app")


def put_logs(group, stream, messages):
    logs = boto3.client("logs")
    logs.create_log_group(logGroupName=group)
    logs.create_log_stream(logGroupName=group, logStreamName=stream)
    now = int(time.time() * 1000)
    logs.put_log_events(logGroupName=group, logStreamName=stream,
                        logEvents=[{"timestamp": now + i, "message": m} for i, m in enumerate(messages)])


@pytest.fixture
def kst(monkeypatch):
    """로컬 시간대를 KST로 바꿔 시간대 의존 결함을 재현한다 (Lambda는 UTC라 드러나지 않음)"""
    monkeypatch.setenv("TZ", "Asia/Seoul")
    time.tzset()
    yield
    monkeypatch.delenv("TZ")
    time.tzset()


def test_fetch_logs_for_service_only_reads_matching_groups(app):
    put_logs("/aws/lambda/wga-llm-test", "2026/09/21/[$LATEST]a", ["START", "ERROR boom", "END"])
    put_logs("/aws/rds/instance/db-1/error", "s", ["rds log"])

    result = app.fetch_cloudwatch_logs_for_service("lambda", days=1)

    assert result["log_groups_count"] == 1
    group = result["log_groups"]["/aws/lambda/wga-llm-test"]
    assert group["status"] == "success" and group["events_count"] == 3
    # 최신 이벤트가 먼저 온다
    assert group["events"][0]["message"] == "END"


def test_fetch_logs_with_filter_pattern(app):
    put_logs("/aws/lambda/wga-llm-test", "s", ["INFO ok", "ERROR boom"])
    result = app.fetch_cloudwatch_logs_for_service("lambda", days=1, filter_pattern="ERROR")
    events = result["log_groups"]["/aws/lambda/wga-llm-test"]["events"]
    assert [e["message"] for e in events] == ["ERROR boom"]


def test_fetch_logs_time_range_does_not_depend_on_local_timezone(app, kst):
    # naive datetime.utcnow().timestamp()는 로컬 시간으로 해석되어 KST에서 조회 범위가 9시간 어긋났다
    put_logs("/aws/lambda/wga-llm-test", "s", ["recent event"])
    result = app.fetch_cloudwatch_logs_for_service("lambda", days=1)
    assert result["log_groups"]["/aws/lambda/wga-llm-test"]["events_count"] == 1


def test_fetch_logs_unknown_service_without_groups_warns(app):
    assert app.fetch_cloudwatch_logs_for_service("eks")["status"] == "warning"


def test_dashboards_list_and_summary(app):
    body = {"widgets": [{"type": "metric", "x": 0, "y": 0, "width": 12, "height": 6,
                         "properties": {"title": "Lambda Errors", "region": "us-east-1",
                                        "metrics": [["AWS/Lambda", "Errors"]]}}]}
    boto3.client("cloudwatch").put_dashboard(DashboardName="wga-test-service", DashboardBody=json.dumps(body))

    listed = app.list_cloudwatch_dashboards()
    assert listed["status"] == "success"
    assert [d["DashboardName"] for d in listed["dashboards"]] == ["wga-test-service"]

    summary = app.get_dashboard_summary("wga-test-service")
    assert summary["widgets_count"] == 1
    assert summary["widgets_summary"][0]["properties"]["title"] == "Lambda Errors"


def test_tools_are_registered_with_schemas(app):
    # 도구 이름은 함수 이름을 camelCase로 바꿔 등록된다 (lambda_mcp.LambdaMCPServer.tool)
    tools = app.mcp_server.tools
    for name in ["fetchCloudwatchLogsForService", "listCloudwatchDashboards", "getDashboardSummary"]:
        assert name in tools
    assert tools["getDashboardSummary"]["inputSchema"]["required"] == ["dashboard_name"]


def test_session_lifecycle(app):
    from lambda_mcp.session import SessionManager
    sessions = SessionManager(table_name=SESSION_TABLE)

    sid = sessions.create_session({"client": "llm"})
    assert sessions.get_session(sid)["client"] == "llm"
    assert sessions.update_session(sid, {"client": "slack"})
    assert sessions.get_session(sid)["client"] == "slack"
    assert sessions.delete_session(sid)
    assert sessions.get_session(sid) is None
