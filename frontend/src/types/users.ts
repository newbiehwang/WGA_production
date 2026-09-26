// 사용자 관리 (services/llm/user_admin.py)와 같은 모양

export type ManagedGroup = 'admins' | 'approvers';

export interface ManagedUser {
    username: string; // Cognito 사용자 이름 (이메일로 로그인하는 풀이라 sub와 같은 UUID). 경로에 쓴다
    email?: string | null;
    name?: string | null;
    // CONFIRMED(사용 중), FORCE_CHANGE_PASSWORD(초대 후 첫 로그인 전), UNCONFIRMED(이메일 확인 전) 등
    status?: string | null;
    enabled: boolean; // false면 정지
    createdAt?: string | null;
    groups: ManagedGroup[];
    isSelf: boolean; // 나 (자기 관리자 권한 빼기·정지는 서버가 막는다)
}

export interface UsersPage {
    users: ManagedUser[];
    cursor?: string | null; // 더 있으면 다음 조회에 넘긴다
    groups: ManagedGroup[];
}
