// 번호판 조회 모드 — 카메라 + COCO-SSD(차량 클래스만) 루프.
// 보행 안전용 DetectionManager(motionGate/poleGate/추적기가 서로 촘촘히 얽혀
// 이미 실기기에서 튜닝된 상태)는 건드리지 않고, 완전히 별도의 가벼운 엔진으로
// 분리한다 — 이 모드의 버그가 보행 안전 기능에 영향을 줄 수 없게 하기 위함.
import { ObjectTracker } from '../detection/objectTracker.js';
import { PlateOcr } from './plateOcr.js';
import { findMatch, normalizePlate } from './plateMatcher.js';
import { classifyPlateColor } from './plateColor.js';
import { debugLogger } from '../utils/debugLogger.js';

const VEHICLE_CLASSES = new Set(['car', 'truck', 'bus']);

export class PlateScanManager {
    constructor() {
        this.video = null;
        this.canvas = null;
        this.ctx = null;
        this.model = null;
        this.ocr = null;
        this.tracker = new ObjectTracker();

        this.isScanning = false;
        this.tickIntervalMs = 400; // 보행 안전용(300ms)보다 느슨 — 실시간 위험 대응이 아니라 순찰 스캔용
        this._timer = null;
        this._animFrameId = null;
        this._lastTracked = []; // 오버레이 애니메이션용 — detect()는 400ms마다만, 그리기는 매 프레임
        this._activeOcrTrackId = null; // 지금 인식 중인 차량(펄스 표시용)

        // 트랙ID별로 한 번만 OCR — 같은 정차/서행 차량을 매 프레임 재스캔하지 않는다
        this._scannedTrackIds = new Set();
        this._ocrInFlight = false;

        // 진단용 주기 로그(보행 안전 모드의 "[성능] stage1=..." 패턴과 동일한 목적).
        // 실측(2026-09-19): 스캔은 켜져 있었는데 차량 감지가 전혀 없었던 구간이 있었지만,
        // 매칭/색상판정처럼 "뭔가 인식 시도가 있었을 때만" 로그가 찍혀서 그 원인이
        // "차량 자체를 못 봤다"인지 "봤는데 번호판만 못 읽었다"인지 구분이 안 됐다.
        // COCO-SSD가 매 틱 몇 대를 보고 있는지 주기적으로 남겨 그 둘을 구분할 수 있게 한다.
        this._lastDiagLogTime = 0;
        this.diagLogIntervalMs = 4000;

        this.plateList = []; // dataManager.getPlateList()에서 로드된 정규화된 목록
        this.onMatch = null; // (match, cropDataUrl) => void — 매칭된 건만 호출됨
        this.onStatus = null; // (text) => void — 화면 상태 텍스트 업데이트용

        // 정확도 테스트 로그용 — 매칭 여부와 무관하게 "번호판다운 영역에서 OCR을
        // 시도했다"는 사실마다 호출됨. app.js가 옵트인 설정을 보고 실제 기록 여부를
        // 결정한다 (기본은 아무 데도 저장 안 함 — 이 콜백을 아무도 구독 안 하면 끝).
        this.onRecognized = null; // ({ text, colorLabel, cropDataUrl }) => void
    }

    setPlateList(list) {
        this.plateList = list;
    }

    async init() {
        this.video = document.getElementById('plateVideoElement');
        this.canvas = document.getElementById('plateCanvasOverlay');
        this.ctx = this.canvas.getContext('2d');

        await this.setupCamera();

        debugLogger.log('[번호판조회] AI 모델 로딩 중...');
        this.model = await cocoSsd.load({ base: 'lite_mobilenet_v2' });

        this.ocr = new PlateOcr();
        await this.ocr.load();
        debugLogger.log('[번호판조회] 초기화 완료');
    }

    async setupCamera() {
        const stream = await navigator.mediaDevices.getUserMedia({
            video: {
                facingMode: 'environment',
                width: { ideal: 1280 },
                height: { ideal: 720 }
            }
        });
        this.video.srcObject = stream;
        return new Promise((resolve) => {
            this.video.onloadedmetadata = () => {
                this.video.play();
                this.canvas.width = this.video.videoWidth;
                this.canvas.height = this.video.videoHeight;
                resolve();
            };
        });
    }

    start() {
        this.isScanning = true;
        this._scannedTrackIds.clear();
        this.tracker.reset();
        this._timer = setInterval(() => this.tick(), this.tickIntervalMs);
        // 오버레이는 detect() 주기(400ms)와 별개로 매 프레임 다시 그려서 펄스 애니메이션이
        // 부드럽게 움직이게 한다 (iOS 카메라의 QR 인식 프레임 효과 참고, 사용자 요청 2026-09-19).
        const animate = () => {
            if (!this.isScanning) return;
            this.drawOverlay(this._lastTracked);
            this._animFrameId = requestAnimationFrame(animate);
        };
        this._animFrameId = requestAnimationFrame(animate);
    }

    stop() {
        this.isScanning = false;
        if (this._timer) {
            clearInterval(this._timer);
            this._timer = null;
        }
        if (this._animFrameId) {
            cancelAnimationFrame(this._animFrameId);
            this._animFrameId = null;
        }
        if (this.video && this.video.srcObject) {
            this.video.srcObject.getTracks().forEach(t => t.stop());
            this.video.srcObject = null;
        }
        if (this.ctx) this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        if (this.ocr) this.ocr.dispose();
    }

    async tick() {
        if (!this.isScanning) return;

        const predictions = await this.model.detect(this.video);
        const vehicles = predictions.filter(p => VEHICLE_CLASSES.has(p.class));
        this._lastTracked = this.tracker.update(vehicles);

        const now = performance.now();
        if (now - this._lastDiagLogTime >= this.diagLogIntervalMs) {
            this._lastDiagLogTime = now;
            // 차량 클래스 전체(vehicles.length)가 아니라 COCO-SSD가 이번 틱에 뭐든
            // 찾긴 했는지(predictions.length)까지 같이 남긴다 — "카메라/모델 자체는
            // 살아있는데 차량만 안 잡히는지" vs "이 틱 자체가 통째로 비었는지" 구분용.
            debugLogger.log(`[번호판조회] 진단: 전체감지=${predictions.length}, 차량=${vehicles.length}`);
        }

        if (!this._ocrInFlight) {
            const candidate = this._lastTracked.find(t => !this._scannedTrackIds.has(t.trackId));
            if (candidate) {
                this._scannedTrackIds.add(candidate.trackId);
                this.runOcr(candidate);
            }
        }
    }

    // 모서리 브래킷("뷰파인더") 스타일 — QR 스캐너처럼 네 귀퉁이만 그려서 카메라가
    // 지금 그 차량을 "잡고 있다"는 느낌을 준다. 상태별로 색/펄스를 다르게 한다:
    //   대기 중(회색) → 인식 중(노란색, 펄스) → 완료(초록색)
    drawCornerBrackets(x, y, w, h, color, bracketLen, lineWidth) {
        const ctx = this.ctx;
        ctx.strokeStyle = color;
        ctx.lineWidth = lineWidth;
        ctx.lineCap = 'round';
        const corners = [
            [[x, y + bracketLen], [x, y], [x + bracketLen, y]],
            [[x + w - bracketLen, y], [x + w, y], [x + w, y + bracketLen]],
            [[x, y + h - bracketLen], [x, y + h], [x + bracketLen, y + h]],
            [[x + w - bracketLen, y + h], [x + w, y + h], [x + w, y + h - bracketLen]]
        ];
        for (const pts of corners) {
            ctx.beginPath();
            ctx.moveTo(pts[0][0], pts[0][1]);
            ctx.lineTo(pts[1][0], pts[1][1]);
            ctx.lineTo(pts[2][0], pts[2][1]);
            ctx.stroke();
        }
    }

    drawOverlay(tracked) {
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        this.ctx.font = '14px sans-serif';

        for (const t of tracked) {
            const [x, y, w, h] = t.bbox;
            const bracketLen = Math.min(w, h) * 0.22;
            const isActive = t.trackId === this._activeOcrTrackId;
            const isDone = this._scannedTrackIds.has(t.trackId) && !isActive;

            let color, label, lineWidth;
            if (isActive) {
                // 펄스: 400~1000ms 주기로 굵기/투명도가 오가며 "지금 읽는 중"을 강조
                const pulse = (Math.sin(performance.now() / 180) + 1) / 2; // 0~1
                lineWidth = 2 + pulse * 2.5;
                color = `rgba(255, 210, 0, ${0.6 + pulse * 0.4})`;
                label = '인식 중...';
            } else if (isDone) {
                color = '#4CAF50';
                label = '완료';
                lineWidth = 2;
            } else {
                color = 'rgba(0, 224, 255, 0.7)';
                label = '대기 중';
                lineWidth = 2;
            }

            this.drawCornerBrackets(x, y, w, h, color, bracketLen, lineWidth);
            this.ctx.fillStyle = color;
            this.ctx.fillText(label, x, y > 16 ? y - 4 : y + h + 16);
        }
    }

    // 차량 bbox 하단부(번호판이 있을 가능성이 높은 영역)를 크롭해 OCR 해상도로 확대.
    // 각도/거리에 따라 부정확할 수 있는 휴리스틱 — 실기기 검증 전까지 정확도 보장 안 함.
    cropPlateRegion(bbox) {
        const [x, y, w, h] = bbox;
        const cropY = y + h * 0.6;
        const cropH = h * 0.4;

        const outW = 320;
        const outH = Math.max(1, Math.round(outW * (cropH / w)));

        const canvas = document.createElement('canvas');
        canvas.width = outW;
        canvas.height = outH;
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(
            this.video,
            Math.max(0, x), Math.max(0, cropY), w, cropH,
            0, 0, outW, outH
        );
        return canvas;
    }

    async runOcr(vehicle) {
        this._ocrInFlight = true;
        this._activeOcrTrackId = vehicle.trackId;
        this.onStatus?.('번호판 위치 확인 중...');
        try {
            const cropCanvas = this.cropPlateRegion(vehicle.bbox);
            const cropCtx = cropCanvas.getContext('2d');
            const imageData = cropCtx.getImageData(0, 0, cropCanvas.width, cropCanvas.height);

            // 번호판 특유의 단색 배경(흰/파랑/노랑/연두/주황/감청)인지 먼저 확인 —
            // 아니면 범퍼·그릴 등 엉뚱한 영역일 가능성이 높아 OCR을 돌리지 않는다.
            // 이 트랙을 "스캔 완료"로 표시하지 않아 다음 틱에 다른 프레임으로 재시도된다.
            const colorInfo = classifyPlateColor(imageData);
            if (!colorInfo.color) {
                this._scannedTrackIds.delete(vehicle.trackId);
                debugLogger.log('[번호판조회] 번호판 영역 아님으로 판단, OCR 생략');
                this.onStatus?.('스캔 중');
                return;
            }

            this.onStatus?.('번호판 인식 중...');
            const text = await this.ocr.recognize(cropCanvas);
            const match = findMatch(text, this.plateList);
            // 매칭 결과와 무관하게 크롭은 한 번만 만들어 두 콜백이 같이 쓴다
            // (onMatch는 CSV 매칭 시에만, onRecognized는 정확도 테스트 옵트인 시에만
            // 실제로 저장으로 이어진다 — 호출 자체는 항상 일어나지만 저장 여부는 app.js가 결정)
            const cropDataUrl = cropCanvas.toDataURL('image/jpeg', 0.7);

            if (match) {
                match.colorLabel = colorInfo.label;
                debugLogger.log(`[번호판조회] 매칭: "${text.trim()}" → ${match.plate} (${match.matchType}, ${colorInfo.label})`);
                this.onMatch?.(match, cropDataUrl);
            } else {
                // 매칭 안 된 차량 — CSV 목록(체납차량 매칭 기록)에는 절대 안 들어간다.
                // 다만 정확도 테스트 로그는 사용자가 명시적으로 켰을 때만 별도로 남는다
                // (당일 한정, 자정 자동삭제 — dataManager.saveTestLogEntry 참고).
                debugLogger.log('[번호판조회] 매칭 없음 (체납차량 기록엔 저장 안 함)');
            }
            this.onRecognized?.({ text: normalizePlate(text), colorLabel: colorInfo.label, cropDataUrl });
            this.onStatus?.('스캔 중');
        } catch (err) {
            debugLogger.log(`[번호판조회] OCR 실패: ${err}`);
            this.onStatus?.('스캔 중');
        } finally {
            this._ocrInFlight = false;
            this._activeOcrTrackId = null;
        }
    }
}
