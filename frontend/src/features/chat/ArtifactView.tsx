// 답변 속 결과물 하나 (![제목](artifact://…)).
// - 차트이고 그릴 내용(spec)이 있으면 브라우저에서 ECharts로 그린다. ECharts는 이때 처음 불러온다 (lazy)
// - 그 밖(다이어그램, spec이 너무 커서 빠진 차트, 브라우저에서 그리다 실패)은 서버가 그린 PNG를 보인다
// - 참조를 모르면(오래된 대화 등) 글로 알린다. 모델이 쓴 주소는 열지 않는다
import { lazy, Suspense, useCallback, useState } from 'react';
import type { Artifact } from '@/types/artifacts';

const EChart = lazy(() => import('./charts/EChart'));

// 불러오는 동안의 자리 높이. 실제 높이는 EChart가 차트 종류에 맞춰 정한다 (chartOption을 첫 화면 번들에 넣지 않으려고)
const LOADING_HEIGHT = 400;

export function ArtifactView({ artifact, title }: { artifact?: Artifact; title: string }) {
    const [failed, setFailed] = useState(false);
    const onError = useCallback(() => setFailed(true), []);

    if (!artifact) {
        return (
            <p className="artifact-missing" role="note">
                {title ? `'${title}' ` : ''}그림을 찾을 수 없습니다.
            </p>
        );
    }

    const drawHere = artifact.kind === 'chart' && artifact.spec && !failed;
    return (
        <figure className="artifact">
            {drawHere ? (
                <Suspense fallback={<div className="artifact-loading" style={{ height: LOADING_HEIGHT }} />}>
                    <EChart spec={artifact.spec!} onError={onError} />
                </Suspense>
            ) : (
                <a href={artifact.url} target="_blank" rel="noopener noreferrer">
                    <img src={artifact.url} alt={title} className="markdown-image" />
                </a>
            )}
            <figcaption className="artifact-caption">
                {title ? <span>{title}</span> : null}
                {/* 서버가 그린 PNG (24시간 동안 열린다). 저장·공유용 */}
                <a href={artifact.url} target="_blank" rel="noopener noreferrer" className="artifact-png">
                    PNG로 열기
                </a>
            </figcaption>
        </figure>
    );
}
