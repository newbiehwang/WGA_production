// 모델 목록과 고른 모델 (예전 stores/models.ts)
import axios from 'axios';
import { create } from 'zustand';
import type { ModelInfo } from '@/types/models';

// 모델 ID를 여기 고정하지 않는다. 고정한 모델이 퇴역하면 모든 요청이 실패한다.
// 목록을 받기 전에는 비워 두고(화면에는 '모델 선택'), 받은 뒤 백엔드가 정한 기본 모델
// (지금 제공되는 최신 Sonnet)을 쓴다. 비어 있는 채로 보내도 백엔드가 기본 모델을 쓴다.
const NO_MODEL: ModelInfo = { id: '', display_name: '' };
const STORAGE_KEY = 'selectedModelId';

interface ModelsState {
    models: ModelInfo[];
    selectedModel: ModelInfo;
    fetchModels: () => Promise<void>;
    selectModel: (id: string) => void;
}

const readSaved = () => {
    try {
        return localStorage.getItem(STORAGE_KEY);
    } catch {
        return null;
    }
};

export const useModelsStore = create<ModelsState>((set, get) => ({
    models: [],
    selectedModel: { ...NO_MODEL },

    fetchModels: async () => {
        const response = await axios.get('/health');
        const models: ModelInfo[] = response.data?.models ?? [];
        // 저장해 둔 선택은 지금 목록에 있을 때만 되살린다 (퇴역한 모델이면 기본 모델)
        const saved = models.find((model) => model.id === readSaved());
        set({ models, selectedModel: saved ?? response.data?.default_model ?? { ...NO_MODEL } });
    },

    selectModel: (id) => {
        const model = get().models.find((m) => m.id === id);
        if (!model) return;
        set({ selectedModel: model });
        try {
            localStorage.setItem(STORAGE_KEY, id);
        } catch {
            // 저장하지 못해도 이번 화면에서는 고른 모델을 쓴다
        }
    },
}));
