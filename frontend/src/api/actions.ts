// 변경 작업 승인 API (services/llm/llm_service.handle_action)
//   GET  /actions/{id}          지금 상태 (대화를 다시 열었을 때)
//   POST /actions/{id}/approve  승인하고 실행 (실행 결과까지 돌려준다)
//   POST /actions/{id}/deny     거절
import axios from 'axios';
import type { PendingAction } from '@/types/actions';

export async function getAction(actionId: string): Promise<PendingAction> {
    return (await axios.get<PendingAction>(`/actions/${actionId}`)).data;
}

export async function decideAction(actionId: string, decision: 'approve' | 'deny'): Promise<PendingAction> {
    return (await axios.post<PendingAction>(`/actions/${actionId}/${decision}`)).data;
}

// 서버가 돌려준 오류 문구 (예: "운영 환경에서는 요청한 본인이 승인할 수 없습니다")
export function actionErrorText(error: unknown): string {
    const response = (error as { response?: { data?: { error?: string } } })?.response;
    return response?.data?.error ?? '요청을 처리하지 못했습니다. 잠시 뒤 다시 시도해 주세요.';
}
