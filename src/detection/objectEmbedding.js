// 오픈셋 인식용 임베딩 모델 (Phase 2, AI_개발위임_브리프.md §3.2 / docs/phase2-design.md).
// COCO-SSD가 낮은 confidence로 탐지한 박스만 재확인하는 용도 — 모든 박스를 다시 돌리지 않는다.
export class ObjectEmbedding {
    constructor() {
        this.model = null;
    }

    async load() {
        this.model = await mobilenet.load({ version: 2, alpha: 1.0 });
    }

    // 캔버스/이미지 요소에서 1024차원 임베딩 벡터(JS 배열)를 추출
    async embed(imageElement) {
        const embeddingTensor = this.model.infer(imageElement, true);
        const data = await embeddingTensor.data();
        embeddingTensor.dispose();
        return Array.from(data);
    }
}

export function cosineSimilarity(a, b) {
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    if (normA === 0 || normB === 0) return 0;
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
