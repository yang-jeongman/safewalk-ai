// 신호등 색 판정 — COCO-SSD가 찾아준 'traffic light' 박스 안에서 켜져 있는
// (밝고 채도 높은) 램프의 색을 찾는다. 원래 특허 구상(3. 제어 및 적응 알고리즘
// 기록.txt)에 있던 "빨간불 경고 / 초록불 안내"를 구현한다.
// COCO-SSD가 신호등 자체는 이미 잘 찾아주므로 새 탐지 모델은 필요 없고,
// 크롭한 영역의 픽셀 색상 히스토그램만 분석하면 된다 — 매우 저비용.
//
// 2026-09-17: "거리가 멀어도 신호등 색 구분돼야 한다" 대응 — 먼 신호등은 원본 bbox가
// 원래 작아서(픽셀 수 자체가 적음) 절대 개수 기준으로는 항상 minPixels 미달이 되기
// 쉬웠다. 호출 쪽(detectionManager)에서 원본 bbox 면적을 sourceArea로 넘겨주면,
// 원본이 작을수록 판정 기준(최소 픽셀 수·채도/명도 하한)을 비례해서 완화한다.
export function classifyTrafficLightColor(imageData, options = {}) {
    const { data, width, height } = imageData;
    const sourceArea = options.sourceArea ?? Infinity; // 비디오 원본상 bbox 픽셀 면적(w*h)

    // 원본이 작을수록(=멀수록) 판정을 관대하게. 40x40px(=1600) 이상이면 기본 기준 그대로,
    // 그보다 작아질수록 선형으로 완화하되 과도한 오탐을 막기 위해 하한을 둔다.
    const smallness = Math.max(0, Math.min(1, 1 - sourceArea / 1600));
    const vThreshold = 0.55 - smallness * 0.12; // 최저 0.43
    const sThreshold = 0.35 - smallness * 0.12; // 최저 0.23
    const minFraction = 0.01 - smallness * 0.006; // 최저 0.004 (0.4%)

    let redCount = 0;
    let yellowCount = 0;
    let greenCount = 0;

    for (let i = 0; i < data.length; i += 4) {
        const { h, s, v } = rgbToHsv(data[i], data[i + 1], data[i + 2]);

        // 켜진 램프만 카운트 — 밝고 채도 높음. 꺼진 램프/검은 하우징은 어둡거나 무채색.
        if (v < vThreshold || s < sThreshold) continue;

        if (h < 18 || h > 345) redCount++;
        else if (h >= 38 && h <= 68) yellowCount++;
        else if (h >= 85 && h <= 160) greenCount++;
    }

    const total = redCount + yellowCount + greenCount;
    const minPixels = Math.max(4, width * height * minFraction); // 노이즈 무시용 최소 픽셀 수
    if (total < minPixels) {
        return { color: null, confidence: 0 };
    }

    const max = Math.max(redCount, yellowCount, greenCount);
    const color = max === redCount ? 'red' : (max === yellowCount ? 'yellow' : 'green');
    return { color, confidence: max / total };
}

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
