// 답변을 만드는 과정(사고 요약·MCP 도구 호출)을 대화 화면의 목록으로 보여 주기 위한 변환.
// 데이터는 두 가지다.
// - 단계(steps): 사고 요약과 도구 호출이 일어난 순서대로 들어 있다. 답을 기다리는 동안의 진행 상황
//   (GET /llm1/progress/{requestId})과 답변의 inference.steps가 같은 모양이다 (services/llm/llm_progress.py)
//     { type: 'thinking', text } | { type: 'tool', id, name, input, status: 'running'|'ok'|'error', error?, ms? }
// - 예전 답변: inference.tools_used만 있다 [{ tool_name, input, status?, error? }] (사고 요약 없음)
// (대화 기록에서 다시 불러온 메시지는 inference가 JSON 문자열로 저장되어 있다)

export interface ToolStep {
    label: string; // 사람이 읽는 이름 (모르는 도구는 도구 이름 그대로)
    name: string; // 도구 이름 (마우스를 올리면 보인다)
    detail: string; // 입력값 요약 (비어 있을 수 있다)
    failed: boolean;
    error?: string;
}

// MCP 도구 이름 → 화면에 보일 이름.
// AWS 공식 MCP 서버 도구(snake_case, cost-explorer)와 직접 둔 도구(mcp/app.py)를 함께 적는다.
// 직접 둔 도구는 서버가 이름을 camelCase로 바꿔 내보내므로(listCloudwatchDashboards), 찾을 때 snake_case로 바꿔 찾는다
const LABELS: Record<string, string> = {
    // AWS 공식 CloudWatch MCP 서버
    describe_log_groups: '로그 그룹 조회',
    analyze_log_group: '로그 분석',
    execute_log_insights_query: '로그 분석 (Insights)',
    get_logs_insight_query_results: '로그 분석 결과',
    cancel_logs_insight_query: '로그 분석 취소',
    get_metric_data: '메트릭 조회',
    get_metric_metadata: '메트릭 정보',
    analyze_metric: '메트릭 분석',
    get_recommended_metric_alarms: '알람 추천',
    get_active_alarms: '알람 조회',
    get_alarm_history: '알람 기록',
    // AWS 공식 문서 MCP 서버
    search_documentation: '문서 검색',
    read_documentation: '문서 읽기',
    read_sections: '문서 읽기 (부분)',
    search_table: '문서 표 검색',
    recommend: '관련 문서 추천',
    // AWS 공식 Billing and Cost Management MCP 서버 (Cost Explorer)
    'cost-explorer': '비용 조회',
    // 직접 둔 도구
    list_cloudwatch_dashboards: '대시보드 목록',
    get_dashboard_summary: '대시보드 요약',
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

// listCloudwatchDashboards → list_cloudwatch_dashboards
const toSnake = (name: string) => name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
const labelOf = (name: string) => LABELS[name] ?? LABELS[toSnake(name)] ?? name;

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
                label: labelOf(name),
                name,
                detail: summarize(step.input),
                failed: step.status === 'error',
                error: step.error ? clip(String(step.error), 160) : undefined,
            };
        });
}

// ---------------------------------------------------------------- 사고 요약과 도구 호출을 순서대로

export type TraceStep =
    | { kind: 'thinking'; text: string; preview: string }
    | {
          kind: 'tool';
          label: string;
          name: string;
          detail: string;
          status: 'running' | 'ok' | 'error';
          error?: string;
          seconds?: string; // 걸린 시간 ("1.2초")
      };

interface RawProgressStep {
    type?: string;
    text?: string;
    name?: string;
    input?: unknown;
    status?: string;
    error?: string;
    ms?: number;
}

const PREVIEW = 60; // 접힌 사고 요약에서 보여 줄 첫 줄 길이

const secondsOf = (ms?: number) => (typeof ms === 'number' ? `${(ms / 1000).toFixed(1)}초` : undefined);

// 진행 상황·inference.steps의 단계 → 화면에 그릴 단계
export function fromProgressSteps(raw: unknown): TraceStep[] {
    if (!Array.isArray(raw)) return [];
    const steps: TraceStep[] = [];
    for (const step of raw as RawProgressStep[]) {
        if (step?.type === 'thinking' && step.text) {
            const firstLine = step.text.trim().split('\n')[0];
            steps.push({ kind: 'thinking', text: step.text.trim(), preview: clip(firstLine, PREVIEW) });
        } else if (step?.type === 'tool' && step.name) {
            steps.push({
                kind: 'tool',
                label: labelOf(step.name),
                name: step.name,
                detail: summarize(step.input),
                status: step.status === 'error' ? 'error' : step.status === 'running' ? 'running' : 'ok',
                error: step.error ? clip(String(step.error), 160) : undefined,
                seconds: secondsOf(step.ms),
            });
        }
    }
    return steps;
}

// 답변 하나의 과정. 단계(steps)가 있으면 그것을, 없으면(예전 답변) 도구 목록만 쓴다
export function traceSteps(inference: unknown): TraceStep[] {
    let data = inference;
    if (typeof data === 'string') {
        try {
            data = JSON.parse(data);
        } catch {
            return [];
        }
    }
    const steps = (data as { steps?: unknown } | null)?.steps;
    if (Array.isArray(steps)) return fromProgressSteps(steps);
    return toolSteps(data).map((step) => ({
        kind: 'tool' as const,
        label: step.label,
        name: step.name,
        detail: step.detail,
        status: step.failed ? ('error' as const) : ('ok' as const),
        error: step.error,
    }));
}
