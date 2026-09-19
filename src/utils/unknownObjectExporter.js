// 미지 객체 로컬 큐 내보내기 (Phase 2 등록 경로, docs/phase2-design.md).
// 서버/토큰 없이 순수 클라이언트에서 ZIP을 만들어 다운로드시킨다 — 사용자가
// 그 파일을 직접 GitHub Issue에 첨부해서 수동으로 라벨링 큐에 올리는 흐름.
// 공개 레포 JS에 쓰기 토큰을 넣지 않기 위한 의도적 선택.
import { dataUrlToBytes, yieldToMain, downloadFilesAsZip } from './zipWriter.js';

let exportInProgress = false;

// 로컬 큐(localStorage 'unknownObjectQueue')를 ZIP으로 묶어 다운로드시킨다.
// 이미지 파일 + manifest.json(카테고리/점수/시각) 포함 — 사용자가 GitHub Issue에
// 수동으로 첨부해서 라벨링 큐에 올리는 용도.
// 비동기: 탐지 루프를 막지 않도록 청크 단위로 메인 스레드를 양보한다 (zipWriter.js 참고).
// 이미 진행 중인 내보내기가 있으면 중복 호출(연타 등)을 무시한다.
export async function exportUnknownObjectQueue() {
    if (exportInProgress) {
        return { count: 0, alreadyInProgress: true };
    }
    exportInProgress = true;

    try {
        const raw = localStorage.getItem('unknownObjectQueue');
        const queue = raw ? JSON.parse(raw) : [];

        if (queue.length === 0) {
            return { count: 0 };
        }

        const files = [];
        const manifest = [];
        const CHUNK_SIZE = 10;

        for (let i = 0; i < queue.length; i++) {
            const item = queue[i];
            const filename = `unknown_${i}_${(item.originalClass || 'obj').replace(/\s+/g, '_')}.jpg`;
            files.push({ name: filename, bytes: dataUrlToBytes(item.dataUrl) });
            manifest.push({
                filename,
                originalClass: item.originalClass,
                score: item.score,
                timestamp: item.timestamp
            });
            if (i % CHUNK_SIZE === CHUNK_SIZE - 1) await yieldToMain();
        }

        files.push({
            name: 'manifest.json',
            bytes: new TextEncoder().encode(JSON.stringify(manifest, null, 2))
        });

        await downloadFilesAsZip(files, `safewalk-unknown-objects-${Date.now()}.zip`);

        return { count: queue.length };
    } finally {
        exportInProgress = false;
    }
}
