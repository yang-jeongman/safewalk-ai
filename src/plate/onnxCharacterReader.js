// 번호판 글자 검출 (YOLOv8m, VRPDetectorKOR 원본 MIT 라이선스 — onnxModels.js 상단
// 설명 참고). 입력 416×416, 클래스 51개(숫자 10 + 한글 40 + 빈 클래스 1).
// 원작자 본인이 "한글 인식률이 높지 않다"고 밝힌 모델이지만, 실측(2026-09-20)에서
// Tesseract.js가 같은 공식 데이터셋 300장 기준 정확 일치 2.7%에 그친 것과 비교하면
// 그래도 번호판 전용으로 학습된 이 모델이 나을 가능성이 높아 채택 — 실기기 검증 필요.
import { frameToCHWTensor, greedyNMS, parseYoloOutput, loadOnnxSession } from './onnxModels.js';

const INPUT_SIZE = 416;
const CONFIDENCE_THRESHOLD = 0.65;
const NMS_THRESHOLD = 0.5;
const MODEL_URL = './models/number_detect.onnx';

// NumberDetectPass.kt의 DETECT_CHARS와 동일 순서 — 숫자가 1~9,0 순서인 것에 주의
// (0이 마지막), 마지막 빈 문자열은 "글자 없음" 클래스.
const DETECT_CHARS = [
    '1', '2', '3', '4', '5', '6', '7', '8', '9', '0',
    '가', '나', '다', '라', '마', '거', '너', '더', '러', '머', '버', '서', '어', '저',
    '고', '노', '도', '로', '모', '보', '소', '오', '조',
    '구', '누', '두', '루', '무', '부', '수', '우', '주',
    '아', '바', '사', '자', '배', '허', '하', '호', ''
];

export class OnnxCharacterReader {
    constructor() {
        this.session = null;
        this.inputName = null;
    }

    async load() {
        this.session = await loadOnnxSession(MODEL_URL);
        this.inputName = this.session.inputNames[0];
    }

    // NumberDetectPass.kt의 imageToScaledBitmap과 동일: 번호판 박스 "너비"를 한 변으로
    // 하는 정사각형을, 번호판 세로 중심에 맞춰 잘라낸다(번호판 자체가 아니라 그 주변
    // 맥락까지 포함한 정사각형 — 이 모델이 그렇게 학습됐기 때문).
    computeSquareCrop(plateBox, videoWidth, videoHeight) {
        const width = plateBox.w;
        const halfWidth = width / 2;
        const centerY = plateBox.y + plateBox.h / 2;
        let startY;
        if (centerY - halfWidth > 0) {
            const stopY = Math.min(videoHeight, centerY + halfWidth);
            startY = stopY - width;
        } else {
            startY = Math.max(0, centerY - halfWidth);
        }
        return { x: plateBox.x, y: startY, w: width, h: width };
    }

    // video + 번호판 박스(네이티브 픽셀 좌표, {x,y,w,h})를 받아 인식된 원문 텍스트를
    // 반환한다(정규화는 plateMatcher.js가 담당). 검출된 글자가 없으면 빈 문자열.
    async read(video, plateBox) {
        if (!this.session) return '';

        const crop = this.computeSquareCrop(plateBox, video.videoWidth, video.videoHeight);
        if (crop.w <= 0 || crop.h <= 0) return '';

        const cropCanvas = document.createElement('canvas');
        cropCanvas.width = crop.w;
        cropCanvas.height = crop.h;
        cropCanvas.getContext('2d').drawImage(
            video, crop.x, crop.y, crop.w, crop.h, 0, 0, crop.w, crop.h
        );

        const chw = frameToCHWTensor(cropCanvas, INPUT_SIZE);
        const inputTensor = new ort.Tensor('float32', chw, [1, 3, INPUT_SIZE, INPUT_SIZE]);
        const results = await this.session.run({ [this.inputName]: inputTensor });
        const output = results[Object.keys(results)[0]];

        const objects = parseYoloOutput(output.data, output.dims, CONFIDENCE_THRESHOLD);
        const kept = greedyNMS(objects, NMS_THRESHOLD);

        // MainActivity.kt: sortBy { it.rect.left } — 왼쪽에서 오른쪽 순서로 글자를 나열
        kept.sort((a, b) => a.box.left - b.box.left);

        return kept.map(o => DETECT_CHARS[o.cls] ?? '').join('');
    }

    async dispose() {
        // onnxruntime-web 세션은 release()로 정리 — 재생성 시 메모리 누수 방지
        if (this.session) {
            await this.session.release();
            this.session = null;
        }
    }
}
