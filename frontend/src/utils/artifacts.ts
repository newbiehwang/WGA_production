// 답변 글을 글 조각과 결과물(차트·다이어그램) 조각으로 나눈다.
//   "비용은 …\n![서비스별 비용](artifact://charts/…/bar_ab12.png)\n…" → [글, 결과물, 글]
// 글 조각은 마크다운으로, 결과물 조각은 ArtifactView로 그린다.
import type { Artifact } from '@/types/artifacts';

export type Segment = { kind: 'text'; text: string } | { kind: 'artifact'; ref: string; title: string };

const ARTIFACT_IMAGE = /!\[([^\]\n]*)\]\((artifact:\/\/[A-Za-z0-9/_.-]+)\)/g;

export function splitArtifacts(text: string): Segment[] {
    const segments: Segment[] = [];
    let last = 0;
    for (const match of text.matchAll(ARTIFACT_IMAGE)) {
        const index = match.index ?? 0;
        if (index > last) segments.push({ kind: 'text', text: text.slice(last, index) });
        segments.push({ kind: 'artifact', title: match[1], ref: match[2] });
        last = index + match[0].length;
    }
    if (last < text.length) segments.push({ kind: 'text', text: text.slice(last) });
    return segments;
}

// 답변 정보의 결과물 (저장된 메시지에서는 inference가 JSON 문자열이다). 주소가 https가 아니면 버린다
export function artifactsOf(inference: unknown): Map<string, Artifact> {
    let data = inference;
    if (typeof data === 'string') {
        try {
            data = JSON.parse(data);
        } catch {
            return new Map();
        }
    }
    const items = (data as { artifacts?: unknown } | null)?.artifacts;
    const map = new Map<string, Artifact>();
    if (!Array.isArray(items)) return map;
    for (const item of items as Artifact[]) {
        if (typeof item?.ref !== 'string' || typeof item.url !== 'string') continue;
        try {
            if (new URL(item.url).protocol !== 'https:') continue;
        } catch {
            continue;
        }
        map.set(item.ref, item);
    }
    return map;
}
