// 번호판 위치 검출 (YOLOv8n, VRPDetectorKOR 원본 MIT 라이선스 — onnxModels.js 상단
// 설명 참고). 입력 640×640, 클래스 1개("번호판"), confidence 임계값·NMS는 원본
// PlateDetectPass.kt 값을 그대로 따른다.
import { frameToCHWTensor, greedyNMS, parseYoloOutput, loadOnnxSession } from './onnxModels.js';

const INPUT_SIZE = 640;
const CONFIDENCE_THRESHOLD = 0.65;
const NMS_THRESHOLD = 0.5;
const MODEL_URL = './models/plate_detect.onnx';

export class OnnxPlateDetector {
    constructor() {
        this.session = null;
        this.inputName = null;
    }

    async load() {
        this.session = await loadOnnxSession(MODEL_URL);
        this.inputName = this.session.inputNames[0];
    }

    // video의 현재 프레임에서 가장 신뢰도 높은 번호판 박스를 찾는다.
    // 반환: { x, y, w, h, score }(네이티브 video 픽셀 좌표) 또는 못 찾으면 null —
    // plateLocator.js의 locatePlateRegion()과 동일한 반환 형태라 plateScanManager.js
    // 쪽 사용법은 그대로 유지된다.
    async detect(video) {
        if (!this.session || !video.videoWidth) return null;

        const chw = frameToCHWTensor(video, INPUT_SIZE);
        const inputTensor = new ort.Tensor('float32', chw, [1, 3, INPUT_SIZE, INPUT_SIZE]);
        const results = await this.session.run({ [this.inputName]: inputTensor });
        const output = results[Object.keys(results)[0]];

        // PlateDetectPass.kt: 박스 좌표를 바로 INPUT_SIZE로 나눠 [0,1] 정규화
        // (letterbox 없이 늘려서 넣었으니 원본 비율과 무관하게 그대로 대응됨)
        const objects = parseYoloOutput(output.data, output.dims, CONFIDENCE_THRESHOLD)
            .map(o => ({
                ...o,
                box: {
                    left: Math.max(o.box.left, 0) / INPUT_SIZE,
                    top: Math.max(o.box.top, 0) / INPUT_SIZE,
                    right: Math.min(o.box.right, INPUT_SIZE - 1) / INPUT_SIZE,
                    bottom: Math.min(o.box.bottom, INPUT_SIZE - 1) / INPUT_SIZE
                }
            }));

        const kept = greedyNMS(objects, NMS_THRESHOLD);
        if (kept.length === 0) return null;

        const best = kept.reduce((a, b) => (b.conf > a.conf ? b : a));
        const { left, top, right, bottom } = best.box;
        return {
            x: left * video.videoWidth,
            y: top * video.videoHeight,
            w: (right - left) * video.videoWidth,
            h: (bottom - top) * video.videoHeight,
            score: best.conf
        };
    }

    async dispose() {
        if (this.session) {
            await this.session.release();
            this.session = null;
        }
    }
}
