// 번호판 조회 모드 — 카메라 + 수동 조준 캡처.
// 보행 안전용 DetectionManager(motionGate/poleGate/추적기가 서로 촘촘히 얽혀
// 이미 실기기에서 튜닝된 상태)는 건드리지 않고, 완전히 별도의 가벼운 엔진으로
// 분리한다 — 이 모드의 버그가 보행 안전 기능에 영향을 줄 수 없게 하기 위함.
//
// 상호작용 방식 변경 이력(2026-09-19): 원래는 COCO-SSD로 차량을 자동 감지해
// 걸으면서 매 차량마다 자동으로 번호판을 크롭·인식했다. 실측(정차 차량 30장,
// 실제 도보 854장)에서 두 가지가 드러났다: (1) OCR 전처리 자체가 부실해서
// 크롭이 정확해도 결과가 엉망이었음(plateOcr.js에서 수정) — 그리고 그걸 고친
// 뒤에도 (2) "차량 박스 하단 40%"라는 고정 비율 크롭이 실제 도보 중 다양한
// 각도·거리에서는 번호판을 자주 놓쳤다. 고정식 번호판 인식기들이 카메라를
// 고정해두는 이유와 같은 문제라, 자동 감지를 걷어내고 실제 CCTV/스캐너 앱들처럼
// "사용자가 직접 프레임에 번호판을 맞추고 확인 버튼을 누르는" 방식으로 바꿨다.
// 인식률이 실측으로 검증되면 자동 스캔을 다시 검토하기로 함.
import { PlateOcr } from './plateOcr.js';
import { findMatch, normalizePlate } from './plateMatcher.js';
import { classifyPlateColor } from './plateColor.js';
import { estimateSharpness } from '../detection/sharpness.js';
import { debugLogger } from '../utils/debugLogger.js';

export class PlateScanManager {
    constructor() {
        this.video = null;
        this.canvas = null;
        this.ctx = null;
        this.ocr = null;

        this.isActive = false; // 카메라가 켜져 가이드 프레임을 그리고 있는지
        this._animFrameId = null;
        this._capturing = false;

        // 가이드 프레임 — 번호판 근사 비율(신형 8자리 단일행 기준 약 2.8:1)로 화면
        // 중앙에 고정 표시. 정확한 크기가 아니라 "이 안에 번호판을 맞추라"는 조준
        // 보조선일 뿐이라 여유를 두고 약간 넓게 잡았다.
        this.guideAspectRatio = 2.8;
        this.guideWidthFraction = 0.82;

        // 흐린 사진 경고용 기준선 — 아직 번호판 크롭 기준으로 실측 보정된 적 없는
        // 시작값(미지 객체 큐의 값과 동일 계열 방식만 재사용). 자동 스캔 때와 달리
        // 여기선 결과를 무조건 보여주고 "흐릴 수 있음"만 경고한다(차단하지 않음) —
        // 사용자가 직접 조준한 캡처라 결과를 숨기는 것보다 보여주고 판단을 맡기는
        // 게 낫다고 판단.
        this.minPlateCropSharpness = 60;

        this.plateList = []; // dataManager.getPlateList()에서 로드된 정규화된 목록
        this.onMatch = null; // (match, cropDataUrl) => void — 매칭된 건만 호출됨
        this.onStatus = null; // (text) => void — 화면 상태 텍스트 업데이트용

        // 정확도 테스트 로그용 — 매칭 여부와 무관하게 캡처마다 호출됨. app.js가
        // 옵트인 설정을 보고 실제 기록 여부를 결정한다.
        this.onRecognized = null; // ({ text, colorLabel, cropDataUrl }) => void

        // 캡처 직후 화면에 "인식됨: XXX" 즉시 피드백을 주기 위한 콜백 — 매칭 여부와
        // 무관하게, 그리고 저장 여부와도 무관하게 매 캡처마다 호출된다.
        this.onCaptureResult = null; // ({ text, rawText, match, colorLabel, sharpness, cropDataUrl }) => void
    }

    setPlateList(list) {
        this.plateList = list;
    }

    async init() {
        this.video = document.getElementById('plateVideoElement');
        this.canvas = document.getElementById('plateCanvasOverlay');
        this.ctx = this.canvas.getContext('2d');

        await this.setupCamera();

        this.ocr = new PlateOcr();
        debugLogger.log('[번호판조회] OCR 모델 로딩 중...');
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
        this.isActive = true;
        const animate = () => {
            if (!this.isActive) return;
            this.drawGuideFrame();
            this._animFrameId = requestAnimationFrame(animate);
        };
        this._animFrameId = requestAnimationFrame(animate);
    }

    stop() {
        this.isActive = false;
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

    // 캔버스는 video와 같은 네이티브 해상도로 맞춰져 있고 둘 다 동일한 CSS
    // object-fit:cover로 표시되므로, 캔버스 네이티브 좌표에서 그린 사각형이 화면에
    // 보이는 위치와 캡처 시 crop할 video 영역이 좌표계가 그대로 일치한다 —
    // 화면 표시 좌표 ↔ 영상 원본 좌표 변환이 따로 필요 없다.
    getGuideRect() {
        const w = this.canvas.width * this.guideWidthFraction;
        const h = w / this.guideAspectRatio;
        const x = (this.canvas.width - w) / 2;
        const y = (this.canvas.height - h) / 2;
        return { x, y, w, h };
    }

    // 모서리 브래킷("뷰파인더") 스타일 — QR 스캐너처럼 네 귀퉁이만 그린다.
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

    drawGuideFrame() {
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        const { x, y, w, h } = this.getGuideRect();
        const bracketLen = Math.min(w, h) * 0.16;

        let color, lineWidth, label;
        if (this._capturing) {
            const pulse = (Math.sin(performance.now() / 150) + 1) / 2;
            color = `rgba(255, 210, 0, ${0.6 + pulse * 0.4})`;
            lineWidth = 2 + pulse * 2.5;
            label = '인식 중...';
        } else {
            color = 'rgba(0, 224, 255, 0.85)';
            lineWidth = 2.5;
            label = '번호판을 프레임 안에 맞춰주세요';
        }

        this.drawCornerBrackets(x, y, w, h, color, bracketLen, lineWidth);
        this.ctx.font = '15px sans-serif';
        this.ctx.fillStyle = color;
        this.ctx.fillText(label, x, y > 20 ? y - 8 : y + h + 20);
    }

    cropGuideRegion() {
        const { x, y, w, h } = this.getGuideRect();
        const outW = 400;
        const outH = Math.max(1, Math.round(outW * (h / w)));

        const canvas = document.createElement('canvas');
        canvas.width = outW;
        canvas.height = outH;
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(this.video, x, y, w, h, 0, 0, outW, outH);
        return canvas;
    }

    // 사용자가 "번호판 인식" 버튼을 눌렀을 때만 호출된다 — 자동 감지/루프 없음.
    async capture() {
        if (this._capturing || !this.ocr) return null;
        this._capturing = true;
        this.onStatus?.('번호판 인식 중...');
        try {
            const cropCanvas = this.cropGuideRegion();
            const cropCtx = cropCanvas.getContext('2d');
            const imageData = cropCtx.getImageData(0, 0, cropCanvas.width, cropCanvas.height);

            const colorInfo = classifyPlateColor(imageData);
            const sharpness = estimateSharpness(imageData);
            const cropDataUrl = cropCanvas.toDataURL('image/jpeg', 0.8);

            const rawText = await this.ocr.recognize(cropCanvas);
            const normalizedText = normalizePlate(rawText);
            const match = findMatch(rawText, this.plateList);

            const result = {
                text: normalizedText,
                rawText: rawText.trim(),
                match,
                colorLabel: colorInfo.label,
                sharpness,
                cropDataUrl
            };

            if (match) {
                match.colorLabel = colorInfo.label;
                debugLogger.log(`[번호판조회] 매칭: "${rawText.trim()}" → ${match.plate} (${match.matchType})`);
                this.onMatch?.(match, cropDataUrl);
            } else {
                debugLogger.log(`[번호판조회] 인식 결과: "${normalizedText || '(비어있음)'}" (매칭 없음, 선명도=${sharpness.toFixed(0)})`);
            }
            this.onRecognized?.({ text: normalizedText, colorLabel: colorInfo.label, cropDataUrl });
            this.onCaptureResult?.(result);
            return result;
        } catch (err) {
            debugLogger.log(`[번호판조회] 인식 실패: ${err}`);
            return null;
        } finally {
            this._capturing = false;
            this.onStatus?.('대기 중');
        }
    }
}
