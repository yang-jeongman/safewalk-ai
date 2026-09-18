// 번호판 배경색 판정 — trafficLightColor.js와 같은 방식(HSV 히스토그램)을 재사용한다.
// 목적 두 가지:
//   (1) OCR을 돌리기 전에 크롭 영역이 번호판다운 단색 배경을 가졌는지 먼저 걸러서,
//       범퍼·그릴 등 엉뚱한 영역에 OCR을 낭비하지 않는다.
//   (2) 매칭 성공 시 "영업용(노란 번호판)"처럼 용도 라벨을 함께 보여준다.
//
// 한국 번호판 색상 체계(2026-09-19, 사용자 제공 참고자료 기준 — 공식 법령 원문 대조는
// 아직 안 함, 실기기 검증 전까지 근사치로 취급):
//   흰색   → 일반 비사업용(자가용·화물차·렌터카)
//   하늘색 → 전기차/수소차(친환경)
//   노란색 → 영업용(택시·버스·택배·영업용화물)
//   연두색 → 고가 법인차(취득가 8천만원 이상)
//   주황색 → 영업용 건설기계(덤프트럭 등)
//   감청색 → 외교용
const COLOR_LABELS = {
    white: '일반',
    blue: '전기차',
    yellow: '영업용',
    lightgreen: '법인차',
    orange: '건설기계(영업용)',
    navy: '외교용'
};

function rgbToHsv(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const d = max - min;

    let h = 0;
    if (d !== 0) {
        if (max === r) h = 60 * (((g - b) / d) % 6);
        else if (max === g) h = 60 * ((b - r) / d + 2);
        else h = 60 * ((r - g) / d + 4);
    }
    if (h < 0) h += 360;

    const s = max === 0 ? 0 : d / max;
    const v = max;
    return { h, s, v };
}

// imageData(번호판 크롭 canvas)에서 배경색을 추정한다.
// 반환: { color, label, confidence } — color는 null이면 "번호판 배경색 같지 않음"(OCR 스킵 신호)
export function classifyPlateColor(imageData) {
    const { data, width, height } = imageData;

    let whiteCount = 0;
    let yellowCount = 0;
    let blueCount = 0;
    let lightGreenCount = 0;
    let orangeCount = 0;
    let navyCount = 0;
    let sampled = 0;

    for (let i = 0; i < data.length; i += 4) {
        const { h, s, v } = rgbToHsv(data[i], data[i + 1], data[i + 2]);
        sampled++;

        // 검정 글자(무채색, 어두움)는 배경색 판정에서 제외
        if (s < 0.12 && v < 0.35) continue;

        if (s < 0.15) {
            // 무채색이면서 밝음 → 흰색 바탕
            if (v > 0.55) whiteCount++;
            continue;
        }

        if (h >= 38 && h <= 68) yellowCount++;
        else if (h >= 15 && h < 38 && v > 0.5) orangeCount++;
        else if (h >= 70 && h <= 150 && v > 0.45) lightGreenCount++;
        else if (h >= 180 && h <= 250) {
            if (v < 0.35) navyCount++; // 어두운 파랑 = 외교용
            else blueCount++; // 밝은 하늘색 = 전기차
        }
    }

    const counts = { white: whiteCount, yellow: yellowCount, blue: blueCount, lightgreen: lightGreenCount, orange: orangeCount, navy: navyCount };
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    const minPixels = Math.max(8, width * height * 0.15); // 배경이 크롭의 상당 부분을 차지해야 함

    if (total < minPixels || sampled === 0) {
        return { color: null, label: null, confidence: 0 };
    }

    const [color, count] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    return { color, label: COLOR_LABELS[color], confidence: count / total };
}
