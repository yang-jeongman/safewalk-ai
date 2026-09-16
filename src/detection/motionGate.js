// 모션 게이트 (1단계) — 초파리 LPLC2/looming-detector가 풀던 문제의 "구조"를 차용.
// "저게 뭔지"는 모른 채(class-agnostic) 프레임차분만으로 확대율(θ/θ', time-to-collision
// 근사인 tau)을 계산한다. COCO-SSD보다 훨씬 저비용이라 매 프레임 돌려도 부담이 적다.
//
// 안전 원칙(AI_개발위임_브리프.md §3.1): 이 모듈의 출력은 2단계(COCO-SSD) 검사를
// "생략"시키는 데 절대 쓰지 않는다. 오직 검사를 더 앞당기는 가산 용도로만 쓴다 —
// 실제 스케줄링 로직은 detectionManager.js 쪽에 있다.
//
// 실기기 실측(안드로이드, 2026-09-15)에서 드러난 문제 2가지를 반영해 조정함:
// 1) 화면 전체의 움직임량만 보면 손떨림/보행 흔들림에도 "확대"로 계속 오탐한다 —
//    진짜 들이받는 물체는 중심부에서 커지므로, 중심 영역의 움직임만 확대율 계산에 쓴다.
// 2) 단일 샘플 노이즈로 튀는 것을 막기 위해 연속 2회 이상 조건을 만족해야 looming으로 인정.
export class MotionGate {
    constructor(video, options = {}) {
        this.video = video;

        // 다운샘플 해상도 — 작을수록 저비용, 너무 작으면 신호가 뭉개짐
        this.gridWidth = options.gridWidth || 32;
        this.gridHeight = options.gridHeight || 24;

        // 중심 영역(실제 진행 방향과 맞닿는 부분) 비율 — 가로/세로 각각 이 비율만큼만 사용
        this.centerRatioW = options.centerRatioW ?? 0.5;
        this.centerRatioH = options.centerRatioH ?? 0.5;

        this.diffThreshold = options.diffThreshold ?? 18; // 0-255 그레이스케일 차분 임계값
        this.historyWindowMs = options.historyWindowMs ?? 600; // 확대율 계산용 시간창
        this.minAreaRatio = options.minAreaRatio ?? 0.05; // 이보다 작은 움직임은 노이즈로 무시
        // 실기기 실측(iOS, 2026-09-15)에서 상대 증가율(dArea/area)만으로는 기준선이
        // 낮을 때 카메라 노이즈만으로도 "2배 증가"처럼 읽혀 tau가 거의 항상 낮게
        // 나오는 문제가 확인됨. 절대 증가폭 최소치를 추가로 요구해 억제한다.
        this.minAbsoluteGrowth = options.minAbsoluteGrowth ?? 0.03; // 시간창 동안 최소 이만큼 늘어야 함
        this.urgentTau = options.urgentTau ?? 1.0; // 초 단위 — 이보다 작으면 "임박"으로 판단
        this.requiredStreak = options.requiredStreak ?? 2; // 연속 몇 회 충족해야 looming 확정

        this.canvas = document.createElement('canvas');
        this.canvas.width = this.gridWidth;
        this.canvas.height = this.gridHeight;
        this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });

        // 중심 영역 좌표 (그리드 셀 인덱스 기준)
        const marginW = Math.round((this.gridWidth * (1 - this.centerRatioW)) / 2);
        const marginH = Math.round((this.gridHeight * (1 - this.centerRatioH)) / 2);
        this.centerX0 = marginW;
        this.centerX1 = this.gridWidth - marginW;
        this.centerY0 = marginH;
        this.centerY1 = this.gridHeight - marginH;

        this.prevGray = null;
        this.history = []; // { t, area } — 중심 영역 motionRatio
        this._loomingStreak = 0;
    }

    // 일정 주기로 호출됨(호출 빈도는 detectionManager가 제어) — 가볍지만
    // 비디오→캔버스 리드백 자체가 기기별로 비쌀 수 있어 매 rAF마다 부르지 않는다.
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

        let centerMotionCells = 0;
        let centerCellCount = 0;
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        if (this.prevGray) {
            for (let y = 0; y < this.gridHeight; y++) {
                const inCenterRow = y >= this.centerY0 && y < this.centerY1;
                for (let x = 0; x < this.gridWidth; x++) {
                    if (!inCenterRow || x < this.centerX0 || x >= this.centerX1) continue;
                    const i = y * this.gridWidth + x;
                    centerCellCount++;
                    if (Math.abs(gray[i] - this.prevGray[i]) > this.diffThreshold) {
                        centerMotionCells++;
                        if (x < minX) minX = x;
                        if (x > maxX) maxX = x;
                        if (y < minY) minY = y;
                        if (y > maxY) maxY = y;
                    }
                }
            }
        }
        this.prevGray = gray;

        const motionRatio = centerCellCount > 0 ? centerMotionCells / centerCellCount : 0;
        const now = performance.now();
        this.history.push({ t: now, area: motionRatio });
        while (this.history.length > 2 && now - this.history[0].t > this.historyWindowMs) {
            this.history.shift();
        }

        // 확대/움직임이 몰려있는 영역을 비디오 픽셀 좌표 bbox로 변환.
        // COCO-SSD가 박스를 못 만드는 물체(벽/기둥 등)를 위한 "일반 장애물" 폴백용.
        let hotRegionBbox = null;
        if (centerMotionCells > 0 && this.video && this.video.videoWidth) {
            const scaleX = this.video.videoWidth / this.gridWidth;
            const scaleY = this.video.videoHeight / this.gridHeight;
            hotRegionBbox = [
                minX * scaleX,
                minY * scaleY,
                (maxX - minX + 1) * scaleX,
                (maxY - minY + 1) * scaleY
            ];
        }

        return this.computeExpansion(motionRatio, now, hotRegionBbox);
    }

    computeExpansion(motionRatio, now, hotRegionBbox) {
        const result = this._rawExpansion(motionRatio, now, hotRegionBbox);

        // 연속 requiredStreak회 충족해야 최종 looming으로 인정 (단일 샘플 노이즈 억제)
        if (result.rawLooming) {
            this._loomingStreak++;
        } else {
            this._loomingStreak = 0;
        }
        result.looming = this._loomingStreak >= this.requiredStreak;
        if (!result.looming) {
            result.urgency = 0;
            result.hotRegionBbox = null;
        }

        return result;
    }

    _rawExpansion(motionRatio, now, hotRegionBbox) {
        if (this.history.length < 2 || motionRatio < this.minAreaRatio) {
            return { rawLooming: false, looming: false, urgency: 0, motionRatio, tau: Infinity, hotRegionBbox: null };
        }

        const oldest = this.history[0];
        const dt = (now - oldest.t) / 1000; // 초
        const dArea = motionRatio - oldest.area;

        // 절대 증가폭이 충분하지 않으면(=노이즈 수준) looming 후보에서 제외.
        // 기준선이 작을 때 상대 증가율만으로 판단하면 노이즈에도 쉽게 흔들린다.
        if (dt <= 0 || dArea < this.minAbsoluteGrowth) {
            return { rawLooming: false, looming: false, urgency: 0, motionRatio, tau: Infinity, hotRegionBbox: null };
        }

        // tau ≈ area / (dArea/dt) — LPLC2가 근사하는 time-to-collision과 같은 형태(θ/θ')
        const growthRate = dArea / dt;
        const tau = motionRatio / growthRate;

        const rawLooming = tau < this.urgentTau;
        const urgency = rawLooming ? Math.min(1, 1 - tau / this.urgentTau) : 0;

        return { rawLooming, looming: rawLooming, urgency, motionRatio, tau, hotRegionBbox };
    }

    reset() {
        this.prevGray = null;
        this.history = [];
        this._loomingStreak = 0;
    }
}
