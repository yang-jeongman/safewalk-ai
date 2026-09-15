// 알려진 객체 갤러리 — 카테고리별 참조 임베딩(Phase 2, docs/phase2-design.md).
// 처음엔 비어있고, 라벨링 큐를 통해 점진적으로 채워진다.
import { cosineSimilarity } from './objectEmbedding.js';

export class KnownObjectGallery {
    constructor(url = './data/known-objects-gallery.json') {
        this.url = url;
        this.entries = []; // { category, threatLevel, embedding }
    }

    async load() {
        try {
            const res = await fetch(this.url);
            if (!res.ok) throw new Error(`gallery fetch ${res.status}`);
            const data = await res.json();
            this.entries = data.entries || [];
        } catch (err) {
            console.warn('알려진 객체 갤러리 로드 실패 (빈 갤러리로 시작):', err);
            this.entries = [];
        }
    }

    // 가장 유사한 항목과 유사도를 반환. 갤러리가 비어있으면 항상 미지로 처리된다.
    match(embedding) {
        let best = null;
        let bestSimilarity = -1;

        for (const entry of this.entries) {
            const similarity = cosineSimilarity(embedding, entry.embedding);
            if (similarity > bestSimilarity) {
                bestSimilarity = similarity;
                best = entry;
            }
        }

        return { entry: best, similarity: bestSimilarity };
    }
}
