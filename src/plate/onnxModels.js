// 번호판 조회 모드 — VRPDetectorKOR(HK416, MIT License)의 학습된 YOLOv8 ONNX 모델
// 2개를 그대로 재사용한다: (1) 번호판 위치 검출, (2) 번호판 글자 검출.
// 원본: https://github.com/HK416/VRPDetectorKOR (MIT) — 전처리/후처리 방식(입력 크기,
// 정규화, NMS, 클래스 순서)은 그 저장소의 PlateDetectPass.kt/NumberDetectPass.kt를
// 그대로 이식했다. 실측(2026-09-20)으로 확인된 사실: Tesseract.js는 AI Hub 공식
// 번호판 데이터셋 300장 중 정확 일치 2.7%에 그쳤다(한글 글자 인식이 특히 약함) —
// 촬영 조건이 아니라 범용 OCR 자체의 한계였다. 번호판 전용으로 학습된 이 모델들이
// 그 문제를 실제로 해결하는지는 여전히 실기기 검증이 필요하다.
//
// onnxruntime-web(CDN)을 사용 — 이 프로젝트의 "서버 없음, 클라이언트에서만 추론"
// 원칙을 그대로 유지한다.

// video/canvas 프레임을 size×size로 비율 무시하고 늘려서 CHW, [0,1] 정규화된
// Float32Array로 변환한다 (PlateDetectPass.kt의 bitmapToFloatBuffer와 동일 방식 —
// letterbox 없이 그냥 늘림).
export function frameToCHWTensor(source, size) {
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(source, 0, 0, size, size);
    const { data } = ctx.getImageData(0, 0, size, size);

    const planeSize = size * size;
    const chw = new Float32Array(3 * planeSize);
    for (let i = 0, p = 0; i < data.length; i += 4, p++) {
        chw[p] = data[i] / 255; // R
        chw[planeSize + p] = data[i + 1] / 255; // G
        chw[2 * planeSize + p] = data[i + 2] / 255; // B
    }
    return chw;
}

function boxArea(box) {
    const w = box.right - box.left;
    const h = box.bottom - box.top;
    return w < 0 || h < 0 ? 0 : w * h;
}

function iou(a, b) {
    const interLeft = Math.max(a.left, b.left);
    const interTop = Math.max(a.top, b.top);
    const interRight = Math.min(a.right, b.right);
    const interBottom = Math.min(a.bottom, b.bottom);
    const interArea = boxArea({ left: interLeft, top: interTop, right: interRight, bottom: interBottom });
    const aArea = boxArea(a);
    const bArea = boxArea(b);
    return interArea / (aArea + bArea - interArea);
}

// PlateDetectPass.kt/NumberDetectPass.kt의 greedyNMS와 동일한 방식 —
// 가장 신뢰도 높은 박스부터 채택하고, IoU가 threshold 이상인 것들을 제거.
export function greedyNMS(objects, threshold = 0.5) {
    const remaining = [...objects];
    const results = [];
    while (remaining.length > 0) {
        remaining.sort((a, b) => b.conf - a.conf);
        const best = remaining.shift();
        results.push(best);
        for (let i = remaining.length - 1; i >= 0; i--) {
            if (iou(best.box, remaining[i].box) >= threshold) {
                remaining.splice(i, 1);
            }
        }
    }
    return results;
}

// YOLOv8 ONNX 출력(무-NMS 형태) 공통 파싱: [1, 4+numClasses, numAnchors] 텐서에서
// 클래스별 최고 신뢰도를 찾아 confidence 임계값을 넘는 박스만 뽑는다.
// (PlateDetectPass.kt/NumberDetectPass.kt의 parseResultTensor와 동일 로직)
export function parseYoloOutput(outputData, dims, confidenceThreshold) {
    const [, numChannels, numAnchors] = dims; // [1, 4+numClasses, numAnchors]
    const numClasses = numChannels - 4;
    const objects = [];

    for (let k = 0; k < numAnchors; k++) {
        let cls = -1;
        let conf = 0;
        for (let j = 4; j < numChannels; j++) {
            const v = outputData[j * numAnchors + k];
            if (v > conf) {
                conf = v;
                cls = j - 4;
            }
        }
        if (conf >= confidenceThreshold && cls !== -1) {
            const cx = outputData[0 * numAnchors + k];
            const cy = outputData[1 * numAnchors + k];
            const w = outputData[2 * numAnchors + k];
            const h = outputData[3 * numAnchors + k];
            objects.push({
                cls,
                conf,
                box: {
                    left: cx - w / 2,
                    top: cy - h / 2,
                    right: cx + w / 2,
                    bottom: cy + h / 2
                }
            });
        }
    }
    return objects;
}

export async function loadOnnxSession(url) {
    return ort.InferenceSession.create(url);
}
