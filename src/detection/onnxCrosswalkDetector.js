// 횡단보도 + 신호등 색 검출 (YOLOv8n, Ssevinc/assistive-vision-ai 원본 —
// models/NOTICE.md 참고: 모델·코드 MIT, 학습 데이터 CC BY 4.0).
// COCO-SSD는 애초에 "횡단보도" 클래스가 없어 새 모델이 필요했다. 신호등 색은
// 기존 trafficLightColor.js(HSV 히스토그램)와 별도 경로로 이 모델도 같이
// 판정해, 한쪽이 놓쳐도 다른 쪽이 잡을 수 있게 한다(detectionManager.js에서
// 기존 COCO-SSD 'traffic light' 박스와 겹치면 중복 추가하지 않음).
//
// 원본 8개 클래스 중 crosswalk·red_light·yellow_light·green_light만 쓴다 —
// stairs는 이 모델이 방향 구분 없이 "계단 있음"만 판정하고, seating/shelter/
// trash_can은 SafeWalk 위협 분류에 아직 안 쓰여서 이번 스코프에서 뺐다
// (2026-09-26, "횡단보도부터" 결정).
import { frameToCHWTensor, greedyNMS, parseYoloOutput, loadOnnxSession } from '../plate/onnxModels.js';

const INPUT_SIZE = 640;
const CONFIDENCE_THRESHOLD = 0.5;
const NMS_THRESHOLD = 0.5;
const MODEL_URL = './models/crosswalk_scene.onnx';

// data.yaml의 클래스 순서 그대로(알파벳순) — 학습된 인덱스와 반드시 일치해야 함.
const CLASSES = ['crosswalk', 'green_light', 'red_light', 'seating', 'shelter', 'stairs', 'trash_can', 'yellow_light'];
const LIGHT_COLOR_BY_CLASS = { red_light: 'red', yellow_light: 'yellow', green_light: 'green' };

export class OnnxCrosswalkDetector {
    constructor() {
        this.session = null;
        this.inputName = null;
    }

    async load() {
        this.session = await loadOnnxSession(MODEL_URL);
        this.inputName = this.session.inputNames[0];
    }

    // video의 현재 프레임에서 횡단보도/신호등 박스를 전부 찾는다.
    // 반환: detectionManager의 predictions 배열과 같은 형태 — { class, score, bbox: [x,y,w,h] },
    // 신호등은 기존 COCO-SSD 경로와 동일하게 trafficLightColor 필드를 얹어서 반환한다.
    async detect(video) {
        if (!this.session || !video.videoWidth) return [];

        const chw = frameToCHWTensor(video, INPUT_SIZE);
        const inputTensor = new ort.Tensor('float32', chw, [1, 3, INPUT_SIZE, INPUT_SIZE]);
        const results = await this.session.run({ [this.inputName]: inputTensor });
        const output = results[Object.keys(results)[0]];

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
        const predictions = [];
        for (const o of kept) {
            const className = CLASSES[o.cls];
            if (className !== 'crosswalk' && !(className in LIGHT_COLOR_BY_CLASS)) continue;

            const { left, top, right, bottom } = o.box;
            const bbox = [
                left * video.videoWidth,
                top * video.videoHeight,
                (right - left) * video.videoWidth,
                (bottom - top) * video.videoHeight
            ];

            if (className === 'crosswalk') {
                predictions.push({ class: 'crosswalk', score: o.conf, bbox });
            } else {
                predictions.push({
                    class: 'traffic light',
                    score: o.conf,
                    bbox,
                    trafficLightColor: LIGHT_COLOR_BY_CLASS[className]
                });
            }
        }
        return predictions;
    }

    async dispose() {
        if (this.session) {
            await this.session.release();
            this.session = null;
        }
    }
}
