// 번호판 조회 모드 — CSV 파싱 + 정규화 + 매칭 (관리자 도구, 2026-09-19).
// 서버 없음: CSV는 기기 로컬(IndexedDB)에만 저장되고 어디로도 전송되지 않는다.
// 이 파일은 테스트/파일럿용 예시 데이터 취급을 전제로 한다 — 실제 지자체 체납자
// 개인정보를 다루려면 별도 법무 검토가 선행되어야 한다 (제안서 §6 참고).

// 한국 번호판에 실제 쓰이는 한글 음절만 화이트리스트로 남긴다 (오인식 방지 + OCR
// char whitelist와 동일 문자셋 사용 목적)
const PLATE_HANGUL = '가나다라마거너더러머버서어저고노도로모보소오조구누두루무부수우주하허호배육해공';

// 공백/하이픈 등 OCR 잡음을 제거하고 대조 가능한 형태로 정규화한다.
export function normalizePlate(raw) {
    if (!raw) return '';
    return raw
        .replace(/[\s\-·.]/g, '')
        .replace(new RegExp(`[^0-9${PLATE_HANGUL}]`, 'g'), '')
        .trim();
}

// 아주 단순한 CSV 파서 — 첫 컬럼=번호판, 둘째 컬럼(선택)=비고.
// 따옴표로 감싼 필드의 콤마는 고려하지 않는다(체납차량 목록처럼 단순 2열 CSV 전제).
export function parsePlateCsv(text) {
    const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const records = [];
    for (const line of lines) {
        const [plateRaw, ...rest] = line.split(',');
        const plate = normalizePlate(plateRaw);
        if (!plate) continue;
        // 헤더 행("번호판", "plate" 등)은 숫자가 하나도 없으면 걸러진다
        if (!/[0-9]/.test(plate)) continue;
        records.push({ plate, note: rest.join(',').trim() });
    }
    return records;
}

// 편집거리 1 이하인지만 빠르게 판정 (OCR 한 글자 오차 정도만 "확인 필요"로 허용 —
// 그 이상 차이나는 건 다른 차량일 가능성이 높아 매칭에서 제외).
function withinEditDistanceOne(a, b) {
    if (a === b) return true;
    const lenDiff = Math.abs(a.length - b.length);
    if (lenDiff > 1) return false;

    if (a.length === b.length) {
        let diff = 0;
        for (let i = 0; i < a.length; i++) {
            if (a[i] !== b[i]) diff++;
            if (diff > 1) return false;
        }
        return diff === 1;
    }

    // 길이가 1 다른 경우 — 짧은 쪽 기준으로 한 글자 삽입/삭제로 맞춰지는지 확인
    const [shorter, longer] = a.length < b.length ? [a, b] : [b, a];
    for (let skip = 0; skip < longer.length; skip++) {
        let ok = true;
        for (let i = 0, j = 0; i < shorter.length; i++, j++) {
            if (j === skip) j++;
            if (shorter[i] !== longer[j]) { ok = false; break; }
        }
        if (ok) return true;
    }
    return false;
}

// ocrText를 체납차량 목록과 대조한다.
// 반환: { plate, note, matchType: 'exact'|'fuzzy' } | null
export function findMatch(ocrText, plateList) {
    const normalized = normalizePlate(ocrText);
    if (!normalized || normalized.length < 4) return null; // 너무 짧으면 오인식 가능성이 높음

    for (const entry of plateList) {
        if (entry.plate === normalized) {
            return { plate: entry.plate, note: entry.note, matchType: 'exact' };
        }
    }
    for (const entry of plateList) {
        if (withinEditDistanceOne(entry.plate, normalized)) {
            return { plate: entry.plate, note: entry.note, matchType: 'fuzzy' };
        }
    }
    return null;
}
