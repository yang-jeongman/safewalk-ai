// 위험요소 수동 스냅샷(맨홀/계단/에스컬레이터/웅덩이/싱크홀 등) 내보내기 —
// unknownObjectExporter.js와 같은 원칙: 서버 없이 클라이언트에서 ZIP으로 묶어
// 반환하고, 실제 다운로드는 uiController.presentDownload()가 처리한다.
import { dataUrlToBytes, yieldToMain, buildZipAsync } from './zipWriter.js';

let exportInProgress = false;

export async function exportHazardSnapshots(dataManager) {
    if (exportInProgress) {
        return { count: 0, alreadyInProgress: true };
    }
    exportInProgress = true;

    try {
        const snapshots = await dataManager.getHazardSnapshots();
        if (snapshots.length === 0) {
            return { count: 0 };
        }

        const files = [];
        const manifest = [];
        const CHUNK_SIZE = 5; // 동영상 Blob→bytes 변환이 사진보다 무거워 더 자주 양보

        for (let i = 0; i < snapshots.length; i++) {
            const item = snapshots[i];
            const ext = item.mediaType === 'video' ? 'webm' : 'jpg';
            const filename = `hazard_${i}_${item.category}.${ext}`;

            const bytes = item.mediaType === 'video'
                ? new Uint8Array(await item.blob.arrayBuffer())
                : dataUrlToBytes(item.dataUrl);
            files.push({ name: filename, bytes });

            manifest.push({
                filename,
                category: item.category,
                mediaType: item.mediaType,
                timestamp: item.timestamp
            });
            if (i % CHUNK_SIZE === CHUNK_SIZE - 1) await yieldToMain();
        }

        files.push({
            name: 'manifest.json',
            bytes: new TextEncoder().encode(JSON.stringify(manifest, null, 2))
        });

        const blob = await buildZipAsync(files);
        return { count: snapshots.length, blob, filename: `safewalk-hazard-snapshots-${Date.now()}.zip` };
    } finally {
        exportInProgress = false;
    }
}
