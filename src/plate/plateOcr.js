// 번호판 조회 모드 — Tesseract.js(WASM, CDN 로드) 기반 OCR 래퍼.
// 클라이언트에서만 실행되고 이미지가 어디로도 전송되지 않는다 — 프로젝트 전체의
// "서버 없음" 원칙을 이 기능에도 그대로 적용한다.
//
// 실측(2026-09-19, 사용자가 정지 차량 번호판 "389우4244"로 30회 테스트): 크롭 자체는
// 대부분(30장 중 다수) 번호판이 선명하게 잡혔는데도 OCR 결과는 30건 전부 엉뚱한
// 글자였다 — 즉 문제는 "번호판을 못 찾는 것"이 아니라 "찾은 번호판을 못 읽는 것"으로
// 확인됨. 원인으로 추정되는 두 가지를 반영: (1) 전처리 없이 원본 색상 그대로
// Tesseract에 넣고 있었다 — 옛날 사내 프로토타입(project_pytesseract.py)도 이진화
// (흑백 임계값) 후 OCR을 돌렸는데 그 단계가 빠져 있었다. (2) 페이지 분할 모드를
// 지정 안 해서 Tesseract가 일반 문서로 가정하고 레이아웃을 분석하려 했다 — 번호판처럼
// 한 줄짜리 큰 글자에는 안 맞는 모드.
const PLATE_CHAR_WHITELIST = '0123456789가나다라마거너더러머버서어저고노도로모보소오조구누두루무부수우주하허호배육해공';

// Otsu 방법으로 그레이스케일 이미지의 최적 이진화 임계값을 구한다 — 조명이 매번
// 다르므로 고정 임계값보다 안정적이다.
function otsuThreshold(grayHistogram, totalPixels) {
    let sumAll = 0;
    for (let i = 0; i < 256; i++) sumAll += i * grayHistogram[i];

    let sumB = 0, wB = 0, maxVariance = 0, threshold = 128;
    for (let t = 0; t < 256; t++) {
        wB += grayHistogram[t];
        if (wB === 0) continue;
        const wF = totalPixels - wB;
        if (wF === 0) break;

        sumB += t * grayHistogram[t];
        const mB = sumB / wB;
        const mF = (sumAll - sumB) / wF;
        const variance = wB * wF * (mB - mF) * (mB - mF);
        if (variance > maxVariance) {
            maxVariance = variance;
            threshold = t;
        }
    }
    return threshold;
}

// 크롭 canvas를 그레이스케일 + Otsu 이진화한 새 canvas로 변환한다.
// 번호판은 밝은 바탕에 어두운 글자(또는 그 반대)라 이진화하면 Tesseract의 글자
// 분리가 훨씬 쉬워진다 — 옛 프로토타입의 cv2.threshold 단계를 그대로 재현.
function binarize(canvas) {
    const ctx = canvas.getContext('2d');
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const { data, width, height } = imageData;

    const gray = new Uint8ClampedArray(width * height);
    const histogram = new Array(256).fill(0);
    for (let i = 0, p = 0; i < data.length; i += 4, p++) {
        const g = Math.round(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
        gray[p] = g;
        histogram[g]++;
    }

    const threshold = otsuThreshold(histogram, width * height);

    // otsuThreshold의 wB는 "값이 threshold 이하인 픽셀"을 배경으로 누적하므로,
    // 여기서도 같은 기준(<=는 배경/검정, >는 전경/흰색)으로 나눠야 앞뒤가 맞는다.
    // (>=로 나누면 threshold와 정확히 같은 값의 군집이 통째로 반대쪽으로 넘어가는
    // 버그가 생김 — 단위 테스트로 확인됨)
    for (let i = 0, p = 0; i < data.length; i += 4, p++) {
        const v = gray[p] > threshold ? 255 : 0;
        data[i] = data[i + 1] = data[i + 2] = v;
    }

    const out = document.createElement('canvas');
    out.width = width;
    out.height = height;
    out.getContext('2d').putImageData(imageData, 0, 0);
    return out;
}

export class PlateOcr {
    constructor() {
        this.worker = null;
    }

    async load() {
        this.worker = await Tesseract.createWorker('kor');
        await this.worker.setParameters({
            tessedit_char_whitelist: PLATE_CHAR_WHITELIST,
            // PSM 7 = 한 줄짜리 텍스트로 가정 (번호판 레이아웃에 맞춤, 일반 문서 레이아웃
            // 분석을 시도하지 않게 함)
            tessedit_pageseg_mode: '7'
        });
    }

    // canvas/이미지 요소에서 텍스트를 추출해 그대로 반환 (정규화는 plateMatcher.js 담당)
    async recognize(canvasOrImage) {
        const preprocessed = binarize(canvasOrImage);
        const { data } = await this.worker.recognize(preprocessed);
        return data.text || '';
    }

    async dispose() {
        if (this.worker) {
            await this.worker.terminate();
            this.worker = null;
        }
    }
}
