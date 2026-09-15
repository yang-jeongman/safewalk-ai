// 모션 게이트 (1단계) — 초파리 LPLC2/looming-detector가 풀던 문제의 "구조"를 차용.
// "저게 뭔지"는 모른 채(class-agnostic) 프레임차분만으로 확대율(θ/θ', time-to-collision
// 근사인 tau)을 계산한다. COCO-SSD보다 훨씬 저비용이라 매 프레임 돌려도 부담이 적다.
//
// 안전 원칙(AI_개발위임_브리프.md §3.1): 이 모듈의 출력은 2단계(COCO-SSD) 검사를
// "생략"시키는 데 절대 쓰지 않는다. 오직 검사를 더 앞당기는 가산 용도로만 쓴다 —
// 실제 스케줄링 로직은 detectionManager.js 쪽에 있다.
export class MotionGate {
    constructor(video, options = {}) {
        this.video = video;

        // 다운샘플 해상도 — 작을수록 저비용, 너무 작으면 신호가 뭉개짐
        this.gridWidth = options.gridWidth || 32;
        this.gridHeight = options.gridHeight || 24;

        this.diffThreshold = options.diffThreshold ?? 18; // 0-255 그레이스케일 차분 임계값
        this.historyWindowMs = options.historyWindowMs ?? 600; // 확대율 계산용 시간창
        this.minAreaRatio = options.minAreaRatio ?? 0.015; // 이보다 작은 움직임은 노이즈로 무시
        this.urgentTau = options.urgentTau ?? 1.2; // 초 단위 — 이보다 작으면 "임박"으로 판단

        this.canvas = document.createElement('canvas');
        this.canvas.width = this.gridWidth;
        this.canvas.height = this.gridHeight;
        this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });

        this.prevGray = null;
        this.history = []; // { t, area }
    }

    // 매 프레임 호출됨 — 반드시 가벼워야 한다.
    update() {
        if (!this.video || this.video.readyState < 2) {
            return { looming: false, urgency: 0, motionRatio: 0, tau: Infinity };
        }

        this.ctx.drawImage(this.video, 0, 0, this.gridWidth, this.gridHeight);
        const frame = this.ctx.getImageData(0, 0, this.gridWidth, this.gridHeight).data;

        const cellCount = this.gridWidth * this.gridHeight;
        const gray = new Uint8ClampedArray(cellCount);
        for (let i = 0; i < cellCount; i++) {
            const o = i * 4;
            gray[i] = (frame[o] + frame[o + 1] + frame[o + 2]) / 3;
        }

        let motionCells = 0;
        if (this.prevGray) {
            for (let i = 0; i < cellCount; i++) {
                if (Math.abs(gray[i] - this.prevGray[i]) > this.diffThreshold) {
                    motionCells++;
                }
            }
        }
        this.prevGray = gray;

        const motionRatio = motionCells / cellCount;
        const now = performance.now();
        this.history.push({ t: now, area: motionRatio });
        while (this.history.length > 2 && now - this.history[0].t > this.historyWindowMs) {
            this.history.shift();
        }

        return this.computeExpansion(motionRatio, now);
    }

    computeExpansion(motionRatio, now) {
        if (this.history.length < 2 || motionRatio < this.minAreaRatio) {
            return { looming: false, urgency: 0, motionRatio, tau: Infinity };
        }

        const oldest = this.history[0];
        const dt = (now - oldest.t) / 1000; // 초
        const dArea = motionRatio - oldest.area;

        if (dt <= 0 || dArea <= 0) {
            return { looming: false, urgency: 0, motionRatio, tau: Infinity };
        }

        // tau ≈ area / (dArea/dt) — LPLC2가 근사하는 time-to-collision과 같은 형태(θ/θ')
        const growthRate = dArea / dt;
        const tau = motionRatio / growthRate;

        const looming = tau < this.urgentTau;
        const urgency = looming ? Math.min(1, 1 - tau / this.urgentTau) : 0;

        return { looming, urgency, motionRatio, tau };
    }

    reset() {
        this.prevGray = null;
        this.history = [];
    }
}
