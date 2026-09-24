// src/stores/models.ts
import { defineStore } from 'pinia';
import axios from 'axios';
import type { ModelInfo, ModelsState } from '@/types/models';

// 모델 ID를 여기 고정하지 않는다. 고정한 모델이 퇴역하면 모든 요청이 실패한다.
// 목록을 받기 전에는 비워 두고(화면에는 '모델 선택'), 받은 뒤 백엔드가 정한 기본 모델
// (지금 제공되는 Sonnet 중 가장 낮은 버전)을 쓴다. 비어 있는 채로 보내도 백엔드가 기본 모델을 쓴다.
const NO_MODEL: ModelInfo = { id: '', display_name: '' };

export const useModelsStore = defineStore('models', {
    state: (): ModelsState => ({
        models: [],
        loading: false,
        error: null,
        selectedModel: { ...NO_MODEL },
    }),

    getters: {
        getModelById:
            (state) =>
            (id: string): ModelInfo | undefined => {
                return state.models.find((model) => model.id === id);
            },
        hasModels: (state) => state.models.length > 0,
        getModelOptions: (state) =>
            state.models.map((model) => ({
                value: model.id,
                label: model.display_name,
            })),
    },

    actions: {
        async fetchModels() {
            this.loading = true;
            this.error = null;

            try {
                const apiUrl = import.meta.env.VITE_API_DEST || 'http://localhost:8000';

                const response = await axios.get(`${apiUrl}/health`, {
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    withCredentials: true,
                });

                if (response.data && response.data.models) {
                    this.models = response.data.models;
                }
                // 저장해 둔 선택은 loadSelectedModelFromStorage가 지금 목록에 있을 때만 되살린다
                this.selectedModel = response.data?.default_model ?? { ...NO_MODEL };

                return this.models;
            } catch (error: any) {
                console.error('모델 목록 가져오기 오류:', error);
                this.error = error.message || '모델 목록을 불러오는 중 오류가 발생했습니다.';
                throw error;
            } finally {
                this.loading = false;
            }
        },

        selectModel(modelId: string) {
            const model = this.getModelById(modelId);
            if (model) {
                this.selectedModel = model;
                localStorage.setItem('selectedModelId', modelId);
            }
        },

        loadSelectedModelFromStorage() {
            const savedModelId = localStorage.getItem('selectedModelId');
            if (savedModelId && this.models.length > 0) {
                const model = this.getModelById(savedModelId);
                if (model) {
                    this.selectedModel = model;
                }
            }
        },

        resetState() {
            this.models = [];
            this.loading = false;
            this.error = null;
            this.selectedModel = { ...NO_MODEL };
        },
    },
});
