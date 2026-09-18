// 번호판 조회 모드 — Tesseract.js(WASM, CDN 로드) 기반 OCR 래퍼.
// 클라이언트에서만 실행되고 이미지가 어디로도 전송되지 않는다 — 프로젝트 전체의
// "서버 없음" 원칙을 이 기능에도 그대로 적용한다.
//
// 정확도는 검증되지 않았다 (2026-09-19 시점): 한국 번호판 특화 모델이 아니라 범용
// 한국어 OCR을 쓰고 있어, 실기기 실측 전까지는 프로토타입 수준으로 취급해야 한다.
const PLATE_CHAR_WHITELIST = '0123456789가나다라마거너더러머버서어저고노도로모보소오조구누두루무부수우주하허호배육해공';

export class PlateOcr {
    constructor() {
        this.worker = null;
    }

    async load() {
        this.worker = await Tesseract.createWorker('kor');
        await this.worker.setParameters({
            tessedit_char_whitelist: PLATE_CHAR_WHITELIST
        });
    }

    // canvas/이미지 요소에서 텍스트를 추출해 그대로 반환 (정규화는 plateMatcher.js 담당)
    async recognize(canvasOrImage) {
        const { data } = await this.worker.recognize(canvasOrImage);
        return data.text || '';
    }

    async dispose() {
        if (this.worker) {
            await this.worker.terminate();
            this.worker = null;
        }
    }
}
