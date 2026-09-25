"""WGA MCP 서버 (Lambda Function URL, Streamable HTTP)

도구는 두 곳에서 온다.
1. AWS 공식 MCP 서버 (awslabs, lambda_mcp/official.py가 이 서버에 붙인다)
   - CloudWatch: 로그 그룹 조회, Logs Insights 쿼리, 로그 이상 탐지, 메트릭 조회·분석, 알람·알람 기록
   - AWS 문서: 문서 검색·읽기·추천
   - 비용: Cost Explorer (billing-cost-management 서버의 Cost Explorer 부분만)
2. 이 파일에 직접 둔 도구 (공식 서버가 없거나 폐기된 것)
   - CloudWatch 대시보드 목록·요약 (공식 CloudWatch 서버에 대시보드 도구가 없다)
   - 아키텍처 다이어그램 (공식 diagram 서버는 PyPI에서 폐기되었다. 폐기 전 공식 서버를 옮겨 온 코드)
   - 차트 (AntV 차트 서비스, AWS와 무관)
"""
import os
import json
import boto3
from typing import Dict, Any
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

# Initialize the MCP server
mcp_server = LambdaMCPServer(name="cloudguard", version="1.0.0", session_table=session_table)
# 공식 서버는 여기서 불러오지 않고 도구 목록이 처음 필요할 때 불러온다 (콜드 스타트, lambda_mcp/official.py)
mcp_server.attach(OfficialTools.default())


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