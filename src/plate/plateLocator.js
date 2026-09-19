// 번호판 조회 모드 — 화면 안에서 번호판처럼 생긴 영역을 실시간으로 찾아 안내
// 프레임이 QR 스캐너처럼 번호판 위치·크기를 "따라가게" 한다 (사용자 요청 2026-09-19:
// "아이폰 QR 촬영처럼 프레임이 따라가면 좋겠다").
//
// 정직하게 짚어야 할 한계: QR코드는 고유한 파인더 패턴이 있어 검출이 쉽지만, 번호판은
// "밝은 직사각형 안에 글자가 있다"는 훨씬 약한 신호다. OpenCV 등 검증된 라이브러리
// 없이 순수 Canvas 2D로 짠 휴리스틱이라, 실제 정확도는 검증 전이다 — 그래서 이 트래킹은
// 프레임 위치를 "보조"만 하고, 최종 캡처는 여전히 사용자가 직접 확인 후 누른다
// (자동 캡처로 바로 가지 않음, 2026-09-19 사용자 지시: "추가 기능은 인식률이 확보된
// 후에 진행").
//
// 방식: 작은 해상도로 축소한 프레임에서 Sobel 에지 강도 맵을 만들고, 적분영상
// (integral image)으로 여러 크기·위치의 후보 사각형(번호판 근사 비율)의 에지 밀도를
// O(1)에 평가한다 — 너무 낮으면(빈 벽/도로) 번호판이 아니고, 너무 높으면(나뭇잎·자갈
// 등 텍스처 배경) 번호판이 아니라고 보고 중간 범위를 선호한다.
const WORK_WIDTH = 176; // 작업 해상도 — 낮을수록 빠르지만 작거나 먼 번호판은 놓치기 쉬움
const ASPECT_RATIO = 2.8; // 번호판 근사 가로:세로 (plateScanManager.js의 가이드 프레임과 동일)

function toGrayscale(imageData) {
    const { data, width, height } = imageData;
    const gray = new Float32Array(width * height);
    for (let i = 0, p = 0; i < data.length; i += 4, p++) {
        gray[p] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    }
    return gray;
}

function edgeMagnitude(gray, width, height) {
    const mag = new Float32Array(width * height);
    for (let y = 1; y < height - 1; y++) {
        for (let x = 1; x < width - 1; x++) {
            const i = y * width + x;
            const gx = gray[i - width - 1] - gray[i - width + 1]
                + 2 * gray[i - 1] - 2 * gray[i + 1]
                + gray[i + width - 1] - gray[i + width + 1];
            const gy = gray[i - width - 1] + 2 * gray[i - width] + gray[i - width + 1]
                - gray[i + width - 1] - 2 * gray[i + width] - gray[i + width + 1];
            mag[i] = Math.sqrt(gx * gx + gy * gy);
        }
    }
    return mag;
}

// 적분영상 — 임의 사각형 안의 합을 O(1)에 구하기 위한 전처리 (Viola-Jones류 기법)
function buildIntegral(values, width, height) {
    const stride = width + 1;
    const integral = new Float64Array(stride * (height + 1));
    for (let y = 0; y < height; y++) {
        let rowSum = 0;
        for (let x = 0; x < width; x++) {
            rowSum += values[y * width + x];
            integral[(y + 1) * stride + (x + 1)] = integral[y * stride + (x + 1)] + rowSum;
        }
    }
    return integral;
}

function rectSum(integral, width, x, y, w, h) {
    const stride = width + 1;
    const x2 = x + w, y2 = y + h;
    return integral[y2 * stride + x2] - integral[y * stride + x2]
        - integral[y2 * stride + x] + integral[y * stride + x];
}

// video의 현재 프레임에서 가장 번호판다운 사각형 영역을 찾는다.
// 반환: { x, y, w, h, score }(네이티브 video 픽셀 좌표) 또는 못 찾으면 null.
export function locatePlateRegion(video) {
    if (!video.videoWidth) return null;

    const workHeight = Math.max(1, Math.round(WORK_WIDTH * (video.videoHeight / video.videoWidth)));
    const canvas = document.createElement('canvas');
    canvas.width = WORK_WIDTH;
    canvas.height = workHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0, WORK_WIDTH, workHeight);
    const imageData = ctx.getImageData(0, 0, WORK_WIDTH, workHeight);

    const gray = toGrayscale(imageData);
    const edges = edgeMagnitude(gray, WORK_WIDTH, workHeight);
    const integral = buildIntegral(edges, WORK_WIDTH, workHeight);

    let best = null;
    let bestScore = -Infinity;

    for (let wFrac = 0.22; wFrac <= 0.7; wFrac += 0.08) {
        const w = Math.round(WORK_WIDTH * wFrac);
        const h = Math.round(w / ASPECT_RATIO);
        if (h < 6 || h >= workHeight) continue;

        const strideX = Math.max(2, Math.round(w / 5));
        const strideY = Math.max(2, Math.round(h / 3));

        for (let y = 0; y + h < workHeight; y += strideY) {
            for (let x = 0; x + w < WORK_WIDTH; x += strideX) {
                const sum = rectSum(integral, WORK_WIDTH, x, y, w, h);
                const density = sum / (w * h);

                // 8~60 사이를 선호(빈 배경도 아니고 텍스처 잡음도 아닌 "글자스러운" 밀도),
                // 28 근처를 정점으로 완만하게 감점
                const score = (density > 8 && density < 60)
                    ? density - Math.abs(density - 28) * 0.3
                    : -1;

                if (score > bestScore) {
                    bestScore = score;
                    best = { x, y, w, h };
                }
            }
        }
    }

    if (!best || bestScore < 8) return null;

    const scaleX = video.videoWidth / WORK_WIDTH;
    const scaleY = video.videoHeight / workHeight;
    return {
        x: best.x * scaleX,
        y: best.y * scaleY,
        w: best.w * scaleX,
        h: best.h * scaleY,
        score: bestScore
    };
}
