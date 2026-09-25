"""WGA MCP 서버 (Lambda Function URL, Streamable HTTP)

도구는 두 곳에서 온다.
1. AWS 공식 MCP 서버 (awslabs, lambda_mcp/official.py가 이 서버에 붙인다)
   - CloudWatch: 로그 그룹 조회, Logs Insights 쿼리, 로그 이상 탐지, 메트릭 조회·분석, 알람·알람 기록
   - AWS 문서: 문서 검색·읽기·추천
   - 비용: Cost Explorer (billing-cost-management 서버의 Cost Explorer 부분만)
   - CloudTrail: 최근 90일 관리 이벤트 조회 (누가 언제 어떤 API를 불렀나. 유료인 CloudTrail Lake 도구는 뺐다)
   - Pricing: 공개 가격표 조회 (이 설정이면 월 얼마인지. 로컬 파일을 읽거나 쓰는 도구는 뺐다)
   - IAM: 사용자·역할·그룹·정책 조회와 권한 시뮬레이션 (읽기 전용. 변경 도구는 뺐다)
2. 이 파일에 직접 둔 도구 (공식 서버가 없거나 폐기된 것)
   - CloudWatch 대시보드 목록·요약 (공식 CloudWatch 서버에 대시보드 도구가 없다)
   - 아키텍처 다이어그램 (공식 diagram 서버는 PyPI에서 폐기되었다. 폐기 전 공식 서버를 옮겨 온 코드)
   - 차트 (AntV 차트 서비스, AWS와 무관)
   - 변경 도구 2개: 로그 보존 기간, 알람 알림 켜기·끄기 (이 환경의 WGA 리소스만, 사람이 승인해야 실행된다)

변경 도구의 통제 (lambda_mcp/risk.py, lambda_mcp/approval.py)
- tools/list가 도구마다 위험도를 붙인다. LLM Lambda는 변경 도구를 바로 실행하지 않고 승인 요청을 만든다.
- 사용자가 승인하면 LLM Lambda가 작업 ID를 붙여 부르고, 이 서버가 승인 테이블을 직접 다시 확인한 뒤 한 번만 실행한다.
- 도구 안에서도 이름으로 이 환경의 WGA 리소스인지 확인하고, IAM도 같은 범위(wga-*)로만 허용한다.
"""
import os
import json
import boto3
from typing import Dict, Any
from lambda_mcp.approval import ApprovalGate
from lambda_mcp.lambda_mcp import LambdaMCPServer
from lambda_mcp.official import OfficialTools
from lambda_mcp.diagram_utils import (
    generate_diagram,
    get_diagram_examples,
    list_diagram_icons
)
from lambda_mcp.mcp_types import DiagramType
from lambda_mcp.chart_utils import generate_chart_url, validate_chart_data


# Get session table name from environment variable
session_table = os.environ.get('MCP_SESSION_TABLE', f'wga-mcp-sessions-{os.environ.get("ENV", "dev")}')
aws_region = os.environ.get("AWS_REGION", "ap-northeast-2")

cloudwatch_client = boto3.client('cloudwatch', region_name=aws_region)
logs_client = boto3.client('logs', region_name=aws_region)
environment = os.environ.get("ENV", "dev")

# Initialize the MCP server
mcp_server = LambdaMCPServer(name="cloudguard", version="1.0.0", session_table=session_table)
# 공식 서버는 여기서 불러오지 않고 도구 목록이 처음 필요할 때 불러온다 (콜드 스타트, lambda_mcp/official.py)
mcp_server.attach(OfficialTools.default())
# 변경 도구 실행 직전의 승인 재확인. 테이블 이름이 없으면(로컬 등) 변경 도구는 실행되지 않는다
_pending_table_name = os.environ.get("PENDING_ACTIONS_TABLE")
if _pending_table_name:
    mcp_server.approval_gate = ApprovalGate(boto3.resource("dynamodb", region_name=aws_region).Table(_pending_table_name))


@mcp_server.tool()
def list_cloudwatch_dashboards() -> Dict[str, Any]:
    """
    Lists all CloudWatch dashboards in the AWS account.

    Returns:
        A dictionary containing the list of dashboard names and their ARNs.
    """
    try:
        dashboards = []
        paginator = cloudwatch_client.get_paginator('list_dashboards')
        for page in paginator.paginate():
            for entry in page.get('DashboardEntries', []):
                dashboards.append({
                    'DashboardName': entry.get('DashboardName'),
                    'DashboardArn': entry.get('DashboardArn')
                })

        return {
            'status': 'success',
            'dashboard_count': len(dashboards),
            'dashboards': dashboards
        }

    except Exception as e:
        return {'status': 'error', 'message': str(e)}


@mcp_server.tool()
def get_dashboard_summary(dashboard_name: str) -> Dict[str, Any]:
    """
    Retrieves and summarizes the configuration of a specified CloudWatch dashboard.

    Args:
        dashboard_name: The name of the CloudWatch dashboard.

    Returns:
        A summary of the dashboard's widgets and their configurations.
    """
    try:
        # Fetch the dashboard configuration
        response = cloudwatch_client.get_dashboard(DashboardName=dashboard_name)
        dashboard_body = response.get('DashboardBody', '{}')
        dashboard_config = json.loads(dashboard_body)

        # Summarize the widgets in the dashboard
        widgets_summary = []
        for widget in dashboard_config.get('widgets', []):
            widget_summary = {
                'type': widget.get('type'),
                'x': widget.get('x'),
                'y': widget.get('y'),
                'width': widget.get('width'),
                'height': widget.get('height'),
                'properties': widget.get('properties', {})
            }
            widgets_summary.append(widget_summary)

        return {
            'dashboard_name': dashboard_name,
            'widgets_count': len(widgets_summary),
            'widgets_summary': widgets_summary
        }

    except Exception as e:
        return {'status': 'error', 'message': str(e)}


# ---------------------------------------------------------------- 변경 도구 (승인 필요)
# 범위: 이 환경(ENV)의 WGA 리소스만. 이름 규칙은 CloudFormation과 같다
#   Lambda 로그 그룹 /aws/lambda/wga-<서비스>-<env>, 알람 wga-<env>-<이름>
# 오류는 dict로 돌려주지 않고 예외로 올린다 (서버가 실패로 기록하고 승인 테이블에 failed를 남긴다)

# CloudWatch Logs가 받는 보존 기간(일)
RETENTION_DAYS = [1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096, 1827, 2192, 2557, 2922,
                  3288, 3653]


def _trail(event_source: str, event_name: str, response: Dict[str, Any]) -> Dict[str, Any]:
    """이 변경이 CloudTrail에 남긴 이벤트를 찾을 단서. CloudTrail 이벤트의 requestID가 AWS API 응답의 요청 ID와 같다.
    감사 로그(앱에서 누가 승인했나)와 CloudTrail(AWS에서 무엇이 바뀌었나)을 이 요청 ID로 잇는다."""
    return {"event_source": event_source, "event_name": event_name,
            "request_id": (response or {}).get("ResponseMetadata", {}).get("RequestId")}


def _check_log_group(log_group_name: str) -> None:
    if not (log_group_name.startswith("/aws/lambda/wga-") and log_group_name.endswith(f"-{environment}")):
        raise ValueError(f"이 환경의 WGA Lambda 로그 그룹(/aws/lambda/wga-*-{environment})만 바꿀 수 있습니다: "
                         f"{log_group_name}")


def _current_retention(log_group_name: str):
    for page in logs_client.get_paginator('describe_log_groups').paginate(logGroupNamePrefix=log_group_name):
        for group in page.get('logGroups', []):
            if group.get('logGroupName') == log_group_name:
                return group.get('retentionInDays')  # 없으면 영구 보관
    raise ValueError(f"로그 그룹이 없습니다: {log_group_name}")


def _retention_text(days) -> str:
    return "영구 보관" if days is None else f"{days}일"


@mcp_server.tool()
def set_log_retention(log_group_name: str, retention_days: int) -> Dict[str, Any]:
    """
    Changes the retention period of a WGA Lambda log group in this environment. This modifies AWS resources, so it
    runs only after the user approves it; calling it creates an approval request instead of running immediately.

    Args:
        log_group_name: Log group name, e.g. /aws/lambda/wga-llm-dev (only /aws/lambda/wga-*-<env> is allowed).
        retention_days: New retention in days. One of 1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096, 1827, 2192, 2557, 2922, 3288, 3653.

    Returns:
        The log group with the retention before and after the change.
    """
    preview = preview_log_retention(log_group_name, retention_days)
    response = logs_client.put_retention_policy(logGroupName=log_group_name, retentionInDays=retention_days)
    return {"status": "success", **preview, "cloudtrail": _trail("logs.amazonaws.com", "PutRetentionPolicy", response)}


@mcp_server.preview("setLogRetention")
def preview_log_retention(log_group_name: str, retention_days: int) -> Dict[str, Any]:
    _check_log_group(log_group_name)
    if retention_days not in RETENTION_DAYS:
        raise ValueError(f"보존 기간은 {RETENTION_DAYS} 중 하나여야 합니다: {retention_days}")
    before = _current_retention(log_group_name)
    return {"target": log_group_name, "before": _retention_text(before), "after": _retention_text(retention_days),
            "summary": f"{log_group_name} 로그 보존 기간 {_retention_text(before)} → {_retention_text(retention_days)}"
                       + (" (지난 로그 일부가 지워질 수 있습니다)" if before is None or retention_days < before else "")}


def _check_alarm(alarm_name: str) -> None:
    if not alarm_name.startswith(f"wga-{environment}-"):
        raise ValueError(f"이 환경의 WGA 알람(wga-{environment}-*)만 바꿀 수 있습니다: {alarm_name}")
    # 거버넌스 알람(인젝션 의심 등)은 끌 수 없다: 인젝션으로 속은 요청이 감시 장치부터 끄는 것을 막는다 (IAM도 Deny)
    if alarm_name.startswith(f"wga-{environment}-governance-"):
        raise ValueError(f"거버넌스 알람은 바꿀 수 없습니다: {alarm_name}")


def _alarm_actions_enabled(alarm_name: str) -> bool:
    alarms = cloudwatch_client.describe_alarms(AlarmNames=[alarm_name])
    found = alarms.get('MetricAlarms', []) + alarms.get('CompositeAlarms', [])
    if not found:
        raise ValueError(f"알람이 없습니다: {alarm_name}")
    return bool(found[0].get('ActionsEnabled'))


def _actions_text(enabled: bool) -> str:
    return "알림 켜짐" if enabled else "알림 꺼짐"


@mcp_server.tool()
def set_alarm_actions(alarm_name: str, enabled: bool) -> Dict[str, Any]:
    """
    Turns notifications (alarm actions) of a WGA CloudWatch alarm in this environment on or off, e.g. to silence an
    alarm during maintenance. This modifies AWS resources, so it runs only after the user approves it; calling it
    creates an approval request instead of running immediately.

    Args:
        alarm_name: Alarm name (only wga-<env>-* is allowed).
        enabled: true to turn notifications on, false to turn them off.

    Returns:
        The alarm with the notification state before and after the change.
    """
    preview = preview_alarm_actions(alarm_name, enabled)
    if enabled:
        response = cloudwatch_client.enable_alarm_actions(AlarmNames=[alarm_name])
    else:
        response = cloudwatch_client.disable_alarm_actions(AlarmNames=[alarm_name])
    event_name = "EnableAlarmActions" if enabled else "DisableAlarmActions"
    return {"status": "success", **preview, "cloudtrail": _trail("monitoring.amazonaws.com", event_name, response)}


@mcp_server.preview("setAlarmActions")
def preview_alarm_actions(alarm_name: str, enabled: bool) -> Dict[str, Any]:
    _check_alarm(alarm_name)
    before = _alarm_actions_enabled(alarm_name)
    return {"target": alarm_name, "before": _actions_text(before), "after": _actions_text(enabled),
            "summary": f"{alarm_name} {_actions_text(before)} → {_actions_text(enabled)}"
                       + (" (알람이 울려도 알림이 가지 않습니다)" if not enabled else "")}


@mcp_server.tool()
def generate_architecture_diagram(
        code: str,
        filename: str = None,
        timeout: int = 30
) -> Dict[str, Any]:
    """
    Generate an architecture diagram from Python code using the diagrams package.

    This tool accepts Python code that uses the diagrams package DSL and generates
    a PNG diagram, then uploads it to S3 and returns a presigned URL.

    Args:
        code: Python code string using the diagrams package DSL
        filename: Optional output filename (without extension)
        timeout: Timeout in seconds for diagram generation

    Returns:
        Dictionary with the S3 URL and status information
    """
    try:
        result = generate_diagram(code, filename, timeout)
        # DiagramGenerateResponse 객체를 딕셔너리로 변환
        return {
            'status': result.status,
            'url': result.url,
            's3_key': result.s3_key,
            'message': result.message
        }
    except Exception as e:
        return {
            'status': 'error',
            'message': f'Error generating diagram: {str(e)}'
        }


@mcp_server.tool()
def get_diagram_code_examples(
        diagram_type: str = "all"
) -> Dict[str, Any]:
    """
    Get example code for different types of architecture diagrams.

    This tool provides ready-to-use example code for various diagram types.
    Use these examples to understand the syntax and capabilities of the diagrams package.

    Args:
        diagram_type: Type of diagram example to return (aws, sequence, flow, class, k8s, onprem, custom, all)

    Returns:
        Dictionary with example code for the requested diagram type(s)
    """
    try:
        # Convert string to DiagramType enum
        if diagram_type.lower() == "aws":
            dtype = DiagramType.AWS
        elif diagram_type.lower() == "k8s":
            dtype = DiagramType.K8S
        elif diagram_type.lower() == "flow":
            dtype = DiagramType.FLOW
        elif diagram_type.lower() == "sequence":
            dtype = DiagramType.SEQUENCE
        elif diagram_type.lower() == "class":
            dtype = DiagramType.CLASS
        elif diagram_type.lower() == "onprem":
            dtype = DiagramType.ONPREM
        elif diagram_type.lower() == "custom":
            dtype = DiagramType.CUSTOM
        else:
            dtype = DiagramType.ALL

        result = get_diagram_examples(dtype)
        # DiagramExampleResponse 객체를 딕셔너리로 변환
        return {
            'examples': result.examples
        }
    except Exception as e:
        return {
            'status': 'error',
            'message': f'Error getting examples: {str(e)}'
        }


@mcp_server.tool()
def list_available_diagram_icons(
        provider_filter: str = None,
        service_filter: str = None
) -> Dict[str, Any]:
    """
    List available icons from the diagrams package with optional filtering.

    This tool helps you discover what icons are available for creating diagrams.
    Call without filters to see all providers, or use filters to narrow down results.

    Args:
        provider_filter: Filter icons by provider name (e.g., "aws", "gcp", "k8s")
        service_filter: Filter icons by service name (e.g., "compute", "database", "network")

    Returns:
        Dictionary with available providers, services, and icons
    """
    try:
        result = list_diagram_icons(provider_filter, service_filter)
        # DiagramIconsResponse 객체를 딕셔너리로 변환
        return {
            'providers': result.providers,
            'filtered': result.filtered,
            'filter_info': result.filter_info
        }
    except Exception as e:
        return {
            'status': 'error',
            'message': f'Error listing icons: {str(e)}'
        }


@mcp_server.tool()
def generate_line_chart(
        data: str,
        width: int = 600,
        height: int = 400,
        title: str = "",
        axis_x_title: str = "",
        axis_y_title: str = "",
        stack: bool = False
) -> Dict[str, Any]:
    """
    Generate a line chart to show trends over time.

    Args:
        data: JSON string of data for line chart, such as '[{"time": "2015", "value": 23}]'
        width: Width of the chart (default: 600)
        height: Height of the chart (default: 400)
        title: Title of the chart
        axis_x_title: X-axis title
        axis_y_title: Y-axis title
        stack: Whether stacking is enabled for multi-series data

    Returns:
        Dictionary with chart URL or error message
    """
    try:
        chart_data = json.loads(data)

        if not validate_chart_data(chart_data, ["time", "value"]):
            return {
                "status": "error",
                "message": "Invalid data format. Each item must have 'time' and 'value' fields."
            }

        options = {
            "data": chart_data,
            "width": width,
            "height": height,
            "title": title,
            "axisXTitle": axis_x_title,
            "axisYTitle": axis_y_title,
            "stack": stack
        }

        result = generate_chart_url("line", options)
        return result

    except json.JSONDecodeError:
        return {
            "status": "error",
            "message": "Invalid JSON format for data parameter"
        }
    except Exception as e:
        return {
            "status": "error",
            "message": f"Error generating line chart: {str(e)}"
        }


@mcp_server.tool()
def generate_bar_chart(
        data: str,
        width: int = 600,
        height: int = 400,
        title: str = "",
        axis_x_title: str = "",
        axis_y_title: str = "",
        group: bool = False,
        stack: bool = True
) -> Dict[str, Any]:
    """
    Generate a bar chart for numerical comparisons among different categories.

    Args:
        data: JSON string of data for bar chart, such as '[{"category": "Category A", "value": 10}]'
        width: Width of the chart (default: 600)
        height: Height of the chart (default: 400)
        title: Title of the chart
        axis_x_title: X-axis title
        axis_y_title: Y-axis title
        group: Whether grouping is enabled (requires 'group' field in data)
        stack: Whether stacking is enabled (requires 'group' field in data)

    Returns:
        Dictionary with chart URL or error message
    """
    try:
        chart_data = json.loads(data)

        if not validate_chart_data(chart_data, ["category", "value"]):
            return {
                "status": "error",
                "message": "Invalid data format. Each item must have 'category' and 'value' fields."
            }

        options = {
            "data": chart_data,
            "width": width,
            "height": height,
            "title": title,
            "axisXTitle": axis_x_title,
            "axisYTitle": axis_y_title,
            "group": group,
            "stack": stack
        }

        result = generate_chart_url("bar", options)
        return result

    except json.JSONDecodeError:
        return {
            "status": "error",
            "message": "Invalid JSON format for data parameter"
        }
    except Exception as e:
        return {
            "status": "error",
            "message": f"Error generating bar chart: {str(e)}"
        }


@mcp_server.tool()
def generate_pie_chart(
        data: str,
        width: int = 600,
        height: int = 400,
        title: str = "",
        inner_radius: float = 0.0
) -> Dict[str, Any]:
    """
    Generate a pie chart to show the proportion of parts.

    Args:
        data: JSON string of data for pie chart, such as '[{"category": "Category A", "value": 27}]'
        width: Width of the chart (default: 600)
        height: Height of the chart (default: 400)
        title: Title of the chart
        inner_radius: Inner radius for donut chart (0-1, default: 0)

    Returns:
        Dictionary with chart URL or error message
    """
    try:
        chart_data = json.loads(data)

        if not validate_chart_data(chart_data, ["category", "value"]):
            return {
                "status": "error",
                "message": "Invalid data format. Each item must have 'category' and 'value' fields."
            }

        options = {
            "data": chart_data,
            "width": width,
            "height": height,
            "title": title,
            "innerRadius": inner_radius
        }

        result = generate_chart_url("pie", options)
        return result

    except json.JSONDecodeError:
        return {
            "status": "error",
            "message": "Invalid JSON format for data parameter"
        }
    except Exception as e:
        return {
            "status": "error",
            "message": f"Error generating pie chart: {str(e)}"
        }


@mcp_server.tool()
def generate_scatter_chart(
        data: str,
        width: int = 600,
        height: int = 400,
        title: str = "",
        axis_x_title: str = "",
        axis_y_title: str = ""
) -> Dict[str, Any]:
    """
    Generate a scatter chart to show the relationship between two variables.

    Args:
        data: JSON string of data for scatter chart, such as '[{"x": 10, "y": 15}]'
        width: Width of the chart (default: 600)
        height: Height of the chart (default: 400)
        title: Title of the chart
        axis_x_title: X-axis title
        axis_y_title: Y-axis title

    Returns:
        Dictionary with chart URL or error message
    """
    try:
        chart_data = json.loads(data)

        if not validate_chart_data(chart_data, ["x", "y"]):
            return {
                "status": "error",
                "message": "Invalid data format. Each item must have 'x' and 'y' fields."
            }

        options = {
            "data": chart_data,
            "width": width,
            "height": height,
            "title": title,
            "axisXTitle": axis_x_title,
            "axisYTitle": axis_y_title
        }

        result = generate_chart_url("scatter", options)
        return result

    except json.JSONDecodeError:
        return {
            "status": "error",
            "message": "Invalid JSON format for data parameter"
        }
    except Exception as e:
        return {
            "status": "error",
            "message": f"Error generating scatter chart: {str(e)}"
        }


@mcp_server.tool()
def generate_area_chart(
        data: str,
        width: int = 600,
        height: int = 400,
        title: str = "",
        axis_x_title: str = "",
        axis_y_title: str = "",
        stack: bool = False
) -> Dict[str, Any]:
    """
    Generate an area chart to show data trends under continuous independent variables.

    Args:
        data: JSON string of data for area chart, such as '[{"time": "2018", "value": 99.9}]'
        width: Width of the chart (default: 600)
        height: Height of the chart (default: 400)
        title: Title of the chart
        axis_x_title: X-axis title
        axis_y_title: Y-axis title
        stack: Whether stacking is enabled (requires 'group' field in data)

    Returns:
        Dictionary with chart URL or error message
    """
    try:
        chart_data = json.loads(data)

        if not validate_chart_data(chart_data, ["time", "value"]):
            return {
                "status": "error",
                "message": "Invalid data format. Each item must have 'time' and 'value' fields."
            }

        options = {
            "data": chart_data,
            "width": width,
            "height": height,
            "title": title,
            "axisXTitle": axis_x_title,
            "axisYTitle": axis_y_title,
            "stack": stack
        }

        result = generate_chart_url("area", options)
        return result

    except json.JSONDecodeError:
        return {
            "status": "error",
            "message": "Invalid JSON format for data parameter"
        }
    except Exception as e:
        return {
            "status": "error",
            "message": f"Error generating area chart: {str(e)}"
        }


@mcp_server.tool()
def generate_word_cloud_chart(
        data: str,
        width: int = 600,
        height: int = 400,
        title: str = ""
) -> Dict[str, Any]:
    """
    Generate a word cloud chart to show word frequency through text size variation.

    Args:
        data: JSON string of data for word cloud, such as '[{"text": "word", "value": 4.272}]'
        width: Width of the chart (default: 600)
        height: Height of the chart (default: 400)
        title: Title of the chart

    Returns:
        Dictionary with chart URL or error message
    """
    try:
        chart_data = json.loads(data)

        if not validate_chart_data(chart_data, ["text", "value"]):
            return {
                "status": "error",
                "message": "Invalid data format. Each item must have 'text' and 'value' fields."
            }

        options = {
            "data": chart_data,
            "width": width,
            "height": height,
            "title": title
        }

        result = generate_chart_url("word-cloud", options)
        return result

    except json.JSONDecodeError:
        return {
            "status": "error",
            "message": "Invalid JSON format for data parameter"
        }
    except Exception as e:
        return {
            "status": "error",
            "message": f"Error generating word cloud chart: {str(e)}"
        }


@mcp_server.tool()
def generate_radar_chart(
        data: str,
        width: int = 600,
        height: int = 400,
        title: str = ""
) -> Dict[str, Any]:
    """
    Generate a radar chart to display multidimensional data (four dimensions or more).

    Args:
        data: JSON string of data for radar chart, such as '[{"name": "Design", "value": 70}]'
        width: Width of the chart (default: 600)
        height: Height of the chart (default: 400)
        title: Title of the chart

    Returns:
        Dictionary with chart URL or error message
    """
    try:
        chart_data = json.loads(data)

        if not validate_chart_data(chart_data, ["name", "value"]):
            return {
                "status": "error",
                "message": "Invalid data format. Each item must have 'name' and 'value' fields."
            }

        options = {
            "data": chart_data,
            "width": width,
            "height": height,
            "title": title
        }

        result = generate_chart_url("radar", options)
        return result

    except json.JSONDecodeError:
        return {
            "status": "error",
            "message": "Invalid JSON format for data parameter"
        }
    except Exception as e:
        return {
            "status": "error",
            "message": f"Error generating radar chart: {str(e)}"
        }


@mcp_server.tool()
def generate_column_chart(
        data: str,
        width: int = 600,
        height: int = 400,
        title: str = "",
        axis_x_title: str = "",
        axis_y_title: str = "",
        group: bool = True,
        stack: bool = False
) -> Dict[str, Any]:
    """
    Generate a column chart for comparing categorical data.

    Args:
        data: JSON string of data for column chart, such as '[{"category": "Beijing", "value": 825, "group": "Gas Car"}]'
        width: Width of the chart (default: 600)
        height: Height of the chart (default: 400)
        title: Title of the chart
        axis_x_title: X-axis title
        axis_y_title: Y-axis title
        group: Whether grouping is enabled (requires 'group' field in data)
        stack: Whether stacking is enabled (requires 'group' field in data)

    Returns:
        Dictionary with chart URL or error message
    """
    try:
        chart_data = json.loads(data)

        if not validate_chart_data(chart_data, ["category", "value"]):
            return {
                "status": "error",
                "message": "Invalid data format. Each item must have 'category' and 'value' fields."
            }

        options = {
            "data": chart_data,
            "width": width,
            "height": height,
            "title": title,
            "axisXTitle": axis_x_title,
            "axisYTitle": axis_y_title,
            "group": group,
            "stack": stack
        }

        result = generate_chart_url("column", options)
        return result

    except json.JSONDecodeError:
        return {
            "status": "error",
            "message": "Invalid JSON format for data parameter"
        }
    except Exception as e:
        return {
            "status": "error",
            "message": f"Error generating column chart: {str(e)}"
        }


@mcp_server.tool()
def generate_histogram_chart(
        data: str,
        width: int = 600,
        height: int = 400,
        title: str = "",
        axis_x_title: str = "",
        axis_y_title: str = "",
        bin_number: int = None
) -> Dict[str, Any]:
    """
    Generate a histogram chart to show frequency distribution of data.

    Args:
        data: JSON string of numeric data, such as '[78, 88, 60, 100, 95]'
        width: Width of the chart (default: 600)
        height: Height of the chart (default: 400)
        title: Title of the chart
        axis_x_title: X-axis title
        axis_y_title: Y-axis title
        bin_number: Number of bins for histogram (optional)

    Returns:
        Dictionary with chart URL or error message
    """
    try:
        chart_data = json.loads(data)

        # Validate that data is a list of numbers
        if not isinstance(chart_data, list) or not all(isinstance(x, (int, float)) for x in chart_data):
            return {
                "status": "error",
                "message": "Invalid data format. Data must be a list of numbers."
            }

        options = {
            "data": chart_data,
            "width": width,
            "height": height,
            "title": title,
            "axisXTitle": axis_x_title,
            "axisYTitle": axis_y_title
        }

        if bin_number is not None:
            options["binNumber"] = bin_number

        result = generate_chart_url("histogram", options)
        return result

    except json.JSONDecodeError:
        return {
            "status": "error",
            "message": "Invalid JSON format for data parameter"
        }
    except Exception as e:
        return {
            "status": "error",
            "message": f"Error generating histogram: {str(e)}"
        }


@mcp_server.tool()
def generate_treemap_chart(
        data: str,
        width: int = 600,
        height: int = 400,
        title: str = ""
) -> Dict[str, Any]:
    """
    Generate a treemap chart to display hierarchical data.

    Args:
        data: JSON string of hierarchical data, such as '[{"name": "Design", "value": 70, "children": [{"name": "Tech", "value": 20}]}]'
        width: Width of the chart (default: 600)
        height: Height of the chart (default: 400)
        title: Title of the chart

    Returns:
        Dictionary with chart URL or error message
    """
    try:
        chart_data = json.loads(data)

        # Basic validation for treemap data structure
        if not isinstance(chart_data, list):
            return {
                "status": "error",
                "message": "Invalid data format. Data must be a list of tree nodes."
            }

        for item in chart_data:
            if not isinstance(item, dict) or "name" not in item or "value" not in item:
                return {
                    "status": "error",
                    "message": "Invalid data format. Each item must have 'name' and 'value' fields."
                }

        options = {
            "data": chart_data,
            "width": width,
            "height": height,
            "title": title
        }

        result = generate_chart_url("treemap", options)
        return result

    except json.JSONDecodeError:
        return {
            "status": "error",
            "message": "Invalid JSON format for data parameter"
        }
    except Exception as e:
        return {
            "status": "error",
            "message": f"Error generating treemap: {str(e)}"
        }


@mcp_server.tool()
def generate_dual_axes_chart(
        categories: str,
        series: str,
        width: int = 600,
        height: int = 400,
        title: str = "",
        axis_x_title: str = ""
) -> Dict[str, Any]:
    """
    Generate a dual axes chart combining bar and line charts.

    Args:
        categories: JSON string of categories, such as '["2015", "2016", "2017"]'
        series: JSON string of series data, such as '[{"type": "column", "data": [91.9, 99.1, 101.6], "axisYTitle": "Sales"}, {"type": "line", "data": [0.055, 0.06, 0.062], "axisYTitle": "Ratio"}]'
        width: Width of the chart (default: 600)
        height: Height of the chart (default: 400)
        title: Title of the chart
        axis_x_title: X-axis title

    Returns:
        Dictionary with chart URL or error message
    """
    try:
        categories_data = json.loads(categories)
        series_data = json.loads(series)

        if not isinstance(categories_data, list) or not categories_data:
            return {
                "status": "error",
                "message": "Categories must be a non-empty list."
            }

        if not isinstance(series_data, list) or not series_data:
            return {
                "status": "error",
                "message": "Series must be a non-empty list."
            }

        # Validate series data structure
        for series_item in series_data:
            if not isinstance(series_item, dict) or "type" not in series_item or "data" not in series_item:
                return {
                    "status": "error",
                    "message": "Each series item must have 'type' and 'data' fields."
                }

            if series_item["type"] not in ["column", "line"]:
                return {
                    "status": "error",
                    "message": "Series type must be 'column' or 'line'."
                }

        options = {
            "categories": categories_data,
            "series": series_data,
            "width": width,
            "height": height,
            "title": title,
            "axisXTitle": axis_x_title
        }

        result = generate_chart_url("dual-axes", options)
        return result

    except json.JSONDecodeError:
        return {
            "status": "error",
            "message": "Invalid JSON format for categories or series parameter"
        }
    except Exception as e:
        return {
            "status": "error",
            "message": f"Error generating dual axes chart: {str(e)}"
        }


@mcp_server.tool()
def generate_mind_map(
        data: str,
        width: int = 600,
        height: int = 400
) -> Dict[str, Any]:
    """
    Generate a mind map chart to organize hierarchical information.

    Args:
        data: JSON string of mind map data, such as '{"name": "main topic", "children": [{"name": "topic 1", "children": [{"name": "subtopic 1-1"}]}]}'
        width: Width of the chart (default: 600)
        height: Height of the chart (default: 400)

    Returns:
        Dictionary with chart URL or error message
    """
    try:
        chart_data = json.loads(data)

        # Validate mind map data structure
        if not isinstance(chart_data, dict) or "name" not in chart_data:
            return {
                "status": "error",
                "message": "Invalid data format. Root node must have a 'name' field."
            }

        options = {
            "data": chart_data,
            "width": width,
            "height": height
        }

        result = generate_chart_url("mind-map", options)
        return result

    except json.JSONDecodeError:
        return {
            "status": "error",
            "message": "Invalid JSON format for data parameter"
        }
    except Exception as e:
        return {
            "status": "error",
            "message": f"Error generating mind map: {str(e)}"
        }


@mcp_server.tool()
def generate_network_graph(
        nodes: str,
        edges: str,
        width: int = 600,
        height: int = 400
) -> Dict[str, Any]:
    """
    Generate a network graph to show relationships between entities.

    Args:
        nodes: JSON string of nodes, such as '[{"name": "node1"}, {"name": "node2"}]'
        edges: JSON string of edges, such as '[{"source": "node1", "target": "node2", "name": "edge1"}]'
        width: Width of the chart (default: 600)
        height: Height of the chart (default: 400)

    Returns:
        Dictionary with chart URL or error message
    """
    try:
        nodes_data = json.loads(nodes)
        edges_data = json.loads(edges)

        # Validate nodes data
        if not isinstance(nodes_data, list) or not nodes_data:
            return {
                "status": "error",
                "message": "Nodes must be a non-empty list."
            }

        for node in nodes_data:
            if not isinstance(node, dict) or "name" not in node:
                return {
                    "status": "error",
                    "message": "Each node must have a 'name' field."
                }

        # Validate edges data
        if not isinstance(edges_data, list):
            return {
                "status": "error",
                "message": "Edges must be a list."
            }

        for edge in edges_data:
            if not isinstance(edge, dict) or "source" not in edge or "target" not in edge:
                return {
                    "status": "error",
                    "message": "Each edge must have 'source' and 'target' fields."
                }

        chart_data = {
            "nodes": nodes_data,
            "edges": edges_data
        }

        options = {
            "data": chart_data,
            "width": width,
            "height": height
        }

        result = generate_chart_url("network-graph", options)
        return result

    except json.JSONDecodeError:
        return {
            "status": "error",
            "message": "Invalid JSON format for nodes or edges parameter"
        }
    except Exception as e:
        return {
            "status": "error",
            "message": f"Error generating network graph: {str(e)}"
        }


@mcp_server.tool()
def generate_flow_diagram(
        nodes: str,
        edges: str,
        width: int = 600,
        height: int = 400
) -> Dict[str, Any]:
    """
    Generate a flow diagram to show process steps and decision points.

    Args:
        nodes: JSON string of nodes, such as '[{"name": "Start"}, {"name": "Process"}]'
        edges: JSON string of edges, such as '[{"source": "Start", "target": "Process", "name": "flow"}]'
        width: Width of the chart (default: 600)
        height: Height of the chart (default: 400)

    Returns:
        Dictionary with chart URL or error message
    """
    try:
        nodes_data = json.loads(nodes)
        edges_data = json.loads(edges)

        # Validate nodes data
        if not isinstance(nodes_data, list) or not nodes_data:
            return {
                "status": "error",
                "message": "Nodes must be a non-empty list."
            }

        for node in nodes_data:
            if not isinstance(node, dict) or "name" not in node:
                return {
                    "status": "error",
                    "message": "Each node must have a 'name' field."
                }

        # Validate edges data
        if not isinstance(edges_data, list):
            return {
                "status": "error",
                "message": "Edges must be a list."
            }

        for edge in edges_data:
            if not isinstance(edge, dict) or "source" not in edge or "target" not in edge:
                return {
                    "status": "error",
                    "message": "Each edge must have 'source' and 'target' fields."
                }

        chart_data = {
            "nodes": nodes_data,
            "edges": edges_data
        }

        options = {
            "data": chart_data,
            "width": width,
            "height": height
        }

        result = generate_chart_url("flow-diagram", options)
        return result

    except json.JSONDecodeError:
        return {
            "status": "error",
            "message": "Invalid JSON format for nodes or edges parameter"
        }
    except Exception as e:
        return {
            "status": "error",
            "message": f"Error generating flow diagram: {str(e)}"
        }


@mcp_server.tool()
def generate_fishbone_diagram(
        data: str,
        width: int = 600,
        height: int = 400
) -> Dict[str, Any]:
    """
    Generate a fishbone diagram to analyze causes and effects.

    Args:
        data: JSON string of fishbone data, such as '{"name": "main problem", "children": [{"name": "cause 1", "children": [{"name": "subcause 1-1"}]}]}'
        width: Width of the chart (default: 600)
        height: Height of the chart (default: 400)

    Returns:
        Dictionary with chart URL or error message
    """
    try:
        chart_data = json.loads(data)

        # Validate fishbone data structure
        if not isinstance(chart_data, dict) or "name" not in chart_data:
            return {
                "status": "error",
                "message": "Invalid data format. Root node must have a 'name' field."
            }

        options = {
            "data": chart_data,
            "width": width,
            "height": height
        }

        result = generate_chart_url("fishbone-diagram", options)
        return result

    except json.JSONDecodeError:
        return {
            "status": "error",
            "message": "Invalid JSON format for data parameter"
        }
    except Exception as e:
        return {
            "status": "error",
            "message": f"Error generating fishbone diagram: {str(e)}"
        }
# Define the lambda handler
def lambda_handler(event, context):
    """AWS Lambda handler function."""
    return mcp_server.handle_request(event, context)