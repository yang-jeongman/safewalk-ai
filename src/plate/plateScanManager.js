// 번호판 조회 모드 — 카메라 + COCO-SSD(차량 클래스만) 루프.
// 보행 안전용 DetectionManager(motionGate/poleGate/추적기가 서로 촘촘히 얽혀
// 이미 실기기에서 튜닝된 상태)는 건드리지 않고, 완전히 별도의 가벼운 엔진으로
// 분리한다 — 이 모드의 버그가 보행 안전 기능에 영향을 줄 수 없게 하기 위함.
import { ObjectTracker } from '../detection/objectTracker.js';
import { PlateOcr } from './plateOcr.js';
import { findMatch } from './plateMatcher.js';
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

        // 트랙ID별로 한 번만 OCR — 같은 정차/서행 차량을 매 프레임 재스캔하지 않는다
        this._scannedTrackIds = new Set();
        this._ocrInFlight = false;

        this.plateList = []; // dataManager.getPlateList()에서 로드된 정규화된 목록
        this.onMatch = null; // (match, cropDataUrl) => void — 매칭된 건만 호출됨
        this.onStatus = null; // (text) => void — 화면 상태 텍스트 업데이트용
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
    }

    stop() {
        this.isScanning = false;
        if (this._timer) {
            clearInterval(this._timer);
            this._timer = null;
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
        const tracked = this.tracker.update(vehicles);

        this.drawOverlay(tracked);

        if (!this._ocrInFlight) {
            const candidate = tracked.find(t => !this._scannedTrackIds.has(t.trackId));
            if (candidate) {
                this._scannedTrackIds.add(candidate.trackId);
                this.runOcr(candidate);
            }
        }
    }

    drawOverlay(tracked) {
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        this.ctx.strokeStyle = '#00e0ff';
        this.ctx.lineWidth = 2;
        this.ctx.font = '16px sans-serif';
        this.ctx.fillStyle = '#00e0ff';
        for (const t of tracked) {
            const [x, y, w, h] = t.bbox;
            this.ctx.strokeRect(x, y, w, h);
            const label = this._scannedTrackIds.has(t.trackId) ? '조회 완료' : '대기 중';
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
        this.onStatus?.('번호판 인식 중...');
        try {
            const cropCanvas = this.cropPlateRegion(vehicle.bbox);
            const text = await this.ocr.recognize(cropCanvas);
            const match = findMatch(text, this.plateList);

            if (match) {
                debugLogger.log(`[번호판조회] 매칭: "${text.trim()}" → ${match.plate} (${match.matchType})`);
                const cropDataUrl = cropCanvas.toDataURL('image/jpeg', 0.7);
                this.onMatch?.(match, cropDataUrl);
            } else {
                // 매칭 안 된 차량 — 인식 텍스트/크롭을 어디에도 남기지 않는다 (무관 차량
                // 데이터 최소 수집 원칙). 디버그 로그에도 원문 텍스트를 남기지 않는다.
                debugLogger.log('[번호판조회] 매칭 없음 (기록 안 함)');
            }
            this.onStatus?.('스캔 중');
        } catch (err) {
            debugLogger.log(`[번호판조회] OCR 실패: ${err}`);
            this.onStatus?.('스캔 중');
        } finally {
            this._ocrInFlight = false;
        }
    }
}
