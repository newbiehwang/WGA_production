// 답변을 만들며 부른 MCP 도구를 대화 화면의 세로줄 목록으로 보여 주기 위한 변환.
// 데이터는 LLM 응답의 inference.tools_used다: [{ tool_name, input, status?, error? }]
// (대화 기록에서 다시 불러온 메시지는 inference가 JSON 문자열로 저장되어 있다)

export interface ToolStep {
    label: string; // 사람이 읽는 이름 (모르는 도구는 도구 이름 그대로)
    name: string; // 도구 이름 (마우스를 올리면 보인다)
    detail: string; // 입력값 요약 (비어 있을 수 있다)
    failed: boolean;
    error?: string;
}

// mcp/app.py의 @mcp_server.tool() 목록
const LABELS: Record<string, string> = {
    fetch_cloudwatch_logs_for_service: '로그 그룹 조회',
    list_log_groups: '로그 그룹 목록',
    analyze_log_group: '로그 분석',
    analyze_log_groups_insights: '로그 분석 (Insights)',
    get_insights_query_templates: 'Insights 쿼리 예시',
    list_cloudwatch_dashboards: '대시보드 목록',
    get_dashboard_summary: '대시보드 요약',
    get_cloudwatch_alarms_for_service: '알람 조회',
    get_detailed_breakdown_by_day: '일별 비용 조회',
    search_documentation: '문서 검색',
    recommend_documentation: '관련 문서 추천',
    read_documentation: '문서 읽기',
    generate_architecture_diagram: '아키텍처 다이어그램 생성',
    get_diagram_code_examples: '다이어그램 예시',
    list_available_diagram_icons: '다이어그램 아이콘 목록',
    generate_line_chart: '선 차트 생성',
    generate_bar_chart: '막대 차트 생성',
    generate_column_chart: '세로 막대 차트 생성',
    generate_pie_chart: '파이 차트 생성',
    generate_scatter_chart: '산점도 생성',
    generate_area_chart: '영역 차트 생성',
    generate_word_cloud_chart: '워드 클라우드 생성',
    generate_radar_chart: '레이더 차트 생성',
    generate_histogram_chart: '히스토그램 생성',
    generate_treemap_chart: '트리맵 생성',
    generate_dual_axes_chart: '이중 축 차트 생성',
    generate_mind_map: '마인드맵 생성',
    generate_network_graph: '네트워크 그래프 생성',
    generate_flow_diagram: '흐름도 생성',
    generate_fishbone_diagram: '피시본 다이어그램 생성',
};

const MAX_VALUE = 40; // 값 하나의 최대 길이
const MAX_DETAIL = 100; // 한 줄 전체의 최대 길이

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

// 입력값 중 글자·숫자·참거짓만 " · "로 잇는다. 차트 데이터 같은 배열·객체는 길어서 뺀다
const summarize = (input: unknown): string => {
    if (!input || typeof input !== 'object') return '';
    const values = Object.values(input as Record<string, unknown>)
        .filter((v) => ['string', 'number', 'boolean'].includes(typeof v) && String(v).trim() !== '')
        .map((v) => clip(String(v).replace(/\s+/g, ' ').trim(), MAX_VALUE));
    return clip(values.join(' · '), MAX_DETAIL);
};

interface RawStep {
    tool_name?: string;
    input?: unknown;
    status?: string;
    error?: string;
}

export function toolSteps(inference: unknown): ToolStep[] {
    let data = inference;
    if (typeof data === 'string') {
        try {
            data = JSON.parse(data);
        } catch {
            return [];
        }
    }
    const raw = (data as { tools_used?: RawStep[] } | null)?.tools_used;
    if (!Array.isArray(raw)) return [];

    // 예전에 저장된 기록은 호출 한 번이 같은 항목 두 개로 들어 있다(status 없음). 이어진 중복을 하나로 줄인다
    const legacy = raw.every((step) => step.status === undefined);
    const steps = legacy
        ? raw.filter(
              (step, i) =>
                  i === 0 ||
                  step.tool_name !== raw[i - 1].tool_name ||
                  JSON.stringify(step.input) !== JSON.stringify(raw[i - 1].input),
          )
        : raw;

    return steps
        .filter((step) => step.tool_name)
        .map((step) => {
            const name = String(step.tool_name);
            return {
                label: LABELS[name] ?? name,
                name,
                detail: summarize(step.input),
                failed: step.status === 'error',
                error: step.error ? clip(String(step.error), 160) : undefined,
            };
        });
}
