// 순수 클라이언트 ZIP 작성기 (외부 라이브러리 없음) — 원래 unknownObjectExporter.js에
// 있던 걸 공용으로 뽑아냈다. 서버 없이 내보내기 기능이 필요한 곳(미지 객체 큐,
// 번호판 테스트 로그 등)에서 공통으로 쓴다.

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) {
            c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        }
        table[n] = c >>> 0;
    }
    return table;
})();

function crc32(bytes) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) {
        crc = CRC_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
}

export function dataUrlToBytes(dataUrl) {
    const base64 = dataUrl.split(',')[1];
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
}

function writeUint32LE(view, offset, value) {
    view.setUint32(offset, value, true);
}

function writeUint16LE(view, offset, value) {
    view.setUint16(offset, value, true);
}

// 메인 스레드를 한 틱 양보한다 — 탐지 루프(rAF/setInterval)가 그 사이에 끼어들 수 있게.
export function yieldToMain() {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

// 파일 목록({name, bytes})을 무압축(store) ZIP으로 묶는다.
// 실측(2026-09-18): 파일 수가 많을 때(150개) 동기 버전이 CRC32/base64 디코딩을 한
// 호출 안에서 다 처리하느라 메인 스레드를 15~20초 이상 막아 그동안 탐지 루프 fps가
// 1~2로 주저앉는 게 실기기 로그로 확인됐다. 파일 몇 개마다 한 번씩 yieldToMain()으로
// 양보해 탐지 루프가 계속 돌 수 있게 한다.
export async function buildZipAsync(files) {
    const chunks = [];
    const centralEntries = [];
    let offset = 0;
    const CHUNK_SIZE = 8;

    for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const nameBytes = new TextEncoder().encode(file.name);
        const crc = crc32(file.bytes);

        const localHeader = new ArrayBuffer(30);
        const lv = new DataView(localHeader);
        writeUint32LE(lv, 0, 0x04034b50);
        writeUint16LE(lv, 4, 20);
        writeUint16LE(lv, 6, 0);
        writeUint16LE(lv, 8, 0);
        writeUint16LE(lv, 10, 0);
        writeUint16LE(lv, 12, 0);
        writeUint32LE(lv, 14, crc);
        writeUint32LE(lv, 18, file.bytes.length);
        writeUint32LE(lv, 22, file.bytes.length);
        writeUint16LE(lv, 26, nameBytes.length);
        writeUint16LE(lv, 28, 0);

        chunks.push(new Uint8Array(localHeader), nameBytes, file.bytes);

        centralEntries.push({ nameBytes, crc, size: file.bytes.length, offset });
        offset += 30 + nameBytes.length + file.bytes.length;

        if (i % CHUNK_SIZE === CHUNK_SIZE - 1) await yieldToMain();
    }

    const centralStart = offset;
    for (const entry of centralEntries) {
        const central = new ArrayBuffer(46);
        const cv = new DataView(central);
        writeUint32LE(cv, 0, 0x02014b50);
        writeUint16LE(cv, 4, 20);
        writeUint16LE(cv, 6, 20);
        writeUint16LE(cv, 8, 0);
        writeUint16LE(cv, 10, 0);
        writeUint16LE(cv, 12, 0);
        writeUint16LE(cv, 14, 0);
        writeUint32LE(cv, 16, entry.crc);
        writeUint32LE(cv, 20, entry.size);
        writeUint32LE(cv, 24, entry.size);
        writeUint16LE(cv, 28, entry.nameBytes.length);
        writeUint16LE(cv, 30, 0);
        writeUint16LE(cv, 32, 0);
        writeUint16LE(cv, 34, 0);
        writeUint16LE(cv, 36, 0);
        writeUint32LE(cv, 38, 0);
        writeUint32LE(cv, 42, entry.offset);

        chunks.push(new Uint8Array(central), entry.nameBytes);
        offset += 46 + entry.nameBytes.length;
    }
    const centralSize = offset - centralStart;

    const end = new ArrayBuffer(22);
    const ev = new DataView(end);
    writeUint32LE(ev, 0, 0x06054b50);
    writeUint16LE(ev, 4, 0);
    writeUint16LE(ev, 6, 0);
    writeUint16LE(ev, 8, centralEntries.length);
    writeUint16LE(ev, 10, centralEntries.length);
    writeUint32LE(ev, 12, centralSize);
    writeUint32LE(ev, 16, centralStart);
    writeUint16LE(ev, 20, 0);
    chunks.push(new Uint8Array(end));

    return new Blob(chunks, { type: 'application/zip' });
}

// files({name, bytes})를 ZIP으로 묶어 바로 다운로드시킨다.
export async function downloadFilesAsZip(files, filename) {
    const blob = await buildZipAsync(files);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
}
