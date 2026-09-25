// 답변의 결과물 (services/llm/artifacts.py의 inference.artifacts).
// 답변 글에는 ![제목](artifact://…) 참조만 있고, 실제 주소와 그릴 내용은 여기 있다.
import type { ChartSpec } from '@/features/chat/charts/chartOption';

export interface Artifact {
    ref: string; // artifact://charts/2026/09/26/bar_ab12cd34.png
    url: string; // 서버가 만든 presigned URL (24시간). PNG
    kind: 'chart' | 'diagram';
    spec?: ChartSpec; // 차트만. 있으면 브라우저가 ECharts로 다시 그린다
}
