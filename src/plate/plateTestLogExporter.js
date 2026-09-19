// 번호판 인식 정확도 테스트 로그(당일 한정) 내보내기 — 실기기에서 재현된 인식
// 실패/오류를 스크린샷 대신 크롭 이미지+텍스트로 그대로 전달할 방법이 없다는
// 피드백(2026-09-19) 대응. 오직 사용자가 직접 옵트인해서 쌓은 "오늘" 데이터만
// 대상이고, 버튼을 눌러야만 내보내진다 — 자동 업로드/전송은 여전히 없다.
import { dataUrlToBytes, yieldToMain, downloadFilesAsZip } from '../utils/zipWriter.js';

export async function exportPlateTestLog(entries) {
    if (!entries || entries.length === 0) {
        return { count: 0 };
    }

    const files = [];
    const manifest = [];
    const CHUNK_SIZE = 10;

    for (let i = 0; i < entries.length; i++) {
        const item = entries[i];
        const filename = `plate_${i}_${(item.text || 'unreadable').replace(/\s+/g, '_')}.jpg`;
        if (item.cropDataUrl) {
            files.push({ name: filename, bytes: dataUrlToBytes(item.cropDataUrl) });
        }
        manifest.push({
            filename: item.cropDataUrl ? filename : null,
            text: item.text,
            colorLabel: item.colorLabel,
            timestamp: item.timestamp
        });
        if (i % CHUNK_SIZE === CHUNK_SIZE - 1) await yieldToMain();
    }

    files.push({
        name: 'manifest.json',
        bytes: new TextEncoder().encode(JSON.stringify(manifest, null, 2))
    });

    await downloadFilesAsZip(files, `safewalk-plate-test-log-${Date.now()}.zip`);
    return { count: entries.length };
}
