// 기둥 게이트 — COCO-SSD가 아예 모르는 "길고 가는 수직 구조물"(전봇대·기둥·가로등 지주 등)을
// 학습 데이터 없이 감지하는 기하학적 휴리스틱. motionGate(looming, 접근 중일 때만)와 달리
// 접근 여부와 무관하게(스쳐 지나가거나 가만히 서 있어도) 항상 동작한다 — 사용자 피드백
// (2026-09-17): "전봇대·기둥 인식률 낮음"에 대응해 추가.
//
// 원리(class-agnostic): 작은 그리드로 다운샘플 → 그레이스케일 → 열(column)별로 좌우 이웃 밝기
// 차이(가로 방향 그래디언트 = 수직 경계 강도)를 본다. 전봇대/기둥은 배경과 뚜렷한 밝기 경계를
// 만들고 그 경계가 화면 세로로 길게 끊김 없이 이어진다는 특징이 있다 — 그 "길게 이어진 수직
// 경계"만으로 존재를 추정한다("기둥"이라 확신하는 게 아니라 "수직 구조물 있음" 정도의 신호).
//
// 한계: 사람 다리, 가로수 줄기, 건물 모서리 등도 비슷한 신호를 낼 수 있다 — 그래서 위협도는
// 낮게 잡고(threatLevels.pole), COCO-SSD가 이미 그 위치를 설명(bboxOverlaps)하면 추가하지
// 않는다(detectionManager.runStage2). 정밀 분류가 아니라 "여기 뭔가 있다"는 안전망이 목적.
export class PoleGate {
    constructor(video, options = {}) {
        this.video = video;

        // 다운샘플 해상도 — motionGate(32x24)보다 가로를 조금 더 촘촘히 잡아
        // 좁은 기둥과 넓은 배경을 구분한다. 그래도 여전히 매우 저비용.
        this.gridWidth = options.gridWidth || 48;
        this.gridHeight = options.gridHeight || 32;

        this.edgeThreshold = options.edgeThreshold ?? 28; // 그레이스케일 좌우 차분 임계값(0-255)
        this.minRunRatio = options.minRunRatio ?? 0.7; // 화면 세로의 이 비율 이상 끊김없이 이어져야 후보
        this.maxGapCells = options.maxGapCells ?? 1; // 이 칸 이하의 끊김(전선 가림 등)은 이어진 것으로 인정
        this.centerRatioW = options.centerRatioW ?? 0.8; // 화면 맨 가장자리(주변시야)는 제외
        this.requiredStreak = options.requiredStreak ?? 5; // 연속 몇 회 충족해야 확정(단일 프레임 노이즈 억제)
        // 실기기 실측(2026-09-18)에서 위험감지가 초당 ~1회씩 터지는 심각한 오탐이 확인됨.
        // 원인: "매 프레임 어딘가에 후보가 있다"는 사실만으로 streak을 쌓아서, 매번 다른
        // 문틀/나무줄기/그림자 경계를 이어 붙여 streak이 사실상 절대 0으로 안 돌아갔다.
        // 같은 물체(=비슷한 x 위치)가 연속으로 잡혀야만 streak을 쌓도록 위치 연속성을 요구한다.
        this.positionToleranceCells = options.positionToleranceCells ?? 2;
        this._streak = 0;
        this._lastBestX = null;

        this.canvas = document.createElement('canvas');
        this.canvas.width = this.gridWidth;
        this.canvas.height = this.gridHeight;
        this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    }

    // 일정 주기로 호출됨(주기는 detectionManager가 제어) — motionGate와 동일하게
    // 비디오→캔버스 리드백 비용 때문에 매 rAF가 아니라 샘플링 주기로 제한한다.
    update() {
        if (!this.video || this.video.readyState < 2 || !this.video.videoWidth) {
            return { detected: false, bbox: null };
        }

        this.ctx.drawImage(this.video, 0, 0, this.gridWidth, this.gridHeight);
        const frame = this.ctx.getImageData(0, 0, this.gridWidth, this.gridHeight).data;

        const gray = new Float32Array(this.gridWidth * this.gridHeight);
        for (let i = 0; i < gray.length; i++) {
            const o = i * 4;
            gray[i] = (frame[o] + frame[o + 1] + frame[o + 2]) / 3;
        }

        const marginW = Math.round((this.gridWidth * (1 - this.centerRatioW)) / 2);
        let best = null; // { x, runLength, y0, y1 }

        for (let x = marginW + 1; x < this.gridWidth - marginW - 1; x++) {
            let runLength = 0;
            let runStartY = 0;
            let gap = 0;
            let bestRun = 0;
            let bestY0 = 0;
            let bestY1 = 0;

            for (let y = 0; y < this.gridHeight; y++) {
                const i = y * this.gridWidth + x;
                // 좌우 이웃 픽셀 차분 — 세로로 뻗은 밝기 경계일수록 이 값이 크다
                const grad = Math.abs(gray[i - 1] - gray[i + 1]);

                if (grad > this.edgeThreshold) {
                    if (runLength === 0) runStartY = y;
                    runLength++;
                    gap = 0;
                } else if (runLength > 0 && gap < this.maxGapCells) {
                    // 짧은 끊김은 허용하고 이어지는 것으로 취급
                    gap++;
                    runLength++;
                } else {
                    if (runLength > bestRun) {
                        bestRun = runLength;
                        bestY0 = runStartY;
                        bestY1 = y - 1;
                    }
                    runLength = 0;
                    gap = 0;
                }
            }
            if (runLength > bestRun) {
                bestRun = runLength;
                bestY0 = runStartY;
                bestY1 = this.gridHeight - 1;
            }

            if (bestRun >= this.gridHeight * this.minRunRatio && (!best || bestRun > best.runLength)) {
                best = { x, runLength: bestRun, y0: bestY0, y1: bestY1 };
            }
        }

        // 이번 프레임 후보가 직전 프레임 후보와 비슷한 x 위치일 때만 같은 물체로
        // 보고 streak을 잇는다. 위치가 크게 다르면(=다른 경계를 우연히 주움)
        // streak을 1부터 다시 시작 — "아무 후보나 있으면 OK"였던 버그 수정.
        if (best) {
            const samePosition = this._lastBestX !== null &&
                Math.abs(best.x - this._lastBestX) <= this.positionToleranceCells;
            this._streak = samePosition ? this._streak + 1 : 1;
            this._lastBestX = best.x;
        } else {
            this._streak = 0;
            this._lastBestX = null;
        }
        const detected = this._streak >= this.requiredStreak;

        let bbox = null;
        if (detected && best) {
            const scaleX = this.video.videoWidth / this.gridWidth;
            const scaleY = this.video.videoHeight / this.gridHeight;
            // 감지된 건 경계선 1개 열뿐이라 실제 폭보다 좁게 잡힌다 — 시각화·위협판정용으로
            // 좌우에 약간 여유(패딩)를 둔다.
            const padX = 1.5 * scaleX;
            bbox = [
                Math.max(0, best.x * scaleX - padX),
                best.y0 * scaleY,
                2 * padX,
                (best.y1 - best.y0 + 1) * scaleY
            ];
        }

        return { detected, bbox, streak: this._streak };
    }

    reset() {
        this._streak = 0;
        this._lastBestX = null;
    }
}
