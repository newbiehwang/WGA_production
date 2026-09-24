export interface ModelInfo {
    id: string;
    display_name: string;
    created_at?: string; // 출시일 (Anthropic Models API). 기본 모델 선택에 쓴다
}

export interface ModelsState {
    models: ModelInfo[];
    loading: boolean;
    error: string | null;
    selectedModel: ModelInfo;
}
