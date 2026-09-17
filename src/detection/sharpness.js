// 크롭 선명도 추정 — "분산-오브-라플라시안"(variance of Laplacian) 방식.
// 걷는 중 캡처한 미지 객체 크롭이 손떨림/보행 흔들림으로 블러가 심해 라벨링
// 큐 품질이 낮았던 문제(2026-09-16/18 실측) 대응. 값이 낮을수록 흐릿함.
export function estimateSharpness(imageData) {
    const { data, width, height } = imageData;

    const gray = new Float32Array(width * height);
    for (let i = 0; i < width * height; i++) {
        const o = i * 4;
        gray[i] = (data[o] + data[o + 1] + data[o + 2]) / 3;
    }

    let sum = 0;
    let sumSq = 0;
    let count = 0;

    for (let y = 1; y < height - 1; y++) {
        for (let x = 1; x < width - 1; x++) {
            const i = y * width + x;
            // 4-이웃 라플라시안 근사 — 경계(에지)가 뚜렷할수록 값이 크게 튄다
            const lap = 4 * gray[i] - gray[i - 1] - gray[i + 1] - gray[i - width] - gray[i + width];
            sum += lap;
            sumSq += lap * lap;
            count++;
        }
    }

    if (count === 0) return 0;
    const mean = sum / count;
    return sumSq / count - mean * mean; // 분산
}
